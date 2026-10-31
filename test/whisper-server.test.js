import { test } from "node:test";
import assert from "node:assert/strict";
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

test("no restart after stop", async () => {
  const server = new WhisperServer("/usr/bin/false");
  server.start({ modelPath: "m", prompt: "" });
  server.stop();
  assert.equal(await server.transcribe(Buffer.alloc(0)), null);
  assert.equal(server.proc, null);
});
