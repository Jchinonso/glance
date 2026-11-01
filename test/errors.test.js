import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import { createProvider, isAbort } from "../src/providers.js";

const make = (Cls, status, message) => new Cls(status, { type: "error", error: { type: "x", message } }, message, new Headers());

test("Anthropic: maps API failures to plain advice", () => {
  const p = createProvider({ provider: "anthropic", apiKey: "sk-ant-test" });
  assert.match(p.describeError(make(Anthropic.AuthenticationError, 401, "invalid x-api-key")), /key was rejected/);
  assert.match(p.describeError(make(Anthropic.RateLimitError, 429, "rate limited")), /Wait a few seconds/);
  assert.match(p.describeError(make(Anthropic.BadRequestError, 400, "Your credit balance is too low")), /out of credit/);
  assert.match(p.describeError(make(Anthropic.InternalServerError, 529, "Overloaded")), /busy/);
  assert.match(p.describeError(new Anthropic.APIConnectionError({ message: "fetch failed" })), /internet connection/);
});

test("Anthropic: costs use each model's prices", () => {
  const p = createProvider({ provider: "anthropic", apiKey: "sk-ant-test" });
  const u = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 };
  assert.equal(p.cost(u, "claude-opus-5-5"), 24);
  assert.equal(p.cost(u, "claude-sonnet-5-5"), 12);
  assert.equal(p.cost(u, "claude-haiku-5-5"), 0.6);
  assert.equal(p.cost(u, "unknown-model"), 12); // falls back to the default (Sonnet)
});

// A tiny OpenAI-compatible server: records requests, replies as told.
async function mockServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const r = { url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null };
      requests.push(r);
      handler(r, res);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, requests, close: () => server.close() };
}

const sse = (res, events) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const e of events) res.write(`data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`);
  res.end();
};

test("OpenAI-compatible: streams text, sends images and the key, reports usage", async () => {
  const srv = await mockServer((r, res) =>
    sse(res, [
      { choices: [{ delta: { content: "Hel" } }] },
      { choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 120, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 100 } } },
      "[DONE]",
    ]),
  );
  try {
    const p = createProvider({ provider: "openai", apiKey: "key-123", baseUrl: srv.url, model: "gpt-test" });
    let streamed = "";
    const { done } = p.stream({ model: "gpt-test", system: "be brief", parts: [{ type: "image", data: "QUJD" }, { type: "text", text: "hi" }], maxTokens: 100, onText: (t) => (streamed += t) });
    const result = await done;
    assert.equal(streamed, "Hello");
    assert.deepEqual({ ...result, usage: { ...result.usage } }, { text: "Hello", usage: { input: 120, output: 2, cacheRead: 100, cacheWrite: 0 }, stop: "end", refusal: null });
    const req = srv.requests[0];
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, "Bearer key-123");
    assert.equal(req.body.model, "gpt-test");
    assert.deepEqual(req.body.messages[0], { role: "system", content: "be brief" });
    assert.deepEqual(req.body.messages[1].content[0], { type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } });
    assert.equal(p.cost(result.usage), null); // prices unknown
    assert.equal(p.name("gpt-test"), "gpt-test");
  } finally {
    srv.close();
  }
});

test("OpenAI-compatible: no key header for a local server, cut-off answers reported", async () => {
  const srv = await mockServer((r, res) => sse(res, [{ choices: [{ delta: { content: "x" }, finish_reason: "length" }] }, "[DONE]"]));
  try {
    const p = createProvider({ provider: "openai", apiKey: null, baseUrl: srv.url, model: "llama" });
    const result = await p.stream({ model: "llama", system: "s", parts: [{ type: "text", text: "q" }], maxTokens: 5, onText() {} }).done;
    assert.equal(result.stop, "max_tokens");
    assert.equal(srv.requests[0].headers.authorization, undefined);
  } finally {
    srv.close();
  }
});

test("OpenAI-compatible: single requests and plain-advice errors", async () => {
  const srv = await mockServer((r, res) => {
    if (r.body.model === "missing") {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "model not found" } }));
    }
    if (r.body.model === "badkey") {
      res.writeHead(401);
      return res.end("{}");
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "notes" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1 } }));
  });
  try {
    const p = createProvider({ provider: "openai", apiKey: "k", baseUrl: srv.url, model: "ok" });
    const result = await p.complete({ model: "ok", system: "s", user: "u", maxTokens: 50 });
    assert.equal(result.text, "notes");
    assert.equal(srv.requests[0].body.stream, undefined);
    const missing = await p.complete({ model: "missing", system: "s", user: "u", maxTokens: 5 }).catch((e) => e);
    assert.match(p.describeError(missing, "missing"), /doesn't have a model called "missing"/);
    const badkey = await p.complete({ model: "badkey", system: "s", user: "u", maxTokens: 5 }).catch((e) => e);
    assert.match(p.describeError(badkey, "badkey"), /rejected the API key/);
    const down = createProvider({ provider: "openai", apiKey: "k", baseUrl: "http://127.0.0.1:1/v1", model: "x" });
    const unreachable = await down.complete({ model: "x", system: "s", user: "u", maxTokens: 5 }).catch((e) => e);
    assert.match(down.describeError(unreachable, "x"), /Can't reach 127\.0\.0\.1:1/);
  } finally {
    srv.close();
  }
});

test("OpenAI-compatible: cancelling a stream counts as an abort", async () => {
  const srv = await mockServer((r, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "slow" } }] })}\n\n`); // never ends
  });
  try {
    const p = createProvider({ provider: "openai", apiKey: "k", baseUrl: srv.url, model: "m" });
    const job = p.stream({ model: "m", system: "s", parts: [{ type: "text", text: "q" }], maxTokens: 5, onText: () => job.abort() });
    const e = await job.done.catch((err) => err);
    assert.ok(isAbort(e));
  } finally {
    srv.close();
  }
});

test("OpenAI-compatible: switches to max_completion_tokens, or drops the limit, when the server refuses it", async () => {
  const srv = await mockServer((r, res) => {
    const reply = (status, message) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(status === 200 ? { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] } : { error: { message } }));
    };
    if (r.body.model === "new" && "max_tokens" in r.body) return reply(400, "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.");
    if (r.body.model === "small" && ("max_tokens" in r.body || "max_completion_tokens" in r.body)) return reply(400, "max_tokens must be less than or equal to 8192");
    reply(200);
  });
  try {
    const fresh = () => createProvider({ provider: "openai", apiKey: "k", baseUrl: srv.url, model: "x" });
    const p = fresh();
    assert.equal((await p.complete({ model: "new", system: "s", user: "u", maxTokens: 50 })).text, "ok");
    await p.complete({ model: "new", system: "s", user: "u", maxTokens: 50 }); // remembered: no second refusal
    assert.deepEqual(srv.requests.map((r) => [r.body.max_tokens, r.body.max_completion_tokens]), [[50, undefined], [undefined, 50], [undefined, 50]]);
    srv.requests.length = 0;
    assert.equal((await fresh().complete({ model: "small", system: "s", user: "u", maxTokens: 16000 })).text, "ok");
    assert.equal(srv.requests.length, 2);
    assert.ok(!("max_tokens" in srv.requests[1].body));
  } finally {
    srv.close();
  }
});

test("OpenAI-compatible: a text-only model refusing screenshots says how to fix it", async () => {
  const srv = await mockServer((r, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "This model does not support image input" } }));
  });
  try {
    const p = createProvider({ provider: "openai", apiKey: "k", baseUrl: srv.url, model: "llama" });
    const e = await p.stream({ model: "llama", system: "s", parts: [{ type: "image", data: "QUJD" }, { type: "text", text: "q" }], maxTokens: 5, onText() {} }).done.catch((err) => err);
    assert.match(p.describeError(e, "llama"), /can't read screenshots.*Screenshot every question/);
  } finally {
    srv.close();
  }
});

// Anthropic's streaming format, minimal: one text block.
const anthropicStream = (res, text) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev("message_start", { message: { id: "m1", type: "message", role: "assistant", content: [], model: "claude-opus-5-5", stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
  ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
  ev("content_block_stop", { index: 0 });
  ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } });
  ev("message_stop", {});
  res.end();
};

test("Anthropic: retries once without the refusal fallback when the account lacks it", async () => {
  const srv = await mockServer((r, res) => {
    if (r.body.fallbacks) {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "fallbacks: this feature is not available for your organization" } }));
    }
    anthropicStream(res, "hello");
  });
  try {
    const p = createProvider({ provider: "anthropic", apiKey: "sk-ant-test", anthropicBaseUrl: srv.url.replace(/\/v1$/, "") });
    let streamed = "";
    const ask = () => p.stream({ model: "claude-opus-5-5", system: "s", parts: [{ type: "text", text: "q" }], maxTokens: 50, effort: "low", onText: (t) => (streamed += t) }).done;
    const result = await ask();
    assert.equal(result.text, "hello");
    assert.equal(streamed, "hello");
    assert.deepEqual(srv.requests.map((r) => !!r.body.fallbacks), [true, false]);
    assert.equal(srv.requests[1].body.system[0].cache_control.type, "ephemeral"); // instructions still cached
    // Remembered for the session: the next ask goes straight without it.
    await ask();
    assert.deepEqual(srv.requests.map((r) => !!r.body.fallbacks), [true, false, false]);
  } finally {
    srv.close();
  }
});

test("Anthropic: other bad requests are not retried", async () => {
  const srv = await mockServer((r, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "messages: text content blocks must be non-empty" } }));
  });
  try {
    const p = createProvider({ provider: "anthropic", apiKey: "sk-ant-test", anthropicBaseUrl: srv.url.replace(/\/v1$/, "") });
    const e = await p.stream({ model: "claude-opus-5-5", system: "s", parts: [{ type: "text", text: "q" }], maxTokens: 50, effort: "low", onText() {} }).done.catch((err) => err);
    assert.match(p.describeError(e), /couldn't process this request/);
    assert.equal(srv.requests.length, 1);
  } finally {
    srv.close();
  }
});

test("Anthropic: stopping a stream counts as an abort, not an error", async () => {
  const srv = await mockServer((r, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", type: "message", role: "assistant", content: [], model: "claude-opus-5-5", stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n`);
    res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`);
    res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "slow" } })}\n\n`); // never ends
  });
  try {
    const p = createProvider({ provider: "anthropic", apiKey: "sk-ant-test", anthropicBaseUrl: srv.url.replace(/\/v1$/, "") });
    const job = p.stream({ model: "claude-opus-5-5", system: "s", parts: [{ type: "text", text: "q" }], maxTokens: 50, effort: "low", onText: () => job.abort() });
    const e = await job.done.catch((err) => err);
    assert.ok(isAbort(e), `${e?.constructor?.name}: ${e?.message}`);
  } finally {
    srv.close();
  }
});
