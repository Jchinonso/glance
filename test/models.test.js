import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { downloadModel, MODEL, modelPresent, modelSize, removeOldModels, verifyModel } from "../src/models.js";

const DATA = Buffer.alloc(200_000, 7);
const SMALL = Buffer.from("tokens\n");
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const BYTES = { "encoder.onnx": DATA, "tokens.txt": SMALL };

// A two-file stand-in for the Parakeet model.
function model(overrides = {}) {
  return {
    dir: "test-model",
    files: [
      { name: "encoder.onnx", size: DATA.length, sha256: sha256(DATA), ...overrides },
      { name: "tokens.txt", size: SMALL.length, sha256: sha256(SMALL) },
    ],
  };
}
const bytesFor = (req) => BYTES[path.basename(req.url)];

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

test("downloads every file, verifies them, and reports progress over the whole model", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "glance-models-"));
  const { url, close } = await serve((req, res) => (bytesFor(req) ? sendRange(req, res, bytesFor(req)) : res.writeHead(404).end()));
  try {
    const progress = [];
    const dir = await downloadModel({ root, baseUrl: url, model: model(), onProgress: (p) => progress.push(p) });
    assert.equal(dir, path.join(root, "test-model"));
    assert.deepEqual(await readFile(path.join(dir, "encoder.onnx")), DATA);
    assert.deepEqual(await readFile(path.join(dir, "tokens.txt")), SMALL);
    await assert.rejects(stat(path.join(dir, "encoder.onnx.part")), /ENOENT/);
    assert.deepEqual(progress.at(-1), { received: DATA.length + SMALL.length, total: DATA.length + SMALL.length });
    assert.equal(progress[0].received, 0);
    assert.ok(modelPresent(root, model()));
    assert.deepEqual(await verifyModel(root, model()), []);
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an interrupted download keeps the .part and resumes with Range", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "glance-models-"));
  const ranges = [];
  let first = true;
  const { url, close } = await serve((req, res) => {
    if (path.basename(req.url) === "encoder.onnx") {
      ranges.push(req.headers.range || null);
      if (first) {
        first = false;
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(DATA.length) });
        res.write(DATA.subarray(0, 80_000), () => setTimeout(() => res.destroy(), 20));
        return;
      }
    }
    sendRange(req, res, bytesFor(req));
  });
  try {
    const opts = { root, baseUrl: url, model: model() };
    await assert.rejects(downloadModel(opts));
    assert.ok((await stat(path.join(root, "test-model", "encoder.onnx.part"))).size > 0);
    const dir = await downloadModel(opts);
    assert.deepEqual(await readFile(path.join(dir, "encoder.onnx")), DATA);
    assert.equal(ranges[0], null);
    assert.match(ranges[1], /^bytes=[1-9]\d*-$/);
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a stalled download times out, keeps the .part and resumes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "glance-models-"));
  const held = [];
  const stalled = await serve((req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(DATA.length) });
    res.write(DATA.subarray(0, 80_000));
    held.push(res);
  });
  const normal = await serve((req, res) => sendRange(req, res, bytesFor(req)));
  try {
    await assert.rejects(downloadModel({ root, baseUrl: stalled.url, model: model(), idleMs: 300 }), {
      message: "The speech model download stalled. Check your connection.",
    });
    const part = path.join(root, "test-model", "encoder.onnx.part");
    assert.ok((await stat(part)).size > 0);
    const dir = await downloadModel({ root, baseUrl: normal.url, model: model() });
    assert.deepEqual(await readFile(path.join(dir, "encoder.onnx")), DATA);
    await assert.rejects(stat(part), /ENOENT/);
  } finally {
    for (const res of held) res.destroy();
    stalled.server.closeAllConnections?.();
    await stalled.close();
    await normal.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a wrong checksum deletes the .part and throws", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "glance-models-"));
  const { url, close } = await serve((req, res) => sendRange(req, res, bytesFor(req)));
  try {
    await assert.rejects(downloadModel({ root, baseUrl: url, model: model({ sha256: "0".repeat(64) }) }), {
      message: "The speech model download was corrupted. Try again.",
    });
    await assert.rejects(stat(path.join(root, "test-model", "encoder.onnx.part")), /ENOENT/);
    await assert.rejects(stat(path.join(root, "test-model", "encoder.onnx")), /ENOENT/);
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
});

test("files copied in by hand are accepted after their checksum; a changed file is caught and removed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "glance-models-"));
  const dir = path.join(root, "test-model");
  try {
    assert.equal(modelPresent(root, model()), false);
    await mkdir(dir);
    await writeFile(path.join(dir, "encoder.onnx"), DATA);
    await writeFile(path.join(dir, "tokens.txt"), SMALL);
    assert.equal(modelPresent(root, model()), true);
    assert.deepEqual(await verifyModel(root, model()), []);
    assert.ok(JSON.parse(await readFile(path.join(dir, ".verified.json"), "utf8"))["encoder.onnx"]);
    // Same size, other bytes: the size check passes, the checksum doesn't.
    await writeFile(path.join(dir, "encoder.onnx"), Buffer.alloc(DATA.length, 9));
    assert.deepEqual(await verifyModel(root, model()), ["encoder.onnx"]);
    await assert.rejects(stat(path.join(dir, "encoder.onnx")), /ENOENT/);
    // Nothing downloaded again for the file that's fine.
    const asked = [];
    const { url, close } = await serve((req, res) => (asked.push(path.basename(req.url)), sendRange(req, res, bytesFor(req))));
    try {
      await downloadModel({ root, baseUrl: url, model: model() });
    } finally {
      await close();
    }
    assert.deepEqual(asked, ["encoder.onnx"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("old speech models (whisper.cpp, WhisperKit) are removed from the models folder, and nothing else", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "glance-models-"));
  try {
    await writeFile(path.join(root, "ggml-small.en.bin"), Buffer.alloc(3000));
    await writeFile(path.join(root, "ggml-base.en.bin"), Buffer.alloc(2000));
    await writeFile(path.join(root, "ggml-large-v3-turbo-q5_0.bin.part"), Buffer.alloc(500));
    await mkdir(path.join(root, "whisperkit", "models", "openai"), { recursive: true });
    await writeFile(path.join(root, "whisperkit", "models", "openai", "weights.bin"), Buffer.alloc(1000));
    await mkdir(path.join(root, MODEL.dir));
    await writeFile(path.join(root, MODEL.dir, "tokens.txt"), "keep");
    await writeFile(path.join(root, "notes.bin"), "keep");
    const { removed, bytes } = removeOldModels(root);
    assert.deepEqual(removed.sort(), ["ggml-base.en.bin", "ggml-large-v3-turbo-q5_0.bin.part", "ggml-small.en.bin", "whisperkit"]);
    assert.equal(bytes, 6500);
    assert.equal(await readFile(path.join(root, MODEL.dir, "tokens.txt"), "utf8"), "keep");
    assert.equal(await readFile(path.join(root, "notes.bin"), "utf8"), "keep");
    assert.deepEqual(removeOldModels(root), { removed: [], bytes: 0 });
    assert.deepEqual(removeOldModels(path.join(root, "missing")), { removed: [], bytes: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the model is Parakeet TDT 0.6B v2 (int8): four files, about 660 MB", () => {
  assert.equal(MODEL.dir, "parakeet-tdt-0.6b-v2-int8");
  assert.deepEqual(MODEL.files.map((f) => [f.name, f.size]), [
    ["encoder.int8.onnx", 652184296],
    ["decoder.int8.onnx", 7257753],
    ["joiner.int8.onnx", 1739080],
    ["tokens.txt", 9384],
  ]);
  assert.ok(MODEL.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)));
  assert.equal(Math.round(modelSize() / 10_000_000) * 10, 660);
});
