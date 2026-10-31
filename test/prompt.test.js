import { test } from "node:test";
import assert from "node:assert/strict";
import { ask, splitKeys, systemPrompt } from "../src/assistant.js";

test("resume and job description go with every style, word for word", () => {
  const resume = "Led the billing migration, cut invoice errors 40%.";
  const job = "Senior Backend Engineer at Ledgerly.";
  for (const style of ["interview", "brief", "natural"]) {
    const p = systemPrompt(style, "", resume, job);
    assert.ok(p.includes(`<resume>\n${resume}\n</resume>`), style);
    assert.ok(p.includes(`<job_description>\n${job}\n</job_description>`), style);
  }
  // Outside Interview mode, only for questions about the user or the role.
  assert.ok(systemPrompt("brief", "", resume, job).includes("Use only when a question is about the user"));
  assert.ok(!systemPrompt("interview", "", resume, job).includes("Use only when a question is about the user"));
});

test("custom instructions come last so they win conflicts", () => {
  const p = systemPrompt("interview", "Answer in British English.", "resume text", "job text");
  assert.ok(p.indexOf("<user_instructions>") > p.indexOf("<job_description>"));
});

test("Interview style leaves out the general rules that conflict with spoken answers", () => {
  const p = systemPrompt("interview", "", "", "");
  for (const rule of ["State any assumption in one line", "what the main alternative would cost", "Never ask clarifying questions"]) assert.ok(!p.includes(rule), rule);
  assert.ok(p.includes("Resume = case study") && p.includes("never placeholders"));
  assert.ok(systemPrompt("brief", "", "", "").includes("State any assumption in one line"));
});

// Captures the request ask() would send, without calling the API.
function sentText(style, previous) {
  let params;
  const provider = { name: () => "test", stream: (p) => { params = p; return { done: new Promise(() => {}), abort() {} }; } };
  ask({ provider, model: "m", question: "", transcript: [], previous, screenshots: [], effort: "low", style, customInstructions: "", onText() {} });
  return params.parts.at(-1).text;
}

test("interview keeps older answers long enough for follow-ups to stay consistent", () => {
  const story = `**At Acme Pay I disagreed with my manager.** ${"Details of the story. ".repeat(40)}We finished a week late.`;
  const previous = [{ question: "Tell me about a disagreement.", answer: story }, { question: "Why?", answer: "Short." }];
  assert.ok(sentText("interview", previous).includes("finished week late"));
  assert.ok(!sentText("brief", previous).includes("finished week late"));
});

test("your details from setup go with every question", () => {
  const p = systemPrompt("brief", "", "", "", { name: "Johnson", salary: "$140k-$160k", visa: "Needs sponsorship", notice: "" });
  assert.ok(p.includes("<user_details>\nName: Johnson\nSalary expectation: $140k-$160k\nVisa status: Needs sponsorship\n</user_details>"));
  assert.ok(!systemPrompt("brief", "", "", "", {}).includes("<user_details>"));
});

test("the Keys line is split off, and only near the top", () => {
  const answer = "**I led the billing migration.**\nKeys: billing migration · 40% fewer errors · staged rollout\n\nAt Acme Pay we…";
  assert.deepEqual(splitKeys(answer), { text: "**I led the billing migration.**\n\nAt Acme Pay we…", keys: ["billing migration", "40% fewer errors", "staged rollout"] });
  assert.deepEqual(splitKeys("**Hi.**\n\na\n\nb\n\nKeys: not this").keys, []);
  assert.deepEqual(splitKeys("**Yes.**\n\nKeys: · Proud of Acme work · Four weeks notice").keys, ["Proud of Acme work", "Four weeks notice"]); // stray leading dot
  assert.deepEqual(splitKeys("**Yes.**\n**Keys:** cache first · then shard").keys, ["cache first", "then shard"]); // bold label
  assert.deepEqual(splitKeys("To remap:\nKeys: Cmd+K opens search").keys, [], "an ordinary Keys: line stays");
  assert.equal(splitKeys("**A.**\n\nKeys: x · y\n\nBody.").text, "**A.**\n\nBody.", "no double gap left behind");
});

test("earlier answers drop their Keys line; what the user said replaces the suggestion", async () => {
  let sent = "";
  const provider = { name: () => "x", stream: ({ parts }) => ((sent = parts.at(-1).text), { done: Promise.resolve({ text: "", usage: {}, stop: "end" }), abort() {} }) };
  const previous = [
    { question: "Tell me about a project.", answer: "**The billing migration.**\nKeys: billing · Postgres · 40%\n\nWe moved billing to Postgres." },
    { question: "Why Postgres?", answer: "**Transactions.**\n\nIt gave us real transactions.", said: "I talked about the team knowing Postgres already" },
  ];
  await ask({ provider, model: "m", question: "", transcript: [], previous, screenshots: [], effort: "low", style: "interview", onText() {} }).done;
  assert.ok(!sent.includes("Keys:"), sent);
  assert.match(sent, /A \(user said this instead of the suggestion\): .*team knowing Postgres/);
  assert.ok(!sent.includes("It gave us real transactions"));
});

test("an answer cut short is marked as such for follow-ups", async () => {
  let sent = "";
  const provider = { name: () => "x", stream: ({ parts }) => ((sent = parts.at(-1).text), { done: Promise.resolve({ text: "", usage: {}, stop: "end" }), abort() {} }) };
  const previous = [{ question: "Walk me through the migration.", answer: "**We moved billing to Postgres.**\n\nFirst we", stopped: true }];
  await ask({ provider, model: "m", question: "", transcript: [], previous, screenshots: [], effort: "low", style: "interview", onText() {} }).done;
  assert.match(sent, /First we \[stopped before the end\]/);
});
