// The real app (Electron, test mode) with its one speech engine: setup
// downloads the Parakeet model's files (small stand-ins served by a local
// server: GLANCE_MODELS_URL, GLANCE_TEST_MODEL_FILES), checks them, starts
// the engine (a stand-in for sherpa-onnx: GLANCE_TEST_ASR, so the real model
// is never loaded), and removes old whisper.cpp and WhisperKit models.
// Set GLANCE_SKIP_UI=1 to skip.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";
import { MODEL } from "../src/models.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const FAKE_ASR = path.join(here, "fixtures", "fake-asr.mjs");
const skip = !!process.env.GLANCE_SKIP_UI || process.platform !== "darwin";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dirs = [];

// Stand-ins for the model's four files: the real tokens.txt (the engine reads
// it for the hotwords) and small blobs for the rest.
const DATA = {
  "encoder.int8.onnx": Buffer.alloc(300_000, 1),
  "decoder.int8.onnx": Buffer.alloc(20_000, 2),
  "joiner.int8.onnx": Buffer.alloc(10_000, 3),
  "tokens.txt": readFileSync(path.join(here, "fixtures", "parakeet-tokens.txt")),
};
const FILES = MODEL.files.map(({ name }) => ({ name, size: DATA[name].length, sha256: createHash("sha256").update(DATA[name]).digest("hex") }));
const TOTAL = FILES.reduce((sum, f) => sum + f.size, 0);

// The model server. Every request is recorded; holdEncoder() keeps the
// encoder's download halfway until releaseEncoder(); failing makes every
// request answer HTTP 500.
const served = [];
let held = null;
let failing = false;
const server = http.createServer(async (req, res) => {
  const name = path.basename(req.url);
  served.push(name);
  if (failing) return res.writeHead(500).end();
  const data = DATA[name];
  if (!data) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(data.length) });
  const half = Math.floor(data.length / 2);
  if (name === "encoder.int8.onnx" && held) {
    // Progress goes out at most every 250 ms: the last byte of the first half
    // comes later, so the window sees it.
    res.write(data.subarray(0, half - 1));
    await sleep(400);
    res.write(data.subarray(half - 1, half));
    await held.promise;
  } else res.write(data.subarray(0, half));
  res.end(data.subarray(half));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const MODELS_URL = `http://127.0.0.1:${server.address().port}`;
function holdEncoder() {
  let release;
  const promise = new Promise((r) => (release = r));
  held = { promise, release };
}
function releaseEncoder() {
  held?.release();
  held = null;
}

after(() => {
  releaseEncoder();
  server.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function newDir(extra = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "glance-uisp-"));
  dirs.push(dir);
  writeFileSync(path.join(dir, "config.json"), JSON.stringify({ provider: "openai", openaiBaseUrl: "http://127.0.0.1:9/v1", openaiModel: "fake", onboarded: true, style: "brief", autoScreen: false, ...extra }));
  return dir;
}

const readLog = (dir) => (existsSync(path.join(dir, "logs", "glance.log")) ? readFileSync(path.join(dir, "logs", "glance.log"), "utf8") : "");
const modelDir = (dir) => path.join(dir, "models", MODEL.dir);

// What an older Glance left in its models folder.
function oldModels(dir) {
  const models = path.join(dir, "models");
  mkdirSync(path.join(models, "whisperkit", "openai_whisper-large-v3-v20240930_turbo"), { recursive: true });
  writeFileSync(path.join(models, "whisperkit", "openai_whisper-large-v3-v20240930_turbo", "AudioEncoder.bin"), Buffer.alloc(400_000));
  writeFileSync(path.join(models, "ggml-small.en.bin"), Buffer.alloc(300_000));
  writeFileSync(path.join(models, "ggml-base.en.bin"), Buffer.alloc(200_000));
  writeFileSync(path.join(models, "ggml-large-v3-turbo-q5_0.bin.part"), Buffer.alloc(100_000));
}

async function waitFor(check, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await check();
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${check}`);
}

// Starts Glance; resolves with { run, quit } once its window answers.
async function launch(dir, env = {}) {
  const port = 9800 + Math.floor(Math.random() * 90);
  const app = spawn(electronPath, [root, `--remote-debugging-port=${port}`], {
    env: { ...process.env, GLANCE_TEST_DIR: dir, GLANCE_MODELS_URL: MODELS_URL, GLANCE_TEST_MODEL_FILES: JSON.stringify(FILES), GLANCE_TEST_ASR: FAKE_ASR, ...env },
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
  for (let i = 0; i < 100 && !(await run(`return typeof state !== "undefined" && !!state?.shortcuts;`)); i++) await sleep(50);
  const quit = async () => {
    releaseEncoder();
    ws.close();
    if (app.exitCode === null) await new Promise((r) => (app.once("exit", r), app.kill()));
  };
  return { run, quit };
}

const mainState = (run) => run(`return await g.getState();`);
async function waitState(run, check, ms = 15000) {
  const end = Date.now() + ms;
  let s;
  while (Date.now() < end) {
    s = await mainState(run);
    if (check(s)) return s;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${check}: ${JSON.stringify(s?.speech)}`);
}
// Settings › General › Speech as shown.
async function settings(run) {
  await run(`state = await g.getState(); render();`);
  return run(`return {
    hint: document.getElementById("speechHint").textContent,
    status: document.getElementById("speechStatus").hidden ? null : document.getElementById("speechStatusText").textContent,
    retry: !document.getElementById("speechRetry").hidden,
  };`);
}

test("a Mac upgrading from an older Glance: setup reopens at the speech step, downloads Parakeet, starts it, and removes the old models", { skip }, async () => {
  const dir = newDir({ transcription: "fast", whisperMode: "cpu", turboOk: true, whisperkitEnabled: true });
  oldModels(dir);
  served.length = 0;
  holdEncoder();
  const { run, quit } = await launch(dir);
  try {
    let s = await waitState(run, (x) => x.speech.status === "downloading" && x.speech.received >= DATA["encoder.int8.onnx"].length / 2);
    assert.equal(s.speech.total, TOTAL);
    assert.deepEqual(served, ["encoder.int8.onnx"]);
    // Setup is back, at the speech step, with progress.
    await waitFor(() => run(`return onboarding?.step === "speech";`));
    assert.match(await run(`return document.getElementById("obSpeechMeta").textContent;`), /^0 of 0 MB$/); // stand-in files are tiny
    assert.ok(await run(`return document.getElementById("obNext").disabled;`));
    // Settings says so too.
    const shown = await settings(run);
    assert.equal(shown.hint, "Parakeet (on this Mac)");
    assert.match(shown.status, /^Downloading the speech model: \d+%$/);
    // The old models stay until Parakeet is in.
    assert.ok(existsSync(path.join(dir, "models", "ggml-small.en.bin")));
    releaseEncoder();
    s = await waitState(run, (x) => x.speech.status === "ready" && x.speech.engine === "ready");
    assert.deepEqual(served, MODEL.files.map((f) => f.name));
    for (const f of FILES) assert.deepEqual(readFileSync(path.join(modelDir(dir), f.name)), DATA[f.name]);
    // Setup closes by itself for a returning user.
    await waitFor(() => run(`return onboarding === null;`));
    assert.deepEqual(await settings(run), { hint: "Parakeet (on this Mac)", status: null, retry: false });
    // Old models gone, everything else kept.
    assert.deepEqual(readFileSync(path.join(dir, "models", MODEL.dir, "tokens.txt")), DATA["tokens.txt"]);
    for (const old of ["ggml-small.en.bin", "ggml-base.en.bin", "ggml-large-v3-turbo-q5_0.bin.part", "whisperkit"]) assert.ok(!existsSync(path.join(dir, "models", old)), `${old} removed`);
    const log = readLog(dir);
    assert.match(log, /speech model download finish/);
    assert.match(log, /old speech models removed: .*ggml-small\.en\.bin.*whisperkit.* \(1 MB freed\)/);
    assert.match(log, /engine=parakeet loaded loadMs=\d+ hotwords=\d+/);
    assert.doesNotMatch(log, /whisper-server|whisper-cli|engine=whisper/);
  } finally {
    await quit();
  }
});

test("a model already in place is checked, not downloaded, and the engine loads at launch", { skip }, async () => {
  const dir = newDir();
  mkdirSync(modelDir(dir), { recursive: true });
  for (const f of FILES) writeFileSync(path.join(modelDir(dir), f.name), DATA[f.name]);
  served.length = 0;
  const { run, quit } = await launch(dir);
  try {
    await waitState(run, (x) => x.speech.status === "ready" && x.speech.engine === "ready");
    assert.deepEqual(served, []);
    assert.equal(await run(`return onboarding;`), null);
    assert.match(readLog(dir), /speech model ok: parakeet-tdt-0\.6b-v2-int8/);
    assert.ok(existsSync(path.join(modelDir(dir), ".verified.json")));
    // Words to recognize are saved (Listener tests cover them reaching the engine).
    await run(`await g.setSetting("vocabulary", "Ledgerly, Priya");`);
    assert.equal(await run(`return (await g.getState()).vocabulary;`), "Ledgerly, Priya");
  } finally {
    await quit();
  }
});

test("a file that fails its checksum is downloaded again", { skip }, async () => {
  const dir = newDir();
  mkdirSync(modelDir(dir), { recursive: true });
  for (const f of FILES) writeFileSync(path.join(modelDir(dir), f.name), DATA[f.name]);
  writeFileSync(path.join(modelDir(dir), "joiner.int8.onnx"), Buffer.alloc(DATA["joiner.int8.onnx"].length, 9));
  served.length = 0;
  const { run, quit } = await launch(dir);
  try {
    await waitState(run, (x) => x.speech.status === "ready" && x.speech.engine === "ready");
    assert.deepEqual(served, ["joiner.int8.onnx"]);
    assert.deepEqual(readFileSync(path.join(modelDir(dir), "joiner.int8.onnx")), DATA["joiner.int8.onnx"]);
  } finally {
    await quit();
  }
});

test("a failed download shows the reason and Try again, which finishes it", { skip }, async () => {
  const dir = newDir({ onboarded: false });
  failing = true;
  const { run, quit } = await launch(dir);
  try {
    // Gives up after the automatic retries (2 + 5 + 15 s); then Try again.
    const s = await waitState(run, (x) => x.speech.status === "error", 40000);
    assert.equal(s.speech.error, "The speech model download failed (HTTP 500).");
    assert.deepEqual(await settings(run), { hint: "Parakeet (on this Mac)", status: "The speech model download failed (HTTP 500).", retry: true });
    await sleep(500);
    assert.equal((await mainState(run)).speech.status, "error", "no more automatic attempts");
    failing = false;
    await run(`document.getElementById("speechRetry").click();`);
    await waitState(run, (x) => x.speech.status === "ready" && x.speech.engine === "ready");
    assert.deepEqual(await settings(run), { hint: "Parakeet (on this Mac)", status: null, retry: false });
  } finally {
    failing = false;
    await quit();
  }
});
