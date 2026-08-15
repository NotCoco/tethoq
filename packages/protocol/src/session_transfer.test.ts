import assert from "node:assert/strict";
import test from "node:test";
import { ProtocolValidationError, validateSessionTransferRequest } from "./index.js";

test("session transfer validation trims accepted fields", () => {
  assert.deepEqual(validateSessionTransferRequest({ sessionId: " host/provider/session ", prompt: " Continue here. " }), {
    sessionId: "host/provider/session",
    prompt: "Continue here.",
  });
});

test("session transfer validation rejects empty and oversized prompts", () => {
  assert.throws(() => validateSessionTransferRequest({ sessionId: "session", prompt: "   " }), ProtocolValidationError);
  assert.throws(() => validateSessionTransferRequest({ sessionId: "session", prompt: "x".repeat(32_001) }), ProtocolValidationError);
});
