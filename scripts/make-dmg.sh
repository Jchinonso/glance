#!/bin/sh
# Builds dist/Glance-<version>-<arch>.dmg from the packaged app: the app plus
# an Applications shortcut to drag it onto. The DMG is LZMA-compressed (ULMO)
# for a smaller download. arch: arm64 (the default) or x64. Run `npm run
# package` (or `package:x64`) first, or `npm run dmg` / `dmg:x64`, which do both.
set -e
cd "$(dirname "$0")/.."
version=$(node -p 'require("./package.json").version')
arch=${1:-arm64}
app=dist/Glance-darwin-$arch/Glance.app
[ -d "$app" ] || { echo "No $app. Package it first." >&2; exit 1; }
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
cp -R "$app" "$stage/"
ln -s /Applications "$stage/Applications"
out="dist/Glance-$version-$arch.dmg"
rm -f "$out"
hdiutil create -quiet -volname "Glance" -srcfolder "$stage" -fs HFS+ -format ULMO -ov "$out"
echo "$out"
