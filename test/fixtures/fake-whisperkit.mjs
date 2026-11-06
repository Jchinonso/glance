#!/usr/bin/env node
// A stand-in for glance-whisper (native/glance-whisper) speaking its JSON-lines
// protocol, for tests. FAKE_WK sets how it behaves:
//   ok        downloads, loads and transcribes ("hello from whisperkit")
//   error     transcribe replies with an error
//   crash     exits on every transcribe, like a native crash
//   loadfail  load replies with an error
//   slowload  load takes FAKE_WK_LOAD_MS (default 60000) before ready
// FAKE_WK_TEXT overrides the transcript. --models <dir>: download writes the
// same files WhisperKit would, so the app sees the model as installed.
import { mkdirSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

const mode = process.env.FAKE_WK || "ok";
const text = process.env.FAKE_WK_TEXT || "hello from whisperkit";
const args = process.argv.slice(2);
const models = args[args.indexOf("--models") + 1];
const variant = args.includes("--variant") ? args[args.indexOf("--variant") + 1] : "openai_whisper-large-v3-v20240930_turbo_632MB";
const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
// FAKE_WK_LOG: one line per request, so tests can see what the app asked for.
const note = (o) => process.env.FAKE_WK_LOG && appendFileSync(process.env.FAKE_WK_LOG, `${JSON.stringify(o)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const variantDir = path.join(models, "models", "argmaxinc", "whisperkit-coreml", variant);
const tokenizerDir = path.join(models, "models", "openai", "whisper-large-v3");
let loaded = false;

const rl = readline.createInterface({ input: process.stdin });
const queue = [];
let busy = false;
rl.on("line", (line) => {
  queue.push(line);
  pump();
});
rl.on("close", () => {
  queue.push('{"op":"quit"}');
  pump();
});

async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) await handle(queue.shift());
  busy = false;
}

async function handle(line) {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  note(req);
  if (req.op === "quit") process.exit(0);
  if (req.op === "download") {
    if (!existsSync(path.join(variantDir, ".glance-complete"))) {
      const total = 1000;
      for (const received of [0, 400, 1000]) {
        send({ event: "download", received, total, fraction: received / total });
        await sleep(20);
      }
      mkdirSync(variantDir, { recursive: true });
      mkdirSync(tokenizerDir, { recursive: true });
      writeFileSync(path.join(tokenizerDir, "tokenizer.json"), "{}");
      writeFileSync(path.join(variantDir, ".glance-complete"), "");
    }
    return send({ event: "downloaded" });
  }
  if (req.op === "load") {
    send({ event: "loading" });
    if (mode === "loadfail") return send({ event: "error", message: "Core ML couldn't load the model" });
    await sleep(mode === "slowload" ? Number(process.env.FAKE_WK_LOAD_MS || 60000) : 20);
    loaded = true;
    return send({ event: "ready", loadMs: 20 });
  }
  if (req.op === "transcribe") {
    if (!loaded) return send({ id: req.id, error: "model not loaded" });
    if (mode === "crash") process.kill(process.pid, "SIGABRT");
    if (mode === "error") return send({ id: req.id, error: "decoding failed" });
    return send({ id: req.id, text: ` ${text} `, ms: 5 });
  }
}
