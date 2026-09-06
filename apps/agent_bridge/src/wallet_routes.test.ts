import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHostIdentity, type JsonObject, type RequestEnvelope } from "../../../packages/protocol/src/index.js";
import { DirectApiProviderAdapter } from "../../../packages/provider_direct/src/index.js";
import { AgentBridge } from "./bridge.js";
import { BridgeRequestRouter } from "./request_router.js";

test("wallet routes configure an encrypted direct key without echoing it to clients", async () => {
  const root = await mkdtemp(join(tmpdir(), "tethoq-wallet-route-"));
  const statePath = join(root, "direct-wallet.json");
  const hostId = "host-wallet";
  const identity = createHostIdentity();
  const adapter = new DirectApiProviderAdapter({ hostId, statePath, encryptionSecret: identity.privateKeyPem, environment: {} });
  const bridge = new AgentBridge({ version: 1, hostId, displayName: "Wallet host", identity, enabledProviders: ["direct"] }, [adapter]);
  const router = new BridgeRequestRouter(bridge);
  let counter = 0;
  const request = async (type: string, payload: JsonObject) => {
    counter += 1;
    const envelope: RequestEnvelope = {
      protocolVersion: 1,
      messageId: `message-${counter}`,
      hostId,
      sentAt: new Date(0).toISOString(),
      kind: "request",
      type,
      requestId: `request-${counter}`,
      payload,
    };
    return await router.handle(envelope);
  };
  try {
    await bridge.start();
    const secret = ["sk-router", "test-value"].join("-");
    const configured = await request("wallet.configure", {
      providerId: "direct",
      endpointId: "zai",
      apiKey: secret,
      setBalance: 12.5,
    });
    assert.equal(configured.ok, true);
    assert.equal(JSON.stringify(configured).includes(secret), false);
    assert.equal((configured.payload.wallet as JsonObject).kind, "user_api");
    assert.equal((configured.payload.wallet as JsonObject).apiKeyConfigured, true);
    assert.equal((await readFile(statePath, "utf8")).includes(secret), false);

    const fetched = await request("wallet.get", { providerId: "direct", modelId: "zai::glm-5.2" });
    assert.equal(fetched.ok, true);
    assert.equal((fetched.payload.wallet as JsonObject).endpointName, "Z.ai API");

    const selectedEndpoint = await request("wallet.get", { providerId: "direct", endpointId: "openai" });
    assert.equal(selectedEndpoint.ok, true);
    assert.equal((selectedEndpoint.payload.wallet as JsonObject).endpointName, "OpenAI API");
    assert.equal((selectedEndpoint.payload.wallet as JsonObject).apiKeyConfigured, false);

    const cleared = await request("wallet.configure", { providerId: "direct", endpointId: "zai", clearBalance: true });
    assert.equal(cleared.ok, true);
    assert.equal((cleared.payload.wallet as JsonObject).balance, undefined);

    const invalid = await request("wallet.configure", { providerId: "direct", endpointId: "zai", setBalance: "12" });
    assert.equal(invalid.ok, false);
    assert.match(invalid.error?.message ?? "", /setBalance must be a finite number/);

    const invalidClear = await request("wallet.configure", { providerId: "direct", endpointId: "zai", clearBalance: "yes" });
    assert.equal(invalidClear.ok, false);
    assert.match(invalidClear.error?.message ?? "", /clearBalance must be a boolean/);
  } finally {
    await bridge.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
