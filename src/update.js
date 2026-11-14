import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

// Where releases live. They must be public: the check and the download are
// anonymous. If the source moves to a private repo, point this at a public
// repo that holds only the releases.
export const RELEASES_REPO = "Jchinonso/glance";
export const RELEASES_URL = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`;
export const BUNDLE_ID = "com.glance.overlay";

// An error whose message is written for the user.
export class UpdateError extends Error {}

const fromReleases = (url) => url.startsWith(`https://github.com/${RELEASES_REPO}/releases/download/`);
const parts = (v) => String(v).replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);

export function isNewer(latest, current) {
  const a = parts(latest);
  const b = parts(current);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

// The update in a GitHub release for this version and chip, or null. Only a
// DMG that GitHub lists with a sha256 digest counts: the download is checked
// against it before anything is installed.
export function pickUpdate(release, { current, arch, trusted = fromReleases }) {
  const version = String(release?.tag_name || "").replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(version) || release.draft || release.prerelease || !isNewer(version, current)) return null;
  const asset = release.assets?.find((a) => a.name === `Glance-${version}-${arch}.dmg`);
  const sha256 = /^sha256:([0-9a-f]{64})$/.exec(asset?.digest || "")?.[1];
  if (!asset || !sha256 || !(asset.size > 0) || !trusted(asset.browser_download_url)) return null;
  return { version, url: asset.browser_download_url, size: asset.size, sha256, page: `https://github.com/${RELEASES_REPO}/releases/tag/v${version}` };
}

export async function checkForUpdate({ current, arch, url = RELEASES_URL, trusted, fetchFn = fetch }) {
  const response = await fetchFn(url, { headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return pickUpdate(await response.json(), { current, arch, trusted });
}

// Downloads the update's DMG to file. Rejects, and deletes the file, unless
// its size and sha256 match what the release lists.
export async function downloadUpdate(update, { file, onProgress, idleMs = 30000, fetchFn = fetch }) {
  const controller = new AbortController();
  let timer;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), idleMs);
  };
  const hash = createHash("sha256");
  let received = 0;
  let handle;
  try {
    arm();
    const response = await fetchFn(update.url, { redirect: "follow", signal: controller.signal });
    if (!response.ok || !response.body) throw new UpdateError(`The update download failed (HTTP ${response.status}).`);
    handle = await open(file, "w");
    for await (const chunk of response.body) {
      arm();
      received += chunk.byteLength;
      if (received > update.size) break;
      await handle.write(chunk);
      hash.update(chunk);
      onProgress?.(received);
    }
  } catch (e) {
    await handle?.close().catch(() => {});
    rmSync(file, { force: true });
    if (e instanceof UpdateError) throw e;
    if (controller.signal.aborted) throw new UpdateError("The update download stalled. Check your connection.");
    if (e?.code === "ENOSPC") throw new UpdateError("Not enough disk space for the update.");
    throw new UpdateError("The update download failed. Check your connection.");
  } finally {
    clearTimeout(timer);
  }
  await handle.close();
  if (received !== update.size || hash.digest("hex") !== update.sha256) {
    rmSync(file, { force: true });
    throw new UpdateError("The update download was corrupted. Try again.");
  }
  return file;
}

// The Glance.app this process runs from, or null (npm run dev, for example).
export function appBundle(execPath) {
  const bundle = path.resolve(execPath, "..", "..", "..");
  return path.basename(bundle) === "Glance.app" ? bundle : null;
}

// Whether Glance can swap its own bundle: not from the mounted DMG, and not
// from the read-only copy macOS runs a never-moved download from.
export function canReplace(bundle) {
  if (bundle.includes("/AppTranslocation/")) return false;
  try {
    accessSync(bundle, constants.W_OK);
    accessSync(path.dirname(bundle), constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// What an interrupted update (or install.sh) can leave behind: the staged
// copy or the old app beside Glance.app, and the DMG in the temp folder.
// Only these names.
export function removeUpdateLeftovers({ bundle, temp }) {
  const places = [
    [path.dirname(bundle), /^(\.Glance-(\d+\.\d+\.\d+|install|old)\.app|Glance\.app\.old)$/],
    [temp, /^Glance-\d+\.\d+\.\d+-(arm64|x64)\.dmg$/],
  ];
  const removed = [];
  for (const [dir, pattern] of places) {
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {}
    for (const name of names.filter((n) => pattern.test(n))) removed.push(rm(path.join(dir, name), { recursive: true, force: true }).catch(() => {}));
  }
  return Promise.all(removed);
}

const exec = promisify(execFile);
const plist = async (app, key) => (await exec("/usr/bin/plutil", ["-extract", key, "raw", path.join(app, "Contents", "Info.plist")])).stdout.trim();

// Copies Glance.app out of the DMG to a hidden folder beside the installed
// app (same disk, so the swap is a rename). Refuses anything that isn't
// Glance at the expected version. Returns the copy's path.
export async function stageUpdate({ dmg, bundle, version }) {
  const mount = mkdtempSync(path.join(os.tmpdir(), "glance-update-"));
  const staged = path.join(path.dirname(bundle), `.Glance-${version}.app`);
  try {
    await exec("/usr/bin/hdiutil", ["attach", dmg, "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mount]);
    const source = path.join(mount, "Glance.app");
    if ((await plist(source, "CFBundleIdentifier")) !== BUNDLE_ID || (await plist(source, "CFBundleShortVersionString")) !== version) {
      throw new UpdateError("The update isn't the version it claims to be, so it wasn't installed.");
    }
    rmSync(staged, { recursive: true, force: true });
    await exec("/usr/bin/ditto", [source, staged]);
    await exec("/usr/bin/xattr", ["-dr", "com.apple.quarantine", staged]).catch(() => {});
    return staged;
  } catch (e) {
    rmSync(staged, { recursive: true, force: true });
    if (e?.code === "ENOSPC" || /No space left/i.test(e?.stderr || "")) throw new UpdateError("Not enough disk space for the update.");
    throw e;
  } finally {
    await exec("/usr/bin/hdiutil", ["detach", mount, "-force"]).catch(() => {});
    rmSync(mount, { recursive: true, force: true });
  }
}

// Run detached with (pid, installed app, staged app): waits for Glance to
// quit, swaps the bundles, and reopens. If the swap fails the old app is put
// back, and either way Glance opens again.
export const SWAP_SCRIPT = `
pid=$1; app=$2; new=$3; old="$app.old"
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 150 ]; then rm -rf "$new"; exit 1; fi
  sleep 0.2
done
rm -rf "$old"
if mv "$app" "$old"; then
  if mv "$new" "$app"; then rm -rf "$old"; else mv "$old" "$app"; rm -rf "$new"; fi
else
  rm -rf "$new"
fi
open "$app"
`;
