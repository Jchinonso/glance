#!/bin/sh
# Builds glance-whisper (native/glance-whisper: WhisperKit running Whisper
# large-v3 turbo on the Neural Engine) and copies it, with any resource
# bundles SwiftPM puts next to it, into vendor/whisperkit/, signed ad hoc.
# Needs Xcode (or its command line tools) with Swift 5.10 or later; the first
# build fetches WhisperKit from GitHub. Run by `npm run package`.
set -e
cd "$(dirname "$0")/.."
command -v swift >/dev/null 2>&1 || { echo "Missing Swift. Install Xcode (or run: xcode-select --install)." >&2; exit 1; }
pkg=native/glance-whisper
(cd "$pkg" && swift build -c release --arch arm64)
bin=$(cd "$pkg" && swift build -c release --arch arm64 --show-bin-path)

out=vendor/whisperkit
rm -rf "$out"
mkdir -p "$out/licenses"
cp "$bin/glance-whisper" "$out/"
for b in "$bin"/*.bundle; do
  [ -e "$b" ] && cp -R "$b" "$out/"
done
lic="$pkg/.build/checkouts/WhisperKit/LICENSE"
[ -f "$lic" ] && cp "$lic" "$out/licenses/WhisperKit-LICENSE"
codesign --force --sign - "$out/glance-whisper"
echo "Built $out/glance-whisper"
