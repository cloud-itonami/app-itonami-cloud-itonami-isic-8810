#!/bin/sh
# Build the debug Android APK (aarch64) for this classification-series app.
# Requires: Android SDK + NDK 27, JDK 21, Rust target aarch64-linux-android.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
: "${ANDROID_HOME:=$HOME/Library/Android/sdk}"
if [ -z "${NDK_HOME:-}" ]; then NDK_HOME=$(ls -d "$ANDROID_HOME"/ndk/* | sort | tail -1); fi
export ANDROID_HOME NDK_HOME
build_tools=$(ls -d "$ANDROID_HOME"/build-tools/* 2>/dev/null | sort -V | tail -1)
aapt2="$build_tools/aapt2"
if [ ! -x "$aapt2" ]; then
  echo "no aapt2 under $ANDROID_HOME/build-tools; it checks the built APK's permissions" >&2; exit 1
fi
for tool in cargo rustc; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "$tool is not on PATH; install a Rust toolchain (rustup) and put its cargo/rustc on PATH" >&2; exit 1
  fi
done
cd "$root"
test -x node_modules/.bin/tauri || npm ci
npm run build
# Every tauri call goes through `npm run tauri --`: tauri records the command it
# was started with in gen/android (buildSrc BuildTask.kt), and Gradle runs that
# command again from src-tauri, where a bare node_modules/.bin path is not found.
# gen/android is generated, never edited: start from a fresh init each build so
# no earlier init (or a local patch) carries into the APK.
rm -rf "$root/src-tauri/gen/android"
npm run tauri -- android init --ci
# gen/android is not in git (app/.gitignore). The activity that makes the APK
# is the committed android/MainActivity.kt, with the package taken from
# tauri.conf.json's identifier, so the APK comes from the commit and not from
# a local edit under gen/.
pkg=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).identifier)' "$root/src-tauri/tauri.conf.json")
if ! printf '%s\n' "$pkg" | grep -Eq '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'; then
  echo "tauri.conf.json identifier '$pkg' is not a Java package name" >&2; exit 1
fi
gen="$root/src-tauri/gen/android/app/src/main"
activity="$gen/java/$(printf '%s' "$pkg" | tr . /)/MainActivity.kt"
if [ ! -f "$activity" ]; then
  echo "tauri android init wrote no $activity" >&2; exit 1
fi
# uiMode must be in configChanges, and INTERNET is removed (the app makes no
# network request): see scripts/android-manifest.mjs.
node "$root/scripts/android-manifest.mjs" "$gen/AndroidManifest.xml"
if [ "$(grep -c '^package __PACKAGE__$' "$root/android/MainActivity.kt")" != 1 ]; then
  echo "android/MainActivity.kt has no single 'package __PACKAGE__' line" >&2; exit 1
fi
sed "s/^package __PACKAGE__\$/package $pkg/" "$root/android/MainActivity.kt" > "$activity"
# AGP packages incrementally into the old APK and keeps the space of replaced entries; start from none.
rm -rf "$root/src-tauri/gen/android/app/build/outputs/apk" "$root/src-tauri/gen/android/app/build/intermediates/apk" "$root/src-tauri/gen/android/app/build/intermediates/incremental"
npm run tauri -- android build --debug --apk --target aarch64 --ci
apk="$root/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk"
test -f "$apk"
# The merged manifest in the APK must not ask for INTERNET.
perms=$("$aapt2" dump permissions "$apk")
if printf '%s\n' "$perms" | grep -q 'android\.permission\.INTERNET'; then
  echo "the APK still asks for android.permission.INTERNET:" >&2; printf '%s\n' "$perms" >&2; exit 1
fi
shasum -a 256 "$apk"
