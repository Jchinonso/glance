import { test } from "node:test";
import assert from "node:assert/strict";
import { isBackchannel, isPromptHallucination } from "../src/transcript.js";

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
