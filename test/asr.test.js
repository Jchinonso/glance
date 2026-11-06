// The engine module (asr.js) in its own process, with a stand-in for
// sherpa-onnx (fixtures/fake-asr.mjs) so the real model is never loaded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { Asr } from "../src/asr.js";

const FAKE = new URL("./fixtures/fake-asr.mjs", import.meta.url).pathname;

function modelDir() {
  const dir = mkdtempSync(`${os.tmpdir()}/glance-asr-`);
  copyFileSync(new URL("./fixtures/parakeet-tokens.txt", import.meta.url), `${dir}/tokens.txt`);
  return dir;
}

const pcm = (samples) => Buffer.alloc(samples * 2, 1);

test("loads once, then transcribes with the hotwords", async () => {
  const dir = modelDir();
  const asr = new Asr({ modelDir: dir, env: { GLANCE_TEST_ASR: FAKE } });
  const states = [];
  asr.on("state", (s) => states.push(s));
  try {
    assert.equal(await asr.load({ hotwords: ["Postgres", "CI/CD"] }), true);
    assert.equal(asr.state, "ready");
    const r = await asr.transcribe(pcm(16000), { hotwords: ["Postgres", "CI/CD"] });
    assert.equal(r.text, `heard 16000 samples hotwords=Postgres :1.0 vocab from ${dir}`);
    assert.ok(Number.isFinite(r.ms));
    const none = await asr.transcribe(pcm(800), { hotwords: [] });
    assert.equal(none.text, `heard 800 samples from ${dir}`);
    assert.deepEqual(states, ["loading", "ready"]);
  } finally {
    asr.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transcribe loads the model itself when needed", async () => {
  const dir = modelDir();
  const asr = new Asr({ modelDir: dir, env: { GLANCE_TEST_ASR: FAKE, FAKE_ASR_TEXT: "Sure." } });
  try {
    assert.equal((await asr.transcribe(pcm(100))).text, "Sure.");
  } finally {
    asr.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a crash fails only the piece in flight; the engine restarts for the next", async () => {
  const dir = modelDir();
  const asr = new Asr({ modelDir: dir, env: { GLANCE_TEST_ASR: FAKE, FAKE_ASR_TEXT: "ok" } });
  const crashes = [];
  asr.on("crash", (r) => crashes.push(r));
  try {
    await asr.load();
    const inFlight = asr.transcribe(pcm(100));
    asr.child.kill("SIGKILL");
    assert.match((await inFlight).error ?? "", /stopped/);
    assert.equal(crashes.length, 1);
    assert.equal((await asr.transcribe(pcm(100))).text, "ok");
  } finally {
    asr.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a model that won't load is tried a few times, then the engine stays off", async () => {
  const dir = modelDir();
  const asr = new Asr({ modelDir: dir, env: { GLANCE_TEST_ASR: FAKE, FAKE_ASR_FAIL_LOAD: "1" } });
  const logs = [];
  asr.on("log", (l) => logs.push(l));
  try {
    for (let i = 0; i < 3; i++) assert.equal(await asr.load(), false);
    assert.equal(asr.state, "failed");
    assert.match((await asr.transcribe(pcm(100))).error, /failed/);
    assert.ok(logs.some((l) => /fake model failed to load/.test(l)), logs.join(" | "));
  } finally {
    asr.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
