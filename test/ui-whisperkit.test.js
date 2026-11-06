// The real app (Electron, test mode) choosing its speech engine, with a fake
// glance-whisper (fixtures/fake-whisperkit.mjs) given in GLANCE_WHISPERKIT_BIN.
// No real model is downloaded and the real helper never runs. Set
// GLANCE_SKIP_UI=1 to skip.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";
import { MODELS } from "../src/models.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const FAKE = path.join(here, "fixtures", "fake-whisperkit.mjs");
const skip = !!process.env.GLANCE_SKIP_UI || process.platform !== "darwin" || parseInt(os.release(), 10) < 23;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dirs = [];

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function newDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "glance-uiwk-"));
  dirs.push(dir);
  // Set up already, so only the speech engine is under test. Downloads of
  // whisper.cpp's model go to a closed port and fail at once.
  writeFileSync(path.join(dir, "config.json"), JSON.stringify({ provider: "openai", openaiBaseUrl: "http://127.0.0.1:9/v1", openaiModel: "fake", onboarded: true, style: "brief", autoScreen: false }));
  return dir;
}

const readLog = (dir) => (existsSync(path.join(dir, "logs", "glance.log")) ? readFileSync(path.join(dir, "logs", "glance.log"), "utf8") : "");
const readConfig = (dir) => JSON.parse(readFileSync(path.join(dir, "config.json"), "utf8"));

async function waitFor(check, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = check();
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${check}`);
}

// Starts Glance; resolves with { app, run, quit } once its window answers.
async function launch(dir, env) {
  const port = 9900 + Math.floor(Math.random() * 90);
  const app = spawn(electronPath, [root, `--remote-debugging-port=${port}`], {
    env: { ...process.env, GLANCE_TEST_DIR: dir, GLANCE_WHISPERKIT_BIN: FAKE, GLANCE_MODELS_URL: "http://127.0.0.1:9", ...env },
    stdio: "ignore",
  });
  let page;
  for (let i = 0; i < 150 && !page; i++) {
    await sleep(100);
    try {
      page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page");
    } catch {}
  }
  assert.ok(page, "Glance's window never appeared");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const waiting = new Map();
  let nextId = 0;
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    waiting.get(d.id)?.(d);
  };
  await new Promise((r) => (ws.onopen = r));
  const run = async (expression) => {
    const id = ++nextId;
    const r = await new Promise((resolve) => {
      waiting.set(id, resolve);
      ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true } }));
    });
    return r.result?.result?.value;
  };
  // The page has loaded its script and state.
  for (let i = 0; i < 100 && !(await run(`return typeof state !== "undefined" && !!state?.shortcuts;`)); i++) await sleep(50);
  const quit = async () => {
    ws.close();
    if (app.exitCode === null) await new Promise((r) => (app.once("exit", r), app.kill()));
  };
  return { app, run, quit };
}

// Fresh state from the main process, not the window's copy.
const mainState = (run) => run(`return await g.getState();`);

// A whisper.cpp model "installed" in dir: findModel only checks the size.
function installModel(dir, name) {
  mkdirSync(path.join(dir, "models"), { recursive: true });
  const file = path.join(dir, "models", MODELS[name].file);
  writeFileSync(file, "");
  truncateSync(file, MODELS[name].size);
}

// WhisperKit's model already downloaded (the files the fake helper checks).
function installKitModel(dir) {
  const models = path.join(dir, "models", "whisperkit", "models");
  const variant = path.join(models, "argmaxinc", "whisperkit-coreml", "openai_whisper-large-v3-v20240930_turbo_632MB");
  mkdirSync(variant, { recursive: true });
  mkdirSync(path.join(models, "openai", "whisper-large-v3"), { recursive: true });
  writeFileSync(path.join(variant, ".glance-complete"), "");
  writeFileSync(path.join(models, "openai", "whisper-large-v3", "tokenizer.json"), "{}");
}

async function waitState(run, check, ms = 15000) {
  const end = Date.now() + ms;
  let s;
  while (Date.now() < end) {
    s = await mainState(run);
    if (check(s)) return s;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${check}: ${JSON.stringify(s?.speech)} ${JSON.stringify(s?.speechEngine)}`);
}

test("a new user on a Mac that can run WhisperKit: setup gets base.en only, then WhisperKit downloads and prepares in the background and takes over", { skip }, async () => {
  const dir = newDir();
  const { run, quit } = await launch(dir, { FAKE_WK: "slowload", FAKE_WK_LOAD_MS: "4000" });
  try {
    // Setup's speech step: the starter model only (its download fails here: closed port).
    await waitFor(() => /speech model download error: base\.en/.test(readLog(dir)));
    let s = await mainState(run);
    assert.equal(s.speech.model, "base.en");
    assert.notEqual(s.speech.status, "ready");
    assert.equal(s.speechEngine.upgrade, null, "the upgrade waits for the starter model");
    assert.doesNotMatch(readLog(dir), /whisperkit download start|small\.en/);
    // The starter arrives: Listen works with whisper.cpp at once, and the
    // upgrade starts by itself in the background.
    installModel(dir, "base.en");
    s = await waitState(run, (x) => x.speech.status === "ready");
    assert.equal(s.speech.model, "base.en");
    await waitFor(() => /whisperkit download finish/.test(readLog(dir)));
    s = await waitState(run, (x) => x.speechEngine.upgrade?.status === "preparing");
    assert.equal(s.speech.status, "ready", "nothing in setup waits for it");
    assert.equal(s.speechEngine.active, "whisper.cpp");
    assert.equal(s.speechEngine.upgrade.to, "whisperkit");
    assert.match(readLog(dir), /whisperkit load start \(first on this Mac\)/);
    // Shown in Settings > General > Transcription only.
    await run(`state = await g.getState(); render();`);
    assert.equal(await run(`return document.getElementById("upgradeText").textContent;`), "Upgrading to Whisper large-v3 turbo: preparing for this Mac (one time, can take up to 20 minutes)");
    assert.equal(await run(`return document.getElementById("upgradeStatus").hidden;`), false);
    // Loaded: WhisperKit is the engine.
    await waitFor(() => /whisperkit ready loadMs=\d+/.test(readLog(dir)));
    s = await waitState(run, (x) => x.speechEngine.active === "whisperkit");
    assert.equal(s.speechEngine.upgrade.status, "ready");
    assert.match(readLog(dir), /engine=whisperkit/);
    assert.equal(readConfig(dir).whisperkitLoaded, true);
    await run(`state = await g.getState(); render();`);
    assert.equal(await run(`return document.getElementById("transcriptionHint").textContent;`), "Whisper large-v3 turbo (Neural Engine)");
    assert.equal(await run(`return document.getElementById("upgradeStatus").hidden;`), true);
    assert.ok(!existsSync(path.join(dir, "models", "ggml-small.en.bin.part")), "small.en isn't downloaded on this path");
  } finally {
    await quit();
  }
  // Next launch: a plain load (no preparing), whisper.cpp until it's done.
  const again = await launch(dir, { FAKE_WK: "slowload", FAKE_WK_LOAD_MS: "6000" });
  try {
    const s = await mainState(again.run);
    assert.equal(s.speech.status, "ready");
    assert.equal(s.speechEngine.upgrade?.status, "loading");
    await waitFor(() => readLog(dir).match(/whisperkit ready/g)?.length === 2);
    assert.equal((await waitState(again.run, (x) => x.speechEngine.active === "whisperkit")).speechEngine.upgrade.status, "ready");
  } finally {
    await again.quit();
  }
});

test("a Mac where WhisperKit fails to load: whisper.cpp with small.en in the background, off after two failed launches, back with a new version", { skip }, async () => {
  const dir = newDir();
  installModel(dir, "base.en");
  installKitModel(dir);

  const first = await launch(dir, { FAKE_WK: "loadfail" });
  try {
    await waitFor(() => /whisperkit failed: load failed/.test(readLog(dir)));
    const s = await waitState(first.run, (x) => x.speechEngine.upgrade?.to === "small.en");
    assert.equal(s.speechEngine.active, "whisper.cpp");
    assert.equal(s.speech.status, "ready");
    assert.equal(s.speech.model, "base.en");
    assert.doesNotMatch(JSON.stringify(s.speechEngine), /Core ML/, "nothing technical in the window");
    await waitFor(() => /speech model download start: small\.en \(background/.test(readLog(dir)));
    assert.match(readLog(dir), /engine=whisper\.cpp/);
    assert.equal(readConfig(dir).whisperkitLoadFailures, 1);
    assert.ok(!readConfig(dir).whisperkitBroken, "one failure doesn't turn it off for good");
  } finally {
    await first.quit();
  }

  const second = await launch(dir, { FAKE_WK: "loadfail" });
  try {
    await waitFor(() => readLog(dir).match(/whisperkit failed: load failed/g)?.length === 2);
    await waitFor(() => readConfig(dir).whisperkitBroken === true);
    assert.equal(readConfig(dir).whisperkitBrokenVersion, JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version);
  } finally {
    await second.quit();
  }

  // Off: not even started.
  const third = await launch(dir, { FAKE_WK: "ok" });
  try {
    await waitFor(() => /whisperkit usable=false \(off after failed loads\)/.test(readLog(dir)));
    assert.equal((await waitState(third.run, (x) => !!x.speechEngine.upgrade)).speechEngine.upgrade.to, "small.en");
  } finally {
    await third.quit();
  }

  // A different version of Glance tries again.
  writeFileSync(path.join(dir, "config.json"), JSON.stringify({ ...readConfig(dir), whisperkitBrokenVersion: "0.0.1" }));
  const fourth = await launch(dir, { FAKE_WK: "ok" });
  try {
    await waitFor(() => /whisperkit ready/.test(readLog(dir)));
    assert.equal((await waitState(fourth.run, (x) => x.speechEngine.active === "whisperkit")).speechEngine.active, "whisperkit");
    await waitFor(() => readConfig(dir).whisperkitBroken !== true);
  } finally {
    await fourth.quit();
  }
});

test("a Mac that can't run WhisperKit: base.en from setup, small.en in the background, used once it's in", { skip }, async () => {
  const dir = newDir();
  installModel(dir, "base.en");
  // No helper (as on macOS 13 or older).
  const first = await launch(dir, { GLANCE_WHISPERKIT_BIN: "" });
  try {
    await waitFor(() => /whisperkit usable=false/.test(readLog(dir)));
    const s = await waitState(first.run, (x) => x.speechEngine.upgrade?.to === "small.en");
    assert.equal(s.speech.status, "ready", "Listen works meanwhile");
    assert.equal(s.speech.model, "base.en");
    assert.equal(s.speechEngine.active, "whisper.cpp");
    await waitFor(() => /speech model download start: small\.en \(background/.test(readLog(dir)));
    await run_(first.run);
  } finally {
    await first.quit();
  }
  // Downloaded: whisper.cpp uses it, nothing more to do.
  installModel(dir, "small.en");
  const second = await launch(dir, { GLANCE_WHISPERKIT_BIN: "" });
  try {
    const s = await mainState(second.run);
    assert.equal(s.speech.model, "small.en");
    assert.equal(s.speechEngine.upgrade, null);
    assert.equal(readLog(dir).match(/download start: small\.en \(background/g).length, 1, "not downloaded again");
  } finally {
    await second.quit();
  }
});

// Settings on that Mac: the upgrade's progress, and Fast/Accurate stays.
async function run_(run) {
  await run(`state = await g.getState(); render();`);
  assert.equal(await run(`return document.getElementById("transcription").hidden;`), false);
  assert.equal(await run(`return document.getElementById("upgradeStatus").hidden;`), false);
  assert.match(await run(`return document.getElementById("upgradeText").textContent;`), /^(Upgrading to the Accurate model: downloading \d+%|The speech model download failed\. Check your connection\.)$/);
}
