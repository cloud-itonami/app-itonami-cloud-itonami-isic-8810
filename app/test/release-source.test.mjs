// release.json says which commit the build was made from (source_commit,
// dirty), and the Android activity that makes the APK is a committed file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { build, sourceState } from "../scripts/build.mjs";
import { TEMPLATE_FILES } from "../scripts/scaffold.mjs";

const APP = fileURLToPath(new URL("../", import.meta.url));
const COMMIT = /^[0-9a-f]{40}$/;
const NO_ENV = {};

const git = (dir, ...args) =>
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

async function checkout(t) {
  const dir = await mkdtemp(join(tmpdir(), "itonami-source-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  git(dir, "init", "-q");
  await writeFile(join(dir, ".gitignore"), "/ignored/\n");
  await writeFile(join(dir, "blueprint.edn"), "[]\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "first");
  return dir;
}

test("a clean git checkout gives its HEAD and dirty false", async (t) => {
  const dir = await checkout(t);
  const state = sourceState(dir, NO_ENV);
  assert.ok(COMMIT.test(state.source_commit));
  assert.equal(state.source_commit, git(dir, "rev-parse", "HEAD").trim());
  assert.equal(state.dirty, false);
});

test("an ignored file keeps the checkout clean", async (t) => {
  const dir = await checkout(t);
  execFileSync("mkdir", [join(dir, "ignored")]);
  await writeFile(join(dir, "ignored/out.txt"), "x");
  assert.equal(sourceState(dir, NO_ENV).dirty, false);
});

test("an untracked file or a tracked change makes it dirty", async (t) => {
  const dir = await checkout(t);
  await writeFile(join(dir, "new.txt"), "x");
  assert.equal(sourceState(dir, NO_ENV).dirty, true);
  await rm(join(dir, "new.txt"));
  await writeFile(join(dir, "blueprint.edn"), "[{}]\n");
  assert.equal(sourceState(dir, NO_ENV).dirty, true);
});

test("git wins over the environment inside a checkout", async (t) => {
  const dir = await checkout(t);
  const env = { ITONAMI_SOURCE_COMMIT: "0".repeat(40), ITONAMI_SOURCE_DIRTY: "true" };
  assert.deepEqual(sourceState(dir, env), { source_commit: git(dir, "rev-parse", "HEAD").trim(), dirty: false });
});

test("without git both are null", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "itonami-nogit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.deepEqual(sourceState(dir, NO_ENV), { source_commit: null, dirty: null });
});

test("a directory inside another checkout does not take its commit", async (t) => {
  const dir = await checkout(t);
  execFileSync("mkdir", [join(dir, "unpacked")]);
  assert.deepEqual(sourceState(join(dir, "unpacked"), NO_ENV), { source_commit: null, dirty: null });
});

test("without git the environment gives the values", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "itonami-nogit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const commit = "0123456789abcdef0123456789abcdef01234567";
  assert.deepEqual(sourceState(dir, { ITONAMI_SOURCE_COMMIT: commit, ITONAMI_SOURCE_DIRTY: "false" }), { source_commit: commit, dirty: false });
  assert.deepEqual(sourceState(dir, { ITONAMI_SOURCE_DIRTY: "true" }), { source_commit: null, dirty: true });
  assert.throws(() => sourceState(dir, { ITONAMI_SOURCE_COMMIT: "abc" }), /40-hex/);
  assert.throws(() => sourceState(dir, { ITONAMI_SOURCE_COMMIT: commit.toUpperCase() }), /40-hex/);
  assert.throws(() => sourceState(dir, { ITONAMI_SOURCE_DIRTY: "1" }), /"true" or "false"/);
});

test("release.json records this checkout's commit and a boolean dirty", async (t) => {
  const repo = resolve(APP, "..");
  const here = sourceState(repo, NO_ENV);
  if (here.source_commit === null) return t.skip("the repository is not a git checkout");
  const { release } = await build(APP, NO_ENV);
  assert.ok(COMMIT.test(release.source_commit), "source_commit is 40 hex");
  assert.equal(release.source_commit, execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
  assert.equal(typeof release.dirty, "boolean");
  const written = JSON.parse(await readFile(join(APP, "dist/release.json"), "utf8"));
  assert.equal(written.source_commit, release.source_commit);
  assert.equal(written.dirty, release.dirty);
  for (const key of ["schema", "id", "source", "version", "tauri", "runtimePins", "sources", "files"]) {
    assert.ok(key in written, `${key} is kept`);
  }
});

test("the scaffold carries the new template files", () => {
  for (const name of [".gitignore", "android/MainActivity.kt", "scripts/android-apk.sh", "scripts/build.mjs", "test/release-source.test.mjs"]) {
    assert.ok(TEMPLATE_FILES.includes(name), `${name} is a template file`);
  }
});

test("the committed MainActivity is the x402 form with a package placeholder", async () => {
  const kt = await readFile(join(APP, "android/MainActivity.kt"), "utf8");
  assert.equal(kt.split("\n")[0], "package __PACKAGE__");
  assert.equal(kt.match(/^package /gm).length, 1);
  for (const part of [
    "ViewCompat.setOnApplyWindowInsetsListener(content)",
    "WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()",
    "max(bars.bottom,ime.bottom)",
    "ViewCompat.requestApplyInsets(content)",
    "override fun onConfigurationChanged(newConfig: Configuration)",
    "applySystemBarAppearance(newConfig)",
    "window.isNavigationBarContrastEnforced=false",
    "isAppearanceLightStatusBars=light",
    "isAppearanceLightNavigationBars=light",
  ]) {
    assert.ok(kt.includes(part), `MainActivity has ${part}`);
  }
  // The decor colours are the page's own --bg, light and dark.
  const css = await readFile(join(APP, "src/style.css"), "utf8");
  const bg = [...css.matchAll(/--bg:\s*#([0-9a-f]{6})/gi)].map((m) => m[1].toUpperCase());
  assert.deepEqual(bg, ["FFFFFF", "141414"]);
  assert.ok(kt.includes(`if (light) 0xFF${bg[0]}.toInt() else 0xFF${bg[1]}.toInt()`));
});

test("android-apk.sh writes the committed activity and checks uiMode", async () => {
  const sh = await readFile(join(APP, "scripts/android-apk.sh"), "utf8");
  assert.ok(sh.includes('"$root/android/MainActivity.kt" > "$activity"'));
  assert.ok(sh.includes("uiMode"));
  // tauri records how it was started, and Gradle runs that again from src-tauri.
  assert.ok(sh.includes("npm run tauri -- android init --ci"));
  assert.ok(sh.includes("npm run tauri -- android build "));
  assert.ok(!/^\s*node_modules\/\.bin\/tauri /m.test(sh), "no direct node_modules/.bin/tauri call");
  assert.ok(sh.indexOf("command -v") < sh.indexOf("npm run build"), "cargo and rustc are checked first");
  for (const dir of ["outputs/apk", "intermediates/apk", "intermediates/incremental"]) {
    assert.ok(sh.includes(`gen/android/app/build/${dir}"`), `the build starts without ${dir}`);
  }
  const ignore = await readFile(join(APP, ".gitignore"), "utf8");
  assert.ok(ignore.split("\n").includes("/src-tauri/gen/android/"));
});
