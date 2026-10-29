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
