import { spawn, execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { writeFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AudioTee } from "audiotee";

const SAMPLE_RATE = 16000;
const FRAME = 480; // 30 ms at 16 kHz
const PRE_ROLL_FRAMES = 10; // keep 300 ms before speech starts
const END_SILENCE_FRAMES = 20; // ~600 ms of silence ends a segment; a question split by a pause is rejoined later
const MAX_SEGMENT_FRAMES = 500; // 15 s hard cap
const MIN_SPEECH_FRAMES = 12; // drop blips under ~360 ms
const FLOOR_WINDOW_FRAMES = 167; // ~5 s of history for the noise floor

// Energy-based voice activity detector that cuts a 16 kHz mono int16 stream
// into speech segments. The noise floor is the quietest frame of the last ~5 s:
// speech always has pauses, so this tracks the room even when it gets louder
// (a fan, music), which a silence-only estimate never notices.
export class Segmenter extends EventEmitter {
  constructor() {
    super();
    this.pending = Buffer.alloc(0);
    this.preRoll = [];
    this.frames = [];
    this.speechFrames = 0;
    this.silence = 0;
    this.speaking = false;
    this.floor = 200;
    this.history = [];
  }

  push(chunk) {
    this.pending = Buffer.concat([this.pending, chunk]);
    const bytes = FRAME * 2;
    while (this.pending.length >= bytes) {
      this.frame(this.pending.subarray(0, bytes));
      this.pending = this.pending.subarray(bytes);
    }
  }

  frame(buf) {
    let sum = 0;
    for (let i = 0; i < buf.length; i += 2) {
      const s = buf.readInt16LE(i);
      sum += s * s;
    }
    const rms = Math.sqrt(sum / FRAME);
    this.history.push(rms);
    if (this.history.length > FLOOR_WINDOW_FRAMES) this.history.shift();
    this.floor = this.floor * 0.9 + Math.min(...this.history) * 0.1;
    const isSpeech = rms > this.floor * 2.5 + 150;

    const copy = Buffer.from(buf);
    if (!this.speaking) {
      this.preRoll.push(copy);
      if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift();
      if (isSpeech) {
        this.speaking = true;
        this.frames = [...this.preRoll];
        this.preRoll = [];
        this.speechFrames = 1;
        this.silence = 0;
      }
      return;
    }

    this.frames.push(copy);
    if (isSpeech) {
      this.speechFrames++;
      this.silence = 0;
    } else {
      this.silence++;
    }
    if (this.silence >= END_SILENCE_FRAMES || this.frames.length >= MAX_SEGMENT_FRAMES) this.flush();
  }

  flush() {
    if (this.speaking && this.speechFrames >= MIN_SPEECH_FRAMES) {
      this.emit("segment", Buffer.concat(this.frames));
    }
    this.speaking = false;
    this.frames = [];
    this.speechFrames = 0;
    this.silence = 0;
  }
}

function wav(pcm) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// Whisper hallucinates these on silence/noise; drop them.
const NOISE = /^\s*(\[.*\]|\(.*\)|you|thank you\.?|thanks for watching!?|\.+)\s*$/i;

// `prompt` primes Whisper with words to expect (tech terms, names), which fixes
// most mishearings of jargon at no speed cost.
export async function whisper({ modelPath, binary, prompt }, pcm) {
  const file = path.join(os.tmpdir(), `glance-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
  try {
    await writeFile(file, wav(pcm));
  } catch (e) {
    return { error: `couldn't write audio: ${e.message}` };
  }
  return new Promise((resolve) => {
    execFile(
      binary,
      // -sns suppresses non-speech tokens, which cuts invented text on noise.
      ["-m", modelPath, "-f", file, "-l", "en", "-nt", "-np", "-sns", "-t", "4", ...(prompt ? ["--prompt", prompt] : [])],
      { timeout: 30000 },
      (err, stdout) => {
        unlink(file).catch(() => {});
        if (err) return resolve({ error: err.message });
        const text = stdout.replace(/\s+/g, " ").trim();
        resolve({ text: NOISE.test(text) ? "" : text });
      },
    );
  });
}

// Keeps the speech model loaded between segments. whisper-cli reloads it for
// every segment (~0.9 s for small.en), most of the wait before a heard
// question shows up. transcribe() returns null when the server isn't usable,
// and the caller falls back to whisper-cli. A server that dies mid-call is
// restarted a couple of times, so one crash doesn't slow the rest of the call.
const SERVER_RESTARTS = 2;

export class WhisperServer {
  constructor(binary) {
    this.binary = binary;
    this.proc = null;
    this.url = null;
    this.opts = null; // set while the server should be running
    this.restarts = 0;
    this.ready = Promise.resolve(false);
    process.on("exit", () => this.stop()); // never leave the model loaded after quit
  }

  start(opts, { restart = false } = {}) {
    this.stop();
    if (!restart) this.restarts = 0;
    this.opts = opts;
    const { modelPath, prompt } = opts;
    if (!path.isAbsolute(this.binary) || !existsSync(this.binary)) return;
    const port = 20000 + Math.floor(Math.random() * 40000);
    const proc = spawn(this.binary, ["-m", modelPath, "-l", "en", "-nt", "-sns", "-t", "4", "--host", "127.0.0.1", "--port", String(port), ...(prompt ? ["--prompt", prompt] : [])], { stdio: "ignore" });
    proc.on("error", () => {});
    proc.on("exit", () => {
      if (this.proc === proc) this.proc = this.url = null;
    });
    this.proc = proc;
    const url = `http://127.0.0.1:${port}`;
    // Ready once it answers HTTP; the model loads in about a second.
    this.ready = (async () => {
      for (let i = 0; i < 80 && this.proc === proc; i++) {
        try {
          await fetch(url, { signal: AbortSignal.timeout(1000) });
          this.url = url;
          return true;
        } catch {}
        await new Promise((r) => setTimeout(r, 250));
      }
      return false;
    })();
  }

  async transcribe(pcm) {
    // Died since it started: restart it; this segment uses whisper-cli meanwhile.
    if (!this.proc && this.opts && this.restarts < SERVER_RESTARTS && existsSync(this.binary)) {
      this.restarts++;
      this.start(this.opts, { restart: true });
      return null;
    }
    if (!this.proc || !(await this.ready) || !this.url) return null;
    const form = new FormData();
    form.append("file", new Blob([wav(pcm)], { type: "audio/wav" }), "audio.wav");
    form.append("response_format", "text");
    try {
      const res = await fetch(`${this.url}/inference`, { method: "POST", body: form, signal: AbortSignal.timeout(30000) });
      return res.ok ? (await res.text()).replace(/\s+/g, " ").trim() : null;
    } catch {
      return null;
    }
  }

  stop() {
    const proc = this.proc;
    this.proc = this.url = this.opts = null;
    proc?.kill("SIGTERM");
  }
}

// The copy bundled with the app (bundleDir) comes first. Apps launched from
// Finder don't inherit the shell PATH, so Homebrew tools are found directly.
function findBinary(name, bundleDir) {
  for (const dir of [bundleDir, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].filter(Boolean)) {
    const p = path.join(dir, name);
    if (existsSync(p)) return p;
  }
  return name;
}

// Captures macOS system audio (the other side of the call, "them"), segments
// speech, and emits transcript lines, transcribed one segment at a time. The
// mic is never recorded.
export class Listener extends EventEmitter {
  // whisperDir: the whisper.cpp build bundled with the app, if any.
  // silentAfterMs: see "silent" below.
  constructor({ modelPath, prompt, audioteePath, whisperDir, whisperBinary = findBinary("whisper-cli", whisperDir), silentAfterMs = 15000 }) {
    super();
    this.silentAfterMs = silentAfterMs;
    this.audioteePath = audioteePath;
    this.opts = { modelPath, prompt, binary: whisperBinary };
    this.server = new WhisperServer(findBinary("whisper-server", whisperDir));
    this.pending = [];
    this.working = false;
    this.running = false;
  }

  // Returns false (with one clear error) when a required tool is missing.
  start() {
    if (this.running) return true;
    if (!path.isAbsolute(this.opts.binary) || !existsSync(this.opts.binary)) {
      this.emit("error", "Listening needs whisper-cpp. Install with: brew install whisper-cpp");
      return false;
    }
    if (!existsSync(this.opts.modelPath)) {
      this.emit("error", "The speech model is missing. Rebuild Glance after downloading it (see README).");
      return false;
    }
    this.running = true;
    this.reportedFailure = false;
    this.server.start(this.opts);
    this.them = new Segmenter();
    this.them.on("segment", (pcm) => this.enqueue(pcm));

    const tee = new AudioTee({ sampleRate: SAMPLE_RATE, chunkDurationMs: 100, binaryPath: this.audioteePath });
    this.tee = tee;
    // System audio is the only source, so losing it ends listening instead of
    // leaving Listen on while nothing is captured. Our own stop() is ignored.
    const failed = (text) => {
      if (!this.running || this.tee !== tee) return;
      this.emit("error", `${text} Check System Settings > Privacy & Security > Screen & System Audio Recording, then press Listen again.`);
      this.stop();
      this.emit("ended");
    };
    // macOS gives exact digital silence, with no error, while system audio
    // access is off or the app hasn't been reopened since it was granted.
    // "silent" fires once if nothing but zeros arrives for silentAfterMs.
    this.heardSound = false;
    clearTimeout(this.silentTimer);
    this.silentTimer = setTimeout(() => {
      if (this.running && this.tee === tee && !this.heardSound) this.emit("silent");
    }, this.silentAfterMs);
    tee.on("data", ({ data }) => {
      if (!this.heardSound && data.some((b) => b !== 0)) this.heardSound = true;
      this.them.push(data);
    });
    tee.on("error", (e) => failed(`System audio failed: ${e.message}.`));
    tee.on("stop", () => failed("System audio capture stopped."));
    tee.start().catch((e) => failed(`System audio failed: ${e.message}.`));
    return true;
  }

  // Takes effect from the next segment; no restart needed.
  setTranscription({ modelPath, prompt }) {
    this.opts = { ...this.opts, modelPath, prompt };
    if (this.running) this.server.start(this.opts);
  }

  // True while the other side is mid-phrase or their last words are still
  // being transcribed: a question heard now may not be complete yet.
  hearing() {
    return this.running && (!!this.them?.speaking || this.working || this.pending.length > 0);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    clearTimeout(this.silentTimer);
    this.tee?.stop().catch(() => {});
    this.them?.flush();
    if (!this.working) this.server.stop();
  }

  enqueue(pcm) {
    this.pending.push({ pcm, at: Date.now() });
    this.drain();
  }

  async drain() {
    if (this.working) return;
    this.working = true;
    let item;
    while ((item = this.pending.shift())) {
      const { pcm, at } = item;
      let text = await this.server.transcribe(pcm);
      if (text === null) {
        const r = await whisper(this.opts, pcm);
        if (r.error) {
          // Once per listen: a broken transcriber fails on every segment.
          if (!this.reportedFailure) this.emit("error", `Transcription failed: ${r.error}`);
          this.reportedFailure = true;
          continue;
        }
        text = r.text;
      } else if (NOISE.test(text)) text = "";
      // start: when the speech began; at: when it ended.
      if (text) this.emit("line", { role: "them", text, at, start: at - Math.round((pcm.length / 2 / SAMPLE_RATE) * 1000) });
    }
    this.working = false;
    if (!this.running) this.server.stop(); // stopped meanwhile: free the model now the last segments are done
  }
}
