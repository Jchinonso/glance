import { test } from "node:test";
import assert from "node:assert/strict";
import { Segmenter } from "../src/audio.js";

const RATE = 16000;
function pcm(seconds, amplitude) {
  const n = Math.round(seconds * RATE);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * 220 * i) / RATE)), i * 2);
  return buf;
}

test("cuts one segment around speech between silences", () => {
  const seg = new Segmenter();
  const out = [];
  seg.on("segment", (b) => out.push(b.length / 2 / RATE));
  seg.push(pcm(0.6, 30)); // quiet room
  seg.push(pcm(1.5, 8000)); // speech
  seg.push(pcm(1.2, 30)); // pause ends the segment
  assert.equal(out.length, 1);
  assert.ok(out[0] > 1.4 && out[0] < 2.6, `segment ${out[0]}s`);
});

test("ignores short blips", () => {
  const seg = new Segmenter();
  let count = 0;
  seg.on("segment", () => count++);
  seg.push(pcm(0.6, 30));
  seg.push(pcm(0.15, 8000));
  seg.push(pcm(1.2, 30));
  assert.equal(count, 0);
});

test("steady background noise is not mistaken for speech", () => {
  const seg = new Segmenter();
  let count = 0;
  seg.on("segment", () => count++);
  const noise = (seconds, amp) => {
    const n = Math.round(seconds * RATE);
    const b = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) b.writeInt16LE(Math.round((Math.random() * 2 - 1) * amp), i * 2);
    return b;
  };
  seg.push(noise(2, 30));
  seg.push(noise(60, 1500)); // a fan turns on
  const fromNoise = count;
  assert.ok(fromNoise <= 1, `${fromNoise} segments from noise`); // at most the moment it switched on
  // Speech over the louder room is still detected, as exactly one segment.
  seg.push(pcm(1.5, 12000));
  seg.push(noise(1.2, 1500));
  assert.equal(count, fromNoise + 1);
});

// A stand-in for audiotee that streams the given bytes, then waits.
async function fakeTee(source) {
  const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(new URL("file://" + tmpdir() + "/glance-tee-").pathname);
  const bin = `${dir}/audiotee`;
  writeFileSync(bin, `#!/bin/sh\nhead -c 64000 ${source}\nsleep 8\n`);
  chmodSync(bin, 0o755);
  return bin;
}


test("listener warns once when nothing but silence arrives (system audio blocked)", async () => {
  const { Listener } = await import("../src/audio.js");
    const l = new Listener({ asr: fakeAsr(), audioteePath: await fakeTee("/dev/zero"), silentAfterMs: 1500 });
  let silent = 0;
  l.on("silent", () => silent++);
  l.on("error", () => {});
  assert.equal(l.start(), true);
  await new Promise((r) => setTimeout(r, 2500));
  l.stop();
  assert.equal(silent, 1);
});

test("listener warns about silence only once per run, not on every Listen", async () => {
  const { Listener } = await import("../src/audio.js");
    const l = new Listener({ asr: fakeAsr(), audioteePath: await fakeTee("/dev/zero"), silentAfterMs: 800 });
  let silent = 0;
  l.on("silent", () => silent++);
  l.on("error", () => {});
  for (let i = 0; i < 2; i++) {
    assert.equal(l.start(), true);
    await new Promise((r) => setTimeout(r, 1300));
    l.stop();
  }
  assert.equal(silent, 1);
});

test("listener doesn't warn once real sound has arrived", async () => {
  const { Listener } = await import("../src/audio.js");
    const l = new Listener({ asr: fakeAsr(), audioteePath: await fakeTee("/dev/urandom"), silentAfterMs: 4000 });
  let silent = 0;
  l.on("silent", () => silent++);
  l.on("error", () => {});
  assert.equal(l.start(), true);
  // Long enough for the fake capture to start under a loaded test run; it
  // sends 2 s of sound at once and then nothing, so a warning would mean the
  // sound was ignored.
  await new Promise((r) => setTimeout(r, 5000));
  l.stop();
  assert.equal(silent, 0);
});

// A stand-in engine: answers each piece with the next of `texts` (an
// { error } entry fails that call), recording what it was asked.
function fakeAsr(texts = ["hello there"], delayMs = 0) {
  const asr = { calls: [], loads: [] };
  asr.load = async (opts) => (asr.loads.push(opts), true);
  asr.transcribe = async (pcm, opts) => {
    asr.calls.push({ bytes: pcm.length, ...opts });
    await new Promise((r) => setTimeout(r, delayMs));
    const next = texts.length > 1 ? texts.shift() : texts[0];
    return typeof next === "string" ? { text: next, ms: delayMs } : next;
  };
  return asr;
}

test("heard lines come from the engine, with timings and the hotwords", async () => {
  const { Listener } = await import("../src/audio.js");
  const asr = fakeAsr(["hello there"], 30);
  const l = new Listener({ asr, hotwords: ["Postgres"] });
  const lines = [];
  l.on("line", (line) => lines.push(line));
  l.enqueue(pcm(1, 8000));
  l.enqueue(pcm(1, 8000));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, "hello there");
  assert.equal(lines[0].via, "parakeet");
  assert.ok(lines[0].transcribeMs >= 25, `transcribeMs ${lines[0].transcribeMs}`);
  assert.equal(lines[0].decodeMs, 30);
  assert.ok(Number.isFinite(lines[0].transcribedAt));
  assert.equal(lines[0].queued, 1);
  assert.equal(lines[1].queued, 0);
  assert.equal(lines[0].at - lines[0].start, 1000);
  assert.deepEqual(asr.calls[0].hotwords, ["Postgres"]);
  assert.equal(asr.calls[0].bytes, RATE * 2);
  l.setHotwords(["Ledgerly"]);
  l.enqueue(pcm(1, 8000));
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(asr.calls.at(-1).hotwords, ["Ledgerly"]);
});

test("prepare loads the model with the hotwords before the first Listen", async () => {
  const { Listener } = await import("../src/audio.js");
  const asr = fakeAsr();
  const l = new Listener({ asr, hotwords: ["React"] });
  await l.prepare();
  assert.deepEqual(asr.loads, [{ hotwords: ["React"] }]);
});

test("noise the engine turns into text is dropped", async () => {
  const { Listener } = await import("../src/audio.js");
  const l = new Listener({ asr: fakeAsr(["  ", "(music)", "Thank you.", "Real words."]) });
  const lines = [];
  l.on("line", (line) => lines.push(line.text));
  for (let i = 0; i < 4; i++) l.enqueue(pcm(1, 8000));
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(lines, ["Real words."]);
});

test("a failed piece is tried once more; a broken engine gives one plain sentence per Listen", async () => {
  const { Listener } = await import("../src/audio.js");
  // First piece fails once then works; after that every call fails.
  const l = new Listener({ asr: fakeAsr([{ error: "speech engine stopped (SIGSEGV)" }, "back again", { error: "speech engine failed" }]) });
  const lines = [];
  const errors = [];
  const details = [];
  l.on("line", (line) => lines.push(line.text));
  l.on("error", (e) => errors.push(e));
  l.on("detail", (d) => details.push(d));
  l.enqueue(pcm(1, 8000));
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(lines, ["back again"]);
  assert.equal(errors.length, 0);
  l.enqueue(pcm(1, 8000));
  l.enqueue(pcm(1, 8000));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /can't transcribe on this Mac right now/);
  assert.ok(details.some((d) => /SIGSEGV/.test(d)), details.join(" | "));
});

test("listener refuses to start before the speech model is in, with one clear error", async () => {
  const { Listener } = await import("../src/audio.js");
  const l = new Listener({ asr: null });
  const errors = [];
  l.on("error", (e) => errors.push(e));
  assert.equal(l.start(), false);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /speech model is missing/);
});

test("listener with the real engine module and a stand-in model emits lines", async () => {
  const { Listener } = await import("../src/audio.js");
  const { Asr } = await import("../src/asr.js");
  const { mkdtempSync, copyFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const modelDir = mkdtempSync(`${tmpdir()}/glance-model-`);
  copyFileSync(new URL("./fixtures/parakeet-tokens.txt", import.meta.url), `${modelDir}/tokens.txt`);
  const asr = new Asr({ modelDir, env: { GLANCE_TEST_ASR: new URL("./fixtures/fake-asr.mjs", import.meta.url).pathname } });
  try {
    const l = new Listener({ asr, hotwords: ["Postgres"] });
    const got = new Promise((r) => l.once("line", r));
    l.enqueue(pcm(0.5, 8000));
    const line = await got;
    assert.equal(line.via, "parakeet");
    assert.match(line.text, /^heard 8000 samples hotwords=Postgres :1\.0 vocab from /);
  } finally {
    asr.stop();
  }
});

test("listener reports when capture dies on its own", async () => {
  const { Listener } = await import("../src/audio.js");
  const l = new Listener({ asr: fakeAsr(), audioteePath: "/usr/bin/false" });
  const errors = [];
  l.on("error", (e) => errors.push(e));
  const ended = new Promise((resolve) => l.on("ended", resolve));
  assert.equal(l.start(), true);
  await ended;
  assert.ok(errors.some((e) => /System audio/.test(e)), errors.join(" | "));
  assert.equal(l.running, false);
});
