import { test } from "node:test";
import assert from "node:assert/strict";
import { caveman, compressAnswer, compressTranscript } from "../src/compress.js";

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
