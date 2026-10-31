import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const ctx = vm.createContext({});
vm.runInContext(`${readFileSync(new URL("../src/ui/hints.js", import.meta.url), "utf8")}\nthis.looksLikeResume = looksLikeResume;`, ctx);
const { looksLikeResume } = ctx;

const RESUME = `Jane Doe
Senior Backend Engineer

EXPERIENCE
Acme Pay, Backend Engineer, Mar 2021 – present
- Led billing migration to Postgres, cut invoice errors 40%.
- Built Kafka event pipeline handling 2M events/day.
Loop, Software Engineer, 2019 - 2021
- Built Node/TypeScript APIs for 30 customers.

EDUCATION
BSc Computer Science, 2015 – 2019`;

test("flags resume text pasted into custom instructions", () => {
  assert.ok(looksLikeResume(RESUME));
});

test("leaves ordinary instructions alone", () => {
  const rules = "Answer in British English. When code is involved, use TypeScript. Explain like I'm a senior engineer, so skip the basics. Keep answers short and lead with the answer. Salary range $140k-$160k, needs visa sponsorship, notice period 4 weeks. Never use emoji. Prefer Postgres examples over MySQL ones when it doesn't matter which.";
  assert.ok(!looksLikeResume(rules));
  assert.ok(!looksLikeResume("Experience: keep it short."));
});
