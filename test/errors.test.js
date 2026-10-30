import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { describeError } from "../src/claude.js";

const make = (Cls, status, message) => new Cls(status, { type: "error", error: { type: "x", message } }, message, new Headers());

test("maps API failures to plain advice", () => {
  assert.match(describeError(make(Anthropic.AuthenticationError, 401, "invalid x-api-key")), /key was rejected/);
  assert.match(describeError(make(Anthropic.RateLimitError, 429, "rate limited")), /Wait a few seconds/);
  assert.match(describeError(make(Anthropic.BadRequestError, 400, "Your credit balance is too low")), /out of credit/);
  assert.match(describeError(make(Anthropic.InternalServerError, 529, "Overloaded")), /busy/);
  assert.match(describeError(new Anthropic.APIConnectionError({ message: "fetch failed" })), /internet connection/);
});

test("recognizes an account without the refusal fallback feature", async () => {
  const { isFallbackUnsupported } = await import("../src/claude.js");
  assert.ok(isFallbackUnsupported(make(Anthropic.BadRequestError, 400, "fallbacks: this feature is not available for your organization")));
  assert.ok(!isFallbackUnsupported(make(Anthropic.BadRequestError, 400, "messages: text content blocks must be non-empty")));
  assert.ok(!isFallbackUnsupported(make(Anthropic.RateLimitError, 429, "fallback rate limited")));
});

test("costs use each model's prices", async () => {
  const { usageCost } = await import("../src/claude.js");
  const u = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
  assert.equal(usageCost(u, "claude-opus-5-5"), 24);
  assert.equal(usageCost(u, "claude-sonnet-5-5"), 12);
  assert.equal(usageCost(u, "claude-haiku-5-5"), 0.6);
  assert.equal(usageCost(u, "unknown-model"), 24); // falls back to the default
});
