// android-apk.sh prepares the manifest that `tauri android init` writes: uiMode
// must be in configChanges, and INTERNET is removed from the merged manifest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { prepareManifest } from "../scripts/android-manifest.mjs";

const APP = fileURLToPath(new URL("../", import.meta.url));
const REMOVE = '<uses-permission android:name="android.permission.INTERNET" tools:node="remove" />';

// The shape `tauri android init` (tauri-cli 3.0.0-alpha.6) generates.
const GENERATED = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />

    <!-- AndroidTV support -->
    <uses-feature android:name="android.software.leanback" android:required="false" />

    <application
        android:allowBackup="false"
        android:usesCleartextTraffic="\${usesCleartextTraffic}">
        <activity
            android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode"
            android:name=".MainActivity"
            android:exported="true">
        </activity>
    </application>
</manifest>
`;

const asks = (xml) => [...xml.matchAll(/<uses-permission[^>]*android\.permission\.INTERNET[^>]*>/g)].map((m) => m[0]);

test("INTERNET is declared removed, once, with the tools namespace", () => {
  const out = prepareManifest(GENERATED);
  assert.deepEqual(asks(out), [REMOVE]);
  assert.match(out, /^<\?xml[^>]*>\n<manifest xmlns:tools="http:\/\/schemas\.android\.com\/tools" xmlns:android="http:\/\/schemas\.android\.com\/apk\/res\/android">\n {4}<uses-permission/m);
  assert.ok(out.includes('android:name="android.software.leanback"'), "the rest stays");
  assert.ok(out.includes("android:configChanges="), "the activity stays");
});

test("a manifest without INTERNET still gets the remove, for library manifests", () => {
  const out = prepareManifest(GENERATED.replace('    <uses-permission android:name="android.permission.INTERNET" />\n', ""));
  assert.deepEqual(asks(out), [REMOVE]);
});

test("running it twice changes nothing more", () => {
  const once = prepareManifest(GENERATED);
  assert.equal(prepareManifest(once), once);
});

test("other INTERNET forms are removed too", () => {
  const xml = GENERATED.replace(
    '    <uses-permission android:name="android.permission.INTERNET" />\n',
    '    <uses-permission android:name="android.permission.INTERNET"></uses-permission>\n    <uses-permission-sdk-23 android:name="android.permission.INTERNET"/>\n    <uses-permission android:name="android.permission.VIBRATE" />\n',
  );
  const out = prepareManifest(xml);
  assert.deepEqual(asks(out), [REMOVE]);
  assert.ok(!out.includes("uses-permission-sdk-23"));
  assert.ok(out.includes('android:name="android.permission.VIBRATE"'), "other permissions are not touched");
});

test("no uiMode, no <manifest>, or a foreign tools namespace is refused", () => {
  assert.throws(() => prepareManifest(GENERATED.replace("|uiMode", "")), /uiMode/);
  assert.throws(() => prepareManifest(GENERATED.replace(/android:configChanges="[^"]*"/, "")), /uiMode/);
  assert.throws(() => prepareManifest("<application/>"), /<manifest>/);
  assert.throws(() => prepareManifest(GENERATED.replace("<manifest ", '<manifest xmlns:tools="urn:other" ')), /xmlns:tools/);
});

test("the CLI edits the file in place and fails without uiMode", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "itonami-manifest-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "AndroidManifest.xml");
  await writeFile(file, GENERATED);
  execFileSync(process.execPath, [join(APP, "scripts/android-manifest.mjs"), file]);
  assert.deepEqual(asks(await readFile(file, "utf8")), [REMOVE]);
  await writeFile(file, GENERATED.replace("|uiMode", ""));
  assert.throws(() => execFileSync(process.execPath, [join(APP, "scripts/android-manifest.mjs"), file], { stdio: "pipe" }));
  assert.equal(await readFile(file, "utf8"), GENERATED.replace("|uiMode", ""), "a refused manifest is left as it was");
});

test("android-apk.sh prepares the manifest and checks the APK's permissions", async () => {
  const sh = await readFile(join(APP, "scripts/android-apk.sh"), "utf8");
  const init = sh.indexOf("android init");
  const prepare = sh.indexOf('node "$root/scripts/android-manifest.mjs" "$gen/AndroidManifest.xml"');
  const build = sh.indexOf("android build");
  assert.ok(init > 0 && prepare > init && build > prepare, "init, then the manifest, then the build");
  const check = sh.indexOf('"$aapt2" dump permissions "$apk"');
  assert.ok(check > build, "the built APK's permissions are checked");
  assert.ok(sh.indexOf('if [ ! -x "$aapt2" ]') < sh.indexOf("npm run build"), "aapt2 is required before anything is built");
});
