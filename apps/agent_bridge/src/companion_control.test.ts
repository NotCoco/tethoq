import assert from "node:assert/strict";
import test from "node:test";
import { validateCompanionControlRequest } from "./companion_control.js";

const token = "x".repeat(43);
const valid = {
  remoteAddress: "127.0.0.1",
  host: "127.0.0.1:43123",
  authorization: `Bearer ${token}`,
  method: "POST",
  path: "/pair/start",
  contentLength: "0",
} as const;

test("companion control accepts only authenticated loopback requests for its exact Host", () => {
  assert.equal(validateCompanionControlRequest(valid, valid.host, token), "ok");
  assert.equal(validateCompanionControlRequest({ ...valid, remoteAddress: "192.168.1.2" }, valid.host, token), "forbidden");
  assert.equal(validateCompanionControlRequest({ ...valid, host: "localhost:43123" }, valid.host, token), "forbidden");
  assert.equal(validateCompanionControlRequest({ ...valid, authorization: `Bearer ${"y".repeat(43)}` }, valid.host, token), "forbidden");
  assert.equal(validateCompanionControlRequest({ ...valid, authorization: undefined }, valid.host, token), "forbidden");
});

test("companion control rejects transfer encoding and every non-empty or ambiguous POST body", () => {
  assert.equal(validateCompanionControlRequest({ ...valid, transferEncoding: "chunked" }, valid.host, token), "request_too_large");
  assert.equal(validateCompanionControlRequest({ ...valid, contentLength: "1" }, valid.host, token), "request_too_large");
  assert.equal(validateCompanionControlRequest({ ...valid, contentLength: undefined }, valid.host, token), "request_too_large");
  assert.equal(validateCompanionControlRequest({ ...valid, method: "GET", contentLength: undefined }, valid.host, token), "ok");
  assert.equal(validateCompanionControlRequest({ ...valid, method: "GET", contentLength: "1" }, valid.host, token), "request_too_large");
});
