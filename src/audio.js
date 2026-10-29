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
const END_SILENCE_FRAMES = 27; // ~800 ms of silence ends a segment
const MAX_SEGMENT_FRAMES = 500; // 15 s hard cap
const MIN_SPEECH_FRAMES = 12; // drop blips under ~360 ms

// Energy-based voice activity detector that cuts a 16 kHz mono int16 stream
// into speech segments. Noise floor adapts while nobody is talking.
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
    this.lastSpeechAt = 0;
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
    const isSpeech = rms > this.floor * 2.5 + 150;
    if (!isSpeech && !this.speaking) this.floor = this.floor * 0.98 + rms * 0.02;
    if (isSpeech) this.lastSpeechAt = Date.now();

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

  isActive(withinMs = 600) {
    return this.speaking || Date.now() - this.lastSpeechAt < withinMs;
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
      ["-m", modelPath, "-f", file, "-l", "en", "-nt", "-np", "-t", "4", ...(prompt ? ["--prompt", prompt] : [])],
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

// Apps launched from Finder don't inherit the shell PATH, so find Homebrew tools directly.
function findBinary(name) {
  for (const dir of ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]) {
    const p = path.join(dir, name);
    if (existsSync(p)) return p;
  }
  return name;
}

// Captures the mic ("me") and macOS system audio ("them"), segments speech,
// and emits transcript lines. Transcription runs one segment at a time.
export class Listener extends EventEmitter {
  constructor({ modelPath, prompt, audioteePath, whisperBinary = findBinary("whisper-cli"), soxBinary = findBinary("rec") }) {
    super();
    this.audioteePath = audioteePath;
    this.opts = { modelPath, prompt, binary: whisperBinary };
    this.soxBinary = soxBinary;
    this.queue = Promise.resolve();
    this.running = false;
  }

  // Returns false (with one clear error) when a required tool is missing.
  start() {
    if (this.running) return true;
    const missing = [
      [this.soxBinary, "sox"],
      [this.opts.binary, "whisper-cpp"],
    ].filter(([bin]) => !path.isAbsolute(bin) || !existsSync(bin));
    if (missing.length) {
      this.emit("error", `Listening needs ${missing.map(([, pkg]) => pkg).join(" and ")}. Install with: brew install ${missing.map(([, pkg]) => pkg).join(" ")}`);
      return false;
    }
    if (!existsSync(this.opts.modelPath)) {
      this.emit("error", "The speech model is missing. Rebuild Glance after downloading it (see README).");
      return false;
    }
    this.running = true;
    this.me = new Segmenter();
    this.them = new Segmenter();
    this.me.on("segment", (pcm) => {
      // Without headphones the mic hears the speakers; skip echo of "them".
      if (this.them.isActive()) return;
      this.enqueue("me", pcm);
    });
    this.them.on("segment", (pcm) => this.enqueue("them", pcm));

    this.mic = spawn(this.soxBinary, ["-q", "-c", "1", "-r", String(SAMPLE_RATE), "-b", "16", "-e", "signed-integer", "-t", "raw", "-"]);
    this.mic.stdout.on("data", (d) => this.me.push(d));
    this.mic.on("error", (e) => this.emit("error", `Mic capture failed: ${e.message}`));
    const mic = this.mic;
    mic.on("exit", (code) => {
      // Only this run's process matters; an old one exiting after a restart doesn't.
      if (!this.running || this.mic !== mic) return;
      this.emit("error", `Microphone capture stopped${code ? ` (exit ${code})` : ""}. Check the input device and microphone permission, then press Listen again.`);
      this.stop();
      this.emit("ended");
    });

    this.tee = new AudioTee({ sampleRate: SAMPLE_RATE, chunkDurationMs: 100, binaryPath: this.audioteePath });
    this.tee.on("data", ({ data }) => this.them.push(data));
    this.tee.on("error", (e) => this.emit("error", `System audio failed: ${e.message}`));
    this.tee.start().catch((e) => this.emit("error", `System audio failed: ${e.message}`));
    return true;
  }

  // Takes effect from the next segment; no restart needed.
  setTranscription({ modelPath, prompt }) {
    this.opts = { ...this.opts, modelPath, prompt };
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this.mic?.kill("SIGTERM");
    this.tee?.stop().catch(() => {});
    this.me?.flush();
    this.them?.flush();
  }

  enqueue(role, pcm) {
    const at = Date.now();
    this.queue = this.queue.then(async () => {
      const { text, error } = await whisper(this.opts, pcm);
      if (error) this.emit("error", `Transcription failed: ${error}`);
      else if (text) this.emit("line", { role, text, at });
    });
  }
}
