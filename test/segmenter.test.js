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

test("listener refuses to start without its tools, with one clear error", async () => {
  const { Listener } = await import("../src/audio.js");
  const l = new Listener({ modelPath: "/nonexistent/model.bin", whisperBinary: "whisper-cli-missing", soxBinary: "rec-missing" });
  const errors = [];
  l.on("error", (e) => errors.push(e));
  assert.equal(l.start(), false);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /brew install sox whisper-cpp/);
});

test("listener reports when capture dies on its own", async () => {
  const { Listener } = await import("../src/audio.js");
  const here = new URL("../package.json", import.meta.url).pathname; // any existing file stands in for the model
  const l = new Listener({ modelPath: here, whisperBinary: "/usr/bin/true", soxBinary: "/usr/bin/false", audioteePath: "/usr/bin/true" });
  const errors = [];
  l.on("error", (e) => errors.push(e));
  const ended = new Promise((resolve) => l.on("ended", resolve));
  assert.equal(l.start(), true);
  await ended;
  assert.ok(errors.some((e) => /Microphone capture stopped/.test(e)), errors.join(" | "));
  assert.equal(l.running, false);
});
