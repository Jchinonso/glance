import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const ctx = vm.createContext({});
for (const f of ["highlight.js", "markdown.js"]) vm.runInContext(readFileSync(new URL(`../src/ui/${f}`, import.meta.url), "utf8"), ctx);
vm.runInContext("this.md = renderMarkdown; this.splitKeys = splitKeys", ctx);
const md = ctx.md;

test("heading directly followed by a list", () => {
  assert.equal(md("### Approach\n1. Sort\n2. Scan"), "<h4>Approach</h4><ol><li>Sort</li><li>Scan</li></ol>");
});

test("list directly under a paragraph line", () => {
  assert.equal(md("Steps:\n- one\n- two"), "<p>Steps:</p><ul><li>one</li><li>two</li></ul>");
});

test("tables", () => {
  const out = md("| Approach | Time |\n|---|---|\n| Scan | O(n) |");
  assert.match(out, /<th>Approach<\/th><th>Time<\/th>/);
  assert.match(out, /<td>Scan<\/td><td>O\(n\)<\/td>/);
});

test("inline formatting, and code is never formatted", () => {
  assert.equal(md("**bold** and *it* and `a*b*c`"), "<p><strong>bold</strong> and <em>it</em> and <code>a*b*c</code></p>");
});

test("escapes HTML everywhere", () => {
  const out = md("<img src=x onerror=alert(1)>\n\n```\n<script>\n```");
  assert.ok(!out.includes("<img") && !out.includes("<script>"));
});

test("multiplication is not italics", () => {
  assert.equal(md("2 * 3 * 4"), "<p>2 * 3 * 4</p>");
});

test("underscore italics render, snake_case stays", () => {
  assert.ok(md("_Assumed 5 years of Go._").includes("<em>Assumed 5 years of Go.</em>"));
  assert.ok(!md("call user_id_map here").includes("<em>"));
});

test("placeholder brackets stay as text", () => {
  assert.ok(md("I led [your example: a team project] last year").includes("[your example: a team project]"));
});

test("a Keys line still being streamed is hidden, not shown as text", () => {
  const split = (t, o) => JSON.parse(JSON.stringify(ctx.splitKeys(t, o)));
  assert.deepEqual(split("**I led it.**\n\nKeys: billing mig", { streaming: true }), { text: "**I led it.**\n", keys: [] });
  assert.deepEqual(split("**I led it.**\n\nKe", { streaming: true }), { text: "**I led it.**\n", keys: [] });
  assert.equal(split("**I led it.**\n\nKeys: billing mig").text, "**I led it.**\n\nKeys: billing mig", "finished answers keep it");
  assert.equal(split("**I led it.**\n\nKeys: a · b\n\nSo", { streaming: true }).text, "**I led it.**\n\nSo");
  assert.equal(split("**Kevin was great.**", { streaming: true }).text, "**Kevin was great.**", "a first line is never hidden");
});
