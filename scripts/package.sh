#!/bin/sh
# Packages and signs dist/Glance-darwin-<arch>/Glance.app.
# arch: arm64 (the default, Apple Silicon) or x64 (Intel).
# GLANCE_STEALTH=1 builds as AudioMonitor with a neutral bundle ID so
# name-based process scanners don't flag it.
set -e
cd "$(dirname "$0")/.."
arch=${1:-arm64}
case "$arch" in
  arm64) other=x64 ;;
  x64) other=arm64 ;;
  *) echo "arch must be arm64 or x64" >&2; exit 1 ;;
esac

if [ "${GLANCE_STEALTH:-0}" = "1" ]; then
  app_name="AudioMonitor"
  bundle_id="com.apple.audio.remotio"
else
  app_name="Glance"
  bundle_id="com.glance.overlay"
fi

# The speech engine is prebuilt per chip. npm installs only this Mac's, so
# fetch the other one when building for it (same version, not saved).
lib="sherpa-onnx-darwin-$arch"
if [ ! -d "node_modules/$lib" ]; then
  version=$(node -p "require('./package.json').dependencies['sherpa-onnx-darwin-arm64']")
  npm install --no-save --force --cpu="$arch" --os=darwin "$lib@$version"
fi

node_modules/.bin/electron-packager . "$app_name" --platform=darwin --arch="$arch" \
  --app-bundle-id="$bundle_id" --out=dist --overwrite \
  --ignore='^/dist' --ignore='^/build' --ignore='^/test' --ignore='^/README.md' \
  --ignore='^/docs' --ignore='^/scripts' --ignore='^/PLAN.md' --ignore='^/\.' \
  --ignore='^/models' --ignore='^/graphify-out' --ignore='^/install\.sh' \
  --ignore="^/node_modules/sherpa-onnx-darwin-$other" \
  --asar.unpackDir="{node_modules/audiotee/bin,node_modules/$lib}" \
  --icon=build/icon.icns --extend-info=build/extra.plist

app="dist/${app_name}-darwin-$arch/${app_name}.app"
codesign --force --deep --sign - "$app"
# The same designated requirement on every build, so macOS keeps the app's
# screen and audio permission across updates.
codesign --force --sign - --requirements "=designated => identifier \"$bundle_id\"" "$app"
