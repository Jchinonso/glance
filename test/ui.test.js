// Clicks through the real app: Electron in test mode (GLANCE_TEST_DIR: its own
// settings folder, no keychain, no global shortcuts, a see-through window),
// answered by a fake OpenAI-compatible server, driven over the DevTools
// protocol. Set GLANCE_SKIP_UI=1 to skip.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";
import { MODELS } from "../src/models.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const skip = !!process.env.GLANCE_SKIP_UI || process.platform !== "darwin";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The fake model: streams a fixed interview-style answer and records requests.
const ANSWER = "**I led our billing migration to Postgres.**\nKeys: billing migration · 40% fewer errors · staged rollout\n\nAt Acme Pay our invoices drifted out of sync, so I moved billing into Postgres transactions.\n\nWe ran both systems side by side and errors fell 40%.\n\n*Added: the side-by-side run. Check it fits.*";
const requests = [];
let server;
let modelUrl;

let app;
let dir;
let ws;
let nextId = 0;
const waiting = new Map();

function cdp(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++nextId;
    waiting.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

// Runs an expression in the window (async allowed) and returns its value.
async function run(expression) {
  const r = await cdp("Runtime.evaluate", { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "evaluation failed");
  return r.result?.result?.value;
}

// Polls until the expression is truthy.
async function until(expression, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await run(`return !!(${expression});`)) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${expression}`);
}

const click = (selector) => run(`document.querySelector(${JSON.stringify(selector)}).click();`);
const shown = (id) => run(`return !document.getElementById(${JSON.stringify(id)}).hidden;`);

before(async () => {
  if (skip) return;
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const request = JSON.parse(body || "{}");
      requests.push(request);
      // Model listing for the provider form.
      if (req.method === "GET" && req.url.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ data: [{ id: "fake", name: "Fake Model" }, { id: "alpha", name: "Alpha" }] }));
      }
      // Test connection: the smallest possible chat request.
      if (request.messages?.length === 1 && request.messages[0]?.content === "Hi") {
        if (request.model === "bad") {
          res.writeHead(401, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: { message: "invalid api key" } }));
        }
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ choices: [{ message: { content: "Hi" }, finish_reason: "stop" }] }));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      // Auto-answer's turn-end check on an introduction: nothing to answer.
      const asked = request.messages?.[1]?.content?.at(-1)?.text ?? "";
      if (asked.includes("reply exactly <none>") && /Interviewer's latest turn: [^\n]*\bwelcome\b/i.test(asked)) {
        for (const piece of ["<no", "ne>"]) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
        return res.end();
      }
      // "slowly" in the question being asked (not earlier answers): one piece,
      // then hang until stopped.
      if (/Question: [^\n]*slowly/.test(request.messages?.[1]?.content?.at(-1)?.text ?? "")) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "**Partly answered.**" } }] })}\n\n`);
        return res.on("close", () => res.end()); // until the app hangs up
      }
      for (const piece of ANSWER.match(/[\s\S]{1,24}/g)) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
        await sleep(5);
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  modelUrl = `http://127.0.0.1:${server.address().port}/v1`;

  dir = mkdtempSync(path.join(os.tmpdir(), "glance-ui-"));
  writeFileSync(path.join(dir, "config.json"), JSON.stringify({ provider: "openai", openaiBaseUrl: modelUrl, openaiModel: "fake", autoScreen: false, style: "brief",
    // As written by builds before 1.2.4: every setting saved, Opus included.
    model: "claude-opus-5-5", effort: "low", invisible: true }));
  // The speech model is already installed in this folder, so the UI tests don't
  // download it. The size check is all findModel needs.
  mkdirSync(path.join(dir, "models"), { recursive: true });
  const modelFile = path.join(dir, "models", MODELS["small.en"].file);
  writeFileSync(modelFile, "");
  truncateSync(modelFile, MODELS["small.en"].size);
  const port = 9400 + Math.floor(Math.random() * 500);
  app = spawn(electronPath, [root, `--remote-debugging-port=${port}`], { env: { ...process.env, GLANCE_TEST_DIR: dir }, stdio: "ignore" });
  let page;
  for (let i = 0; i < 100 && !page; i++) {
    await sleep(100);
    try {
      page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page");
    } catch {}
  }
  assert.ok(page, "Glance's window never appeared");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    waiting.get(d.id)?.(d);
  };
  await new Promise((r) => (ws.onopen = r));
  await until(`typeof state !== "undefined" && state.shortcuts`);
});

after(async () => {
  ws?.close();
  server?.close();
  // Electron writes to its folder while quitting, so remove it after exit.
  if (app && app.exitCode === null) await new Promise((r) => (app.once("exit", r), app.kill()));
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("old settings: Opus moves to the default, other providers' model stays, defaults aren't saved", { skip }, async () => {
  assert.equal(await run(`return state.model;`), "claude-sonnet-5-5");
  assert.equal(await run(`return state.provider;`), "openai");
  const saved = JSON.parse(readFileSync(path.join(dir, "config.json"), "utf8"));
  assert.equal(saved.openaiModel, "fake");
  assert.equal(saved.configVersion, 1);
  for (const k of ["model", "effort", "invisible"]) assert.ok(!(k in saved), `${k} is a default, not saved`);
});

test("first launch: welcome, about you, job description, ready", { skip }, async () => {
  assert.equal(await run(`return onboarding?.step;`), "welcome");
  assert.ok(await run(`return document.body.classList.contains("onboarding");`));
  await click("#obNext");
  assert.equal(await run(`return onboarding.step;`), "about"); // a working setup skips the key step
  await click('#obUse [data-value="meetings"]');
  assert.equal(await run(`return onboardingSteps(onboarding).join();`), "welcome,about,ready");
  assert.ok(!(await run(`return document.getElementById("obNext").disabled;`)), "meetings: resume optional");
  await click('#obUse [data-value="interviews"]');
  // Interviews need a resume: Next waits for one.
  assert.ok(await run(`return document.getElementById("obNext").disabled;`), "interviews: Next waits for a resume");
  assert.match(await run(`return document.getElementById("obResumeNeed").textContent;`), /required for interviews/);
  await run(`const r = document.getElementById("obResume"); r.value = "Jane Doe, Backend Engineer at Acme Pay since 2021."; r.dispatchEvent(new Event("input"));`);
  assert.ok(!(await run(`return document.getElementById("obNext").disabled;`)));
  await click("#obNext");
  assert.equal(await run(`return onboarding.step;`), "job");
  await click("#obBack");
  assert.equal(await run(`return onboarding.step;`), "about");
  await click("#obNext");
  await click("#obNext");
  assert.equal(await run(`return onboarding.step;`), "ready");
  await click("#obNext");
  await until(`onboarding === null && state.onboarded && state.style === "interview"`);
  assert.ok(await shown("modePick"));
});

test("setup: a missing speech model gets a compulsory step with progress and Try again", { skip }, async () => {
  await run(`state.onboarded = false; state.speech = { status: "downloading", model: "small.en", received: 123000000, total: 488000000, error: null };
    onboarding = { step: "welcome", needsKey: false, needsModel: true, use: "interviews", hide: false }; render();`);
  // Skip setup can't leave setup on any step while the model downloads.
  assert.equal(await run(`return document.getElementById("onboardSkip").hidden;`), true);
  await run(`document.getElementById("onboardSkip").click();`);
  assert.equal(await run(`return onboarding.step;`), "welcome");
  await click("#obNext");
  assert.equal(await run(`return onboarding.step;`), "speech");
  assert.equal(await run(`return document.querySelector('#onboard [data-step="speech"] .ob-title').textContent;`), "Download the speech model");
  assert.match(await run(`return document.querySelector('#onboard [data-step="speech"] .ob-lead').textContent;`), /Glance needs this to transcribe calls\. This one-time download is about 490 MB\./);
  assert.equal(await run(`return document.getElementById("obSpeechMeta").textContent;`), "123 of 488 MB");
  assert.equal(await run(`return document.getElementById("obNext").textContent;`), "Continue");
  assert.match(await run(`return document.getElementById("obSpeechFill").style.width;`), /25/);
  // Continue and Skip setup do nothing until the model is installed.
  assert.ok(await run(`return document.getElementById("obNext").disabled;`), "Continue is disabled during the download");
  assert.equal(await run(`return document.getElementById("onboardSkip").hidden;`), true);
  await click("#obNext");
  await run(`document.getElementById("onboardSkip").click();`);
  assert.equal(await run(`return onboarding.step;`), "speech");

  // Ready moves on by itself.
  await run(`onboarding.step = "speech"; state.speech = { status: "ready", model: "small.en", received: 488000000, total: 488000000, error: null }; render();`);
  assert.equal(await run(`return onboarding.step;`), "about");

  // Failure shows the message and a Try again button that asks for a retry.
  await run(`onboarding.step = "speech"; state.speech = { status: "error", model: "small.en", received: 1000, total: 488000000, error: "No connection." }; render();`);
  assert.ok(await shown("obSpeechError"));
  assert.equal(await run(`return document.getElementById("obSpeechError").textContent;`), "No connection.");
  assert.ok(await run(`return document.getElementById("obNext").disabled;`), "a failed download can't be skipped");
  await run(`window.__retried = false; requestSpeechDownload = () => { window.__retried = true; };`);
  await click("#obSpeechRetry");
  assert.equal(await run(`return window.__retried;`), true);
  await run(`requestSpeechDownload = () => g.downloadModel(); onboarding = null; state.onboarded = true; state.speech = { status: "ready", model: "small.en", received: 488000000, total: 488000000, error: null }; render();`);
});

test("setup: an installed speech model means no speech step", { skip }, async () => {
  assert.equal(await run(`return onboardingSteps({ needsKey: false, needsModel: false, use: "interviews" }).includes("speech");`), false);
  await run(`state.onboarded = false; state.speech = { status: "ready", model: "small.en", received: 488000000, total: 488000000, error: null }; startOnboarding(); render();`);
  assert.equal(await run(`return onboarding.step;`), "welcome");
  await click("#obNext");
  assert.notEqual(await run(`return onboarding.step;`), "speech");
  await run(`onboarding = null; state.onboarded = true; render();`);
});

test("setup: a returning user's speech step closes setup once the model is ready", { skip }, async () => {
  await run(`state.onboarded = true; state.style = "brief"; state.resume = "Jane Doe, engineer";
    state.speech = { status: "downloading", model: "small.en", received: 100000000, total: 488000000, error: null };
    startOnboarding("speech"); render();`);
  assert.equal(await run(`return onboarding.step;`), "speech");
  assert.ok(await run(`return document.getElementById("obNext").disabled;`));
  assert.equal(await run(`return document.getElementById("onboardSkip").hidden;`), true);
  await click("#obNext");
  assert.equal(await run(`return onboarding.step;`), "speech", "Continue waits for the model");
  // Ready closes setup on its own for a returning user.
  await run(`state.speech = { status: "ready", model: "small.en", received: 488000000, total: 488000000, error: null }; render();`);
  await until(`onboarding === null`);
  assert.equal(await run(`return state.onboarded;`), true);

  // Interview mode still needs the resume step before setup can close.
  await run(`state.onboarded = true; state.style = "interview"; state.resume = "";
    state.speech = { status: "downloading", model: "small.en", received: 100000000, total: 488000000, error: null };
    startOnboarding("speech"); render();`);
  assert.equal(await run(`return onboarding.step;`), "speech");
  await click("#obNext");
  assert.equal(await run(`return onboarding.step;`), "speech");
  await run(`state.speech = { status: "ready", model: "small.en", received: 488000000, total: 488000000, error: null }; render();`);
  await until(`onboarding?.step === "about"`);
  assert.ok(await shown("obResume"));
  await run(`onboarding = null;
    await g.setSetting("resume", "Jane Doe, engineer");
    await g.setSetting("style", "brief");
    await g.setSetting("setupActive", false);
    state.speech = { status: "ready", model: "small.en", received: 488000000, total: 488000000, error: null };
    render();`);
  await until(`state.style === "brief" && !!state.resume`);
});

test("setup: a speech step that finished by itself doesn't bounce when you go Back", { skip }, async () => {
  await run(`onboarding = null; state.onboarded = false; state.style = "brief";
    state.speech = { status: "downloading", model: "small.en", received: 100000000, total: 488000000, error: null };
    onboarding = { step: "speech", needsKey: false, needsModel: true, use: "meetings", hide: false }; render();`);
  assert.equal(await run(`return onboarding.sawSpeechDownloading;`), true);
  await run(`state.speech = { status: "ready", model: "small.en", received: 488000000, total: 488000000, error: null }; render();`);
  assert.equal(await run(`return onboarding.step;`), "about");
  assert.equal(await run(`return !!onboarding.sawSpeechDownloading;`), false);
  // Back onto the installed step stays there instead of bouncing forward.
  await click("#obBack");
  assert.equal(await run(`return onboarding.step;`), "speech");
  assert.ok(await shown("obSpeechDone"));
  assert.equal(await run(`return document.getElementById("obNext").textContent;`), "Continue");
  assert.ok(!(await run(`return document.getElementById("obNext").disabled;`)), "an installed model enables Continue");
  await click("#obNext");
  assert.equal(await run(`return onboarding.step;`), "about");
  await run(`onboarding = null; state.onboarded = true; state.style = "brief"; await g.setSetting("setupActive", false); render();`);
});

test("settings: every tab, and each form goes back to the tab it came from", { skip }, async () => {
  await run(`if (!document.getElementById("jdCard").hidden) document.getElementById("jdSame").click();`);
  await click("#menuBtn");
  assert.ok(await shown("menu"));
  for (const tab of ["answers", "interview", "session", "general"]) {
    await click(`#settingsTabs [data-tab="${tab}"]`);
    assert.ok(await run(`return !document.querySelector('#menu .tab[data-tab="${tab}"]').hidden;`), tab);
  }
  await click('#settingsTabs [data-tab="interview"]');

  await click("#resumeBtn");
  assert.ok(await shown("docForm"));
  assert.ok(await run(`return document.querySelector(".dock").hidden;`), "the question box hides behind forms");
  await click("#docForm [data-back]");
  assert.ok(await shown("menu"));
  assert.equal(await run(`return settingsTab;`), "interview");

  await click("#profileBtn");
  assert.ok(await shown("profileForm"));
  await run(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));`);
  assert.ok(await shown("menu"), "Esc goes back to Settings");

  await click('#settingsTabs [data-tab="session"]');
  await click("#transcriptToggle");
  assert.ok(await shown("transcript"));
  await click("#transcript [data-back]");
  assert.ok(await shown("menu"), "the transcript goes back to Settings");

  await click('#settingsTabs [data-tab="general"]');
  await click("#shortcutsBtn");
  assert.ok(await shown("shortcutsPanel"));
  await click("#shortcutsDone");
  assert.ok(await shown("menu"));

  await click('#settingsTabs [data-tab="answers"]');
  await click("#keyBtn");
  assert.ok(await shown("keyForm"));
  await click("#cancelKeyBtn");
  assert.ok(await shown("menu"));

  // A form opened outside Settings closes to the answers.
  await click("#menuBtn");
  assert.ok(!(await shown("menu")));
  await run(`openDoc("jobDescription");`);
  await click("#docCancel");
  assert.ok(!(await shown("menu")) && !(await shown("docForm")));
  assert.equal(await run(`return panel;`), null);
});

test("Appearance setting: Light then Dark updates the setting and aria-checked", { skip }, async () => {
  await run(`setMenu(true); document.querySelector('#settingsTabs [data-tab="general"]').click(); render();`);
  assert.ok(await shown("menu"));
  const checked = () => run(`return [...document.querySelectorAll("#theme button")].map((b) => [b.dataset.value, b.getAttribute("aria-checked")]);`);
  assert.deepEqual(await checked(), [["system", "true"], ["light", "false"], ["dark", "false"]]);
  await click('#theme [data-value="light"]');
  await until(`state.theme === "light"`);
  assert.deepEqual(await checked(), [["system", "false"], ["light", "true"], ["dark", "false"]]);
  assert.equal(await run(`return (await g.getState()).theme;`), "light");
  await click('#theme [data-value="dark"]');
  await until(`state.theme === "dark"`);
  assert.deepEqual(await checked(), [["system", "false"], ["light", "false"], ["dark", "true"]]);
  assert.equal(await run(`return (await g.getState()).theme;`), "dark");
  await run(`await g.setSetting("theme", "system"); setMenu(false);`);
  await until(`state.theme === "system"`);
});

test("mode menu switches Interview and Meeting", { skip }, async () => {
  await click("#modeBtn");
  assert.ok(await shown("modeMenu"));
  await click('#modeMenu [data-value="meeting"]');
  await until(`state.style !== "interview"`);
  assert.ok(!(await shown("modeMenu")));
  assert.equal(await run(`return document.getElementById("modeLabel").textContent;`), "Meeting");
  await click("#modeBtn");
  await click('#modeMenu [data-value="interview"]');
  await until(`state.style === "interview"`);
  await run(`if (!document.getElementById("jdCard").hidden) document.getElementById("jdSame").click();`);
});

test("a typed question streams an answer", { skip }, async () => {
  await run(`document.getElementById("question").value = "Tell me about a reliability win"; document.getElementById("askBtn").click();`);
  await until(`answers.length === 1 && answers[0].status === "done"`);
  assert.match(await run(`return document.getElementById("answerBody").textContent;`), /billing migration/);
  assert.match(requests.at(-1).messages[1].content.at(-1).text, /Tell me about a reliability win/);
});

test("answers open in full by default; key points are a setting and a per-answer switch", { skip }, async () => {
  const body = () => run(`return document.getElementById("answerBody").textContent;`);
  assert.match(await body(), /errors fell 40%/, "full by default");
  assert.ok(!(await body()).includes("Keys:"), "the Keys line never shows as text");
  assert.equal(await run(`return document.getElementById("viewToggle").textContent;`), "Key points");
  // Per answer: switch to key points and back.
  await click("#viewToggle");
  assert.deepEqual(await run(`return [...document.querySelectorAll("#answerBody .keys li")].map((li) => li.textContent);`), ["billing migration", "40% fewer errors", "staged rollout"]);
  assert.ok(!(await body()).includes("errors fell"), "key points hide the paragraphs");
  assert.match(await body(), /Added: the side-by-side run/, "the note still shows");
  await click("#viewToggle");
  assert.match(await body(), /errors fell 40%/);
  // The setting: new answers open as key points.
  await run(`g.setSetting("compactAnswers", true);`);
  await until(`state.compactAnswers === true`);
  await run(`document.getElementById("question").value = "Another one"; document.getElementById("askBtn").click();`);
  await until(`answers.at(-1).question === "Another one" && answers.at(-1).status === "done"`);
  assert.equal(await run(`return document.querySelectorAll("#answerBody .keys li").length;`), 3);
  await run(`g.setSetting("compactAnswers", false);`);
  await until(`state.compactAnswers === false`);
  await run(`page = answers.length - 2; renderStage();`); // back to the answer the next test uses
});

test("what you actually said goes with the next question instead of the suggestion", { skip }, async () => {
  const count = await run(`return answers.length;`);
  await click("#saidOpen");
  assert.ok(await shown("saidForm"));
  await run(`document.getElementById("saidInput").value = "I talked about the Kafka pipeline instead"; document.getElementById("saidForm").requestSubmit();`);
  assert.match(await run(`return document.getElementById("saidText").textContent;`), /Kafka pipeline instead/);
  await run(`document.getElementById("question").value = "How did you measure it?"; document.getElementById("askBtn").click();`);
  await until(`answers.length === ${count + 1} && answers.at(-1).status === "done"`);
  const sent = requests.at(-1).messages[1].content.at(-1).text;
  assert.match(sent, /user said this instead of the suggestion\): I talked about Kafka pipeline instead/);
  // Every earlier answer is sent except the one you replaced (all share the fake text).
  assert.equal(sent.split("errors fell").length - 1, count - 1, "the replaced suggestion isn't sent");
  // Earlier answers stay in the pager.
  await click("#prevBtn");
  assert.match(await run(`return document.getElementById("saidText").textContent;`), /Kafka/);
});

test("a stopped answer still counts: what you said about it reaches the next question", { skip }, async () => {
  await run(`document.getElementById("question").value = "Answer this slowly"; document.getElementById("askBtn").click();`);
  await until(`answers.at(-1).text.includes("Partly answered")`);
  await click("#askBtn"); // now Stop
  await until(`answers.at(-1).status === "done" && !state.busy`);
  assert.match(await run(`return document.getElementById("answerBody").textContent;`), /Stopped before the end/, "a stopped answer says so");
  await click("#saidOpen");
  await run(`document.getElementById("saidInput").value = "I described the Postgres cutover"; document.getElementById("saidForm").requestSubmit();`);
  await run(`document.getElementById("question").value = "Go on"; document.getElementById("askBtn").click();`);
  await until(`answers.at(-1).question === "Go on" && answers.at(-1).status === "done"`);
  assert.match(requests.at(-1).messages[1].content.at(-1).text, /instead of the suggestion\): I described Postgres cutover/);
});

test("a question split by pauses shows whole, lead-in included, and Answer sends all of it", { skip }, async () => {
  const now = Date.now();
  const caption = await run(`
    state.listening = true; // as if Listen were on; the next state update resets it
    onTranscript({ role: "them", text: "So looking at your experience with distributed systems,", start: ${now - 6000}, at: ${now - 3500} });
    onTranscript({ role: "them", text: "how would you design a rate limiter", start: ${now - 2600}, at: ${now - 1200} });
    onTranscript({ role: "them", text: "for an API that serves millions of users?", start: ${now - 400}, at: ${now + 1500} });
    const q = document.querySelector("#caption .qtext");
    const shown = { text: q.textContent, lines: Math.round(q.getBoundingClientRect().height / parseFloat(getComputedStyle(q).lineHeight)) };
    document.getElementById("answerQBtn").click();
    return shown;
  `);
  const full = "So looking at your experience with distributed systems, how would you design a rate limiter for an API that serves millions of users?";
  assert.equal(caption.text, full);
  assert.ok(caption.lines >= 1 && caption.lines <= 3, `${caption.lines} lines`);
  await until(`answers.at(-1).question === ${JSON.stringify(full)} && answers.at(-1).status === "done"`);
  assert.match(requests.at(-1).messages[1].content.at(-1).text, /Question: So looking at your experience with distributed systems, how would you design a rate limiter for an API that serves millions of users\?/);
});

test("Answer pressed mid-question waits for the rest, then sends the whole question", { skip }, async () => {
  const now = Date.now();
  const asked = await run(`return answers.length;`);
  const before = await run(`
    let speaking = true;
    window.finishSpeaking = () => (speaking = false);
    stillHearing = async () => speaking;
    state.listening = true;
    onTranscript({ role: "them", text: "Tell me about a time you disagreed with your manager", start: ${now - 3000}, at: ${now - 300} });
    submit();
    await new Promise((r) => setTimeout(r, 300));
    return { label: document.getElementById("answerQBtn").textContent, asked: answers.length };
  `);
  assert.deepEqual(before, { label: "Waiting…", asked }, "nothing is sent while they're still talking");
  await run(`onTranscript({ role: "them", text: "and how it ended?", start: ${now + 500}, at: ${now + 1800} }); finishSpeaking();`);
  await until(`answers.length === ${asked + 1} && answers.at(-1).status === "done"`);
  assert.equal(await run(`return answers.at(-1).question;`), "Tell me about a time you disagreed with your manager and how it ended?");
  await run(`stillHearing = async () => false;`);
});

test("auto-answer: a heard question is answered once they finish, not before", { skip }, async () => {
  const now = Date.now();
  const count = await run(`return answers.length;`);
  await run(`
    let speaking = true;
    window.finishSpeaking = () => (speaking = false);
    stillHearing = async () => speaking;
    state.listening = true;
    onTranscript({ role: "them", text: "Can you tell me about a time?", start: ${now - 2500}, at: ${now - 400} });
  `);
  await sleep(1200);
  assert.equal(await run(`return answers.length;`), count, "nothing starts while they're still talking");
  await run(`onTranscript({ role: "them", text: "When you led a project under pressure?", start: ${now + 300}, at: ${now + 2000} }); finishSpeaking();`);
  await until(`answers.length === ${count + 1} && answers.at(-1).status === "done"`, 5000);
  assert.deepEqual(await run(`const a = answers.at(-1); return [a.question, a.auto];`), ["Can you tell me about a time when you led a project under pressure?", true]);
});

test("auto-answer waits while you type, and stays off in Meeting mode", { skip }, async () => {
  const now = Date.now();
  const count = await run(`return answers.length;`);
  await run(`
    stillHearing = async () => false;
    state.listening = true;
    const q = document.getElementById("question");
    q.value = "my own question";
    q.dispatchEvent(new Event("input"));
    onTranscript({ role: "them", text: "Why do you want this job?", start: ${now + 3000}, at: ${now + 4500} });
  `);
  await sleep(1200);
  assert.equal(await run(`return answers.length;`), count, "typing holds it off");
  await run(`document.getElementById("question").value = ""; questionTypedAt = 0; state.listening = true;`);
  await until(`answers.length === ${count + 1} && answers.at(-1).status === "done"`, 5000);
  assert.equal(await run(`return answers.at(-1).question;`), "Why do you want this job?");

  await click("#modeBtn");
  await click('#modeMenu [data-value="meeting"]');
  await until(`state.style !== "interview"`);
  await run(`state.listening = true; onTranscript({ role: "them", text: "What's the plan for next quarter?", start: ${now + 9000}, at: ${now + 10500} });`);
  await sleep(1200);
  assert.equal(await run(`return answers.length;`), count + 1, "no auto-answer outside Interview mode");
  await click("#modeBtn");
  await click('#modeMenu [data-value="interview"]');
  await until(`state.style === "interview"`);
  await run(`pendingQuestion = null; stillHearing = async () => false; if (!document.getElementById("jdCard").hidden) document.getElementById("jdSame").click();`);
});

test("auto-answer fires with the transcript view open", { skip }, async () => {
  const now = Date.now();
  const count = await run(`return answers.length;`);
  await run(`
    stillHearing = async () => false;
    pendingQuestion = null;
    state.listening = true;
    document.getElementById("question").value = "";
    questionTypedAt = 0;
    view = "transcript";
    render();
    onTranscript({ role: "them", text: "What would you do differently next time?", start: ${now + 7000}, at: ${now + 8500} });
  `);
  await until(`answers.length === ${count + 1} && answers.at(-1).status === "done"`, 5000);
  assert.deepEqual(await run(`const a = answers.at(-1); return [a.question, a.auto, view];`), ["What would you do differently next time?", true, "answers"]);
});

test("auto-answer fires when text in the question box is stale", { skip }, async () => {
  const now = Date.now();
  const count = await run(`return answers.length;`);
  await run(`
    stillHearing = async () => false;
    pendingQuestion = null;
    lastAutoQuestion = null;
    state.listening = true;
    view = "answers";
    const q = document.getElementById("question");
    q.value = "leftover question";
    q.dispatchEvent(new Event("input"));
    questionTypedAt = Date.now() - 6000;
    onTranscript({ role: "them", text: "What would you improve about this design?", start: ${now + 10000}, at: ${now + 11500} });
  `);
  await until(`answers.length === ${count + 1} && answers.at(-1).status === "done"`, 5000);
  assert.deepEqual(await run(`const a = answers.at(-1); return [a.question, a.auto];`), ["What would you improve about this design?", true]);
  await run(`document.getElementById("question").value = ""; questionTypedAt = 0;`);
});

test("auto-answer: if they carry on after a long pause, the whole question is answered again and the first answer stays", { skip }, async () => {
  const now = Date.now();
  const count = await run(`return answers.length;`);
  await run(`
    stillHearing = async () => false;
    state.listening = true;
    onTranscript({ role: "them", text: "Can you walk me through a project", start: ${now + 20000}, at: ${now + 21500} });
  `);
  await until(`answers.length === ${count + 1} && answers.at(-1).status === "done"`, 5000);
  await run(`state.listening = true; onTranscript({ role: "them", text: "where you improved performance?", start: ${now + 22800}, at: ${now + 24300} });`);
  await until(`answers.length === ${count + 2} && answers.at(-1).status === "done"`, 5000);
  assert.deepEqual(await run(`return answers.slice(-2).map((a) => a.question);`), ["Can you walk me through a project", "Can you walk me through a project where you improved performance?"]);
});

test("⌘↵ doesn't stop an auto-answer already under way; Stop does; typing sends right away", { skip }, async () => {
  const now = Date.now();
  const count = await run(`return answers.length;`);
  await run(`stillHearing = async () => false; pendingQuestion = null; lastAutoQuestion = null; state.listening = true; onTranscript({ role: "them", text: "Could you answer this one slowly?", start: ${now + 40000}, at: ${now + 41500} });`);
  await until(`answers.length === ${count + 1} && answers.at(-1).auto && answers.at(-1).text.length > 0`, 5000);
  await run(`submit();`); // ⌘↵ / Answer
  await sleep(400);
  assert.equal(await run(`return answers.at(-1).status;`), "streaming", "⌘↵ kept the auto-answer going");
  // Typing a question while it streams: the button turns back into Ask and sends it at once.
  assert.equal(await run(`return document.getElementById("askBtn").textContent;`), "Stop");
  await run(`const q = document.getElementById("question"); q.value = "Typed while it streams"; q.dispatchEvent(new Event("input"));`);
  assert.equal(await run(`return document.getElementById("askBtn").textContent;`), "Ask");
  await run(`document.getElementById("askForm").requestSubmit();`);
  await until(`answers.length === ${count + 2} && answers.at(-1).question === "Typed while it streams" && answers.at(-1).status === "done"`);
  assert.equal(await run(`return answers.at(-2).status;`), "done", "the interrupted answer stays, stopped");
  // The Stop button stops an auto-answer.
  await run(`state.listening = true; onTranscript({ role: "them", text: "And another one slowly?", start: ${now + 50000}, at: ${now + 51500} });`);
  await until(`answers.length === ${count + 3} && answers.at(-1).auto && answers.at(-1).text.length > 0`, 5000);
  await click("#askBtn"); // shows Stop while busy
  await until(`answers.at(-1).status !== "streaming" && !state.busy`);
});

test("typing a question while Glance waits for a heard one sends the typed one instead", { skip }, async () => {
  const now = Date.now();
  const count = await run(`return answers.length;`);
  await run(`
    let speaking = true;
    stillHearing = async () => speaking;
    window.finishSpeaking = () => (speaking = false);
    state.listening = true;
    onTranscript({ role: "them", text: "Tell me about your last project", start: ${now + 60000}, at: ${now + 61500} });
    submit(); // Answer: waits while they talk
  `);
  await until(`waitingForQuestion`);
  await run(`document.getElementById("question").value = "What is a race condition?"; document.getElementById("askForm").requestSubmit();`);
  await until(`answers.length === ${count + 1} && answers.at(-1).status === "done"`);
  await sleep(400);
  assert.deepEqual(await run(`return [answers.length, answers.at(-1).question, waitingForQuestion];`), [count + 1, "What is a race condition?", false]);
  await run(`finishSpeaking(); stillHearing = async () => false; pendingQuestion = null;`);
});

// Turn-end checks: requests that carry the gated instruction, and the log.
const isGated = (r) => !!r.messages?.[1]?.content?.at?.(-1)?.text?.includes("reply exactly <none>");
const appLog = () => readFileSync(path.join(dir, "logs", "glance.log"), "utf8");
async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${fn}`);
}
const freshTurn = `stillHearing = async () => false; pendingQuestion = null; lastAutoQuestion = null; turn = null; state.listening = true; view = "answers"; document.getElementById("question").value = ""; questionTypedAt = 0;`;

test("auto-answer: an introduction is checked once at the end of the turn, and nothing shows", { skip }, async () => {
  const now = Date.now() - 400000; // in the past, so these lines never lead in to later tests' questions
  const count = await run(`return answers.length;`);
  const shownPage = await run(`return page;`);
  const sent = requests.length;
  const nones = (appLog().match(/turn check id=\d+ result=none/g) || []).length;
  await run(`${freshTurn} onTranscript({ role: "them", text: "Hi, I'm Abby, welcome back to the channel. This will be nine questions.", start: ${now}, at: ${now + 2500} });`);
  await waitFor(() => (appLog().match(/turn check id=\d+ result=none words=\d+ ms=\d+/g) || []).length === nones + 1);
  await sleep(500);
  assert.equal(requests.slice(sent).filter(isGated).length, 1, "one gated request");
  assert.deepEqual(await run(`return [answers.length, page, state.busy, turnCheckPending, document.getElementById("thinkHarder").hidden];`), [count, shownPage, false, false, true]);
});

test("auto-answer: a prompt the rules miss is answered after the turn check", { skip }, async () => {
  const now = Date.now() - 390000;
  const count = await run(`return answers.length;`);
  const sent = requests.length;
  const text = "I'm keen to hear about the project you're proudest of.";
  assert.equal(await run(`return isQuestion(${JSON.stringify(text)});`), false, "the rules don't catch this one");
  await run(`${freshTurn} onTranscript({ role: "them", text: ${JSON.stringify(text)}, start: ${now}, at: ${now + 2500} });`);
  await until(`answers.length === ${count + 1} && answers.at(-1).status === "done"`, 5000);
  assert.deepEqual(await run(`const a = answers.at(-1); return [a.question, a.auto, a.gated, a.text.startsWith("**I led")];`), [text, true, true, true]);
  assert.equal(requests.slice(sent).filter(isGated).length, 1);
  assert.match(appLog(), /turn check id=\d+ result=answer ms=\d+/);
});

test("auto-answer: a question the rules catch fires the usual way, with no turn check", { skip }, async () => {
  const now = Date.now() - 380000;
  const count = await run(`return answers.length;`);
  const sent = requests.length;
  await run(`${freshTurn} onTranscript({ role: "them", text: "What's the hardest bug you've fixed?", start: ${now}, at: ${now + 1500} });`);
  await until(`answers.length === ${count + 1} && answers.at(-1).status === "done"`, 5000);
  await sleep(400);
  assert.deepEqual(await run(`const a = answers.at(-1); return [a.question, a.auto, a.gated];`), ["What's the hardest bug you've fixed?", true, false]);
  const asked = requests.slice(sent).filter((r) => r.messages);
  assert.equal(asked.length, 1);
  assert.ok(!isGated(asked[0]), "no gated instruction");
  assert.match(askedText(asked[0]), /Question: What's the hardest bug you've fixed\?/);
});

test("auto-answer: one turn check per turn, however long the quiet lasts", { skip }, async () => {
  const now = Date.now() - 370000;
  const count = await run(`return answers.length;`);
  const sent = requests.length;
  await run(`${freshTurn} onTranscript({ role: "them", text: "Welcome everyone, thanks for joining us this afternoon.", start: ${now}, at: ${now + 2500} });`);
  await waitFor(() => requests.slice(sent).filter(isGated).length === 1);
  await sleep(1500);
  assert.equal(requests.slice(sent).filter(isGated).length, 1, "still one");
  assert.equal(await run(`return answers.length;`), count);
  // A short line isn't worth a check on its own.
  await run(`turn = null; onTranscript({ role: "them", text: "Okay, great.", start: ${now + 5000}, at: ${now + 6000} });`);
  await sleep(800);
  assert.equal(requests.slice(sent).filter(isGated).length, 1, "under five words: no check");
  await run(`turn = null;`);
});

// The last "ask id=" line in the app's log.
const lastAskLog = () => readFileSync(path.join(dir, "logs", "glance.log"), "utf8").split("\n").filter((l) => / ask id=/.test(l)).at(-1) || "";
const askedText = (r) => r.messages[1].content.at(-1).text;

test("Think harder: shows on a quick spoken answer only, and re-asks the same question with more thinking", { skip }, async () => {
  const now = Date.now() + 80000;
  const count = await run(`return answers.length;`);
  await run(`stillHearing = async () => false; pendingQuestion = null; lastAutoQuestion = null; state.listening = true; view = "answers"; onTranscript({ role: "them", text: "What do you enjoy most about your current role?", start: ${now}, at: ${now + 1500} });`);
  await until(`answers.length === ${count + 1} && answers.at(-1).status === "done"`, 5000);
  assert.equal(await run(`return answers.at(-1).quick;`), true);
  assert.ok(await shown("thinkHarder"), "shown on a quick spoken answer");
  assert.equal(requests.at(-1).reasoning_effort, "none", "answered at Quick");
  assert.match(lastAskLog(), /heard=true hard=false deep=false think=false/);

  await click("#thinkHarder");
  await until(`answers.length === ${count + 2} && answers.at(-1).status === "done"`);
  assert.deepEqual(await run(`return answers.slice(-2).map((a) => [a.question, a.quick]);`), [
    ["What do you enjoy most about your current role?", true],
    ["What do you enjoy most about your current role?", false],
  ]);
  assert.match(askedText(requests.at(-1)), /Question: What do you enjoy most about your current role\?/);
  assert.equal(requests.at(-1).reasoning_effort, "medium", "Think harder thinks even when Depth is Quick");
  assert.match(lastAskLog(), /heard=true hard=false deep=true think=true .*effort=medium/);
  assert.equal(await shown("thinkHarder"), false, "not on a Think harder answer");

  // A hard spoken question answers at Depth: no Think harder.
  await run(`state.listening = true; onTranscript({ role: "them", text: "How would you design a URL shortener?", start: ${now + 10000}, at: ${now + 11500} });`);
  await until(`answers.length === ${count + 3} && answers.at(-1).status === "done"`, 5000);
  assert.equal(await run(`return answers.at(-1).quick;`), false);
  assert.equal(await shown("thinkHarder"), false, "not on a hard question");
  assert.match(lastAskLog(), /heard=true hard=true deep=false think=true/);

  // A typed question: no Think harder.
  await run(`pendingQuestion = null; document.getElementById("question").value = "What is a mutex?"; document.getElementById("askForm").requestSubmit();`);
  await until(`answers.length === ${count + 4} && answers.at(-1).status === "done"`);
  assert.equal(await shown("thinkHarder"), false, "not on a typed question");
  assert.match(lastAskLog(), /heard=false hard=false deep=false think=true/);
});

test("Think harder by ⌘↵: after a quick spoken answer it re-asks deeper; a new heard question still comes first", { skip }, async () => {
  const now = Date.now() + 100000;
  const count = await run(`return answers.length;`);
  await run(`stillHearing = async () => false; pendingQuestion = null; lastAutoQuestion = null; state.listening = true; onTranscript({ role: "them", text: "Why are you leaving your current job?", start: ${now}, at: ${now + 1500} });`);
  await until(`answers.length === ${count + 1} && answers.at(-1).status === "done" && answers.at(-1).quick`, 5000);
  await run(`submit();`); // ⌘↵ with nothing typed
  await until(`answers.length === ${count + 2} && answers.at(-1).status === "done"`);
  assert.equal(await run(`return answers.at(-1).question;`), "Why are you leaving your current job?");
  assert.equal(requests.at(-1).reasoning_effort, "medium");
  assert.match(lastAskLog(), /deep=true/);

  // The deeper answer isn't quick, so ⌘↵ does what it always did (asks with nothing typed).
  await run(`state.listening = false; submit();`);
  await until(`answers.length === ${count + 3} && answers.at(-1).status === "done"`);
  assert.equal(await run(`return answers.at(-1).question;`), "");
  assert.match(lastAskLog(), /heard=false hard=false deep=false/);

  // After a quick answer, a new pending heard question is what ⌘↵ answers.
  await run(`state.listening = true; onTranscript({ role: "them", text: "What motivates you at work?", start: ${now + 10000}, at: ${now + 11500} });`);
  await until(`answers.length === ${count + 4} && answers.at(-1).status === "done" && answers.at(-1).quick`, 5000);
  await run(`
    state.autoAnswer = false; // so only ⌘↵ answers the next one
    state.listening = true;
    onTranscript({ role: "them", text: "Where do you see yourself in five years?", start: ${now + 20000}, at: ${now + 21500} });
    submit();
  `);
  await until(`answers.length === ${count + 5} && answers.at(-1).status === "done"`);
  assert.equal(await run(`return answers.at(-1).question;`), "Where do you see yourself in five years?");
  assert.match(lastAskLog(), /heard=true hard=false deep=false/);
  await run(`pendingQuestion = null; lastAutoQuestion = null;`);
});

test("stopping Listen drops an unanswered question, so it isn't shown or auto-answered later", { skip }, async () => {
  const now = Date.now() + 70000;
  await run(`
    state.listening = true;
    wasListening = true; // as if the app had reported Listen on
    onTranscript({ role: "them", text: "What's your biggest weakness?", start: ${now}, at: ${now + 1500} });
  `);
  assert.equal(await run("return pendingQuestion?.text"), "What's your biggest weakness?");
  // Any real state update now says listening is off: Listen was stopped.
  await run(`g.setSetting("autoScreen", false);`);
  await until(`!state.listening && pendingQuestion === null`);
});

test("Interview mode without a resume reopens setup; auto-answer says it needs Interview mode", { skip }, async () => {
  await run(`await g.setSetting("resume", ""); await g.setSetting("jdCheckedAt", 0); await g.setSetting("style", "brief");`);
  await until(`state.style === "brief" && !state.resume`);
  await run(`setMenu(true); document.querySelector('#settingsTabs [data-tab="interview"]').click();`);
  assert.match(await run(`return document.getElementById("autoAnswerHint").textContent;`), /Only works in Interview mode/);
  await run(`setMenu(false);`);
  await click("#modeBtn");
  await click('#modeMenu [data-value="interview"]');
  // Switched on without a resume: setup comes back, and can't be skipped.
  await until(`state.style === "interview" && !!onboarding`);
  assert.equal(await run(`return onboarding.step;`), "about"); // straight to the resume
  assert.ok(await shown("obResume"));
  assert.equal(await run(`return document.getElementById("onboardSkip").hidden;`), true);
  assert.equal(await run(`return document.getElementById("obNext").disabled;`), true);
  await run(`await g.setSetting("resume", "Jane Doe, engineer");`);
  await until(`!!state.resume`);
  await run(`finishOnboarding();`);
  // Clearing the resume while in Interview mode brings setup back too.
  await run(`await g.setSetting("resume", "");`);
  await until(`!state.resume && !!onboarding`);
  await run(`await g.setSetting("resume", "Jane Doe, engineer");`);
  await until(`!!state.resume`);
  await run(`finishOnboarding();`);
  await run(`setMenu(true); document.querySelector('#settingsTabs [data-tab="interview"]').click();`);
  assert.match(await run(`return document.getElementById("autoAnswerHint").textContent;`), /as soon as the interviewer finishes/);
  await run(`setMenu(false);`);
});

test("setup can't be skipped in Interview mode until a resume is saved", { skip }, async () => {
  await run(`await g.setSetting("resume", ""); await g.setSetting("style", "interview"); startOnboarding(); render();`);
  await until(`!!onboarding && !state.resume`);
  assert.equal(await run(`return document.getElementById("onboardSkip").hidden;`), true);
  await run(`document.getElementById("onboardSkip").click();`);
  assert.ok(await run(`return !!onboarding;`));
  await run(`onboarding.use = "meetings"; render();`); // meetings don't need one
  assert.equal(await run(`return document.getElementById("onboardSkip").hidden;`), false);
  await run(`await g.setSetting("resume", "Jane Doe, engineer"); onboarding.use = "interviews";`);
  await until(`!!state.resume`);
  await run(`render();`);
  assert.equal(await run(`return document.getElementById("onboardSkip").hidden;`), false);
  await click("#onboardSkip");
  await until(`!onboarding`);
});

test("without an API key: the key form shows, the gear still opens Settings, Listen and Screenshot wait", { skip }, async () => {
  await run(`await g.setSetting("provider", "anthropic");`); // no key for it in test mode
  await until(`!state.hasKey`);
  assert.ok(await shown("keyForm"));
  assert.deepEqual(await run(`return ["listenBtn", "shotBtn"].map((id) => getComputedStyle(document.getElementById(id)).display);`), ["none", "none"]);
  await click("#menuBtn");
  assert.ok(await shown("menu"), "Settings opens without a key");
  assert.ok(!(await shown("keyForm")));
  assert.equal(await run(`return getComputedStyle(document.getElementById("listenBtn")).display;`), "none", "still hidden in Settings");
  assert.match(await run(`return document.getElementById("keyMeta").textContent;`), /no key yet/);
  await click('#settingsTabs [data-tab="interview"]');
  await click("#profileBtn");
  assert.ok(await shown("profileForm"), "Settings forms open too");
  await click("#profileCancel");
  await click("#menuBtn");
  assert.ok(await shown("keyForm"), "closing Settings goes back to the key form");
  await click('#keyProvider [data-value="openai"]'); // the local fake model needs no key
  await until(`state.hasKey`);
  assert.ok(!(await shown("keyForm")));
  assert.equal(await run(`return getComputedStyle(document.getElementById("listenBtn")).display;`), "flex");
});

test("provider form: the saved model follows the server's list; a typed one is left alone", { skip }, async () => {
  await run(`await g.setSetting("provider", "openai");`);
  await until(`state.provider === "openai"`);
  const open = async (models, saved) => {
    await run(`listModels = async () => ({ models: ${JSON.stringify(models.map((id) => ({ id })))} });
      setMenu(true); document.querySelector('#settingsTabs [data-tab="answers"]').click();
      state.openaiModel = ${JSON.stringify(saved)}; document.getElementById("keyBtn").click();`);
    await until(`keyModels.length === ${models.length}`);
    return run(`return [document.getElementById("keyModel").value, document.getElementById("keyModelStatus").textContent];`);
  };
  // "gpt-5" saved for OpenAI; OpenRouter calls it "openai/gpt-5".
  const [renamed, renamedNote] = await open(["openai/gpt-5", "openai/gpt-5.4", "anthropic/claude-haiku-5.5"], "gpt-5");
  assert.equal(renamed, "openai/gpt-5");
  assert.match(renamedNote, /Changed to openai\/gpt-5/);
  await click("#cancelKeyBtn");
  // And back: "openai/gpt-5" saved, now on OpenAI's own list as "gpt-5".
  const [back] = await open(["gpt-5", "gpt-5-mini", "gpt-4o"], "openai/gpt-5");
  assert.equal(back, "gpt-5");
  await click("#cancelKeyBtn");
  // Already on the list: left exactly as it is.
  const [kept] = await open(["gpt-5", "gpt-4o"], "gpt-5");
  assert.equal(kept, "gpt-5");
  await click("#cancelKeyBtn");
  // Not on the list at all: cleared, with a note to choose one.
  const [cleared, clearedNote] = await open(["anthropic/claude-haiku-5.5"], "gpt-5");
  assert.equal(cleared, "");
  assert.match(clearedNote, /gpt-5 isn't listed by .*Choose one from the list/);
  // A model the user typed is never changed by a later list load.
  await run(`const m = document.getElementById("keyModel"); m.value = "my-custom"; m.dispatchEvent(new Event("input")); await loadKeyModels();`);
  assert.equal(await run(`return document.getElementById("keyModel").value;`), "my-custom");
  await click("#cancelKeyBtn");
  // Settings warns when the saved model isn't on the provider's list.
  await run(`state.openaiModel = "gpt-5"; state.modelOptions = [{ id: "openai/gpt-5" }]; render();`);
  assert.match(await run(`return document.getElementById("modelHint").textContent;`), /gpt-5 isn't listed by .*Choose a model\./);
  assert.ok(await run(`return document.getElementById("modelHint").classList.contains("caution");`));
  await run(`setMenu(false); listModels = (p) => g.listModels(p);`);
});

test("provider form: a bare server address is normalized, and the old server's model and list are dropped", { skip }, async () => {
  await run(`await g.setSetting("provider", "openai");`);
  await until(`state.provider === "openai"`);
  await run(`window.__calls = []; listModels = async (p) => { window.__calls.push(p); return { models: [{ id: "gpt-5.4" }, { id: "gpt-4o" }] }; };
    setMenu(true); document.querySelector('#settingsTabs [data-tab="answers"]').click();
    state.openaiBaseUrl = "https://openrouter.ai/api/v1"; state.openaiModel = "";
    document.getElementById("keyBtn").click();`);
  await until(`keyModels.length === 2`);
  // The user picked OpenRouter's name for the model.
  await run(`keyModels = [{ id: "openai/gpt-5.4" }]; const m = document.getElementById("keyModel"); m.value = "openai/gpt-5.4"; m.dispatchEvent(new Event("input"));
    window.__calls = []; const u = document.getElementById("keyBaseUrl"); u.value = "api.openai.com"; u.dispatchEvent(new Event("input"));`);
  assert.equal(await run(`return keyModels.length;`), 0, "the old server's list is dropped at once");
  assert.equal(await run(`return document.getElementById("keyModelList").hidden;`), true);
  await until(`window.__calls.length === 1 && keyModels.length === 2`);
  assert.equal(await run(`return window.__calls[0].baseUrl;`), "https://api.openai.com/v1");
  assert.equal(await run(`return document.getElementById("keyModelStatus").classList.contains("error");`), false);
  assert.equal(await run(`return document.getElementById("keyModel").value;`), "gpt-5.4");
  await run(`const u = document.getElementById("keyBaseUrl"); u.dispatchEvent(new Event("blur"));`);
  assert.equal(await run(`return document.getElementById("keyBaseUrl").value;`), "https://api.openai.com/v1");
  // A model chosen after the change is left alone by a later load.
  await run(`const m = document.getElementById("keyModel"); m.value = "my-custom"; m.dispatchEvent(new Event("input")); await loadKeyModels();`);
  assert.equal(await run(`return document.getElementById("keyModel").value;`), "my-custom");
  await click("#cancelKeyBtn");
  await run(`setMenu(false); listModels = (p) => g.listModels(p);`);
});

test("provider form: changing the address renames the model even when the list can't load", { skip }, async () => {
  await run(`await g.setSetting("provider", "openai");`);
  await until(`state.provider === "openai"`);
  await run(`listModels = async () => ({ error: "api.openai.com rejected the API key." });
    setMenu(true); document.querySelector('#settingsTabs [data-tab="answers"]').click();
    state.openaiBaseUrl = "https://openrouter.ai/api/v1"; state.openaiModel = "openai/gpt-5.4"; state.keyHint = "1234";
    document.getElementById("keyBtn").click();`);
  await until(`document.getElementById("keyModel").value === "openai/gpt-5.4"`);
  const setUrl = (u) => run(`const e = document.getElementById("keyBaseUrl"); e.value = ${JSON.stringify(u)}; e.dispatchEvent(new Event("input"));`);
  const model = () => run(`return document.getElementById("keyModel").value;`);
  await setUrl("api.openai.com");
  await until(`document.getElementById("keyModel").value === "gpt-5.4"`);
  assert.equal(await run(`return document.getElementById("keyModelStatus").textContent.includes("Changed to gpt-5.4") || document.getElementById("keyModelStatus").textContent.includes("rejected");`), true);
  await run(`document.getElementById("keyModel").value = "gpt-5"; keyModelTyped = false;`);
  await setUrl("openrouter.ai");
  await until(`document.getElementById("keyModel").value === "openai/gpt-5"`);
  // A model typed after the change is left alone.
  await setUrl("api.openai.com");
  await run(`const m = document.getElementById("keyModel"); m.value = "openai/mine"; m.dispatchEvent(new Event("input"));`);
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(await model(), "openai/mine");
  await click("#cancelKeyBtn");
  await run(`setMenu(false); listModels = (p) => g.listModels(p);`);
});

test("provider form: no key yet is a hint, not an error, except for a local server", { skip }, async () => {
  await run(`await g.setSetting("provider", "openai");`);
  await until(`state.provider === "openai"`);
  await run(`listModels = async () => ({ error: "api.openai.com rejected the API key. Check it in Settings > Answers > AI provider." });
    setMenu(true); document.querySelector('#settingsTabs [data-tab="answers"]').click();`);
  await click("#keyBtn");
  const status = async (url, keyHint) => {
    await run(`state.keyHint = ${JSON.stringify(keyHint)}; document.getElementById("keyInput").value = "";
      document.getElementById("keyBaseUrl").value = ${JSON.stringify(url)}; await loadKeyModels();`);
    return run(`const el = document.getElementById("keyModelStatus"); return [el.className, el.textContent];`);
  };
  // No key, hosted server: a hint.
  assert.deepEqual(await status("https://api.openai.com/v1", null), ["model-status loading", "Paste your API key to load the models."]);
  // A saved key: the real error, without "Check it in Settings…" since this is that form.
  const [cls, text] = await status("https://api.openai.com/v1", "1234");
  assert.equal(cls, "model-status error");
  assert.match(text, /^api\.openai\.com rejected the API key\. Retry$/);
  // A local server needs no key, so its error shows even without one.
  await run(`listModels = async () => ({ error: "Can't reach localhost:11434. Check the base URL in Settings > Answers > AI provider, and your connection." });`);
  const [localCls, localText] = await status("http://localhost:11434/v1", null);
  assert.equal(localCls, "model-status error");
  assert.match(localText, /Can't reach localhost:11434\. Check the server address and your connection\./);
  await click("#cancelKeyBtn");
  await run(`setMenu(false); listModels = (p) => g.listModels(p); state.keyHint = null;`);
});

test("provider form: cards switch provider, models load, Test connection resets on edits", { skip }, async () => {
  await run(`await g.setSetting("provider", "openai");`);
  await until(`state.provider === "openai"`);
  await run(`listModels = async () => ({ models: [{ id: "fake", name: "Fake Model" }, { id: "alpha", name: "Alpha" }] });
    testConnection = async ({ model }) => model === "bad" ? { error: "That key was rejected." } : { ok: true, ms: 800 };
    setMenu(true); document.querySelector('#settingsTabs [data-tab="answers"]').click();`);
  await click("#keyBtn");
  assert.ok(await shown("keyForm"));
  await until(`keyModels.length === 2`);
  assert.equal(await run(`return document.getElementById("keyModel").value;`), "fake", "the saved model is preselected");
  // The chevron shows every model, even with one already in the box.
  await click("#keyModelToggle");
  assert.ok(await shown("keyModelList"));
  assert.deepEqual(await run(`return [...document.querySelectorAll("#keyModelList li[data-i] .combo-id")].map((o) => o.textContent);`), ["fake", "alpha"]);
  assert.equal(await run(`return document.querySelector('#keyModelList li[aria-selected="true"] .combo-id').textContent;`), "fake");
  // Typing filters by ID or name; clicking an entry picks it and closes the list.
  await run(`const m = document.getElementById("keyModel"); m.value = "alp"; m.dispatchEvent(new Event("input"));`);
  assert.deepEqual(await run(`return [...document.querySelectorAll("#keyModelList li[data-i] .combo-id")].map((o) => o.textContent);`), ["alpha"]);
  await click("#keyModelList li[data-i]");
  assert.equal(await run(`return document.getElementById("keyModel").value;`), "alpha");
  assert.ok(!(await shown("keyModelList")));
  // Keyboard: ArrowDown opens and moves, Enter picks, Escape closes.
  await run(`const m = document.getElementById("keyModel"); m.focus(); m.value = ""; m.dispatchEvent(new Event("input"));
    m.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    m.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));`);
  assert.equal(await run(`return document.getElementById("keyModel").value;`), "fake");
  await run(`const m = document.getElementById("keyModel"); m.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    m.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));`);
  assert.ok(!(await shown("keyModelList")));

  await click('#keyProvider [data-value="anthropic"]');
  await until(`state.provider === "anthropic"`);
  assert.equal(await run(`return document.querySelector('#keyProvider [data-value="anthropic"]').getAttribute("aria-checked");`), "true");
  await click('#keyProvider [data-value="openai"]');
  await until(`state.provider === "openai"`);

  await run(`const m = document.getElementById("keyModel"); m.value = "fake"; m.dispatchEvent(new Event("input"));`);
  await click("#testConnBtn");
  await until(`document.getElementById("testConnText").textContent.includes("Connected")`);
  assert.equal(await run(`return document.getElementById("testConnText").textContent;`), "Connected · fake replied in 0.8 s");
  assert.ok(await run(`return document.getElementById("testConnStatus").classList.contains("ok");`));

  await run(`const m = document.getElementById("keyModel"); m.value = "alpha"; m.dispatchEvent(new Event("input"));`);
  assert.equal(await run(`return document.getElementById("testConnText").textContent;`), "Not tested since your last change");
  await run(`const m = document.getElementById("keyModel"); m.value = "bad"; m.dispatchEvent(new Event("input"));`);
  await click("#testConnBtn");
  await until(`document.getElementById("testConnText").textContent.includes("rejected")`);
  assert.ok(await run(`return document.getElementById("testConnStatus").classList.contains("error");`));

  await click("#cancelKeyBtn");
  await run(`setMenu(false); listModels = (p) => g.listModels(p); testConnection = (p) => g.testConnection(p);`);
});

test("settings: the model hint shows known prices, and Depth hides for models without effort", { skip }, async () => {
  await run(`state.provider = "anthropic"; state.modelOptions = []; state.model = "claude-haiku-5-5"; state.effortSupported = true;
    setMenu(true); document.querySelector('#settingsTabs [data-tab="answers"]').click(); render();`);
  // No list fetched yet: the models Glance knows are offered.
  assert.deepEqual(await run(`return settingsModels.map((m) => m.id);`), ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
  assert.match(await run(`return document.getElementById("modelHint").textContent;`), /Haiku 5\.5: \$0\.1 \/ \$0\.5 per million tokens/);
  assert.equal(await run(`return document.getElementById("effortRow").hidden;`), false);
  await run(`state.provider = "openai"; state.effortSupported = true; render();`);
  assert.equal(await run(`return document.getElementById("effortRow").hidden;`), false);
  assert.match(await run(`return document.querySelector("#effortRow small").textContent;`), /Spoken questions use Quick unless they look hard/);
  await run(`state.provider = "anthropic"; state.model = "claude-haiku-4-5"; state.effortSupported = false; render();`);
  assert.match(await run(`return document.getElementById("modelHint").textContent;`), /no prices/);
  assert.equal(await run(`return document.getElementById("effortRow").hidden;`), true);
  await run(`setMenu(false); render();`);
});

test("settings: the model dropdown lists state.modelOptions and saves the choice", { skip }, async () => {
  await run(`state.provider = "openai";
    state.modelOptions = [{ id: "alpha", name: "Alpha" }, { id: "beta", name: "Beta" }];
    state.openaiModel = "alpha"; setMenu(true);
    document.querySelector('#settingsTabs [data-tab="answers"]').click(); render();`);
  assert.equal(await run(`return document.getElementById("settingsModel").value;`), "alpha");
  // The chevron lists every model, with the saved one marked.
  await click("#settingsModelToggle");
  assert.ok(await shown("settingsModelList"));
  assert.deepEqual(await run(`return [...document.querySelectorAll("#settingsModelList li[data-i]")].map((li) => [li.querySelector(".combo-id").textContent, li.querySelector(".combo-name")?.textContent]);`), [["alpha", "Alpha"], ["beta", "Beta"]]);
  assert.equal(await run(`return document.querySelector('#settingsModelList li[aria-selected="true"] .combo-id').textContent;`), "alpha");
  // Picking one saves it.
  await click('#settingsModelList li[data-i="1"]');
  await until(`state.openaiModel === "beta"`);
  assert.ok(!(await shown("settingsModelList")));
  // Typing filters; leaving without picking puts the saved model back. (The
  // save above brought the app's real state back, so the fake list is set again.)
  await run(`state.modelOptions = [{ id: "alpha", name: "Alpha" }, { id: "beta", name: "Beta" }]; render();
    const m = document.getElementById("settingsModel"); m.focus(); m.value = "alp"; m.dispatchEvent(new Event("input"));`);
  assert.deepEqual(await run(`return [...document.querySelectorAll("#settingsModelList li[data-i] .combo-id")].map((e) => e.textContent);`), ["alpha"]);
  await run(`document.getElementById("settingsModel").dispatchEvent(new Event("blur"));`);
  assert.equal(await run(`return document.getElementById("settingsModel").value;`), "beta");
  // A model ID that isn't listed can be typed and saved with Enter.
  await run(`const m = document.getElementById("settingsModel"); m.focus(); m.value = "custom-model"; m.dispatchEvent(new Event("input"));
    m.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));`);
  await until(`state.openaiModel === "custom-model"`);
  // The saved model still shows when the provider's list doesn't include it.
  await run(`const sm = document.getElementById("settingsModel"); sm.blur(); sm.dispatchEvent(new Event("blur")); state.openaiModel = "gamma"; state.modelOptions = [{ id: "alpha", name: "Alpha" }]; render();`);
  assert.equal(await run(`return document.getElementById("settingsModel").value;`), "gamma");
  // Refresh asks the provider for a fresh list.
  await run(`window.__listCalls = 0; listModels = async () => { window.__listCalls++; return { models: [{ id: "delta", name: "Delta" }] }; };`);
  await click("#refreshModelsBtn");
  await until(`window.__listCalls === 1`);
  await until(`document.getElementById("refreshModelsBtn").textContent === "1 model"`);
  await run(`listModels = (p) => g.listModels(p); await g.setSetting("openaiModel", "fake"); setMenu(false);`);
  await until(`state.openaiModel === "fake"`);
});

test("the no-sound warning offers settings and a reopen", { skip }, async () => {
  const labels = await run(`showNotice({ level: "warn", text: "Glance hasn't heard any sound", action: "audio-access" }); return [...document.querySelectorAll("#notice .notice-action")].map((b) => b.textContent);`);
  assert.deepEqual(labels, ["Open settings", "Reopen Glance"]);
  await run(`document.getElementById("notice").hidden = true;`);
});

// Last: it deletes the test app's data and quits it.
test("Delete all Glance data: confirms, removes settings and logs, and quits", { skip }, async () => {
  const { existsSync } = await import("node:fs");
  assert.ok(existsSync(path.join(dir, "config.json")));
  await run(`setMenu(true); document.querySelector('#settingsTabs [data-tab="general"]').click();`);
  await click("#wipeBtn");
  assert.ok(await shown("wipeForm"));
  assert.ok(await run(`return document.querySelector(".dock").hidden;`));
  await click("#wipeCancel");
  assert.ok(await shown("menu"), "Cancel goes back to Settings and deletes nothing");
  assert.ok(existsSync(path.join(dir, "config.json")));
  await click("#wipeBtn");
  const exited = new Promise((r) => app.once("exit", r));
  await run(`document.getElementById("wipeForm").requestSubmit();`).catch(() => {}); // the app quits mid-call
  await exited;
  for (let i = 0; i < 80 && (existsSync(path.join(dir, "config.json")) || existsSync(path.join(dir, "logs"))); i++) await sleep(100);
  assert.ok(!existsSync(path.join(dir, "config.json")), "settings removed");
  assert.ok(!existsSync(path.join(dir, "logs")), "logs removed");
});
