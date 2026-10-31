#!/bin/sh
# Builds dist/Glance-<version>-arm64.dmg from the packaged app: the app plus
# an Applications shortcut to drag it onto. Run `npm run package` first (or
# `npm run dmg`, which does both).
set -e
cd "$(dirname "$0")/.."
version=$(node -p 'require("./package.json").version')
app=dist/Glance-darwin-arm64/Glance.app
[ -d "$app" ] || { echo "No $app. Run npm run package first." >&2; exit 1; }
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
cp -R "$app" "$stage/"
ln -s /Applications "$stage/Applications"
out="dist/Glance-$version-arm64.dmg"
rm -f "$out"
hdiutil create -quiet -volname "Glance" -srcfolder "$stage" -fs HFS+ -format UDZO -ov "$out"
echo "$out"
