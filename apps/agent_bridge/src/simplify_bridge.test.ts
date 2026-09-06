import assert from "node:assert/strict";
import test from "node:test";

import { createHostIdentity, makeGlobalSessionId } from "../../../packages/protocol/src/index.js";
import { FakeProviderAdapter } from "../../../packages/provider_fake/src/index.js";
import type { CreateSessionOptions, SendMessageRequest, SendMessageResult } from "../../../packages/provider_contract/src/index.js";
import { AgentBridge } from "./bridge.js";
import type { BridgeConfig } from "./config.js";

const bridgeConfig: BridgeConfig = {
  version: 1,
  hostId: "host-simplify",
  displayName: "Simplify test host",
  identity: createHostIdentity(),
  enabledProviders: ["fake"],
};

class SimplifyProvider extends FakeProviderAdapter {
  public readonly sends: SendMessageRequest[] = [];
  public readonly steers: SendMessageRequest[] = [];
  public readonly creates: CreateSessionOptions[] = [];

  public constructor() {
    super({ hostId: bridgeConfig.hostId, providerId: "fake", sessionCount: 3 });
  }

  public override hasActiveTurn(_providerSessionId: string): boolean {
    return true;
  }

  public override async createSession(options: CreateSessionOptions) {
    this.creates.push(options);
    return await super.createSession(options);
  }

  public override async sendMessage(providerSessionId: string, request: SendMessageRequest): Promise<SendMessageResult> {
    this.sends.push(request);
    return await super.sendMessage(providerSessionId, request);
  }

  public override async steerMessage(_providerSessionId: string, request: SendMessageRequest): Promise<SendMessageResult> {
    this.steers.push(request);
    return { accepted: true, providerTurnId: request.requestId, details: [] };
  }
}

test("simplify guidance is one-turn, command-free, and survives queue delivery", async (t) => {
  const provider = new SimplifyProvider();
  const bridge = new AgentBridge(bridgeConfig, [provider]);
  t.after(() => bridge.dispose());
  await bridge.start();
  await bridge.refresh();

  const idle = makeGlobalSessionId(bridgeConfig.hostId, "fake", "fake_session_0002");
  await bridge.sendMessage(idle, {
    requestId: "simplify-send",
    content: "/simplify Explain the result",
    metadata: { simplify: { maxWords: 200, target: "upcoming", guidance: "Keep the example." } },
  });
  assert.equal(provider.sends.at(-1)?.content, "Explain the result");
  assert.match(provider.sends.at(-1)?.developerInstructions ?? "", /within 200 words/u);
  assert.ok((provider.sends.at(-1)?.developerInstructions ?? "").split(/\s+/u).length < 200);

  await bridge.sendMessage(idle, {
    requestId: "simplify-previous",
    content: "/simplify",
    metadata: { simplify: { maxWords: 100, target: "previous" } },
  });
  assert.equal(provider.sends.at(-1)?.content, "Simplify the previous answer.");
  assert.match(provider.sends.at(-1)?.developerInstructions ?? "", /immediately previous answer/u);

  await bridge.sendMessage(idle, { requestId: "normal-send", content: "A normal follow-up" });
  assert.equal(provider.sends.at(-1)?.developerInstructions, undefined);

  const working = makeGlobalSessionId(bridgeConfig.hostId, "fake", "fake_session_0001");
  const queued = await bridge.enqueueMessage(working, {
    requestId: "simplify-queue",
    content: "/simplify Explain the queue",
    metadata: { simplify: { maxWords: 100, target: "upcoming" } },
  });
  assert.equal(queued.content, "Explain the queue");
  await bridge.deliverQueuedMessage(queued.id, "steer");
  assert.equal(provider.steers.at(-1)?.content, "Explain the queue");
  assert.match(provider.steers.at(-1)?.developerInstructions ?? "", /within 100 words/u);
});

test("simplified first instruction is dispatched separately and does not persist", async (t) => {
  const provider = new SimplifyProvider();
  const bridge = new AgentBridge(bridgeConfig, [provider]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const created = await bridge.createSession("fake", {
    workingDirectory: "C:\\workspace",
    firstInstruction: "Simplify the previous answer.",
    firstInstructionDeveloperInstructions: "Simplify only this response.",
  });
  assert.equal(provider.creates.at(-1)?.firstInstruction, undefined);
  assert.equal(provider.creates.at(-1)?.developerInstructions, undefined);
  assert.equal(provider.sends.at(-1)?.developerInstructions, "Simplify only this response.");

  await bridge.sendMessage(created.id, { requestId: "after-first", content: "Continue normally" });
  assert.equal(provider.sends.at(-1)?.developerInstructions, undefined);
});

test("global AGENTS instructions stay private and apply to each dispatched task turn", async (t) => {
  const provider = new SimplifyProvider();
  const bridge = new AgentBridge(bridgeConfig, [provider], {
    globalAgentInstructions: async () => "Keep the response calm and concise.",
  });
  t.after(() => bridge.dispose());
  await bridge.start();
  const created = await bridge.createSession("fake", {
    workingDirectory: "C:\\workspace",
    firstInstruction: "Inspect the workflow",
  });
  assert.equal(provider.creates.at(-1)?.firstInstruction, undefined);
  assert.equal(provider.sends.at(-1)?.content, "Inspect the workflow");
  assert.match(provider.sends.at(-1)?.developerInstructions ?? "", /global AGENTS\.md instructions/u);
  assert.match(provider.sends.at(-1)?.developerInstructions ?? "", /Keep the response calm and concise/u);

  await bridge.sendMessage(created.id, { requestId: "global-follow-up", content: "Continue" });
  assert.equal(provider.sends.at(-1)?.content, "Continue");
  assert.equal((provider.sends.at(-1)?.developerInstructions?.match(/global AGENTS\.md instructions/gu) ?? []).length, 1);
});
