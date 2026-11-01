import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// questions.js is a browser script; run it in a sandbox to get its global.
const ctx = vm.createContext({});
vm.runInContext(`${readFileSync(new URL("../src/ui/questions.js", import.meta.url), "utf8")}\nthis.isQuestion = isQuestion; this.nextPendingQuestion = nextPendingQuestion; this.mentionsScreen = mentionsScreen;`, ctx);
const { isQuestion, nextPendingQuestion, mentionsScreen } = ctx;

test("detects questions with and without a question mark", () => {
  for (const q of [
    "What time works for you?",
    "Okay so how would you design a rate limiter",
    "Um, and can you share the doc",
    "walk me through the rollout plan",
  ]) assert.ok(isQuestion(q), q);
});

test("detects interview prompts", () => {
  for (const q of [
    "Tell me about a time you disagreed with your manager",
    "Imagine the service goes down at 2am",
    "Design a URL shortener",
    "Write a function that reverses a linked list",
    "Any questions for us",
    "Does that approach scale",
    "I'd love to hear about your last project",
    "Let's say traffic doubles overnight",
  ]) assert.ok(isQuestion(q), q);
});

test("detects let us and shall openers", () => {
  for (const q of ["Can we talk about your last team", "Could we go over the design", "Shall we start with your background"]) assert.ok(isQuestion(q), q);
});

test("detects let's talk openers", () => {
  for (const q of ["Let's talk about a hard bug", "Let's discuss the tradeoffs", "Let's go over the rollout"]) assert.ok(isQuestion(q), q);
});

test("detects talk openers", () => {
  for (const q of ["Talk about a time you led a project", "Talk to me about your current role"]) assert.ok(isQuestion(q), q);
});

test("detects understanding and walkthrough openers", () => {
  for (const q of ["Help me understand how caching fits", "Run me through your last deploy", "Run us through the architecture"]) assert.ok(isQuestion(q), q);
});

test("detects wanting and wondering openers", () => {
  for (const q of ["I want to understand the migration", "I'd like to understand your process", "I'd like to know why you chose Kafka", "I want to know how you measure success", "I'm wondering how you handle on-call", "I wonder what you would change"]) assert.ok(isQuestion(q), q);
});

test("detects thoughts, experience and elaboration openers", () => {
  for (const q of ["Your thoughts on remote work", "Any experience with Kubernetes", "Have you ever shipped a breaking change", "Elaborate on the caching layer", "Go over the incident response", "Go through your testing strategy", "What if traffic doubles overnight"]) assert.ok(isQuestion(q), q);
});

test("ignores statements", () => {
  for (const s of ["I'll send the doc tomorrow.", "That sounds good to me", "Whatever works."]) assert.ok(!isQuestion(s), s);
});

test("wh-word statements are not questions, but real asks still are", () => {
  for (const s of ["When I was at Google we used Kafka.", "What we did was migrate."]) assert.ok(!isQuestion(s), s);
  for (const q of ["What I'd like to hear is how you scaled it", "When I say scale, how would you shard it", "What about caching", "How about sharding"]) assert.ok(isQuestion(q), q);
});

test("detects real asks that start with a wh-word and a subject pronoun", () => {
  for (const q of [
    "So what I'm asking is how you'd shard it",
    "What I mean is, how would it scale",
    "Where I'd like to start is your last role",
    "What I'm getting at is the failure mode",
  ]) assert.ok(isQuestion(q), q);
});

test("detects a question that follows a statement", () => {
  for (const q of [
    "Thanks for that. Can you walk me through the deploy",
    "We use Postgres today, so how would you scale reads",
    "I see. What would you change",
  ]) assert.ok(isQuestion(q), q);
  assert.ok(!isQuestion("Thanks for that. I'll send the deploy notes later."));
});

test("detects a question in any sentence, not just the last", () => {
  for (const q of [
    "Thanks. Can you explain the deploy. Take your time.",
    "We use Postgres today. How would you scale reads? I'll wait.",
    "I see. What would you change. Let me note that down.",
  ]) assert.ok(isQuestion(q), q);
  assert.ok(!isQuestion("Thanks. I'll send the deploy notes later. Take your time."));
});

const line = (role, text, at, start = at) => ({ role, text, at, start });

test("pending question: kept through short lines, dropped when talk moves on", () => {
  const q = "Tell me about a time you led a project";
  let p = nextPendingQuestion(null, line("them", q, 10000));
  assert.deepEqual({ ...p }, { text: q, at: 10000 });
  // Short aside after a long pause keeps it.
  p = nextPendingQuestion(p, line("them", "Take your time.", 20000, 19000));
  assert.equal(p.text, q);
  // User answered aloud (long gap), then an undetected follow-up: the old question must not be resent.
  assert.equal(nextPendingQuestion(p, line("them", "the team handles tradeoffs there all the time", 40000, 36000)), null);
  // A new detected question replaces the old one.
  assert.equal(nextPendingQuestion(p, line("them", "Why did you pick Kafka?", 40000, 38000)).text, "Why did you pick Kafka?");
});

test("pending question: a follow-up comment within 10 s keeps it, after 10 s it clears", () => {
  const p = { text: "Tell me about a time you led a project", at: 10000 };
  // Within the follow-up window: the old question stays unchanged.
  assert.deepEqual({ ...nextPendingQuestion(p, line("them", "just whatever comes to mind, nothing formal", 15000, 14000)) }, p);
  assert.deepEqual({ ...nextPendingQuestion(p, line("them", "just whatever comes to mind, nothing formal", 19000)) }, p);
  // After the window, a substantial non-question means the talk moved on.
  assert.equal(nextPendingQuestion(p, line("them", "just whatever comes to mind, nothing formal", 21000)), null);
  assert.equal(nextPendingQuestion(p, line("them", "just whatever comes to mind, nothing formal", 25000, 24000)), null);
});

test("pending question: a line right after a short pause continues it", () => {
  const p = { text: "Tell me about a time you disagreed", at: 10000 };
  assert.equal(nextPendingQuestion(p, line("them", "with your manager and how it ended", 13000, 10700)).text, `${p.text} with your manager and how it ended`);
  assert.equal(nextPendingQuestion(p, line("them", "And why?", 11500, 10800)).text, `${p.text} And why?`);
  // After a long gap the same words are a new turn, not a continuation.
  assert.equal(nextPendingQuestion(p, line("them", "And why?", 30000, 29000)).text, "And why?");
  // A long monologue isn't appended; within the follow-up window it keeps the
  // question, and after the window it falls back to the normal rule.
  assert.deepEqual({ ...nextPendingQuestion(p, line("them", "x ".repeat(250).trim(), 10700, 10700)) }, p);
  assert.equal(nextPendingQuestion(p, line("them", "x ".repeat(250).trim(), 30000, 29000)), null);
});

test("pending question: mic lines never touch it", () => {
  const p = { text: "How would you scale reads?", at: 20000 };
  assert.equal(nextPendingQuestion(p, line("me", "So at my last job we moved the whole team to Postgres", 30000, 22000)), p);
  assert.equal(nextPendingQuestion(null, line("me", "Tell me about yourself", 10000)), null);
});

test("pending question: late line spoken before the question changes nothing", () => {
  const p = { text: "How would you scale reads?", at: 20000 };
  assert.equal(nextPendingQuestion(p, line("them", "and that is why we moved the whole team to Postgres", 18000, 15000)), p);
});

test("heard questions about the screen get a screenshot", () => {
  for (const q of ["Can you solve the problem on screen?", "What does this function return?", "Look at line 12, what's wrong?", "I've pasted a query in the chat"]) assert.ok(mentionsScreen(q), q);
  for (const q of ["Tell me about yourself", "How would you design a rate limiter?", "What's your biggest weakness?"]) assert.ok(!mentionsScreen(q), q);
});

test("statements starting with any or has are not questions", () => {
  for (const s of ["Any time works for me", "Has to ship by Friday"]) assert.ok(!isQuestion(s), s);
  assert.ok(isQuestion("Any questions for us"));
});

test("pending question: keeps the lead-in said just before it", () => {
  const before = [line("them", "Thanks for walking me through that.", 3000, 1500), line("them", "So looking at your experience with distributed systems,", 9000, 6000)];
  const q = line("them", "how would you design a rate limiter?", 12500, 9900);
  assert.equal(nextPendingQuestion(null, q, before).text, "So looking at your experience with distributed systems, how would you design a rate limiter?");
  // Two lead-in pieces, each a short pause apart.
  const two = [line("them", "In your last role,", 5000, 4000), line("them", "at the payments company,", 7200, 5800)];
  assert.equal(nextPendingQuestion(null, line("them", "what was the hardest problem you solved?", 10000, 8000), two).text, "In your last role, at the payments company, what was the hardest problem you solved?");
  // An earlier question, or a long gap, is not a lead-in.
  assert.equal(nextPendingQuestion(null, q, [line("them", "Any questions so far?", 9000, 8000)]).text, q.text);
  assert.equal(nextPendingQuestion(null, q, [line("them", "So that's the team.", 4000, 2000)]).text, q.text);
});

test("pending question: pieces split by pauses read as one sentence", () => {
  let p = nextPendingQuestion(null, line("them", "Can you tell me about a time?", 4000, 1800));
  p = nextPendingQuestion(p, line("them", "When you had to deal with a difficult stakeholder.", 8100, 4500));
  p = nextPendingQuestion(p, line("them", "And how you handled it?", 10200, 8100));
  assert.equal(p.text, "Can you tell me about a time when you had to deal with a difficult stakeholder and how you handled it?");
  // A "how/what" clause after a lead-in gets a comma.
  const lead = [line("them", "So looking at your experience with front-end performance.", 9000, 6000)];
  assert.equal(nextPendingQuestion(null, line("them", "How would you make a slow page load faster?", 12000, 9800), lead).text, "So looking at your experience with front-end performance, how would you make a slow page load faster?");
  // A new sentence stays a new sentence, including one opening with "So".
  assert.equal(nextPendingQuestion(null, line("them", "So to start, can you tell me a bit about yourself?", 6000, 3800), [line("them", "Hi, thanks for joining today.", 3000, 1500)]).text, "Hi, thanks for joining today. So to start, can you tell me a bit about yourself?");
  const greet = [line("them", "Great!", 2000, 1500)];
  assert.equal(nextPendingQuestion(null, line("them", "Can you tell me about yourself?", 5000, 3000), greet).text, "Great! Can you tell me about yourself?");
});
