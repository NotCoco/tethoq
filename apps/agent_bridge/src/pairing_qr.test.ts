import assert from "node:assert/strict";
import test from "node:test";
import type { PairingPayload } from "@uar/protocol";
import { pairingQrText, validatePublicBridgeUrl } from "./pairing_qr.js";

const payload: PairingPayload = {
  version: 1,
  hostId: "host_1",
  hostPublicKeyPem: "public-key",
  pairingId: "pair_1",
  secret: "secret",
  shortCode: "123456",
  expiresAt: "2026-08-12T12:00:00.000Z",
};

test("pairing QR contains the complete one-time scan credential", () => {
  const decoded = JSON.parse(pairingQrText(payload, "wss://example.test/bridge")) as Record<string, unknown>;
  assert.deepEqual(decoded, {
    type: "uar.pairing",
    version: 1,
    payload,
    directUrl: "wss://example.test/bridge",
  });
});

test("public phone pairing rejects insecure and credential-bearing endpoints", () => {
  assert.throws(() => validatePublicBridgeUrl("ws://192.168.1.2:8765/bridge"), /wss:\/\//);
  assert.throws(() => validatePublicBridgeUrl("wss://user:secret@example.test/bridge"), /credentials/);
});
