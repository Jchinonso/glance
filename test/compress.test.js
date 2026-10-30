import { test } from "node:test";
import assert from "node:assert/strict";
import { caveman, compressAnswer, compressTranscript, keepsFacts } from "../src/compress.js";

test("drops filler, articles and repeated words", () => {
  assert.equal(caveman("Um, so you know, I think the the cache is really slow."), "so cache is slow.");
});

test("keeps negations and numbers", () => {
  const out = caveman("This is not the only way, but never use more than 3 threads.");
  for (const word of ["not", "only", "never", "3"]) assert.match(out, new RegExp(`\\b${word}\\b`));
});

test("leaves inline and fenced code untouched", () => {
  const code = "```python\ndef f(a):\n    return the_value  # the end\n```";
  const out = caveman(`Use the \`the a an\` name.\n\n${code}`);
  assert.ok(out.includes("`the a an`"));
  assert.ok(out.includes(code));
});

test("transcript: merges same speaker and drops filler-only lines", () => {
  const out = compressTranscript([
    { role: "them", text: "Um, what is the plan?" },
    { role: "them", text: "And when?" },
    { role: "me", text: "Uh." },
  ]);
  assert.deepEqual(out, [{ role: "them", text: "what is plan? And when?" }]);
});

test("answers are capped", () => {
  const text = Array.from({ length: 200 }, (_, i) => `step${i}`).join(" ");
  const out = compressAnswer(text, 100);
  assert.ok(out.length <= 101 && out.endsWith("…"));
});

test("filler after a negation stays, so meaning doesn't flip", () => {
  assert.equal(caveman("This is not just slow."), "This is not just slow.");
  assert.equal(caveman("It is not very good."), "It is not very good.");
});

test("capital A is kept as a name", () => {
  assert.equal(caveman("Plan A beats option B."), "Plan A beats option B.");
});

test("repeated numbers are not collapsed", () => {
  assert.equal(caveman("Scores were 10 10 9."), "Scores were 10 10 9.");
});

test("filler inside hyphenated words stays", () => {
  assert.equal(caveman("Use just-in-time compilation."), "Use just-in-time compilation.");
});

test("quoted text is left exact", () => {
  assert.equal(caveman('The error said "the file is just missing".'), 'error said "the file is just missing".');
});

test("kind of meaning type is kept", () => {
  assert.equal(caveman("What kind of index?"), "What kind of index?");
});

test("keepsFacts: accepts a terse rewrite that keeps the payload", () => {
  const original = "Please never deploy on Fridays. Don't use port 8080. See https://x.io/a and run `npm ci`.";
  assert.ok(keepsFacts(original, "- Never deploy Fridays.\n- Not port 8080.\n- See https://x.io/a, run `npm ci`."));
});

test("keepsFacts: rejects a rewrite that lost a negation, number, link or code", () => {
  const original = "Never deploy on Fridays. Use port 8080. See https://x.io/a and run `npm ci`.";
  assert.ok(!keepsFacts(original, "Deploy Fridays. Port 8080. See https://x.io/a, run `npm ci`."));
  assert.ok(!keepsFacts(original, "Never deploy Fridays. Port 80. See https://x.io/a, run `npm ci`."));
  assert.ok(!keepsFacts(original, "Never deploy Fridays. Port 8080. Run `npm ci`."));
  assert.ok(!keepsFacts(original, "Never deploy Fridays. Port 8080. See https://x.io/a, run npm ci."));
});
