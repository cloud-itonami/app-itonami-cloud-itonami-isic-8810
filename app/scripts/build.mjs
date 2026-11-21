// Static build: dist/ is the whole app (HTML, CSS, JS) for the Tauri v3 shell
// and for a plain static host. No bundler and no dependency. Everything the
// app shows is read here from the repository's own files (blueprint.edn,
// physics.edn, docs/samples/operator-console.html) and pinned by digest in
// release.json; the app carries no second, hand-written copy.
import { mkdir, copyFile, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { readAll } from "./edn.mjs";
import { readBlueprint, deriveIdentity } from "./identity.mjs";
import { extractConsole } from "./console.mjs";

export const TAURI = "3.0.0-alpha.6";
// The page talks to nothing but the Tauri IPC bridge. There is no external
// operation, so no other origin appears here.
export const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src ipc: http://ipc.localhost; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

const COMMIT = /^[0-9a-f]{40}$/;

/**
 * The commit the build is made from, for release.json: `source_commit` is the
 * 40-hex `git rev-parse HEAD` of the repository root, and `dirty` is true when
 * `git status --porcelain` lists a tracked change or an untracked file that is
 * not ignored. The repository root must be the top of its own git checkout; a
 * tarball unpacked inside some other checkout does not take that one's commit.
 * Without git, ITONAMI_SOURCE_COMMIT (40 hex) and ITONAMI_SOURCE_DIRTY
 * ("true" or "false") give the values when they are set; otherwise both are
 * null. Nothing is guessed: a malformed variable stops the build.
 */
export function sourceState(repo, env = process.env) {
  const git = (args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  let top = null;
  try {
    top = git(["rev-parse", "--show-toplevel"]).trim();
  } catch {
    // Not a git checkout, or no git on this machine.
  }
  if (top !== null && realpathSync(top) === realpathSync(repo)) {
    const commit = git(["rev-parse", "HEAD"]).trim();
    if (!COMMIT.test(commit)) throw new Error(`git rev-parse HEAD gave ${JSON.stringify(commit)}, not a 40-hex commit`);
    return { source_commit: commit, dirty: git(["status", "--porcelain"]).trim() !== "" };
  }
  let source_commit = null;
  let dirty = null;
  if (env.ITONAMI_SOURCE_COMMIT !== undefined) {
    if (!COMMIT.test(env.ITONAMI_SOURCE_COMMIT)) throw new Error("ITONAMI_SOURCE_COMMIT is not a 40-hex commit");
    source_commit = env.ITONAMI_SOURCE_COMMIT;
  }
  if (env.ITONAMI_SOURCE_DIRTY !== undefined) {
    if (env.ITONAMI_SOURCE_DIRTY !== "true" && env.ITONAMI_SOURCE_DIRTY !== "false") throw new Error('ITONAMI_SOURCE_DIRTY is not "true" or "false"');
    dirty = env.ITONAMI_SOURCE_DIRTY === "true";
  }
  return { source_commit, dirty };
}

export async function build(appRoot = fileURLToPath(new URL("../", import.meta.url)), env = process.env) {
  const repo = resolve(appRoot, "..");
  // Read before dist/ is written, so the build's own output never counts.
  const state = sourceState(repo, env);
  const out = resolve(appRoot, "dist");
  const meta = JSON.parse(await readFile(resolve(appRoot, "package.json"), "utf8"));

  const pins = JSON.parse(await readFile(resolve(appRoot, "vendor/PINS.json"), "utf8"));
  for (const [name, digest] of Object.entries(pins.files)) {
    if (sha(await readFile(resolve(appRoot, "vendor", name))) !== digest) throw new Error(`canonical runtime pin drift: ${name}`);
  }

  const sources = {};
  const source = async (path) => {
    const file = resolve(repo, path);
    if (!existsSync(file)) return null;
    const bytes = await readFile(file);
    sources[path] = sha(bytes);
    return bytes.toString("utf8");
  };

  const blueprintText = await source("blueprint.edn");
  if (blueprintText === null) throw new Error("blueprint.edn not found next to app/");
  const blueprint = readBlueprint(blueprintText);
  if (typeof meta.itonami?.source !== "string" || !meta.itonami.source) {
    throw new Error("package.json has no itonami.source; re-run scripts/scaffold.mjs");
  }
  const identity = deriveIdentity(meta.itonami.source, blueprint);

  // The stamped files must agree with the blueprint they were stamped from.
  const conf = JSON.parse(await readFile(resolve(appRoot, "src-tauri/tauri.conf.json"), "utf8"));
  const expect = (what, got, want) => { if (got !== want) throw new Error(`${what} is ${JSON.stringify(got)}, blueprint.edn gives ${JSON.stringify(want)}; re-run scripts/scaffold.mjs`); };
  expect("package.json itonami.id", meta.itonami?.id, identity.id);
  expect("package.json itonami.source", meta.itonami?.source, identity.source);
  expect("tauri.conf.json identifier", conf.identifier, identity.id);
  expect("tauri.conf.json productName", conf.productName, identity.productName);
  expect("tauri.conf.json window title", conf.app?.windows?.[0]?.title, identity.title);
  expect("tauri.conf.json version", conf.version, meta.version);
  expect("tauri.conf.json csp", conf.app?.security?.csp, CSP);

  const physicsText = await source("physics.edn");
  let physics = null;
  if (physicsText !== null) {
    const forms = readAll(physicsText);
    if (forms.length !== 1 || !Array.isArray(forms[0]?.cases)) throw new Error("physics.edn must hold one map with :cases");
    physics = forms[0];
  }
  const consoleText = await source("docs/samples/operator-console.html");
  const operatorConsole = consoleText === null ? null : extractConsole(consoleText);
  if (consoleText !== null && operatorConsole === null) delete sources["docs/samples/operator-console.html"];

  const descriptor = {
    schema: "kotoba.app.client-runtime.v1", target: "browser", profile: "trusted-page-v1", entry: "index.html",
    "local-state": { adapter: "localstorage", schema: identity.stateSchema, version: 1 }, workers: [], operations: [],
  };

  await rm(out, { recursive: true, force: true });
  await mkdir(join(out, "vendor"), { recursive: true });
  const index = (await readFile(resolve(appRoot, "src/index.html"), "utf8")).replaceAll("{{CSP}}", CSP).replaceAll("{{TITLE}}", identity.title.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])));
  if (index.includes("{{")) throw new Error("index.html has an unfilled placeholder");
  await writeFile(join(out, "index.html"), index);
  for (const name of ["style.css", "app.js", "view.js"]) await copyFile(resolve(appRoot, "src", name), join(out, name));
  await copyFile(resolve(appRoot, "vendor/kotoba-client-runtime.js"), join(out, "vendor/kotoba-client-runtime.js"));
  const data = { identity, version: meta.version, blueprint, physics, console: operatorConsole, sources, descriptor };
  await writeFile(join(out, "data.js"), `export default ${JSON.stringify(data, null, 1)};\n`);
  await writeFile(join(out, "descriptor.json"), JSON.stringify(descriptor, null, 2) + "\n");

  const names = ["index.html", "style.css", "app.js", "view.js", "data.js", "descriptor.json", "vendor/kotoba-client-runtime.js"];
  const files = {};
  for (const name of names) files[name] = sha(await readFile(join(out, name)));
  const release = { schema: "awai.app.artifact.v1", id: identity.id, source: identity.source, version: meta.version, tauri: TAURI, runtimePins: pins, sources, files, source_commit: state.source_commit, dirty: state.dirty };
  await writeFile(join(out, "release.json"), JSON.stringify(release, null, 2) + "\n");
  return { identity, release, data };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { identity, release } = await build();
  console.log(`${identity.title} (${identity.id}) static build: ${Object.keys(release.files).length} pinned files from ${Object.keys(release.sources).length} sources`);
}
