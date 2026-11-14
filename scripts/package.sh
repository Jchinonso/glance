#!/bin/sh
# Packages and signs dist/Glance-darwin-<arch>/Glance.app.
# arch: arm64 (the default, Apple Silicon) or x64 (Intel).
set -e
cd "$(dirname "$0")/.."
arch=${1:-arm64}
case "$arch" in
  arm64) other=x64 ;;
  x64) other=arm64 ;;
  *) echo "arch must be arm64 or x64" >&2; exit 1 ;;
esac

# The speech engine is prebuilt per chip. npm installs only this Mac's, so
# fetch the other one when building for it (same version, not saved).
lib="sherpa-onnx-darwin-$arch"
if [ ! -d "node_modules/$lib" ]; then
  version=$(node -p "require('./package.json').dependencies['sherpa-onnx-darwin-arm64']")
  npm install --no-save --force --cpu="$arch" --os=darwin "$lib@$version"
fi

node_modules/.bin/electron-packager . Glance --platform=darwin --arch="$arch" \
  --app-bundle-id=com.glance.overlay --out=dist --overwrite \
  --ignore='^/dist' --ignore='^/build' --ignore='^/test' --ignore='^/README.md' \
  --ignore='^/docs' --ignore='^/scripts' --ignore='^/PLAN.md' --ignore='^/\.' \
  --ignore='^/models' --ignore='^/graphify-out' --ignore='^/install\.sh' \
  --ignore="^/node_modules/sherpa-onnx-darwin-$other" \
  --asar.unpackDir="{node_modules/audiotee/bin,node_modules/$lib}" \
  --icon=build/icon.icns --extend-info=build/extra.plist

app="dist/Glance-darwin-$arch/Glance.app"
codesign --force --deep --sign - "$app"
# The same designated requirement on every build, so macOS keeps Glance's
# screen and audio permission across updates.
codesign --force --sign - --requirements '=designated => identifier "com.glance.overlay"' "$app"
