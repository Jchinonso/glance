import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { normalizeBaseUrl as main, renameModelForServer as renameMain } from "../src/urls.js";

// ui/urls.js is a browser script; run it in a sandbox to get its global.
const ctx = vm.createContext({ URL });
vm.runInContext(`${readFileSync(new URL("../src/ui/urls.js", import.meta.url), "utf8")}\nthis.normalizeBaseUrl = normalizeBaseUrl; this.renameModelForServer = renameModelForServer;`, ctx);
const ui = ctx.normalizeBaseUrl;
const renameUi = ctx.renameModelForServer;

const cases = [
  ["api.openai.com", "https://api.openai.com/v1"],
  ["  https://api.openai.com/  ", "https://api.openai.com/v1"],
  ["https://api.openai.com/v1/", "https://api.openai.com/v1"],
  ["https://api.openai.com/custom", "https://api.openai.com/custom"],
  ["openrouter.ai", "https://openrouter.ai/api/v1"],
  ["api.groq.com", "https://api.groq.com/openai/v1"],
  ["api.mistral.ai", "https://api.mistral.ai/v1"],
  ["api.together.xyz", "https://api.together.xyz/v1"],
  ["generativelanguage.googleapis.com", "https://generativelanguage.googleapis.com/v1beta/openai"],
  ["api.deepseek.com", "https://api.deepseek.com/v1"],
  ["localhost:11434", "http://localhost:11434/v1"],
  ["localhost:1234/", "http://localhost:1234/v1"],
  ["http://localhost:11434", "http://localhost:11434/v1"],
  ["localhost:8080", "http://localhost:8080"],
  ["127.0.0.1:8000/v1", "http://127.0.0.1:8000/v1"],
  ["[::1]:8000", "http://[::1]:8000"],
  ["my.server.example/v2", "https://my.server.example/v2"],
  ["https://api.openai.com", "https://api.openai.com/v1"],
  ["", ""],
  ["not a url", ""],
  ["https://", ""],
  ["ftp://example.com", ""],
  ["https:// api.openai.com", ""],
];

test("normalizeBaseUrl: scheme, standard paths, rejects non-addresses", () => {
  for (const [input, want] of cases) {
    assert.equal(main(input), want, `main: ${JSON.stringify(input)}`);
    assert.equal(ui(input), want, `ui: ${JSON.stringify(input)}`);
  }
  assert.equal(main(undefined), "");
});

const renames = [
  ["openai/gpt-5.4", "https://api.openai.com/v1", "gpt-5.4"],
  ["gpt-5.4", "https://api.openai.com/v1", "gpt-5.4"],
  ["~openai/gpt-5:free", "https://api.openai.com/v1", "gpt-5"],
  ["google/gemini-2.5-pro", "https://generativelanguage.googleapis.com/v1beta/openai", "gemini-2.5-pro"],
  ["mistralai/mistral-large", "https://api.mistral.ai/v1", "mistral-large"],
  ["deepseek/deepseek-chat:nitro", "https://api.deepseek.com/v1", "deepseek-chat"],
  ["x-ai/grok-4", "https://api.x.ai/v1", "grok-4"],
  ["anthropic/claude-x", "https://api.openai.com/v1", "anthropic/claude-x"],
  ["gpt-5", "https://openrouter.ai/api/v1", "openai/gpt-5"],
  ["o3", "https://openrouter.ai/api/v1", "openai/o3"],
  ["claude-sonnet-4", "https://openrouter.ai/api/v1", "anthropic/claude-sonnet-4"],
  ["gemini-2.5-pro", "https://openrouter.ai/api/v1", "google/gemini-2.5-pro"],
  ["codestral-latest", "https://openrouter.ai/api/v1", "mistralai/codestral-latest"],
  ["deepseek-chat", "https://openrouter.ai/api/v1", "deepseek/deepseek-chat"],
  ["grok-4", "https://openrouter.ai/api/v1", "x-ai/grok-4"],
  ["llama3.1", "https://openrouter.ai/api/v1", "meta-llama/llama3.1"],
  ["qwen3", "https://openrouter.ai/api/v1", "qwen/qwen3"],
  ["my-model", "https://openrouter.ai/api/v1", "my-model"],
  ["openai/gpt-5", "https://openrouter.ai/api/v1", "openai/gpt-5"],
  ["openai/gpt-5", "https://api.groq.com/openai/v1", "openai/gpt-5"],
  ["openai/gpt-5", "http://localhost:11434/v1", "openai/gpt-5"],
  ["openai/gpt-5", "", "openai/gpt-5"],
];

test("renameModelForServer: vendor prefixes follow the server", () => {
  for (const [model, url, want] of renames) {
    assert.equal(renameMain(model, url), want, `main: ${model} @ ${url}`);
    assert.equal(renameUi(model, url), want, `ui: ${model} @ ${url}`);
  }
});
