#!/bin/sh
# Builds whisper.cpp from source into vendor/whisper/: whisper-cli and
# whisper-server, each a single self-contained program (whisper.cpp and its
# matching ggml linked in statically), so the packaged app transcribes on Macs
# without Homebrew.
#
# Why not copy Homebrew's build: Homebrew upgrades ggml separately from
# whisper.cpp, so its libwhisper (built against one ggml) ran against a newer
# libggml. The mismatch crashed the GPU path on an M3 ("cannot run the
# operation (NONE)") and the CPU path everywhere. Building both from one
# pinned source keeps them in step. OpenMP is off (ggml's own thread pool is
# used instead), so no libomp is bundled.
#
# Needs: Xcode command line tools, git and cmake (brew install cmake).
# Run by `npm run package`.
set -e
cd "$(dirname "$0")/.."

VERSION=v1.9.5 # whisper.cpp release; its ggml (0.26.0) is built with it
src=.cache/whisper.cpp
out=vendor/whisper

command -v cmake >/dev/null || { echo "Missing cmake. Run: brew install cmake" >&2; exit 1; }

if [ ! -d "$src/.git" ] || [ "$(git -C "$src" describe --tags 2>/dev/null)" != "$VERSION" ]; then
  rm -rf "$src"
  mkdir -p "$(dirname "$src")"
  git clone -q --depth 1 --branch "$VERSION" -c advice.detachedHead=false https://github.com/ggml-org/whisper.cpp.git "$src"
fi

cmake -S "$src" -B "$src/build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF \
  -DGGML_OPENMP=OFF \
  -DGGML_METAL=ON \
  -DGGML_METAL_EMBED_LIBRARY=ON \
  -DGGML_BLAS=ON \
  -DGGML_NATIVE=OFF \
  -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 \
  -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_BUILD_EXAMPLES=ON \
  -DWHISPER_SDL2=OFF >/dev/null
cmake --build "$src/build" -j "$(sysctl -n hw.ncpu)" --target whisper-cli whisper-server >/dev/null

rm -rf "$out"
mkdir -p "$out/licenses"
cp "$src/build/bin/whisper-cli" "$src/build/bin/whisper-server" "$out/"
cp "$src/LICENSE" "$out/licenses/whisper.cpp-LICENSE"
codesign --force --sign - "$out/whisper-cli" "$out/whisper-server"

# Self-contained: nothing may load from Homebrew or next to the binaries.
if otool -L "$out"/whisper-* | tail -n +2 | grep -vE "^\S|/System/Library/|/usr/lib/" | grep -q .; then
  echo "whisper.cpp links outside macOS:" >&2
  otool -L "$out"/whisper-* >&2
  exit 1
fi
echo "$out: whisper.cpp $VERSION, $(du -sh "$out" | cut -f1)"
