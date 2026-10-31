import { test } from "node:test";
import assert from "node:assert/strict";
import { ask, systemPrompt } from "../src/assistant.js";

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
