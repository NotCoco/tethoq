import assert from "node:assert/strict";
import test from "node:test";
import type { ApprovalResponse, UserInputResponse } from "../../../packages/protocol/src/index.js";
import type { ProviderApprovalResponse, ProviderUserInputResponse } from "../../../packages/provider_contract/src/index.js";
import { FakeProviderAdapter } from "../../../packages/provider_fake/src/index.js";
import { ApprovalRegistry } from "./approvals.js";
import { UserInputRegistry } from "./user_inputs.js";

class RetryRegistryProvider extends FakeProviderAdapter {
  public approvalFailures = 1;
  public userInputFailures = 1;
  public approvalCalls = 0;
  public userInputCalls = 0;

  public constructor() {
    super({ hostId: "host-registry", providerId: "registry", sessionCount: 0 });
  }

  public override async respondToApproval(_response: ProviderApprovalResponse): Promise<void> {
    this.approvalCalls += 1;
    if (this.approvalFailures-- > 0) throw new Error("temporary approval failure");
  }

  public override async respondToUserInput(_response: ProviderUserInputResponse): Promise<void> {
    this.userInputCalls += 1;
    if (this.userInputFailures-- > 0) throw new Error("temporary input failure");
  }
}

test("approval registry removes successful responses while provider failures remain retryable", async () => {
  const adapter = new RetryRegistryProvider();
  const registry = new ApprovalRegistry();
  const request = registry.add("host-registry", "session-one", adapter, {
    providerRequestId: "provider-approval",
    providerSessionId: "native-session",
    title: "Approve work",
    affectedFiles: [],
    networkDestinations: [],
    riskMetadata: {},
    choices: [{ id: "approve", label: "Approve", kind: "approve" }],
  });
  const response: ApprovalResponse = {
    requestId: request.requestId,
    choiceId: "approve",
    respondedAt: new Date().toISOString(),
  };

  await assert.rejects(() => registry.resolve("host-registry", response), /temporary approval failure/);
  assert.deepEqual(registry.list().map((entry) => entry.requestId), [request.requestId]);
  await registry.resolve("host-registry", response);
  assert.equal(adapter.approvalCalls, 2);
  assert.equal(registry.list().length, 0);
  await assert.rejects(() => registry.resolve("host-registry", response), /stale, resolved, or unknown/);
});

test("approval registry prunes expired requests on both resolve and list", async () => {
  const adapter = new RetryRegistryProvider();
  adapter.approvalFailures = 0;
  const registry = new ApprovalRegistry();
  const expiredAt = new Date(Date.now() - 1_000).toISOString();
  const resolveExpired = registry.add("host-registry", "session-one", adapter, {
    providerRequestId: "expired-resolve",
    providerSessionId: "native-session",
    title: "Expired",
    affectedFiles: [],
    networkDestinations: [],
    riskMetadata: {},
    choices: [{ id: "approve", label: "Approve", kind: "approve" }],
    expiresAt: expiredAt,
  });
  await assert.rejects(() => registry.resolve("host-registry", {
    requestId: resolveExpired.requestId,
    choiceId: "approve",
    respondedAt: new Date().toISOString(),
  }), /expired/);
  const listExpired = registry.add("host-registry", "session-one", adapter, {
    providerRequestId: "expired-list",
    providerSessionId: "native-session",
    title: "Expired",
    affectedFiles: [],
    networkDestinations: [],
    riskMetadata: {},
    choices: [{ id: "approve", label: "Approve", kind: "approve" }],
    expiresAt: expiredAt,
  });
  assert.equal(registry.list().length, 0);
  await assert.rejects(() => registry.resolve("host-registry", {
    requestId: listExpired.requestId,
    choiceId: "approve",
    respondedAt: new Date().toISOString(),
  }), /stale, resolved, or unknown/);
});

test("user-input registry removes successful responses while provider failures remain retryable", async () => {
  const adapter = new RetryRegistryProvider();
  const registry = new UserInputRegistry();
  const request = registry.add("host-registry", "session-one", adapter, "provider-input", {
    title: "Choose a path",
    prompt: "Which path?",
  });
  const response: UserInputResponse = {
    requestId: request.requestId,
    answers: { choice: "A" },
    respondedAt: new Date().toISOString(),
  };

  await assert.rejects(() => registry.resolve("host-registry", response), /temporary input failure/);
  assert.deepEqual(registry.list().map((entry) => entry.requestId), [request.requestId]);
  await registry.resolve("host-registry", response);
  assert.equal(adapter.userInputCalls, 2);
  assert.equal(registry.list().length, 0);
  await assert.rejects(() => registry.resolve("host-registry", response), /stale, resolved, or unknown/);
});

test("user-input registry prunes expired requests on both resolve and list", async () => {
  const adapter = new RetryRegistryProvider();
  adapter.userInputFailures = 0;
  const registry = new UserInputRegistry();
  const expiredAt = new Date(Date.now() - 1_000).toISOString();
  const resolveExpired = registry.add("host-registry", "session-one", adapter, "expired-resolve", {}, expiredAt);
  await assert.rejects(() => registry.resolve("host-registry", {
    requestId: resolveExpired.requestId,
    answers: { choice: "A" },
    respondedAt: new Date().toISOString(),
  }), /expired/);
  const listExpired = registry.add("host-registry", "session-one", adapter, "expired-list", {}, expiredAt);
  assert.equal(registry.list().length, 0);
  await assert.rejects(() => registry.resolve("host-registry", {
    requestId: listExpired.requestId,
    answers: { choice: "A" },
    respondedAt: new Date().toISOString(),
  }), /stale, resolved, or unknown/);
});
