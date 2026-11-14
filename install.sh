#!/bin/sh
# Installs or updates Glance: downloads the latest release for this Mac's
# chip, checks it against the release's sha256, and copies Glance.app into
# /Applications (or $GLANCE_INSTALL_DIR).
#   curl -fsSL https://raw.githubusercontent.com/Jchinonso/glance/main/install.sh | sh
set -eu

# Everything runs inside main, called on the last line, so a download cut
# short runs nothing and no command can read the rest of the script as input.
main() {
  repo="Jchinonso/glance"
  dest="${GLANCE_INSTALL_DIR:-/Applications}"
  fail() { echo "Glance install: $1" >&2; exit 1; }

  [ "$(uname -s)" = "Darwin" ] || fail "Glance runs on macOS only."
  case "$(uname -m)" in
    arm64) arch=arm64 ;;
    x86_64) arch=x64 ;;
    *) fail "unsupported chip: $(uname -m)." ;;
  esac
  # An Intel build of the shell under Rosetta still means an Apple Silicon Mac.
  [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ] && arch=arm64

  os=$(sw_vers -productVersion)
  major=${os%%.*}
  rest=${os#*.}
  minor=${rest%%.*}
  [ "$minor" = "$os" ] && minor=0
  if [ "$major" -lt 14 ] || { [ "$major" -eq 14 ] && [ "$minor" -lt 2 ]; }; then
    fail "Glance needs macOS 14.2 or later. This Mac has $os."
  fi
  [ -d "$dest" ] || fail "$dest doesn't exist."
  [ -w "$dest" ] || fail "this account can't write to $dest. Run it from an administrator account, or pick a folder you own: mkdir -p ~/Applications, then add GLANCE_INSTALL_DIR=~/Applications before sh."

  work=$(mktemp -d)
  mount="$work/mount"
  cleanup() {
    hdiutil detach "$mount" -force >/dev/null 2>&1 || true
    rm -rf "$work"
  }
  trap cleanup EXIT

  echo "Finding the latest Glance…"
  code=$(curl -sSL -o "$work/release.json" -w '%{http_code}' -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$repo/releases/latest") || fail "couldn't reach GitHub. Check your connection."
  # GitHub allows 60 anonymous requests an hour from one network address.
  case "$code" in
    200) ;;
    403 | 429) fail "GitHub is limiting requests from this network right now. Try again in an hour, or download the DMG from https://github.com/$repo/releases/latest" ;;
    *) fail "GitHub answered with an error ($code). Try again later, or download the DMG from https://github.com/$repo/releases/latest" ;;
  esac
  version=$(sed -n 's/^ *"tag_name": *"v\{0,1\}\([0-9][0-9.]*\)".*/\1/p' "$work/release.json" | head -1)
  [ -n "$version" ] || fail "couldn't read the latest version."
  name="Glance-$version-$arch.dmg"
  # The asset's own sha256, which GitHub lists a few lines after its name.
  sum=$(awk -v name="$name" '
    index($0, "\"name\": \"" name "\"") { found = 1 }
    found && /"digest": *"sha256:/ { sub(/.*sha256:/, ""); sub(/".*/, ""); print; exit }
    found && /"browser_download_url"/ { exit }
  ' "$work/release.json")
  [ ${#sum} -eq 64 ] || fail "release $version has no $arch download yet."

  echo "Downloading Glance $version ($arch)…"
  curl -fL --progress-bar -o "$work/$name" "https://github.com/$repo/releases/download/v$version/$name" || fail "the download failed."
  [ "$(shasum -a 256 "$work/$name" | cut -d' ' -f1)" = "$sum" ] || fail "the download was corrupted. Run this again."

  echo "Installing to ${dest}…"
  mkdir "$mount"
  hdiutil attach "$work/$name" -nobrowse -readonly -noautoopen -mountpoint "$mount" >/dev/null
  [ -d "$mount/Glance.app" ] || fail "the download didn't contain Glance."
  osascript -e 'quit app id "com.glance.overlay"' >/dev/null 2>&1 || true
  # Give a running Glance a few seconds to finish quitting before replacing it.
  i=0
  while pgrep -x Glance >/dev/null 2>&1 && [ "$i" -lt 25 ]; do
    sleep 0.2
    i=$((i + 1))
  done
  # Copy the new app in beside the old one, then swap: the old app is only
  # removed once the new one is in place, and comes back if the swap fails.
  new="$dest/.Glance-install.app"
  old="$dest/.Glance-old.app"
  rm -rf "$new" "$old"
  ditto "$mount/Glance.app" "$new"
  xattr -dr com.apple.quarantine "$new" 2>/dev/null || true
  [ -d "$dest/Glance.app" ] && mv "$dest/Glance.app" "$old"
  if ! mv "$new" "$dest/Glance.app"; then
    [ -d "$old" ] && mv "$old" "$dest/Glance.app"
    rm -rf "$new"
    fail "couldn't put the new version in place. Your Glance is unchanged."
  fi
  rm -rf "$old"

  echo "Glance $version is installed. Opening it…"
  open "$dest/Glance.app"
}

main
