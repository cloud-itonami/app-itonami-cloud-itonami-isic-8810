// src-tauri/Cargo.lock must be in the order cargo writes it, or the first cargo
// run during an APK build rewrites it and every clone is left dirty (and the
// release.json `dirty` flag of a later build turns true). Cargo sorts [[package]]
// entries by name, then by version, then by source. `cargo metadata --locked`
// does not catch an order-only difference, so this test reads the file itself
// and needs no cargo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const APP = fileURLToPath(new URL("../", import.meta.url));

/** The [[package]] entries of a Cargo.lock text as { name, version, source }. */
export function lockPackages(text) {
  return text.split(/^\[\[package\]\]$/m).slice(1).map((block) => {
    const field = (key) => new RegExp(`^${key} = "([^"]*)"$`, "m").exec(block)?.[1] ?? "";
    return { name: field("name"), version: field("version"), source: field("source") };
  });
}

/** Cargo's semver order for x.y.z[-pre][+build]: numeric core, a pre-release sorts before the release. */
function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre = null] = v.split("+")[0].split(/-(.*)/s);
    return { nums: core.split(".").map(Number), pre };
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i];
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export function lockOrderProblems(text) {
  const packages = lockPackages(text);
  const problems = [];
  for (let i = 1; i < packages.length; i++) {
    const a = packages[i - 1], b = packages[i];
    const order = a.name !== b.name ? (a.name < b.name ? -1 : 1) : compareVersions(a.version, b.version) || (a.source < b.source ? -1 : a.source > b.source ? 1 : 0);
    if (order >= 0) problems.push(`${b.name} ${b.version} comes after ${a.name} ${a.version}`);
  }
  return problems;
}

test("Cargo.lock lists its packages in cargo's own order", async () => {
  const text = await readFile(join(APP, "src-tauri/Cargo.lock"), "utf8");
  assert.match(text, /^version = 4$/m, "lock file format 4");
  assert.ok(lockPackages(text).some((p) => p.name === "itonami-series-app"), "the app crate is in the lock");
  assert.deepEqual(lockOrderProblems(text), []);
});

test("the order check sees a package out of place and accepts versions in semver order", () => {
  const lock = (...names) => names.map(([n, v]) => `[[package]]\nname = "${n}"\nversion = "${v}"\n`).join("\n");
  assert.deepEqual(lockOrderProblems(lock(["itoa", "1.0.0"], ["javascriptcore-rs", "1.1.2"], ["zerofrom", "0.1.8"])), []);
  assert.deepEqual(lockOrderProblems(lock(["itoa", "1.0.0"], ["zerofrom", "0.1.8"], ["itonami-series-app", "0.1.0"])), ["itonami-series-app 0.1.0 comes after zerofrom 0.1.8"]);
  assert.deepEqual(lockOrderProblems(lock(["syn", "1.0.109"], ["syn", "2.0.9"], ["syn", "2.0.10"])), []);
  assert.deepEqual(lockOrderProblems(lock(["x", "1.0.0-alpha.6"], ["x", "1.0.0"])), []);
  assert.equal(lockOrderProblems(lock(["x", "2.0.10"], ["x", "2.0.9"])).length, 1);
});
