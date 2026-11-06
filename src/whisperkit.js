import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { wav } from "./audio.js";

// Glance's speech upgrade: Whisper large-v3 turbo in Core ML, run by
// WhisperKit on the Neural Engine, inside the glance-whisper helper
// (native/glance-whisper). It speaks JSON lines on stdin/stdout. main.js
// downloads and loads it in the background; whisper.cpp (base.en, from setup)
// transcribes until it's loaded, and covers whatever it can't do (see
// Listener in audio.js).

// Argmax's compressed large-v3 turbo (Sept 2024 weights), 632 MB in Core ML.
export const WHISPERKIT_VARIANT = "openai_whisper-large-v3-v20240930_turbo_632MB";
export const WHISPERKIT_NAME = "Whisper large-v3 turbo";
// Model files plus the tokenizer, for the progress bar before the helper reports a total.
export const WHISPERKIT_SIZE = 648_500_000;

// WhisperKit's download layout under the models folder; the helper writes the
// marker once the model and its tokenizer are complete.
export const kitModelFolder = (modelsDir, variant = WHISPERKIT_VARIANT) => path.join(modelsDir, "models", "argmaxinc", "whisperkit-coreml", variant);
export function kitDownloaded(modelsDir, variant = WHISPERKIT_VARIANT) {
  return existsSync(path.join(kitModelFolder(modelsDir, variant), ".glance-complete")) && existsSync(path.join(modelsDir, "models", "openai", "whisper-large-v3", "tokenizer.json"));
}

// WhisperKit's Core ML models need macOS 14 (Darwin 23) or later.
export function kitSupported({ binary, release = os.release() } = {}) {
  return !!binary && path.isAbsolute(binary) && existsSync(binary) && parseInt(release, 10) >= 23;
}

// Never leave a model loaded after Glance quits, however it quits.
const helpers = new Set();
process.on("exit", () => {
  for (const proc of helpers) proc.kill("SIGKILL");
});

const MAX_CRASHES = 3; // in one session, then whisper.cpp for the rest of it
const TRANSCRIBE_TIMEOUT_MS = 30000; // a 12 s segment takes well under a second
// The first load compiles the model for the Neural Engine: a minute or two on
// recent Macs, over 10 minutes on an M1. Past this it's stuck.
const LOAD_TIMEOUT_MS = 40 * 60 * 1000;

// One helper process. state: "idle" (not started), "downloading", "loading",
// "ready", "failed" (given up for this session). Emits "log" (helper stderr
// and notes), "loading", "ready" (loadMs), "crash" (reason) and "failed"
// (reason). A crash after the model loaded restarts the helper and loads
// again; transcribe() returns null meanwhile, so callers use whisper.cpp.
export class WhisperKit extends EventEmitter {
  constructor({ binary, modelsDir, variant = WHISPERKIT_VARIANT, maxCrashes = MAX_CRASHES, timeoutMs = TRANSCRIBE_TIMEOUT_MS, loadTimeoutMs = LOAD_TIMEOUT_MS }) {
    super();
    this.binary = binary;
    this.modelsDir = modelsDir;
    this.variant = variant;
    this.maxCrashes = maxCrashes;
    this.timeoutMs = timeoutMs;
    this.loadTimeoutMs = loadTimeoutMs;
    this.state = "idle";
    this.crashes = 0;
    this.proc = null;
    this.replies = new Map(); // transcribe id -> resolve
    this.waiter = null; // the download or load in progress: { resolve, reject, onEvent }
    this.loadedOnce = false;
    this.nextId = 1;
    this.readyWaiters = [];
  }

  spawnHelper() {
    if (this.proc) return this.proc;
    const proc = spawn(this.binary, ["--models", this.modelsDir, "--variant", this.variant], { stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    helpers.add(proc);
    proc.on("exit", () => helpers.delete(proc));
    let out = "";
    proc.stdout.on("data", (chunk) => {
      out += chunk;
      let i;
      while ((i = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, i).trim();
        out = out.slice(i + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          this.emit("log", `stdout: ${line.slice(0, 300)}`);
          continue;
        }
        this.message(msg);
      }
    });
    let err = "";
    proc.stderr.on("data", (chunk) => {
      err += chunk;
      let i;
      while ((i = err.indexOf("\n")) >= 0) {
        const line = err.slice(0, i).trim();
        err = err.slice(i + 1);
        if (line) this.emit("log", line);
      }
    });
    proc.stdin.on("error", () => {}); // EPIPE when it died; "exit" handles it
    // "error" (couldn't start) and "exit" can both fire; exited() acts once.
    proc.on("error", (e) => this.exited(proc, `couldn't start: ${e.message}`));
    proc.on("exit", (code, signal) => this.exited(proc, signal ? `signal ${signal}` : `exit code ${code}`));
    return proc;
  }

  send(obj) {
    try {
      this.proc?.stdin.write(`${JSON.stringify(obj)}\n`);
    } catch {}
  }

  message(msg) {
    if (msg.id !== undefined && this.replies.has(String(msg.id))) {
      const resolve = this.replies.get(String(msg.id));
      this.replies.delete(String(msg.id));
      return resolve(msg);
    }
    if (msg.event) this.waiter?.onEvent(msg);
  }

  // Resolves the open requests of a helper that is gone (or being stopped).
  settle(reason, crashed) {
    for (const resolve of this.replies.values()) resolve({ error: `helper stopped (${reason})`, crashed });
    this.replies.clear();
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.reject(Object.assign(new Error(crashed ? `helper stopped (${reason})` : "stopped"), { crashed }));
  }

  exited(proc, reason) {
    if (this.proc !== proc) return; // stopped on purpose
    this.proc = null;
    const wasState = this.state;
    this.crashes++;
    this.emit("crash", reason);
    this.settle(reason, true);
    if (this.crashes >= this.maxCrashes) return this.fail(`helper crashed ${this.crashes} times (last: ${reason})`);
    // Loaded before: bring it back, and whisper.cpp covers the gap.
    if (wasState === "ready") {
      this.state = "idle";
      this.load().catch(() => {});
    }
  }

  fail(reason, { loadFailed = false } = {}) {
    if (this.state === "failed") return;
    this.state = "failed";
    this.emit("failed", reason, { loadFailed });
    for (const r of this.readyWaiters) r(false);
    this.readyWaiters = [];
    this.stop();
  }

  // Runs one long request (download or load) that answers with events.
  request(op, onEvent) {
    if (this.waiter) return Promise.reject(new Error("busy"));
    this.spawnHelper();
    return new Promise((resolve, reject) => {
      this.waiter = {
        resolve: (v) => ((this.waiter = null), resolve(v)),
        reject: (e) => ((this.waiter = null), reject(e)),
        onEvent: (msg) => onEvent(msg, this.waiter),
      };
      this.send({ op });
    });
  }

  // Resolves when the model is on disk; onProgress gets { received, total }.
  download(onProgress) {
    if (this.state === "failed") return Promise.reject(new Error("WhisperKit is off for this session"));
    this.state = "downloading";
    return this.request("download", (msg, w) => {
      if (msg.event === "download") onProgress?.({ received: msg.received, total: msg.total });
      else if (msg.event === "downloaded") w.resolve(true);
      else if (msg.event === "error") w.reject(new Error(msg.message || "download failed"));
    }).finally(() => {
      if (this.state === "downloading") this.state = "idle";
    });
  }

  // Loads the model (the first load on a Mac specializes it for the Neural
  // Engine, a minute or more). Resolves { loadMs }; a failure rejects and
  // leaves the helper off for this session.
  load() {
    if (this.state === "ready") return Promise.resolve({ loadMs: 0 });
    if (this.state === "failed") return Promise.reject(new Error("WhisperKit is off for this session"));
    if (this.loading) return this.loading;
    this.state = "loading";
    const proc = this.spawnHelper();
    const stuck = setTimeout(() => {
      this.emit("log", `load took over ${this.loadTimeoutMs} ms; stopping it`);
      proc.kill("SIGKILL");
    }, this.loadTimeoutMs);
    const loading = this.request("load", (msg, w) => {
      if (msg.event === "loading") this.emit("loading");
      else if (msg.event === "ready") w.resolve({ loadMs: msg.loadMs });
      else if (msg.event === "error") w.reject(new Error(msg.message || "load failed"));
    }).then(
      (r) => {
        this.state = "ready";
        this.loadedOnce = true;
        this.emit("ready", r.loadMs);
        for (const w of this.readyWaiters) w(true);
        this.readyWaiters = [];
        return r;
      },
      (e) => {
        if (e.message === "stopped") {
          if (this.state === "loading") this.state = "idle";
        } else this.fail(`load failed: ${e.message}`, { loadFailed: true });
        throw e;
      },
    );
    this.loading = loading;
    loading.finally(() => {
      clearTimeout(stuck);
      this.loading = null;
    }).catch(() => {});
    return loading;
  }

  // True once loaded, false once failed or after ms.
  waitReady(ms) {
    if (this.state === "ready") return Promise.resolve(true);
    if (this.state === "failed" || this.state === "idle") return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      this.readyWaiters.push((ok) => (clearTimeout(timer), resolve(ok)));
    });
  }

  // { text, ms } or { error }, or null when the model isn't loaded (use whisper.cpp).
  async transcribe(pcm, prompt = "") {
    if (this.state !== "ready" || !this.proc) return null;
    const file = path.join(os.tmpdir(), `glance-wk-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
    try {
      await writeFile(file, wav(pcm));
    } catch (e) {
      return { error: `couldn't write audio: ${e.message}` };
    }
    const id = String(this.nextId++);
    const proc = this.proc;
    try {
      return await new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.replies.delete(id);
          resolve({ error: `no reply in ${this.timeoutMs} ms`, crashed: true });
          proc.kill("SIGKILL"); // stuck: restart it (counts as a crash)
        }, this.timeoutMs);
        this.replies.set(id, (msg) => {
          clearTimeout(timer);
          resolve(msg.error !== undefined ? { error: String(msg.error), crashed: !!msg.crashed } : { text: String(msg.text ?? "").replace(/\s+/g, " ").trim(), ms: msg.ms });
        });
        this.send({ op: "transcribe", id, path: file, prompt });
      });
    } finally {
      unlink(file).catch(() => {});
    }
  }

  // Quits the helper (unloading the model). A later load() starts it again.
  stop() {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    if (this.state !== "failed") this.state = "idle";
    this.settle("stopped", false);
    try {
      proc.stdin.write(`${JSON.stringify({ op: "quit" })}\n`);
      proc.stdin.end();
    } catch {}
    const timer = setTimeout(() => proc.kill("SIGKILL"), 3000);
    proc.once("exit", () => clearTimeout(timer));
  }
}
