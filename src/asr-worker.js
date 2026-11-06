// The speech engine's own process (see asr.js): NVIDIA Parakeet TDT 0.6B v2
// (English, int8) through sherpa-onnx, on the CPU. A decode takes most of a
// second of CPU, so it never runs in Glance's main process, and a crash here
// only stops this process.
//
// Messages in:  { type: "load", modelDir, hotwords }
//               { type: "transcribe", id, pcm (16 kHz mono int16), hotwords }
// Messages out: { type: "ready", loadMs, used, skipped }
//               { type: "result", id, text, ms }
//               { type: "error", id?, message }
//               { type: "log", text }
// hotwords: phrases to listen for (see hotwords.js). A different list that
// needs other pieces reloads the model (about 2 s), which only happens when
// Settings › Words to recognize changes.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { planHotwords, readTokens } from "./hotwords.js";

// Electron's utility process, or a Node child process (tests, scripts).
const port = process.parentPort
  ? { on: (fn) => process.parentPort.on("message", (e) => fn(e.data)), send: (m) => process.parentPort.postMessage(m) }
  : { on: (fn) => process.on("message", fn), send: (m) => process.send(m) };

const vocabPath = path.join(os.tmpdir(), `glance-hotwords-${process.pid}.vocab`);
process.on("exit", () => rmSync(vocabPath, { force: true }));

// sherpa-onnx, or a stand-in module named by GLANCE_TEST_ASR (tests never
// load the real model). Both have create(config) -> { decode(samples, hotwords) }.
async function engine() {
  if (process.env.GLANCE_TEST_ASR) return import(pathToFileURL(process.env.GLANCE_TEST_ASR).href);
  const sherpa = createRequire(import.meta.url)("sherpa-onnx-node");
  return {
    create({ modelDir, bpeVocab }) {
      const file = (name) => path.join(modelDir, name);
      const rec = new sherpa.OfflineRecognizer({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          transducer: { encoder: file("encoder.int8.onnx"), decoder: file("decoder.int8.onnx"), joiner: file("joiner.int8.onnx") },
          tokens: file("tokens.txt"),
          numThreads: 4,
          provider: "cpu",
          modelType: "nemo_transducer",
          debug: 0,
          ...(bpeVocab ? { modelingUnit: "bpe", bpeVocab } : {}),
        },
        // Beam search: as fast as greedy here, and it gets "Postgres" right
        // where greedy wrote "postcars". Hotwords need it too.
        decodingMethod: "modified_beam_search",
        maxActivePaths: 4,
      });
      return {
        decode(samples, hotwords) {
          const stream = hotwords ? rec.createStream(hotwords) : rec.createStream();
          stream.acceptWaveform({ samples, sampleRate: 16000 });
          rec.decode(stream);
          return rec.getResult(stream).text;
        },
      };
    },
  };
}

let mod = null;
let rec = null;
let loaded = null; // { modelDir, vocab } the recognizer was made with
let tokens = null;
let plans = new Map(); // hotword list -> plan

function plan(modelDir, hotwords = []) {
  const key = JSON.stringify(hotwords);
  if (!plans.has(key)) {
    tokens ??= readTokens(readFileSync(path.join(modelDir, "tokens.txt"), "utf8"));
    const p = planHotwords(hotwords, tokens);
    if (p.skipped.length) port.send({ type: "log", text: `hotwords skipped (can't be spelled with the model's pieces): ${p.skipped.join(", ")}` });
    plans = new Map([[key, p]]); // only the current list is kept
  }
  return plans.get(key);
}

async function ensure(modelDir, hotwords) {
  const p = plan(modelDir, hotwords);
  if (rec && loaded.modelDir === modelDir && loaded.vocab === p.vocab) return { p, loadMs: null };
  mod ??= await engine();
  const started = Date.now();
  if (p.vocab) writeFileSync(vocabPath, p.vocab);
  rec = null; // let the old model go before the new one loads
  rec = mod.create({ modelDir, bpeVocab: p.vocab ? vocabPath : null });
  loaded = { modelDir, vocab: p.vocab };
  return { p, loadMs: Date.now() - started };
}

function samplesOf(pcm) {
  const bytes = pcm instanceof Uint8Array ? pcm : new Uint8Array(pcm);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(Math.floor(bytes.byteLength / 2));
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
  return samples;
}

// One message at a time, in order: a decode never overlaps a load.
let queue = Promise.resolve();
port.on((msg) => {
  queue = queue.then(() => handle(msg)).catch((e) => port.send({ type: "error", id: msg?.id, message: String(e?.stack || e) }));
});

async function handle(msg) {
  if (msg?.type === "load") {
    const reload = !!rec;
    const { p, loadMs } = await ensure(msg.modelDir, msg.hotwords);
    port.send({ type: "ready", loadMs: loadMs ?? 0, used: p.used.length, skipped: p.skipped, reload });
  } else if (msg?.type === "transcribe") {
    const { p, loadMs } = await ensure(msg.modelDir, msg.hotwords);
    if (loadMs !== null) port.send({ type: "log", text: `model reloaded for new hotwords in ${loadMs}ms (${p.used.length} phrases)` });
    const started = Date.now();
    const text = rec.decode(samplesOf(msg.pcm), p.hotwords);
    port.send({ type: "result", id: msg.id, text: String(text ?? "").trim(), ms: Date.now() - started });
  }
}
