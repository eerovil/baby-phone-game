#!/usr/bin/env bash
#
# Repair an installed web app that crashes on launch on Android 8 or older.
#
#   ./tools/fix-webapk-android8.sh            # fix every Vauvapeli web app found
#   ./tools/fix-webapk-android8.sh <package>  # fix one, by package name
#
# WHAT IS BROKEN
#
# When Chrome installs a PWA on Android it asks Google's minting server for a
# small wrapper APK. That server currently builds those wrappers with a dex
# (bytecode) format version of 039, which Android 9 introduced. On Android 8 the
# runtime cannot read the file at all, so the process dies while starting:
#
#   java.io.IOException: Failed to open dex files from .../base.apk because:
#     Unrecognized version number in .../base.apk: 0 3 9
#   java.lang.ClassNotFoundException: …webapk.shell_apk.h2o.SplashContentProvider
#
# The web app never gets as far as loading a page, so this is nothing to do with
# the site. Every PWA installed from a recent Chrome onto such a phone fails the
# same way, and there is no manifest setting or Chrome flag that avoids it.
#
# WHAT THIS DOES
#
# The wrapper's bytecode does not actually use anything that 039 added — this
# script checks that first, by looking for the call-site and method-handle
# sections — so it rewrites the version stamp to 038, repairs the two checksums
# in the dex header, and puts the file back. Chrome's own signature on the APK is
# left untouched; Android only verifies that when installing, so the app keeps
# working as the WebAPK Chrome expects.
#
# REQUIREMENTS
#
# adb, python3, and root on the phone (`su`). Enable USB debugging first.
#
# AFTERWARDS
#
# Chrome refreshes a WebAPK every few weeks, and a refreshed one arrives broken
# again. Re-run this when the app starts crashing again.
set -euo pipefail

command -v adb >/dev/null || { echo "adb is not installed" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is not installed" >&2; exit 1; }

adb get-state >/dev/null 2>&1 || { echo "no phone connected (adb get-state)" >&2; exit 1; }

release="$(adb shell getprop ro.build.version.release | tr -d '\r')"
echo "phone: $(adb shell getprop ro.product.model | tr -d '\r'), Android $release"
case "$release" in
  [0-8]|[0-8].*) ;;
  *) echo "Android $release reads dex 039 by itself — nothing to repair." ; exit 0 ;;
esac

adb shell 'su -c id' 2>/dev/null | grep -q 'uid=0' || {
  echo "no root on the phone: this repair rewrites a file under /data/app" >&2
  exit 1
}

if [ "$#" -gt 0 ]; then
  packages="$1"
else
  # Every Chrome-installed web app whose site is this game.
  packages="$(adb shell 'pm list packages org.chromium.webapk' 2>/dev/null \
    | tr -d '\r' | sed 's/package://' | while read -r pkg; do
        [ -n "$pkg" ] || continue
        if adb shell "dumpsys package $pkg" 2>/dev/null | grep -qi 'vauvapeli'; then
          echo "$pkg"
        fi
      done)"
fi

[ -n "$packages" ] || { echo "no Vauvapeli web app is installed on this phone"; exit 0; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

for pkg in $packages; do
  echo
  echo "== $pkg"
  apk_path="$(adb shell "pm path $pkg" | tr -d '\r' | sed 's/package://' | head -1)"
  [ -n "$apk_path" ] || { echo "  not installed, skipping"; continue; }
  apk_dir="$(dirname "$apk_path")"

  adb pull "$apk_path" "$work/base.apk" >/dev/null
  if ! python3 - "$work/base.apk" "$work/patched.apk" <<'PYTHON'
import hashlib, struct, sys, zipfile, zlib

src, out = sys.argv[1], sys.argv[2]
zin = zipfile.ZipFile(src)
dex = bytearray(zin.read('classes.dex'))

version = bytes(dex[4:8])
if version == b'038\x00':
    print('  already dex 038, nothing to do')
    sys.exit(2)
if version != b'039\x00':
    print(f'  unexpected dex version {version!r}, refusing to touch it')
    sys.exit(1)

# Refuse if the bytecode genuinely needs 039: invoke-custom and friends live in
# the call-site and method-handle sections, and Android 8 cannot run them.
map_off = struct.unpack_from('<I', dex, 52)[0]
count = struct.unpack_from('<I', dex, map_off)[0]
for i in range(count):
    kind, _, size, _ = struct.unpack_from('<HHII', dex, map_off + 4 + i * 12)
    if kind in (0x0007, 0x0008) and size:
        print('  this wrapper really does use dex 039 features, refusing')
        sys.exit(1)

dex[4:8] = b'038\x00'
# Both header integrity fields cover the version stamp we just changed.
dex[12:32] = hashlib.sha1(bytes(dex[32:])).digest()
struct.pack_into('<I', dex, 8, zlib.adler32(bytes(dex[12:])) & 0xFFFFFFFF)

with zipfile.ZipFile(out, 'w') as zout:
    for item in zin.infolist():
        body = bytes(dex) if item.filename == 'classes.dex' else zin.read(item.filename)
        zout.writestr(item, body, item.compress_type)
print('  rewrote classes.dex as version 038')
PYTHON
  then
    echo "  skipped"
    continue
  fi

  adb push "$work/patched.apk" /data/local/tmp/webapk-patched.apk >/dev/null
  adb shell "su -c 'am force-stop $pkg
    cp /data/local/tmp/webapk-patched.apk $apk_dir/base.apk
    chmod 644 $apk_dir/base.apk
    chown system:system $apk_dir/base.apk
    rm -rf $apk_dir/oat
    restorecon -R $apk_dir'" >/dev/null 2>&1
  adb shell "rm -f /data/local/tmp/webapk-patched.apk" >/dev/null 2>&1

  adb logcat -c >/dev/null 2>&1 || true
  adb shell "monkey -p $pkg -c android.intent.category.LAUNCHER 1" >/dev/null 2>&1
  sleep 8
  if adb logcat -d 2>/dev/null | grep -q 'Unrecognized version number'; then
    echo "  FAILED: it still cannot read the dex"
    exit 1
  fi
  echo "  repaired — the app launched without the dex error"
done
