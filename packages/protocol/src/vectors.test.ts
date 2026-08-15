import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { JsonValue } from "./models.js";
import { canonicalizeJson, verifyActionSignature, verifyCredentialSignature } from "./index.js";

const vectorsDir = join(process.cwd(), "packages", "protocol", "test_vectors");

interface CanonicalVectorFile {
  readonly vectors: readonly { readonly input: JsonValue; readonly expected: string }[];
  readonly rejected: readonly JsonValue[];
}

interface CredentialVectorFile {
  readonly hostPublicKeyPem: string;
  readonly vectors: readonly { readonly payload: string; readonly signature: string; readonly expectedPayload: Record<string, unknown> }[];
}

interface ActionVectorFile {
  readonly devicePublicKeyPem: string;
  readonly vectors: readonly { readonly signed: { readonly credential: { readonly payload: string; readonly signature: string }; readonly actionId: string; readonly issuedAt: string; readonly expiresAt: string; readonly action: JsonValue; readonly signature: string }; readonly expectedAction: JsonValue }[];
}

test("canonical JSON shared vectors byte-match the Node canonicalizer", async () => {
  const file = JSON.parse(await readFile(join(vectorsDir, "canonical_json.json"), "utf8")) as CanonicalVectorFile;
  assert.ok(file.vectors.length >= 5, "vector file must contain shared canonical vectors");
  for (const vector of file.vectors) {
    assert.equal(canonicalizeJson(vector.input), vector.expected);
  }
  for (const input of file.rejected) {
    assert.throws(() => canonicalizeJson(input), /safe integer range|non-finite/);
  }
});

test("host-signed credential vectors verify on the Node side", async () => {
  const file = JSON.parse(await readFile(join(vectorsDir, "credential_vectors.json"), "utf8")) as CredentialVectorFile;
  for (const vector of file.vectors) {
    const payload = verifyCredentialSignature({ payload: vector.payload, signature: vector.signature }, file.hostPublicKeyPem);
    assert.deepEqual(payload, vector.expectedPayload);
  }
});

test("device-signed action vectors verify on the Node side", async () => {
  const file = JSON.parse(await readFile(join(vectorsDir, "action_vectors.json"), "utf8")) as ActionVectorFile;
  for (const vector of file.vectors) {
    const action = verifyActionSignature(vector.signed, file.devicePublicKeyPem);
    assert.deepEqual(action, vector.expectedAction);
  }
  const original = file.vectors[0]!.signed.signature;
  const flipped = (original[0] === "A" ? "B" : "A") + original.slice(1);
  const tampered = { ...file.vectors[0]!.signed, signature: flipped };
  assert.throws(() => verifyActionSignature(tampered, file.devicePublicKeyPem), /signature is invalid/);
});
