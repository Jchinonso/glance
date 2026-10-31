// Clicks through the real app: Electron in test mode (GLANCE_TEST_DIR: its own
// settings folder, no keychain, no global shortcuts, a see-through window),
// answered by a fake OpenAI-compatible server, driven over the DevTools
// protocol. Set GLANCE_SKIP_UI=1 to skip.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";

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
      res.writeHead(200, { "content-type": "text/event-stream" });
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
  writeFileSync(path.join(dir, "config.json"), JSON.stringify({ provider: "openai", openaiBaseUrl: modelUrl, openaiModel: "fake", autoScreen: false, style: "brief" }));
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
    document.getElementById("question").value = "my own question";
    onTranscript({ role: "them", text: "Why do you want this job?", start: ${now + 3000}, at: ${now + 4500} });
  `);
  await sleep(1200);
  assert.equal(await run(`return answers.length;`), count, "typing holds it off");
  await run(`document.getElementById("question").value = ""; state.listening = true;`);
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
  await run(`stillHearing = async () => false; state.listening = true; onTranscript({ role: "them", text: "Could you answer this one slowly?", start: ${now + 40000}, at: ${now + 41500} });`);
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

test("Interview mode without a resume asks for one first; auto-answer says it needs Interview mode", { skip }, async () => {
  await run(`await g.setSetting("resume", ""); await g.setSetting("jdCheckedAt", 0); await g.setSetting("style", "brief");`);
  await until(`state.style === "brief" && !state.resume`);
  await run(`setMenu(true); document.querySelector('#settingsTabs [data-tab="interview"]').click();`);
  assert.match(await run(`return document.getElementById("autoAnswerHint").textContent;`), /Only works in Interview mode/);
  await run(`setMenu(false);`);
  await click("#modeBtn");
  await click('#modeMenu [data-value="interview"]');
  await until(`state.style === "interview" && !document.getElementById("jdCard").hidden`);
  assert.match(await run(`return document.getElementById("jdText").textContent;`), /Add your resume/);
  assert.equal(await run(`return document.getElementById("jdNew").textContent;`), "Add resume");
  await click("#jdNew");
  assert.ok(await shown("docForm"));
  assert.equal(await run(`return docKind;`), "resume");
  await click("#docCancel");
  await run(`setMenu(true); document.querySelector('#settingsTabs [data-tab="interview"]').click();`);
  assert.match(await run(`return document.getElementById("autoAnswerHint").textContent;`), /as soon as the interviewer finishes/);
  await run(`setMenu(false);`);
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
