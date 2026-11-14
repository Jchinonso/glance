import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { appBundle, canReplace, checkForUpdate, downloadUpdate, isNewer, pickUpdate, removeUpdateLeftovers, SWAP_SCRIPT, UpdateError } from "../src/update.js";

const sha = (data) => createHash("sha256").update(data).digest("hex");
const base = "https://github.com/Jchinonso/glance/releases/download";
const release = (version, assets) => ({ tag_name: `v${version}`, html_url: "https://example.com/elsewhere", assets });
const dmg = (version, arch, extra = {}) => ({ name: `Glance-${version}-${arch}.dmg`, size: 10, digest: `sha256:${"a".repeat(64)}`, browser_download_url: `${base}/v${version}/Glance-${version}-${arch}.dmg`, ...extra });

test("isNewer compares versions by number, not as text", () => {
  assert.equal(isNewer("1.10.0", "1.9.9"), true);
  assert.equal(isNewer("v1.6.3", "1.6.2"), true);
  assert.equal(isNewer("1.6.2", "1.6.2"), false);
  assert.equal(isNewer("1.6.1", "1.6.2"), false);
});

test("pickUpdate: the DMG for this chip, only when newer, checksummed and from the releases", () => {
  const r = release("1.7.0", [dmg("1.7.0", "arm64"), dmg("1.7.0", "x64")]);
  assert.deepEqual(pickUpdate(r, { current: "1.6.2", arch: "x64" }), { version: "1.7.0", url: `${base}/v1.7.0/Glance-1.7.0-x64.dmg`, size: 10, sha256: "a".repeat(64), page: "https://github.com/Jchinonso/glance/releases/tag/v1.7.0" });
  assert.equal(pickUpdate(r, { current: "1.7.0", arch: "x64" }), null, "already current");
  assert.equal(pickUpdate(release("1.7.0", [dmg("1.7.0", "arm64")]), { current: "1.6.2", arch: "x64" }), null, "no DMG for this chip");
  assert.equal(pickUpdate(release("1.7.0", [dmg("1.7.0", "x64", { digest: null })]), { current: "1.6.2", arch: "x64" }), null, "no checksum");
  assert.equal(pickUpdate(release("1.7.0", [dmg("1.7.0", "x64", { browser_download_url: "https://example.com/Glance-1.7.0-x64.dmg" })]), { current: "1.6.2", arch: "x64" }), null, "another host");
  assert.equal(pickUpdate({ ...r, prerelease: true }, { current: "1.6.2", arch: "x64" }), null, "prerelease");
  assert.equal(pickUpdate({ tag_name: "nightly", assets: [] }, { current: "1.6.2", arch: "x64" }), null, "not a version");
});

test("checkForUpdate reads the latest release; a failed request throws", async () => {
  const r = release("1.7.0", [dmg("1.7.0", "arm64")]);
  const found = await checkForUpdate({ current: "1.6.2", arch: "arm64", fetchFn: async () => ({ ok: true, json: async () => r }) });
  assert.equal(found.version, "1.7.0");
  await assert.rejects(checkForUpdate({ current: "1.6.2", arch: "arm64", fetchFn: async () => ({ ok: false, status: 404 }) }), /HTTP 404/);
});

test("downloadUpdate keeps a file that matches its checksum and deletes one that doesn't", async () => {
  const data = Buffer.alloc(300_000, 7);
  const server = http.createServer((_req, res) => res.end(data));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(path.join(os.tmpdir(), "glance-update-test-"));
  const file = path.join(dir, "update.dmg");
  const url = `http://127.0.0.1:${server.address().port}/update.dmg`;
  try {
    const seen = [];
    await downloadUpdate({ url, size: data.length, sha256: sha(data) }, { file, onProgress: (n) => seen.push(n) });
    assert.equal(sha(readFileSync(file)), sha(data));
    assert.equal(seen.at(-1), data.length);
    await assert.rejects(downloadUpdate({ url, size: data.length, sha256: "b".repeat(64) }, { file }), /corrupted/);
    assert.equal(existsSync(file), false, "a bad download is deleted");
    await assert.rejects(downloadUpdate({ url, size: data.length - 1, sha256: sha(data) }, { file }), /corrupted/);
    assert.equal(existsSync(file), false);
    // Failures the user sees are worded for them, never a raw system error.
    server.close();
    await assert.rejects(downloadUpdate({ url, size: data.length, sha256: sha(data) }, { file }), (e) => e instanceof UpdateError && /download failed\. Check your connection/.test(e.message));
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appBundle and canReplace: only a Glance.app Glance can write to", () => {
  assert.equal(appBundle("/Applications/Glance.app/Contents/MacOS/Glance"), "/Applications/Glance.app");
  assert.equal(appBundle("/x/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"), null);
  const dir = mkdtempSync(path.join(os.tmpdir(), "glance-update-test-"));
  try {
    const bundle = path.join(dir, "Glance.app");
    mkdirSync(bundle);
    assert.equal(canReplace(bundle), true);
    assert.equal(canReplace("/private/var/folders/x/AppTranslocation/ABC/d/Glance.app"), false);
    assert.equal(canReplace(path.join(dir, "missing", "Glance.app")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the swap script waits for Glance to quit, then replaces the app", { skip: process.platform !== "darwin" }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "glance-update-test-"));
  try {
    const bundle = path.join(dir, "Glance.app");
    const staged = path.join(dir, ".Glance-9.9.9.app");
    mkdirSync(bundle);
    mkdirSync(staged);
    writeFileSync(path.join(bundle, "version"), "old");
    writeFileSync(path.join(staged, "version"), "new");
    // `open` on these stand-in folders fails, which the script ignores.
    const running = spawn("/bin/sleep", ["1"]);
    const started = Date.now();
    await new Promise((done) => spawn("/bin/sh", ["-c", SWAP_SCRIPT, "sh", String(running.pid), bundle, staged], { stdio: "ignore" }).on("exit", done));
    assert.ok(Date.now() - started >= 700, "waited for the process to exit");
    assert.equal(readFileSync(path.join(bundle, "version"), "utf8"), "new");
    assert.equal(existsSync(staged), false);
    assert.equal(existsSync(`${bundle}.old`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the swap script puts the old app back when the new one can't be moved in", { skip: process.platform !== "darwin" }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "glance-update-test-"));
  try {
    const bundle = path.join(dir, "Glance.app");
    mkdirSync(bundle);
    writeFileSync(path.join(bundle, "version"), "old");
    // The staged copy is missing, so moving it in fails.
    await new Promise((done) => spawn("/bin/sh", ["-c", SWAP_SCRIPT, "sh", "999999", bundle, path.join(dir, ".Glance-9.9.9.app")], { stdio: "ignore" }).on("exit", done));
    assert.equal(readFileSync(path.join(bundle, "version"), "utf8"), "old");
    assert.equal(existsSync(`${bundle}.old`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeUpdateLeftovers deletes only what an interrupted update leaves", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "glance-update-test-"));
  try {
    const apps = path.join(dir, "Applications");
    const temp = path.join(dir, "temp");
    for (const d of ["Glance.app", ".Glance-1.7.0.app", ".Glance-install.app", ".Glance-old.app", "Glance.app.old", "Other.app", ".Glance-notes.app"]) mkdirSync(path.join(apps, d), { recursive: true });
    mkdirSync(temp);
    for (const f of ["Glance-1.7.0-arm64.dmg", "Glance-1.7.0-x64.dmg", "Glance-notes.dmg", "keep.txt"]) writeFileSync(path.join(temp, f), "x");
    await removeUpdateLeftovers({ bundle: path.join(apps, "Glance.app"), temp });
    assert.deepEqual(readdirSync(apps).sort(), [".Glance-notes.app", "Glance.app", "Other.app"]);
    assert.deepEqual(readdirSync(temp).sort(), ["Glance-notes.dmg", "keep.txt"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
