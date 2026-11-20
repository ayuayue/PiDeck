import { test } from "node:test";
import assert from "node:assert/strict";
import register, { retryMessage } from "./pi-deck-retry-no-body.ts";

test("bodyless gateways reuse pi retry without hiding auth and overflow", () => {
  assert.match(retryMessage("400 status code (no body)", "openai-completions"), /connection error/);
  assert.equal(retryMessage("400 status code (no body)", "anthropic-messages"), undefined);
  assert.equal(retryMessage("401 status code (no body)"), undefined);
  assert.equal(retryMessage("400 invalid arguments"), undefined);
  assert.equal(retryMessage("余额不足，请稍后重试"), undefined);
  assert.match(retryMessage("unexpected EOF"), /connection error/);
  assert.equal(retryMessage("400 status code (no body) (connection error)"), undefined);
});

test("the extension changes only an assistant failure's diagnostic", () => {
  let handler;
  register({ on: (event, fn) => { assert.equal(event, "message_end"); handler = fn; } });
  const message = { role: "assistant", stopReason: "error", errorMessage: "unexpected EOF", content: [], usage: { input: 1 } };
  const result = handler({ message });
  assert.equal(result.message.content, message.content);
  assert.equal(result.message.usage, message.usage);
  assert.equal(message.errorMessage, "unexpected EOF");
  assert.equal(handler({ message: { role: "toolResult", errorMessage: "unexpected EOF" } }), undefined);
});
