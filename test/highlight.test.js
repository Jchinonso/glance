import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const ctx = vm.createContext({});
vm.runInContext(`${readFileSync(new URL("../src/ui/highlight.js", import.meta.url), "utf8")}\nthis.highlightCode = highlightCode;`, ctx);
const { highlightCode } = ctx;

test("colors keywords, calls, strings, numbers and comments", () => {
  const out = highlightCode('def f(x):\n    return len("a<b") + 2  # done');
  assert.match(out, /<span class="tok-k">def<\/span>/);
  assert.match(out, /<span class="tok-f">len<\/span>/);
  assert.match(out, /<span class="tok-s">&quot;a&lt;b&quot;<\/span>/);
  assert.match(out, /<span class="tok-n">2<\/span>/);
  assert.match(out, /<span class="tok-c"># done<\/span>/);
});

test("escapes everything it emits", () => {
  assert.ok(!highlightCode("a < b && c > d").includes("<b"));
});

test("decrements, colors and private fields are not comments", () => {
  for (const code of ["for (i = n; i > 0; i--) { x(); }", 'c = "#fff"; d = #fff', "this.#count = 0"]) {
    assert.ok(!highlightCode(code).includes("tok-c"), code);
  }
  assert.match(highlightCode("x = 1  # set x"), /tok-c/);
  assert.match(highlightCode("SELECT 1 -- note"), /tok-c/);
});
