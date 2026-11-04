import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createProvider, supportsEffort, thinkingFor } from "../src/providers.js";

test("thinkingFor: thinking is off at Quick only where the model allows it", () => {
  assert.deepEqual(thinkingFor("claude-sonnet-5-5", "low"), { type: "between_tools" });
  assert.deepEqual(thinkingFor("claude-haiku-5-5", "low"), { type: "disabled" });
  assert.equal(thinkingFor("claude-opus-5-5", "low"), undefined);
  assert.equal(thinkingFor("claude-sonnet-5-5", "medium"), undefined);
});

test("thinkingFor: think = true keeps adaptive thinking on at Quick", () => {
  assert.equal(thinkingFor("claude-sonnet-5-5", "low", true), undefined);
  assert.equal(thinkingFor("claude-haiku-5-5", "low", true), undefined);
  assert.deepEqual(thinkingFor("claude-sonnet-5-5", "low", false), { type: "between_tools" });
  assert.deepEqual(thinkingFor("claude-haiku-5-5", "low", false), { type: "disabled" });
});

test("OpenAI-compatible: prewarm is a no-op", async () => {
  const p = createProvider({ provider: "openai", apiKey: "k", baseUrl: "http://127.0.0.1:1/v1", model: "m" });
  assert.equal(await p.prewarm({ model: "m", system: "s", effort: "low" }), null);
});

// A tiny Anthropic server: records requests and answers as a message.
async function mockAnthropic() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ url: req.url, body: body ? JSON.parse(body) : null });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "m1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5-5",
          content: [{ type: "text", text: "." }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 7, output_tokens: 0, cache_read_input_tokens: 3, cache_creation_input_tokens: 120 },
        }),
      );
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, requests, close: () => server.close() };
}

test("OpenAI-compatible: listModels reads /models, sends the key, sorts by id", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "zeta", name: "Zeta" }, { id: "alpha" }, { id: "middle", name: "Middle" }] }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    const p = createProvider({ provider: "openai", apiKey: "key-123", baseUrl, model: "x" });
    const models = await p.listModels({});
    assert.deepEqual(models, [
      { id: "alpha", name: "alpha" },
      { id: "middle", name: "Middle" },
      { id: "zeta", name: "Zeta" },
    ]);
    assert.equal(seen[0].url, "/v1/models");
    assert.equal(seen[0].headers.authorization, "Bearer key-123");
  } finally {
    server.close();
  }
});

test("OpenAI-compatible: listModels leaves out models that can't chat", async () => {
  const ids = ["gpt-5", "text-embedding-3-small", "whisper-1", "tts-1-hd", "dall-e-3", "omni-moderation-latest", "gpt-4o-transcribe", "gpt-realtime", "gpt-image-1", "nomic-embed-text", "openai/gpt-4o-mini", "meta-llama/llama-4-scout", "anthropic/claude-haiku-5.5:batch", "mistral-ocr-latest"];
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: ids.map((id) => ({ id })) }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const p = createProvider({ provider: "openai", apiKey: "k", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: "x" });
    assert.deepEqual((await p.listModels({})).map((m) => m.id), ["gpt-5", "meta-llama/llama-4-scout", "openai/gpt-4o-mini"]);
  } finally {
    server.close();
  }
});

test("OpenAI-compatible: Gemini's \"models/\" prefix is dropped from listed IDs", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "models/gemini-2.5-flash", display_name: "Gemini 2.5 Flash" }] }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    // The host check reads the base URL, so the test server stands in under a matching path.
    const p = createProvider({ provider: "openai", apiKey: "k", baseUrl: `http://127.0.0.1:${server.address().port}/generativelanguage.googleapis.com/v1beta/openai`, model: "x" });
    assert.deepEqual(await p.listModels({}), [{ id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" }]);
  } finally {
    server.close();
  }
});

test("supportsEffort: effort only for models that accept it", () => {
  for (const id of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-4-5", "claude-opus-4-8", "claude-sonnet-4-6", "claude-sonnet-5", "claude-fable-5-1"]) assert.equal(supportsEffort(id), true, id);
  for (const id of ["claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4-1", "claude-3-7-sonnet-latest", "", undefined]) assert.equal(supportsEffort(id), false, String(id));
});

test("OpenAI-compatible: testConnection succeeds and names a rejected key", async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const request = JSON.parse(body || "{}");
      requests.push(request);
      if (request.model === "badkey") {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "invalid api key" } }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const p = createProvider({ provider: "openai", apiKey: "key-123", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: "good" });
    const result = await p.testConnection("good");
    assert.equal(result.ok, true);
    assert.ok(result.ms >= 0);
    assert.deepEqual(requests[0].messages, [{ role: "user", content: "Hi" }]);
    assert.equal(requests[0].max_tokens, 1);
    const e = await p.testConnection("badkey").catch((err) => err);
    assert.match(e.message, /rejected the API key/);
  } finally {
    server.close();
  }
});

test("Anthropic: listModels reads display names, testConnection sends a tiny message", async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ url: req.url, body: body ? JSON.parse(body) : null });
      res.writeHead(200, { "content-type": "application/json" });
      if (req.method === "GET") {
        res.end(JSON.stringify({ data: [{ id: "claude-z", display_name: "Claude Zed" }, { id: "claude-a", display_name: "Claude Aye" }], has_more: false, first_id: "claude-z", last_id: "claude-a" }));
        return;
      }
      res.end(JSON.stringify({
        id: "m1",
        type: "message",
        role: "assistant",
        model: "claude-a",
        content: [{ type: "text", text: "." }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const p = createProvider({ provider: "anthropic", apiKey: "sk-ant-test", anthropicBaseUrl: `http://127.0.0.1:${server.address().port}` });
    const models = await p.listModels({});
    assert.deepEqual(models, [
      { id: "claude-a", name: "Claude Aye" },
      { id: "claude-z", name: "Claude Zed" },
    ]);
    assert.equal(requests[0].url.startsWith("/v1/models"), true);
    const result = await p.testConnection("claude-a");
    assert.equal(result.ok, true);
    const body = requests.at(-1).body;
    assert.equal(body.model, "claude-a");
    assert.equal(body.max_tokens, 1);
    assert.deepEqual(body.messages, [{ role: "user", content: "Hi" }]);
    assert.equal(body.output_config, undefined); // older models reject effort
  } finally {
    server.close();
  }
});

test("Anthropic: an unknown model ID is sent as-is and has no price", async () => {
  const srv = await mockAnthropic();
  try {
    const p = createProvider({ provider: "anthropic", apiKey: "sk-ant-test", anthropicBaseUrl: srv.url.replace(/\/v1$/, "") });
    await p.prewarm({ model: "claude-future-9", system: "s", effort: "low" });
    assert.equal(srv.requests[0].body.model, "claude-future-9");
    assert.equal(p.cost({ input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 }, "claude-future-9"), null);
  } finally {
    srv.close();
  }
});

test("Anthropic: prewarm sends a non-streaming max_tokens 0 cache request", async () => {
  const srv = await mockAnthropic();
  try {
    const p = createProvider({ provider: "anthropic", apiKey: "sk-ant-test", anthropicBaseUrl: srv.url.replace(/\/v1$/, "") });
    const u = await p.prewarm({ model: "claude-sonnet-5-5", system: "the prompt", effort: "low" });
    assert.deepEqual(u, { input: 7, output: 0, cacheRead: 3, cacheWrite: 120 });
    const body = srv.requests[0].body;
    assert.equal(body.max_tokens, 0);
    assert.equal(body.stream, undefined);
    assert.deepEqual(body.messages, [{ role: "user", content: "." }]);
    assert.deepEqual(body.output_config, { effort: "low" });
    assert.deepEqual(body.system, [{ type: "text", text: "the prompt", cache_control: { type: "ephemeral", ttl: "1h" } }]);
    assert.deepEqual(body.thinking, { type: "between_tools" });

    await p.prewarm({ model: "claude-haiku-5-5", system: "s", effort: "low" });
    assert.deepEqual(srv.requests[1].body.thinking, { type: "disabled" });

    await p.prewarm({ model: "claude-opus-5-5", system: "s", effort: "low" });
    assert.equal("thinking" in srv.requests[2].body, false);

    await p.prewarm({ model: "claude-sonnet-5-5", system: "s", effort: "medium" });
    assert.equal("thinking" in srv.requests[3].body, false);
  } finally {
    srv.close();
  }
});
