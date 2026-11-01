import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WhisperServer } from "../src/audio.js";

const until = async (check) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
};

test("a server that dies is restarted twice, then left to whisper-cli", async () => {
  const server = new WhisperServer("/usr/bin/false"); // exits at once, like a crash
  let spawned = 0;
  const start = server.start.bind(server);
  server.start = (...args) => (spawned++, start(...args));
  server.start({ modelPath: "m", prompt: "" });
  for (let i = 0; i < 4; i++) {
    await until(() => !server.proc);
    assert.equal(await server.transcribe(Buffer.alloc(0)), null);
  }
  assert.equal(spawned, 3); // first start + 2 restarts
  server.stop();
});

test("a server that is not ready yet makes transcribe return null without waiting", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "glance-"));
  const binary = path.join(dir, "slow-server");
  await writeFile(binary, "#!/bin/sh\nsleep 30\n");
  await chmod(binary, 0o755);
  const server = new WhisperServer(binary);
  try {
    server.start({ modelPath: "m", prompt: "" });
    const began = Date.now();
    assert.equal(await server.transcribe(Buffer.alloc(0)), null);
    assert.ok(Date.now() - began < 1000);
  } finally {
    server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("no restart after stop", async () => {
  const server = new WhisperServer("/usr/bin/false");
  server.start({ modelPath: "m", prompt: "" });
  server.stop();
  assert.equal(await server.transcribe(Buffer.alloc(0)), null);
  assert.equal(server.proc, null);
});
