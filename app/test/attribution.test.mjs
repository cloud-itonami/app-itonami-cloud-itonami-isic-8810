// The ISCO-08 attribution (AWAI-3629, final wording) renders in the about view with the
// repository's own code. The code comes from the repository name, as
// build.mjs derives it into dist/data.js, and is checked against
// blueprint.edn, so this file stays the same in every series repository.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveIdentity, readBlueprint } from "../scripts/identity.mjs";
import { TAB_ABOUT, TAB_OVERVIEW, attributionFor, panelTree } from "../src/view.js";

const APP = fileURLToPath(new URL("../", import.meta.url));

const ja = (code) => `職業の参照: ISCO-08（国際労働機関 ILO、2012 年）のコード ${code}。日本語の名称は当方の訳です。この app は ILO が作成・確認・推奨したものではありません。`;
const en = (code) => `Occupation reference: ISCO-08 (International Labour Organization, 2012), code ${code}. This app is not produced, reviewed or endorsed by the ILO.`;

const texts = (tree) => {
  const out = [];
  const walk = (n) => {
    if (n.text !== undefined) out.push(n.text);
    for (const c of n.children || []) walk(c);
  };
  walk(tree);
  return out;
};

const imgs = (tree) => {
  let found = 0;
  const walk = (n) => {
    if (n.tag === "img" || n.tag === "svg" || n.tag === "picture") found += 1;
    for (const c of n.children || []) walk(c);
  };
  walk(tree);
  return found;
};

// Reads the repository's own files and does not write dist/: build.test.mjs
// rebuilds dist/ in a parallel process.
async function repoData() {
  const meta = JSON.parse(await readFile(join(APP, "package.json"), "utf8"));
  const blueprint = readBlueprint(await readFile(join(APP, "../blueprint.edn"), "utf8"));
  const identity = deriveIdentity(meta.itonami.source, blueprint);
  return { identity, version: meta.version, blueprint, physics: null, console: null, sources: {}, descriptor: { operations: [] } };
}

test("the about view carries both attribution sentences with this repository's code", async () => {
  const data = await repoData();
  const identity = data.identity;
  if (identity.scheme !== "isco") {
    assert.equal(attributionFor(identity), null, "only ISCO-08 needs the ILO attribution");
    return;
  }
  assert.match(identity.code, /^[0-9]{4}$/, "an ISCO-08 unit group code has four digits");
  const declared = data.blueprint["itonami.blueprint/isco-08"];
  if (declared !== undefined) assert.equal(String(declared), identity.code, "blueprint.edn names the same code");
  const tree = panelTree(data, TAB_ABOUT);
  const about = texts(tree);
  assert.ok(about.includes(ja(identity.code)), "ja sentence renders verbatim");
  assert.ok(about.includes(en(identity.code)), "en sentence renders verbatim");
  assert.equal(imgs(tree), 0, "no logo or imagery in the about view");
});

test("the attribution follows the code it is given, not a literal", () => {
  const identity = { scheme: "isco", code: "9999", classification: "ISCO-08 unit group 9999" };
  assert.deepEqual(attributionFor(identity), { ja: ja("9999"), en: en("9999") });
  const tree = panelTree({
    identity: { ...identity, id: "network.itonami.isco9999", stateSchema: "itonami.series.isco9999.v1", source: "cloud-itonami-isco-9999", title: "Fixture" },
    version: "0.1.0", blueprint: {}, physics: null, console: null, sources: {}, descriptor: { operations: [] },
  }, TAB_ABOUT);
  const about = texts(tree);
  assert.ok(about.includes(ja("9999")));
  assert.ok(about.includes(en("9999")));
});

test("other schemes and the overview carry no ILO attribution", () => {
  assert.equal(attributionFor({ scheme: "isic", code: "0111" }), null);
  assert.equal(attributionFor({ scheme: "isco", code: "" }), null);
  assert.equal(attributionFor(null), null);
  const data = {
    identity: { scheme: "isic", code: "0111", classification: "ISIC Rev.5 class 0111", id: "x", stateSchema: "s", source: "cloud-itonami-isic-0111", title: "T" },
    version: "0.1.0", blueprint: {}, physics: null, console: null, sources: {}, descriptor: { operations: [] },
  };
  assert.ok(!texts(panelTree(data, TAB_ABOUT)).some((t) => t.includes("ILO")));
  assert.ok(!texts(panelTree(data, TAB_OVERVIEW)).some((t) => t.includes("ILO")));
});
