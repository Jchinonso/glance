import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

// Glance's one speech model: NVIDIA Parakeet TDT 0.6B v2 (English), int8,
// converted for sherpa-onnx by its authors. CC-BY-4.0 (NVIDIA).
// Pinned to the repo's commit so the files always match the sha256 sums below, even if the repo changes.
export const DEFAULT_BASE_URL = "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8/resolve/1ab9323565ddb038682214b292f588070a538ce2";

export const MODEL = {
  dir: "parakeet-tdt-0.6b-v2-int8",
  files: [
    { name: "encoder.int8.onnx", size: 652184296, sha256: "a32b12d17bbbc309d0686fbbcc2987b5e9b8333a7da83fa6b089f0a2acd651ab" },
    { name: "decoder.int8.onnx", size: 7257753, sha256: "b6bb64963457237b900e496ee9994b59294526439fbcc1fecf705b31a15c6b4e" },
    { name: "joiner.int8.onnx", size: 1739080, sha256: "7946164367946e7f9f29a122407c3252b680dbae9a51343eb2488d057c3c43d2" },
    { name: "tokens.txt", size: 9384, sha256: "ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d" },
  ],
};

export const modelSize = (model = MODEL) => model.files.reduce((sum, f) => sum + f.size, 0);
export const modelPath = (root, model = MODEL) => path.join(root, model.dir);

// Written once every file has passed its checksum, so later launches only
// compare sizes and modification times instead of reading 660 MB again.
const VERIFIED = ".verified.json";
const PROGRESS_MS = 250;

function sizeMB(size) {
  return Math.round(size / 1_000_000);
}

function diskFull(size) {
  return new Error(`Not enough disk space for the speech model (${sizeMB(size)} MB needed).`);
}

function statOf(file) {
  try {
    const stat = statSync(file);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

async function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file, { highWaterMark: 1 << 20 });
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

// Every file there with the right size (a quick look, no checksums).
export function modelPresent(root, model = MODEL) {
  const dir = modelPath(root, model);
  return model.files.every((f) => statOf(path.join(dir, f.name))?.size === f.size);
}

function readVerified(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, VERIFIED), "utf8"));
  } catch {
    return {};
  }
}

// Checks every file: size, then its checksum unless it was checked before and
// hasn't changed since. A file that fails is deleted. Returns the names of
// the files that are missing or were deleted (empty: the model is ready).
export async function verifyModel(root, model = MODEL) {
  const dir = modelPath(root, model);
  const before = readVerified(dir);
  const after = {};
  const missing = [];
  for (const f of model.files) {
    const file = path.join(dir, f.name);
    const stat = statOf(file);
    if (!stat || stat.size !== f.size) {
      missing.push(f.name);
      continue;
    }
    const seen = before[f.name];
    if (seen && seen.sha256 === f.sha256 && seen.size === stat.size && seen.mtimeMs === stat.mtimeMs) {
      after[f.name] = seen;
      continue;
    }
    if ((await hashFile(file)) !== f.sha256) {
      unlinkSync(file);
      missing.push(f.name);
      continue;
    }
    after[f.name] = { size: stat.size, mtimeMs: stat.mtimeMs, sha256: f.sha256 };
  }
  try {
    writeFileSync(path.join(dir, VERIFIED), JSON.stringify(after));
  } catch {}
  return missing;
}

async function fetchIntoPart(file, url, size, offset, onProgress, signal, idleMs) {
  const controller = new AbortController();
  let stalled = false;
  let timer;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, idleMs);
  };
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  arm();

  const stallError = () => new Error("The speech model download stalled. Check your connection.");

  let handle;
  try {
    let response;
    try {
      response = await fetch(url, {
        headers: offset ? { Range: `bytes=${offset}-` } : {},
        redirect: "follow",
        signal: controller.signal,
      });
    } catch (e) {
      if (stalled) throw stallError();
      if (e?.code === "ENOSPC") throw diskFull(size);
      throw e;
    }
    if (!response.ok) throw new Error(`The speech model download failed (HTTP ${response.status}).`);
    if (!response.body) throw new Error("The speech model download failed: the server sent no data.");
    // The server ignored our Range header: start the file over.
    if (offset && response.status !== 206) offset = 0;

    let received = offset;
    onProgress?.(received);

    try {
      handle = await open(file, offset ? "a" : "w");
    } catch (e) {
      if (e?.code === "ENOSPC") throw diskFull(size);
      throw e;
    }

    const reader = response.body.getReader();
    for (;;) {
      if (signal?.aborted) throw new Error("The speech model download was stopped.");
      let result;
      try {
        result = await reader.read();
      } catch (e) {
        if (stalled) throw stallError();
        if (e?.code === "ENOSPC") throw diskFull(size);
        throw e;
      }
      const { done, value } = result;
      if (done) break;
      arm();
      try {
        await handle.write(value);
      } catch (e) {
        if (e?.code === "ENOSPC") throw diskFull(size);
        throw e;
      }
      received += value.byteLength;
      onProgress?.(received);
    }
    return received;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    if (handle) await handle.close().catch(() => {});
  }
}

// One file into dir, resuming its .part, then checked against its sha256.
export async function downloadFile(f, { dir, url, onProgress, signal, idleMs = 30000, totalSize = f.size }) {
  const finalPath = path.join(dir, f.name);
  const partPath = `${finalPath}.part`;
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    if (e?.code === "ENOSPC") throw diskFull(totalSize);
    throw e;
  }
  let offset = statOf(partPath)?.size ?? 0;
  if (offset > f.size) {
    unlinkSync(partPath);
    offset = 0;
  }
  if (offset < f.size) offset = await fetchIntoPart(partPath, url, totalSize, offset, onProgress, signal, idleMs);
  else onProgress?.(offset);

  if ((await hashFile(partPath)) !== f.sha256.toLowerCase()) {
    unlinkSync(partPath);
    throw new Error("The speech model download was corrupted. Try again.");
  }
  try {
    renameSync(partPath, finalPath);
  } catch (e) {
    if (e?.code === "ENOSPC") throw diskFull(totalSize);
    throw e;
  }
  return finalPath;
}

// Downloads whatever of the model isn't there yet into <root>/<model.dir>,
// with progress over all of it ({ received, total }), at most a few updates
// a second. Resolves with the model's folder once every file is verified.
export async function downloadModel({ root, baseUrl = DEFAULT_BASE_URL, model = MODEL, onProgress, signal, idleMs = 30000 } = {}) {
  if (!root) throw new Error("No folder to download the speech model into.");
  const dir = modelPath(root, model);
  const total = modelSize(model);
  const missing = new Set(await verifyModel(root, model));
  let done = model.files.filter((f) => !missing.has(f.name)).reduce((sum, f) => sum + f.size, 0);
  let lastReport = 0;
  const report = (received, force = false) => {
    const now = Date.now();
    if (!force && now - lastReport < PROGRESS_MS) return;
    lastReport = now;
    onProgress?.({ received: Math.min(received, total), total });
  };
  report(done, true);
  for (const f of model.files) {
    if (!missing.has(f.name)) continue;
    await downloadFile(f, { dir, url: `${baseUrl.replace(/\/+$/, "")}/${f.name}`, signal, idleMs, totalSize: total, onProgress: (received) => report(done + received) });
    done += f.size;
    report(done, true);
  }
  const still = await verifyModel(root, model);
  if (still.length) throw new Error("The speech model download was corrupted. Try again.");
  return dir;
}

// Speech models from older versions of Glance (whisper.cpp's ggml-*.bin,
// leftover .part downloads of them, and WhisperKit's folder), deleted once
// Parakeet is in. Only these names, and only directly in Glance's own models
// folder. Returns what went and the bytes freed.
export function removeOldModels(root) {
  const removed = [];
  let bytes = 0;
  let names = [];
  try {
    names = readdirSync(root);
  } catch {
    return { removed, bytes };
  }
  const sizeOf = (p) => {
    try {
      const stat = statSync(p);
      if (!stat.isDirectory()) return stat.size;
      return readdirSync(p).reduce((sum, n) => sum + sizeOf(path.join(p, n)), 0);
    } catch {
      return 0;
    }
  };
  for (const name of names) {
    if (!/^ggml-.+\.bin(\.part)?$/.test(name) && name !== "whisperkit") continue;
    const p = path.join(root, name);
    const size = sizeOf(p);
    try {
      rmSync(p, { recursive: name === "whisperkit", force: true });
      removed.push(name);
      bytes += size;
    } catch {}
  }
  return { removed, bytes };
}
