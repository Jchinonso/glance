// WhisperKit (whisperkit.js) and the Listener's use of it, against a fake
// glance-whisper (fixtures/fake-whisperkit.mjs) speaking the same protocol.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Listener } from "../src/audio.js";
import { kitDownloaded, kitSupported, WhisperKit } from "../src/whisperkit.js";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-whisperkit.mjs");
const RATE = 16000;
const pcm = (seconds) => {
  const n = Math.round(seconds * RATE);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / RATE)), i * 2);
  return buf;
};
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "glance-wk-"));

// The fake reads its behaviour from the environment it's spawned with.
function withMode(mode, fn) {
  return async () => {
    const before = process.env.FAKE_WK;
    process.env.FAKE_WK = mode;
    try {
      await fn();
    } finally {
      if (before === undefined) delete process.env.FAKE_WK;
      else process.env.FAKE_WK = before;
    }
  };
}

async function loadedKit(options = {}) {
  const kit = new WhisperKit({ binary: FAKE, modelsDir: tmp(), ...options });
  await kit.download();
  await kit.load();
  return kit;
}

function fakeCli(text) {
  const bin = path.join(tmp(), "whisper-cli");
  writeFileSync(bin, `#!/bin/sh\necho ${JSON.stringify(text)}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

const nextLine = (l) => new Promise((r) => l.once("line", r));

test("kitSupported needs the helper and macOS 14 (Darwin 23) or later", () => {
  assert.equal(kitSupported({ binary: FAKE, release: "23.0.0" }), true);
  assert.equal(kitSupported({ binary: FAKE, release: "25.6.0" }), true);
  assert.equal(kitSupported({ binary: FAKE, release: "22.6.0" }), false, "macOS 13");
  assert.equal(kitSupported({ binary: "/nonexistent/glance-whisper", release: "25.0.0" }), false);
  assert.equal(kitSupported({ binary: null, release: "25.0.0" }), false);
});

test("download reports progress, marks the model installed and is idempotent", withMode("ok", async () => {
  const dir = tmp();
  const kit = new WhisperKit({ binary: FAKE, modelsDir: dir });
  assert.equal(kitDownloaded(dir), false);
  const progress = [];
  await kit.download((p) => progress.push(p));
  assert.deepEqual(progress.map((p) => p.received), [0, 400, 1000]);
  assert.equal(progress[0].total, 1000);
  assert.equal(kitDownloaded(dir), true);
  const again = [];
  await kit.download((p) => again.push(p));
  assert.deepEqual(again, [], "already there: downloaded at once");
  const ready = [];
  kit.on("ready", (ms) => ready.push(ms));
  assert.deepEqual(await kit.load(), { loadMs: 20 });
  assert.equal(kit.state, "ready");
  assert.deepEqual(ready, [20]);
  kit.stop();
  assert.equal(kit.state, "idle");
}));

test("heard lines come from WhisperKit once it's loaded; its prompt is only the user's words", withMode("ok", async () => {
  const log = path.join(tmp(), "requests.log");
  process.env.FAKE_WK_LOG = log;
  try {
    const kit = await loadedKit();
    // whisper.cpp's prompt (the built-in tech terms) isn't sent to WhisperKit.
    const l = new Listener({ modelPath: "/nonexistent", whisperBinary: fakeCli("hello from cli"), prompt: "Terms: React, Postgres. Names and terms: Jane Doe, Kafka.", kitPrompt: "Jane Doe, Kafka", whisperkit: kit });
    l.server.transcribe = async () => assert.fail("whisper-server isn't used while WhisperKit works");
    const got = nextLine(l);
    l.enqueue(pcm(1));
    const line = await got;
    assert.equal(line.via, "whisperkit");
    assert.equal(line.text, "hello from whisperkit");
    assert.equal(line.role, "them");
    assert.ok(line.transcribeMs >= 0 && line.start < line.at);
    const sent = () => readFileSync(log, "utf8").trim().split("\n").map((s) => JSON.parse(s)).filter((r) => r.op === "transcribe");
    assert.equal(sent()[0].prompt, "Jane Doe, Kafka");
    assert.match(sent()[0].path, /\.wav$/);
    // No words of their own: no prompt at all.
    l.setTranscription({ modelPath: "/nonexistent", prompt: "Terms: React, Postgres.", kitPrompt: "" });
    const again = nextLine(l);
    l.enqueue(pcm(1));
    await again;
    assert.equal(sent()[1].prompt, "");
    kit.stop();
  } finally {
    delete process.env.FAKE_WK_LOG;
  }
}));

test("WhisperKit's hallucinations on noise are dropped like whisper.cpp's", withMode("ok", async () => {
  process.env.FAKE_WK_TEXT = "Thank you.";
  try {
    const kit = await loadedKit();
    const l = new Listener({ modelPath: "/nonexistent", whisperBinary: fakeCli("should not run"), whisperkit: kit });
    let lines = 0;
    l.on("line", () => lines++);
    l.enqueue(pcm(1));
    for (let i = 0; i < 50 && (l.working || l.pending.length); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(lines, 0);
    kit.stop();
  } finally {
    delete process.env.FAKE_WK_TEXT;
  }
}));

test("a helper error on a segment falls back to whisper.cpp for that segment", withMode("error", async () => {
  const kit = await loadedKit();
  const l = new Listener({ modelPath: "/nonexistent", whisperBinary: fakeCli("hello from cli"), whisperkit: kit });
  l.server.transcribe = async () => null;
  const details = [];
  l.on("detail", (d) => details.push(d));
  const got = nextLine(l);
  l.enqueue(pcm(1));
  const line = await got;
  assert.equal(line.via, "cli");
  assert.equal(line.text, "hello from cli");
  assert.match(details[0], /^whisperkit failed: decoding failed/);
  assert.equal(kit.state, "ready", "one bad segment doesn't turn it off");
  kit.stop();
}));

test("a helper that crashes 3 times is off for the session; whisper.cpp hears every segment", withMode("crash", async () => {
  const kit = await loadedKit();
  const l = new Listener({ modelPath: "/nonexistent", whisperBinary: fakeCli("hello from cli"), whisperkit: kit });
  l.server.transcribe = async () => null;
  const failed = [];
  const crashes = [];
  kit.on("failed", (reason) => failed.push(reason));
  kit.on("crash", (reason) => crashes.push(reason));
  const lines = [];
  l.on("line", (line) => lines.push(line));
  for (let i = 0; i < 5; i++) {
    // Wait for the restarted helper to load again, so each segment reaches it.
    if (kit.state !== "failed") await kit.waitReady(5000);
    const got = nextLine(l);
    l.enqueue(pcm(1));
    await got;
  }
  assert.equal(lines.length, 5, "no speech lost");
  assert.ok(lines.every((x) => x.via === "cli" && x.text === "hello from cli"));
  assert.equal(crashes.length, 3);
  assert.match(crashes[0], /SIGABRT/);
  assert.equal(failed.length, 1);
  assert.match(failed[0], /crashed 3 times/);
  assert.equal(kit.state, "failed");
  assert.equal(await kit.transcribe(pcm(1)), null);
}));

test("a failed load turns WhisperKit off for the session and says it was the load", withMode("loadfail", async () => {
  const kit = new WhisperKit({ binary: FAKE, modelsDir: tmp() });
  await kit.download();
  const failed = [];
  kit.on("failed", (reason, info) => failed.push({ reason, ...info }));
  await assert.rejects(kit.load(), /Core ML couldn't load the model/);
  assert.equal(kit.state, "failed");
  assert.deepEqual(failed, [{ reason: "load failed: Core ML couldn't load the model", loadFailed: true }]);
  await assert.rejects(kit.load(), /off for this session/);
}));

test("while WhisperKit loads, segments use whisper.cpp without waiting; once it's ready, it takes over mid-Listen", withMode("slowload", async () => {
  process.env.FAKE_WK_LOAD_MS = "800";
  try {
    const kit = new WhisperKit({ binary: FAKE, modelsDir: tmp() });
    await kit.download();
    const loading = kit.load();
    const model = new URL("../package.json", import.meta.url).pathname; // any file: the fake cli ignores it
    const l = new Listener({ modelPath: model, whisperBinary: fakeCli("hello from cli"), whisperkit: kit });
    l.server.transcribe = async () => null;
    const began = Date.now();
    let got = nextLine(l);
    l.enqueue(pcm(1));
    assert.equal((await got).via, "cli");
    assert.ok(Date.now() - began < 700, "not held up by the load");
    assert.equal(kit.state, "loading");
    await loading;
    got = nextLine(l);
    l.enqueue(pcm(1));
    const line = await got;
    assert.equal(line.via, "whisperkit");
    assert.equal(line.text, "hello from whisperkit");
    kit.stop();
  } finally {
    delete process.env.FAKE_WK_LOAD_MS;
  }
}));

test("a helper that can't start is a crash, not a hang", async () => {
  const kit = new WhisperKit({ binary: "/nonexistent/glance-whisper", modelsDir: tmp() });
  await assert.rejects(kit.download(), /helper stopped/);
  assert.equal(kit.crashes, 1);
});

test("a load that never finishes is stopped and counts as a failed load", withMode("slowload", async () => {
  const kit = new WhisperKit({ binary: FAKE, modelsDir: tmp(), loadTimeoutMs: 300 });
  await kit.download();
  const failed = [];
  kit.on("failed", (reason, info) => failed.push(info));
  await assert.rejects(kit.load(), /helper stopped/);
  assert.equal(kit.state, "failed");
  assert.deepEqual(failed, [{ loadFailed: true }]);
}));
