import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// questions.js is a browser script; run it in a sandbox to get its global.
const ctx = vm.createContext({});
vm.runInContext(`${readFileSync(new URL("../src/ui/questions.js", import.meta.url), "utf8")}\nthis.isQuestion = isQuestion;`, ctx);
const { isQuestion } = ctx;

test("detects questions with and without a question mark", () => {
  for (const q of [
    "What time works for you?",
    "Okay so how would you design a rate limiter",
    "Um, and can you share the doc",
    "walk me through the rollout plan",
  ]) assert.ok(isQuestion(q), q);
});

test("ignores statements", () => {
  for (const s of ["I'll send the doc tomorrow.", "That sounds good to me", "Whatever works."]) assert.ok(!isQuestion(s), s);
});

test("detects a question that follows a statement", () => {
  for (const q of [
    "Thanks for that. Can you walk me through the deploy",
    "We use Postgres today, so how would you scale reads",
    "I see. What would you change",
  ]) assert.ok(isQuestion(q), q);
  assert.ok(!isQuestion("Thanks for that. I'll send the deploy notes later."));
});
