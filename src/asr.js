// Glance's speech engine: NVIDIA Parakeet TDT 0.6B v2 (English, int8) through
// sherpa-onnx, on the CPU, in its own process (asr-worker.js): Electron's
// utility process inside Glance, a Node child process elsewhere (tests,
// scripts). The model loads once (about 2 s) and stays loaded; each phrase
// then takes about 0.5-0.8 s on an M1.
//
//   const asr = new Asr({ modelDir });
//   await asr.load({ hotwords });                 // optional: transcribe loads it too
//   const { text, ms } = await asr.transcribe(pcm, { hotwords });  // or { error }
//
// pcm: 16 kHz mono signed 16-bit little-endian. hotwords: phrases to listen
// for, most important first (see hotwords.js).
import { fork } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";

const WORKER = fileURLToPath(new URL("./asr-worker.js", import.meta.url));
// Crashes in one session before Glance stops restarting the engine.
const MAX_CRASHES = 3;
// A phrase is at most 12 s of audio and takes about a second; this only
// catches a stuck engine.
const TRANSCRIBE_TIMEOUT_MS = 60000;
const LOAD_TIMEOUT_MS = 120000;

export class Asr extends EventEmitter {
  constructor({ modelDir, workerPath = WORKER, env = {} } = {}) {
    super();
    this.modelDir = modelDir;
    this.workerPath = workerPath;
    this.env = env;
    this.state = "off"; // off, loading, ready, failed
    this.child = null;
    this.waiting = new Map(); // id -> resolve
    this.nextId = 1;
    this.crashes = 0;
    this.loading = null;
    this.hotwords = [];
    process.on("exit", () => this.stop());
  }

  setState(state, detail) {
    if (this.state === state) return;
    this.state = state;
    this.emit("state", state, detail);
  }

  async spawn() {
    const env = { ...process.env, ...this.env };
    let child;
    if (process.versions.electron && process.type === "browser") {
      const { utilityProcess } = await import("electron");
      child = utilityProcess.fork(this.workerPath, [], { serviceName: "Glance Speech", env, stdio: ["ignore", "ignore", "pipe"] });
      this.send = (m) => child.postMessage(m);
    } else {
      child = fork(this.workerPath, [], { env, serialization: "advanced", stdio: ["ignore", "ignore", "pipe", "ipc"] });
      this.send = (m) => child.send(m);
    }
    this.child = child;
    // sherpa-onnx writes its errors to stderr.
    child.stderr?.on("data", (d) => {
      for (const line of String(d).split("\n")) if (line.trim()) this.emit("log", line.trim().slice(0, 1000));
    });
    child.on("message", (m) => this.onMessage(m));
    child.on("exit", (code, signal) => this.onExit(child, code, signal));
    child.on("error", () => {});
  }

  onMessage(m) {
    if (m?.type === "log") return void this.emit("log", m.text);
    if (m?.type === "ready") {
      this.setState("ready");
      this.emit("ready", m);
      return void this.waiting.get("load")?.({ ok: true, ...m });
    }
    if (m?.type === "result") return void this.waiting.get(m.id)?.({ text: m.text, ms: m.ms });
    if (m?.type === "error") {
      this.emit("log", `engine error: ${m.message}`);
      const resolve = this.waiting.get(m.id ?? "load") ?? this.waiting.get("load");
      resolve?.({ error: m.message });
    }
  }

  onExit(child, code, signal) {
    if (this.child !== child) return;
    this.child = null;
    const reason = `speech engine stopped (${signal || `code ${code}`})`;
    for (const resolve of this.waiting.values()) resolve({ error: reason });
    this.waiting.clear();
    if (this.stopping) return;
    this.crashes++;
    this.emit("crash", reason);
    this.setState(this.crashes >= MAX_CRASHES ? "failed" : "off", reason);
  }

  request(key, message, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.emit("log", `engine timed out after ${timeoutMs}ms; restarting it`);
        resolve({ error: "speech engine timed out" });
        this.waiting.delete(key);
        this.child?.kill();
      }, timeoutMs);
      this.waiting.set(key, (r) => {
        clearTimeout(timer);
        this.waiting.delete(key);
        resolve(r);
      });
      try {
        this.send(message);
      } catch (e) {
        this.waiting.get(key)?.({ error: e.message });
      }
    });
  }

  // Starts the engine and loads the model. Resolves true once it's ready.
  load({ hotwords = this.hotwords } = {}) {
    this.hotwords = hotwords;
    if (this.state === "failed") return Promise.resolve(false);
    if (this.loading) return this.loading;
    if (this.state === "ready" && this.child) return Promise.resolve(true);
    this.stopping = false;
    this.setState("loading");
    const task = (async () => {
      if (!this.child) await this.spawn();
      const r = await this.request("load", { type: "load", modelDir: this.modelDir, hotwords }, LOAD_TIMEOUT_MS);
      if (r.error) {
        this.emit("log", `engine load failed: ${r.error}`);
        // Exited: onExit has counted it. Otherwise stop it and count it here.
        if (!this.child) return false;
        const child = this.child;
        this.child = null;
        child.kill();
        this.crashes++;
        this.setState(this.crashes >= MAX_CRASHES ? "failed" : "off", r.error);
        return false;
      }
      return true;
    })().finally(() => {
      if (this.loading === task) this.loading = null;
    });
    this.loading = task;
    return task;
  }

  async transcribe(pcm, { hotwords = this.hotwords } = {}) {
    this.hotwords = hotwords;
    if (this.state !== "ready" || !this.child) {
      if (!(await this.load({ hotwords }))) return { error: this.state === "failed" ? "speech engine failed" : "speech engine not loaded" };
    }
    const id = this.nextId++;
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    return this.request(id, { type: "transcribe", id, modelDir: this.modelDir, pcm: bytes, hotwords }, TRANSCRIBE_TIMEOUT_MS);
  }

  stop() {
    this.stopping = true;
    const child = this.child;
    this.child = null;
    for (const resolve of this.waiting.values()) resolve({ error: "speech engine stopped" });
    this.waiting.clear();
    child?.kill();
    if (this.state !== "failed") this.setState("off");
  }
}
