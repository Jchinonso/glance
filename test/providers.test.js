import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createProvider, thinkingFor } from "../src/providers.js";

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
