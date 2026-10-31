// Regenerates the README screenshots in docs/images/: runs Glance in test mode
// (its own settings folder, no keychain) with a made-up profile and a fake
// OpenAI-compatible model, walks through the main screens and captures each.
//   node scripts/screenshots.mjs
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "docs", "images");
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RESUME = `Jane Doe
Senior Backend Engineer · jane@example.com

EXPERIENCE
Acme Pay, Backend Engineer, 2021 – present
- Led billing migration to Postgres, cut invoice errors 40%.
- Built Kafka event pipeline handling 2M events/day.

Loop, Software Engineer, 2019 – 2021
- Built Node/TypeScript APIs.

SKILLS
Node.js, TypeScript, Postgres, Kafka, AWS`;
const JOB = "Senior Backend Engineer at Ledgerly. Payments infrastructure: Postgres, Kafka, Go. On-call rotation.";
const ANSWER = `**At Acme Pay I led our billing migration to Postgres, and it cut invoice errors by 40%. It's the reliability win I'm proudest of.**

Keys: Invoices drifting out of sync · Transactions and constraints · Side-by-side cutover · 40% fewer errors

Our old billing setup let invoice data drift out of sync, so customers got wrong or duplicate invoices and finance fixed them by hand. Since this was money, every error cost us trust and support time.

I moved invoice creation into single Postgres transactions, added constraints so duplicates couldn't be written, and made the billing jobs safe to retry. Rather than a big-bang cutover, we ran both systems side by side, compared their output, and moved customers over in stages.

Invoice errors dropped 40%, and the manual cleanup mostly went away. Looking back, I'd build the reconciliation dashboard on day one, because catching mismatches early made the biggest difference.

*Added: the side-by-side cutover and dashboard. Check they match what you did.*`;

const server = http.createServer((req, res) => {
  req.resume();
  req.on("end", async () => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const piece of ANSWER.match(/[\s\S]{1,40}/g)) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5214, completion_tokens: 318 } })}\n\ndata: [DONE]\n\n`);
    res.end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));

const dir = mkdtempSync(path.join(os.tmpdir(), "glance-shots-"));
writeFileSync(path.join(dir, "config.json"), JSON.stringify({ provider: "openai", openaiBaseUrl: `http://127.0.0.1:${server.address().port}/v1`, openaiModel: "gpt-4o", autoScreen: false, style: "interview", invisible: true, resume: RESUME, jobDescription: JOB, profileName: "Jane Doe", notice: "4 weeks" }));
const port = 9900 + Math.floor(Math.random() * 90);
const app = spawn(electronPath, [root, `--remote-debugging-port=${port}`], { env: { ...process.env, GLANCE_TEST_DIR: dir, ANTHROPIC_API_KEY: "sk-ant-placeholder-1234" }, stdio: "ignore" });

let page;
for (let i = 0; i < 100 && !page; i++) {
  await sleep(100);
  try {
    page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page");
  } catch {}
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const waiting = new Map();
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  waiting.get(d.id)?.(d);
};
await new Promise((r) => (ws.onopen = r));
const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const run = async (js) => (await cdp("Runtime.evaluate", { expression: `(async () => { ${js} })()`, awaitPromise: true, returnByValue: true })).result?.result?.value;
const until = async (js) => { for (let i = 0; i < 100 && !(await run(`return !!(${js});`)); i++) await sleep(50); };
async function shot(name) {
  await sleep(500); // let the window fit its content
  const { result } = await cdp("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(out, `${name}.png`), Buffer.from(result.data, "base64"));
  console.log(`docs/images/${name}.png`);
}

await until(`typeof state !== "undefined" && state.shortcuts`);
await shot("welcome");
await run(`document.getElementById("obNext").click();`);
await shot("setup-about");
await run(`document.getElementById("onboardSkip").click();`);
await until(`!onboarding`);
await run(`askingJob = true; render();`);
await shot("new-interview");
await run(`document.getElementById("jdSame").click();`);

// Listening, with a question split by pauses joined back together.
const now = Date.now();
await run(`
  state.listening = true; state.listeningSince = Date.now() - 754000;
  stillHearing = async () => true; // keep auto-answer from firing for this shot
  onTranscript({ role: "them", text: "Thanks for that.", start: ${now - 9000}, at: ${now - 8000} });
  onTranscript({ role: "them", text: "So looking at your time at Acme Pay,", start: ${now - 4000}, at: ${now - 2500} });
  onTranscript({ role: "them", text: "can you tell me about a reliability win you're proud of?", start: ${now - 1800}, at: ${now} });
`);
await shot("question-heard");

await run(`stillHearing = async () => false; document.getElementById("answerQBtn").click();`);
await until(`answers.length && answers.at(-1).status === "done"`);
await run(`state.listening = true; pendingQuestion = null; renderStrip(); document.getElementById("stage").scrollTop = 0;`);
await shot("interview-answer");

await run(`document.getElementById("viewToggle").click();`);
await shot("key-points");
await run(`document.getElementById("viewToggle").click();`);

await run(`document.getElementById("modeBtn").click();`);
await shot("mode-menu");
await run(`setModeMenu(false);`);

await run(`document.getElementById("menuBtn").click(); document.querySelector('#settingsTabs [data-tab="interview"]').click();`);
await shot("settings-interview");
// Shown with Anthropic selected (placeholder key; nothing is sent).
await run(`await g.setSetting("provider", "anthropic"); await g.setSetting("model", "claude-sonnet-5-5"); document.querySelector('#settingsTabs [data-tab="answers"]').click();`);
await shot("settings-answers");
await run(`setMenu(false);`);

await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
await shot("light-mode");

ws.close();
await new Promise((r) => (app.once("exit", r), app.kill()));
server.close();
rmSync(dir, { recursive: true, force: true });
