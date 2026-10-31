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
      // "slowly" in the question: one piece, then hang until stopped.
      if (/slowly/.test(JSON.stringify(request.messages?.[1] ?? ""))) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "**Partly answered.**" } }] })}\n\n`);
        return req.on("close", () => res.end());
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
  await click('#obUse [data-value="interviews"]');
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

test("interview answers open compact: bold line and key phrases, with the full answer one click away", { skip }, async () => {
  await run(`localStorage.removeItem("glance.answerView"); answerView = "compact"; renderStage();`);
  assert.deepEqual(await run(`return [...document.querySelectorAll("#answerBody .keys li")].map((li) => li.textContent);`), ["billing migration", "40% fewer errors", "staged rollout"]);
  assert.ok(!(await run(`return document.getElementById("answerBody").textContent.includes("errors fell");`)), "compact hides the paragraphs");
  assert.match(await run(`return document.getElementById("answerBody").textContent;`), /Added: the side-by-side run/, "the note still shows");
  assert.equal(await run(`return document.getElementById("viewToggle").textContent;`), "Full answer");
  await click("#viewToggle");
  const full = await run(`return document.getElementById("answerBody").textContent;`);
  assert.match(full, /errors fell 40%/);
  assert.ok(!full.includes("Keys:"), "the Keys line never shows as text");
  assert.equal(await run(`return localStorage.getItem("glance.answerView");`), "full");
  await click("#viewToggle");
  assert.equal(await run(`return answerView;`), "compact");
});

test("what you actually said goes with the next question instead of the suggestion", { skip }, async () => {
  await click("#saidOpen");
  assert.ok(await shown("saidForm"));
  await run(`document.getElementById("saidInput").value = "I talked about the Kafka pipeline instead"; document.getElementById("saidForm").requestSubmit();`);
  assert.match(await run(`return document.getElementById("saidText").textContent;`), /Kafka pipeline instead/);
  await run(`document.getElementById("question").value = "How did you measure it?"; document.getElementById("askBtn").click();`);
  await until(`answers.length === 2 && answers[1].status === "done"`);
  const sent = requests.at(-1).messages[1].content.at(-1).text;
  assert.match(sent, /user said this instead of the suggestion\): I talked about Kafka pipeline instead/);
  assert.ok(!sent.includes("errors fell"), "the replaced suggestion isn't sent");
  // Earlier answers stay in the pager.
  await click("#prevBtn");
  assert.match(await run(`return document.getElementById("saidText").textContent;`), /Kafka/);
});

test("a stopped answer still counts: what you said about it reaches the next question", { skip }, async () => {
  await run(`document.getElementById("question").value = "Answer this slowly"; document.getElementById("askBtn").click();`);
  await until(`answers.at(-1).text.includes("Partly answered")`);
  await click("#askBtn"); // now Stop
  await until(`answers.at(-1).status === "done" && !state.busy`);
  await click("#saidOpen");
  await run(`document.getElementById("saidInput").value = "I described the Postgres cutover"; document.getElementById("saidForm").requestSubmit();`);
  await run(`document.getElementById("question").value = "Go on"; document.getElementById("askBtn").click();`);
  await until(`answers.at(-1).question === "Go on" && answers.at(-1).status === "done"`);
  assert.match(requests.at(-1).messages[1].content.at(-1).text, /instead of the suggestion\): I described Postgres cutover/);
});
