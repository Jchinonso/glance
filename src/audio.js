import { EventEmitter } from "node:events";
import { AudioTee } from "audiotee";

const SAMPLE_RATE = 16000;
const FRAME = 480; // 30 ms at 16 kHz
const PRE_ROLL_FRAMES = 10; // keep 300 ms before speech starts
const END_SILENCE_FRAMES = 14; // ~420 ms of silence ends a segment; a question split by a pause is rejoined later
// 12 s hard cap: a long turn is transcribed in pieces as it goes, so its
// first words show up while they're still talking.
const MAX_SEGMENT_FRAMES = 400;
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

// Text the speech engine sometimes makes of noise; dropped.
const NOISE = /^\s*(\[.*\]|\(.*\)|you|thank you\.?|thanks for watching!?|\.+)\s*$/i;

// Captures macOS system audio (the other side of the call, "them"), segments
// speech, and emits transcript lines, transcribed one segment at a time by
// the speech engine (asr.js). The mic is never recorded.
export class Listener extends EventEmitter {
  // asr: an Asr (asr.js), or anything with load() and transcribe(pcm, { hotwords }).
  // hotwords: phrases to listen for (tech terms, the user's words).
  // silentAfterMs: see "silent" below.
  constructor({ asr, hotwords = [], audioteePath, silentAfterMs = 15000 }) {
    super();
    this.asr = asr;
    this.hotwords = hotwords;
    this.silentAfterMs = silentAfterMs;
    this.audioteePath = audioteePath;
    this.pending = [];
    this.working = false;
    this.running = false;
    this.heardSound = false; // any sound since Glance opened
    this.warnedSilent = false;
  }

  // Loads the model when Glance opens, so the first Listen is instant.
  prepare() {
    return this.asr?.load?.({ hotwords: this.hotwords });
  }

  // The engine, once the model is in (Glance can open before it is).
  setAsr(asr) {
    this.asr = asr;
  }

  // From the next segment.
  setHotwords(hotwords) {
    this.hotwords = hotwords;
  }

  // Returns false (with one clear error) when it can't listen.
  start() {
    if (this.running) return true;
    if (!this.asr) {
      this.emit("error", "The speech model is missing. Quit and reopen Glance to download it.");
      return false;
    }
    this.running = true;
    this.reportedFailure = false;
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
    // "silent" fires if nothing but zeros arrives for silentAfterMs. Nothing
    // playing yet (Listen pressed before the call starts) looks the same, so
    // it fires at most once each time Glance opens (not per Listen), and never
    // once any sound has come through: access is evidently working.
    clearTimeout(this.silentTimer);
    if (!this.heardSound && !this.warnedSilent) {
      this.silentTimer = setTimeout(() => {
        if (!this.running || this.tee !== tee || this.heardSound) return;
        this.warnedSilent = true;
        this.emit("silent");
      }, this.silentAfterMs);
    }
    tee.on("data", ({ data }) => {
      if (!this.heardSound && data.some((b) => b !== 0)) this.heardSound = true;
      this.them.push(data);
    });
    tee.on("error", (e) => failed(`System audio failed: ${e.message}.`));
    tee.on("stop", () => failed("System audio capture stopped."));
    tee.start().catch((e) => failed(`System audio failed: ${e.message}.`));
    return true;
  }

  // True while the other side is mid-phrase or their last words are still
  // being transcribed (also just after Stop): a question heard now may not be
  // complete yet.
  hearing() {
    return (this.running && !!this.them?.speaking) || this.working || this.pending.length > 0;
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    clearTimeout(this.silentTimer);
    this.tee?.stop().catch(() => {});
    this.them?.flush();
    // The model stays loaded for the next Listen.
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
      const began = Date.now();
      const r = await this.asr.transcribe(pcm, { hotwords: this.hotwords });
      if (typeof r?.text !== "string") {
        // The engine crashed or got stuck; it restarts for the next piece.
        // This piece gets one more try.
        if (!item.retried) {
          item.retried = true;
          this.emit("detail", `transcription failed, retrying that piece: ${r?.error}`);
          this.pending.unshift(item);
          continue;
        }
        // Once per listen: the window gets a plain sentence; the details go to the log.
        if (!this.reportedFailure) {
          this.emit("detail", `transcription failed: ${r?.error}`);
          this.emit("error", "Glance can't transcribe on this Mac right now, so it can't hear the call. Quit and reopen Glance, then press Listen. If it keeps happening, send the file glance.log from Library › Logs › Glance to whoever set Glance up.");
        }
        this.reportedFailure = true;
        continue;
      }
      const text = NOISE.test(r.text) ? "" : r.text.replace(/\s+/g, " ").trim();
      const transcribedAt = Date.now();
      // start: when the speech began; at: when it ended. decodeMs: the
      // engine's own time; transcribeMs adds the trip to and from it.
      if (text) this.emit("line", { role: "them", text, at, start: at - Math.round((pcm.length / 2 / SAMPLE_RATE) * 1000), transcribeMs: transcribedAt - began, decodeMs: r.ms, transcribedAt, queued: this.pending.length, via: "parakeet" });
    }
    this.working = false;
  }
}
