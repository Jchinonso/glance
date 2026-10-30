import { test } from "node:test";
import assert from "node:assert/strict";
import { isBackchannel, isEcho, isPromptHallucination } from "../src/transcript.js";

test("echo of the other side is caught", () => {
  const them = "Maybe it's not your first job. Which is good. And we would like to ask you a couple of questions.";
  assert.ok(isEcho("That's good. And we would like to ask you a couple of questions.", them));
  assert.ok(!isEcho("I've been building React apps for about ten years.", them));
});

test("backchannels are dropped, real short answers are kept", () => {
  for (const t of ["Mm-hmm.", "Uh-huh", "hmm", "Mm."]) assert.ok(isBackchannel(t), t);
  for (const t of ["Yes.", "No, not yet.", "Sure, go ahead."]) assert.ok(!isBackchannel(t), t);
});

test("repeated vocabulary terms from unclear audio are dropped", () => {
  const terms = ["React", "Next.js", "Redis", "Kubernetes"];
  assert.ok(isPromptHallucination("React, React, creation.", terms));
  assert.ok(!isPromptHallucination("We moved the cache to Redis last year.", terms));
  assert.ok(!isPromptHallucination("Yeah, yeah, sounds good.", terms));
});
