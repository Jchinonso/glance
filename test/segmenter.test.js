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
  const l = new Listener({ modelPath: "/nonexistent/model.bin", whisperBinary: "whisper-cli-missing" });
  const errors = [];
  l.on("error", (e) => errors.push(e));
  assert.equal(l.start(), false);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /brew install whisper-cpp/);
});

test("listener reports when capture dies on its own", async () => {
  const { Listener } = await import("../src/audio.js");
  const here = new URL("../package.json", import.meta.url).pathname; // any existing file stands in for the model
  const l = new Listener({ modelPath: here, whisperBinary: "/usr/bin/true", audioteePath: "/usr/bin/false" });
  const errors = [];
  l.on("error", (e) => errors.push(e));
  const ended = new Promise((resolve) => l.on("ended", resolve));
  assert.equal(l.start(), true);
  await ended;
  assert.ok(errors.some((e) => /System audio/.test(e)), errors.join(" | "));
  assert.equal(l.running, false);
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
  const here = new URL("../package.json", import.meta.url).pathname;
  const l = new Listener({ modelPath: here, whisperBinary: "/usr/bin/true", audioteePath: await fakeTee("/dev/zero"), silentAfterMs: 1500 });
  let silent = 0;
  l.on("silent", () => silent++);
  l.on("error", () => {});
  assert.equal(l.start(), true);
  await new Promise((r) => setTimeout(r, 2500));
  l.stop();
  assert.equal(silent, 1);
});

test("listener doesn't warn once real sound has arrived", async () => {
  const { Listener } = await import("../src/audio.js");
  const here = new URL("../package.json", import.meta.url).pathname;
  const l = new Listener({ modelPath: here, whisperBinary: "/usr/bin/true", audioteePath: await fakeTee("/dev/urandom"), silentAfterMs: 1500 });
  let silent = 0;
  l.on("silent", () => silent++);
  l.on("error", () => {});
  assert.equal(l.start(), true);
  await new Promise((r) => setTimeout(r, 2500));
  l.stop();
  assert.equal(silent, 0);
});
