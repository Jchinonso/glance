import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_BASE_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

export const MODELS = {
  "small.en": {
    file: "ggml-small.en.bin",
    size: 487614201,
    sha256: "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d",
  },
  "base.en": {
    file: "ggml-base.en.bin",
    size: 147964211,
    sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
  },
};

const PROGRESS_MS = 250;

function sizeMB(size) {
  return Math.round(size / 1_000_000);
}

function diskFull(model) {
  return new Error(`Not enough disk space for the speech model (${sizeMB(model.size)} MB needed).`);
}

function statSize(file) {
  try {
    const stat = statSync(file);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

export function findModel(name, { dirs = [], models = MODELS } = {}) {
  const model = models?.[name];
  if (!model) return null;
  for (const dir of dirs) {
    if (!dir) continue;
    const file = path.join(dir, model.file);
    if (statSize(file) === model.size) return file;
  }
  return null;
}

async function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function fetchIntoPart(file, url, model, offset, onProgress, signal, idleMs) {
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
      if (e?.code === "ENOSPC") throw diskFull(model);
      throw e;
    }
    if (!response.ok) throw new Error(`The speech model download failed (HTTP ${response.status}).`);
    if (!response.body) throw new Error("The speech model download failed: the server sent no data.");
    // The server ignored our Range header: start the file over.
    if (offset && response.status !== 206) offset = 0;

    let received = offset;
    let lastReport = 0;
    const report = (force = false) => {
      const now = Date.now();
      if (!force && now - lastReport < PROGRESS_MS) return;
      lastReport = now;
      onProgress?.({ received, total: model.size });
    };
    report(true);

    try {
      handle = await open(file, offset ? "a" : "w");
    } catch (e) {
      if (e?.code === "ENOSPC") throw diskFull(model);
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
        if (e?.code === "ENOSPC") throw diskFull(model);
        throw e;
      }
      const { done, value } = result;
      if (done) break;
      arm();
      try {
        await handle.write(value);
      } catch (e) {
        if (e?.code === "ENOSPC") throw diskFull(model);
        throw e;
      }
      received += value.byteLength;
      report();
    }
    report(true);
    return received;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    if (handle) await handle.close().catch(() => {});
  }
}

export async function downloadModel(name, { dir, baseUrl = DEFAULT_BASE_URL, models = MODELS, onProgress, signal, idleMs = 30000 } = {}) {
  const model = models?.[name];
  if (!model) throw new Error(`Unknown speech model: ${name}`);
  if (!dir) throw new Error("No folder to download the speech model into.");

  const finalPath = path.join(dir, model.file);
  const partPath = `${finalPath}.part`;

  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    if (e?.code === "ENOSPC") throw diskFull(model);
    throw e;
  }

  let offset = statSize(partPath) ?? 0;
  if (offset > model.size) {
    unlinkSync(partPath);
    offset = 0;
  }
  if (offset < model.size) {
    offset = await fetchIntoPart(partPath, `${baseUrl.replace(/\/+$/, "")}/${model.file}`, model, offset, onProgress, signal, idleMs);
  } else {
    onProgress?.({ received: offset, total: model.size });
  }

  const digest = await hashFile(partPath);
  if (digest !== model.sha256.toLowerCase()) {
    unlinkSync(partPath);
    throw new Error("The speech model download was corrupted. Try again.");
  }

  try {
    renameSync(partPath, finalPath);
  } catch (e) {
    if (e?.code === "ENOSPC") throw diskFull(model);
    throw e;
  }
  return finalPath;
}
