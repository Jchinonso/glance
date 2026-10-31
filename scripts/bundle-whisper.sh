#!/bin/sh
# Copies the Homebrew whisper.cpp build (whisper-server, whisper-cli, their
# libraries and ggml's compute backends) into vendor/whisper/, so the packaged
# app transcribes on Macs without Homebrew. Library paths are rewritten to
# point next to the binaries (ggml also looks for its backends in the
# executable's folder), then each file is signed again.
# Needs: brew install whisper-cpp. Run by `npm run package`.
set -e
cd "$(dirname "$0")/.."
WHISPER=$(brew --prefix whisper-cpp 2>/dev/null) || true
GGML=$(brew --prefix ggml 2>/dev/null) || true
OMP=$(brew --prefix libomp 2>/dev/null) || true
for d in "$WHISPER" "$GGML" "$OMP"; do
  [ -d "$d" ] || { echo "Missing a Homebrew package. Run: brew install whisper-cpp" >&2; exit 1; }
done

out=vendor/whisper
rm -rf "$out"
mkdir -p "$out/licenses"
cp -L "$WHISPER/bin/whisper-server" "$WHISPER/bin/whisper-cli" "$out/"
cp -L "$WHISPER/lib/libwhisper.1.dylib" "$GGML/lib/libggml.0.dylib" "$GGML/lib/libggml-base.0.dylib" "$OMP/lib/libomp.dylib" "$out/"
cp -L "$GGML"/libexec/*.so "$out/"
cp "$WHISPER/LICENSE" "$out/licenses/whisper.cpp-LICENSE"
cp "$GGML/LICENSE" "$out/licenses/ggml-LICENSE"
cp "$OMP/LICENSE.TXT" "$out/licenses/libomp-LICENSE.txt"
chmod u+w "$out"/*

# Every reference to a library we ship points next to the file that loads it.
relink() {
  file=$1
  otool -L "$file" | tail -n +2 | awk '{print $1}' | while read -r dep; do
    case "$(basename "$dep")" in
      libwhisper.1.dylib | libggml.0.dylib | libggml-base.0.dylib | libomp.dylib)
        install_name_tool -change "$dep" "@loader_path/$(basename "$dep")" "$file" 2>/dev/null ;;
    esac
  done
}
for f in "$out"/*.dylib; do install_name_tool -id "@loader_path/$(basename "$f")" "$f" 2>/dev/null; done
for f in "$out"/whisper-server "$out"/whisper-cli "$out"/*.dylib "$out"/*.so; do
  relink "$f"
  # Drop Homebrew rpaths so nothing resolves outside the bundle.
  otool -l "$f" | awk '/LC_RPATH/{getline; getline; print $2}' | while read -r rp; do install_name_tool -delete_rpath "$rp" "$f" 2>/dev/null; done
  codesign --force --sign - "$f" 2>/dev/null
done

# Nothing may still point into Homebrew.
if otool -L "$out"/whisper-* "$out"/*.dylib "$out"/*.so | grep -q /opt/homebrew; then
  echo "Some libraries still point into Homebrew:" >&2
  otool -L "$out"/whisper-* "$out"/*.dylib "$out"/*.so | grep /opt/homebrew >&2
  exit 1
fi
echo "$out: $(ls "$out" | wc -l | tr -d ' ') files, $(du -sh "$out" | cut -f1)"
