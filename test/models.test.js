import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { downloadModel, findModel, MODELS } from "../src/models.js";

const DATA = Buffer.alloc(200_000, 7);
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

function model(overrides = {}) {
  return { "test.en": { file: "ggml-test.en.bin", size: DATA.length, sha256: sha256(DATA), ...overrides } };
}

async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { server, url, close: () => new Promise((resolve) => server.close(resolve)) };
}

function rangeFrom(req) {
  const match = /^bytes=(\d+)-/.exec(req.headers.range || "");
  return match ? Number(match[1]) : 0;
}

function sendRange(req, res, data) {
  const start = rangeFrom(req);
  res.writeHead(start ? 206 : 200, {
    "content-type": "application/octet-stream",
    "accept-ranges": "bytes",
    "content-length": String(data.length - start),
    ...(start ? { "content-range": `bytes ${start}-${data.length - 1}/${data.length}` } : {}),
  });
  res.end(data.subarray(start));
}

test("downloads, verifies and renames the model", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "glance-models-"));
  const { url, close } = await serve((req, res) => sendRange(req, res, DATA));
  try {
    const progress = [];
    const file = await downloadModel("test.en", { dir, baseUrl: url, models: model(), onProgress: (p) => progress.push(p) });
    assert.equal(file, path.join(dir, "ggml-test.en.bin"));
    assert.deepEqual(await readFile(file), DATA);
    await assert.rejects(stat(`${file}.part`), /ENOENT/);
    assert.equal(progress.at(-1).received, DATA.length);
    assert.equal(progress.at(-1).total, DATA.length);
  } finally {
    await close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an interrupted download keeps the .part and resumes with Range", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "glance-models-"));
  const ranges = [];
  let first = true;
  const { url, close } = await serve((req, res) => {
    ranges.push(req.headers.range || null);
    if (first) {
      first = false;
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(DATA.length) });
      res.write(DATA.subarray(0, 80_000), () => setTimeout(() => res.destroy(), 20));
      return;
    }
    sendRange(req, res, DATA);
  });
  try {
    const opts = { dir, baseUrl: url, models: model() };
    await assert.rejects(downloadModel("test.en", opts));
    assert.ok((await stat(path.join(dir, "ggml-test.en.bin.part"))).size > 0);
    const file = await downloadModel("test.en", opts);
    assert.deepEqual(await readFile(file), DATA);
    assert.equal(ranges[0], null);
    assert.match(ranges[1], /^bytes=[1-9]\d*-$/);
  } finally {
    await close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a stalled download times out, keeps the .part and resumes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "glance-models-"));
  const held = [];
  const stalled = await serve((req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(DATA.length) });
    res.write(DATA.subarray(0, 80_000));
    held.push(res);
  });
  const normal = await serve((req, res) => sendRange(req, res, DATA));
  try {
    await assert.rejects(downloadModel("test.en", { dir, baseUrl: stalled.url, models: model(), idleMs: 300 }), {
      message: "The speech model download stalled. Check your connection.",
    });
    const part = path.join(dir, "ggml-test.en.bin.part");
    assert.ok((await stat(part)).size > 0);
    const file = await downloadModel("test.en", { dir, baseUrl: normal.url, models: model() });
    assert.deepEqual(await readFile(file), DATA);
    await assert.rejects(stat(part), /ENOENT/);
  } finally {
    for (const res of held) res.destroy();
    stalled.server.closeAllConnections?.();
    await stalled.close();
    await normal.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a wrong checksum deletes the .part and throws", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "glance-models-"));
  const { url, close } = await serve((req, res) => sendRange(req, res, DATA));
  try {
    const bad = model({ sha256: "0".repeat(64) });
    await assert.rejects(downloadModel("test.en", { dir, baseUrl: url, models: bad }), {
      message: "The speech model download was corrupted. Try again.",
    });
    await assert.rejects(stat(path.join(dir, "ggml-test.en.bin.part")), /ENOENT/);
    await assert.rejects(stat(path.join(dir, "ggml-test.en.bin")), /ENOENT/);
  } finally {
    await close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("findModel needs the exact size and checks folders in order", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "glance-models-"));
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  const third = path.join(root, "third");
  const models = model();
  const file = models["test.en"].file;
  try {
    await Promise.all([mkdir(first), mkdir(second), mkdir(third)]);
    await writeFile(path.join(first, file), Buffer.alloc(DATA.length - 1));
    await writeFile(path.join(second, file), Buffer.alloc(DATA.length + 1));
    assert.equal(findModel("test.en", { dirs: [first, second], models }), null);
    await writeFile(path.join(third, file), DATA);
    assert.equal(findModel("test.en", { dirs: [first, second, third], models }), path.join(third, file));
    await writeFile(path.join(second, file), DATA);
    assert.equal(findModel("test.en", { dirs: [first, second, third], models }), path.join(second, file));
    assert.equal(findModel("missing", { dirs: [first, second, third], models }), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the shipped models keep their expected names and sizes", () => {
  assert.deepEqual(Object.keys(MODELS), ["small.en", "base.en"]);
  assert.equal(MODELS["small.en"].file, "ggml-small.en.bin");
  assert.equal(MODELS["small.en"].size, 487614201);
  assert.equal(MODELS["base.en"].file, "ggml-base.en.bin");
  assert.equal(MODELS["base.en"].size, 147964211);
});
