import assert from "node:assert/strict";
import test from "node:test";
import {
  CURRENT_PROTOCOL_VERSION,
  createHostIdentity,
  type JsonObject,
  type RemoteSession,
  type RequestEnvelope,
  type ResponseEnvelope,
} from "../../../packages/protocol/src/index.js";
import { FakeProviderAdapter } from "../../../packages/provider_fake/src/index.js";
import {
  ProviderAdapterError,
  type CreateSessionOptions,
  type ProviderClientTooling,
  type SendMessageRequest,
  type SendMessageResult,
} from "../../../packages/provider_contract/src/index.js";
import { AgentBridge } from "./bridge.js";
import type { BridgeConfig } from "./config.js";
import { meshToolDefinitions } from "./mesh_tools.js";
import { BridgeRequestRouter } from "./request_router.js";
import {
  maxScheduledTaskStateBytes,
  projectedScheduledTaskStateBytes,
  scheduledTaskPlaceholderId,
  validateScheduledTask,
  validateScheduledTaskState,
  type ScheduledTask,
  type ScheduledTaskPersistence,
  type ScheduledTaskState,
} from "./scheduled_task_store.js";
import {
  openScheduledTaskScheduler,
  type CreateScheduledTaskInput,
  type ScheduledTaskScheduler,
} from "./scheduled_tasks.js";

const start = Date.parse("2026-08-29T10:00:00.000Z");

class MemoryScheduledTaskStore implements ScheduledTaskPersistence {
  public state: ScheduledTaskState;
  public failNextWrite = false;

  public constructor(state: ScheduledTaskState = { version: 1, tasks: [] }) {
    this.state = validateScheduledTaskState(state);
  }

  public async read(): Promise<ScheduledTaskState> {
    return validateScheduledTaskState(this.state);
  }

  public async write(tasks: readonly ScheduledTask[]): Promise<void> {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("Injected scheduled-task persistence failure");
    }
    this.state = validateScheduledTaskState({ version: 1, tasks });
  }

  public async flush(): Promise<void> {}
}

class ManualClock {
  public now: number;
  readonly #timers = new Map<number, { readonly at: number; readonly callback: () => void }>();
  #nextId = 1;

  public constructor(now: number) {
    this.now = now;
  }

  public readonly setTimeout = (callback: () => void, delayMs: number): number => {
    const id = this.#nextId++;
    this.#timers.set(id, { at: this.now + delayMs, callback });
    return id;
  };

  public readonly clearTimeout = (handle: unknown): void => {
    if (typeof handle === "number") this.#timers.delete(handle);
  };

  public advanceBy(milliseconds: number): void {
    const target = this.now + milliseconds;
    for (;;) {
      const next = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (next === undefined) break;
      this.now = next[1].at;
      this.#timers.delete(next[0]);
      next[1].callback();
    }
    this.now = target;
  }
}

class TrackingFakeProvider extends FakeProviderAdapter {
  public createCalls = 0;
  public readonly createOptions: CreateSessionOptions[] = [];
  public messageReads = 0;
  public readonly sends: Array<{ readonly providerSessionId: string; readonly request: SendMessageRequest }> = [];
  public failNextSend = false;

  public override async createSession(options: CreateSessionOptions): Promise<RemoteSession> {
    this.createCalls += 1;
    this.createOptions.push(options);
    return await super.createSession(options);
  }

  public override async sendMessage(
    providerSessionId: string,
    request: SendMessageRequest,
  ): Promise<SendMessageResult> {
    this.sends.push({ providerSessionId, request });
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new ProviderAdapterError(this.providerId, "NOT_DELIVERED", `${this.providerId} rejected the scheduled task`, true);
    }
    return { accepted: true, providerTurnId: `${this.providerId}-scheduled-turn`, details: [] };
  }

  public override async getMessages(providerSessionId: string) {
    this.messageReads += 1;
    return await super.getMessages(providerSessionId);
  }
}

class BlockingCreateProvider extends TrackingFakeProvider {
  readonly createStarted: Promise<void>;
  readonly #creationGate: Promise<void>;
  #markCreateStarted!: () => void;
  #releaseCreate!: () => void;

  public constructor(options: ConstructorParameters<typeof TrackingFakeProvider>[0]) {
    super(options);
    this.createStarted = new Promise<void>((resolve) => { this.#markCreateStarted = resolve; });
    this.#creationGate = new Promise<void>((resolve) => { this.#releaseCreate = resolve; });
  }

  public releaseCreate(): void { this.#releaseCreate(); }

  public override async createSession(options: CreateSessionOptions): Promise<RemoteSession> {
    this.#markCreateStarted();
    await this.#creationGate;
    return await super.createSession(options);
  }
}

class PostCreateFailureProvider extends TrackingFakeProvider {
  public failBridgeNormalizationOnce = true;

  public override async createSession(options: CreateSessionOptions): Promise<RemoteSession> {
    const session = await super.createSession(options);
    if (!this.failBridgeNormalizationOnce) return session;
    this.failBridgeNormalizationOnce = false;
    Object.defineProperty(session, "postCreateFailure", {
      enumerable: true,
      get: () => { throw new Error("simulated interruption after provider creation"); },
    });
    return session;
  }
}

function config(hostId: string, providers: readonly TrackingFakeProvider[]): BridgeConfig {
  return {
    version: 1,
    hostId,
    displayName: "Scheduled task integration test",
    identity: createHostIdentity(),
    enabledProviders: providers.map((provider) => provider.providerId),
  };
}

function request(hostId: string, requestId: string, type: string, payload: JsonObject): RequestEnvelope {
  return {
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    messageId: `message-${requestId}`,
    hostId,
    sentAt: new Date(start).toISOString(),
    kind: "request",
    type,
    requestId,
    payload,
  };
}

function object(value: unknown, name: string): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value), `${name} must be an object`);
  return value as Record<string, unknown>;
}

function successfulTask(response: ResponseEnvelope): Record<string, unknown> {
  assert.equal(response.ok, true, response.error?.message);
  return object(response.payload.task, "task");
}

function testClientTooling(): ProviderClientTooling {
  return {
    definitions: meshToolDefinitions,
    execute: async () => null,
    mcpServer: () => ({ name: "test-mesh", command: "node", args: [], env: {} }),
  };
}

function createPayload(providerId: string, runAt: number, title = `Scheduled ${providerId}`): JsonObject {
  return {
    providerId,
    modelId: `${providerId}-model`,
    reasoningEffort: "max",
    workingDirectory: `C:\\workspaces\\${providerId}`,
    title,
    content: `Run the ${providerId} scheduled task.`,
    runAt: new Date(runAt).toISOString(),
  };
}

async function fixture(
  hostId: string,
  providers: readonly TrackingFakeProvider[],
  initialState: ScheduledTaskState = { version: 1, tasks: [] },
): Promise<{
  readonly bridge: AgentBridge;
  readonly router: BridgeRequestRouter;
  readonly scheduler: ScheduledTaskScheduler;
  readonly clock: ManualClock;
  readonly store: MemoryScheduledTaskStore;
}> {
  const clock = new ManualClock(start);
  const store = new MemoryScheduledTaskStore(initialState);
  let bridge: AgentBridge | undefined;
  const scheduler = await openScheduledTaskScheduler({
    store,
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    dispatch: async (task) => {
      assert.ok(bridge);
      return await bridge.dispatchScheduledTask(task);
    },
    onChange: (change) => {
      bridge?.scheduledTaskChanged(change.task, change.reason, change.previousTargetSessionId);
    },
  });
  bridge = new AgentBridge(config(hostId, providers), providers);
  bridge.configureClientTooling(testClientTooling());
  bridge.configureScheduledTasks(scheduler);
  await bridge.start();
  return { bridge, router: new BridgeRequestRouter(bridge), scheduler, clock, store };
}

test("router creates, lists, cancels, runs now, and retries a failed scheduled task", async (t) => {
  const hostId = "host-scheduled-router";
  const provider = new TrackingFakeProvider({ hostId, providerId: "codex", sessionCount: 0 });
  const { bridge, router, scheduler } = await fixture(hostId, [provider]);
  t.after(() => bridge.dispose());

  const cancelledCreate = await router.handle(request(
    hostId,
    "schedule-cancelled",
    "scheduled_task.create",
    createPayload(provider.providerId, start + 10 * 60_000, "Cancel this task"),
  ));
  const cancelledTask = successfulTask(cancelledCreate);
  assert.equal(cancelledTask.status, "pending");
  assert.equal(cancelledTask.targetSessionId, scheduledTaskPlaceholderId("schedule-cancelled"));
  assert.equal(cancelledCreate.payload.session, undefined, "scheduling must not return a provider session");
  assert.equal(provider.createCalls, 0, "scheduling must not create a provider session before dispatch");
  const pendingSessionId = String(cancelledTask.targetSessionId);
  assert.equal(bridge.sessions().some((session) => session.id === pendingSessionId), false);
  assert.equal(provider.messageReads, 0, "a pending placeholder must not request provider history");

  const firstList = await router.handle(request(hostId, "list-before-cancel", "scheduled_task.list", {}));
  assert.equal(firstList.ok, true);
  assert.equal((firstList.payload.tasks as unknown[]).length, 1);

  const cancelled = await router.handle(request(hostId, "cancel-route", "scheduled_task.cancel", {
    scheduledTaskId: "schedule-cancelled",
  }));
  assert.equal(successfulTask(cancelled).requestId, "schedule-cancelled");
  assert.equal(successfulTask(cancelled).status, "cancelled");

  const secondList = await router.handle(request(hostId, "list-after-cancel", "scheduled_task.list", {}));
  assert.equal(secondList.ok, true);
  assert.deepEqual(secondList.payload.tasks, []);

  provider.failNextSend = true;
  const retryCreate = await router.handle(request(
    hostId,
    "schedule-retry",
    "scheduled_task.create",
    createPayload(provider.providerId, start + 10 * 60_000, "Retry this task"),
  ));
  assert.equal(successfulTask(retryCreate).status, "pending");
  assert.equal(provider.createCalls, 0);

  const failed = await router.handle(request(hostId, "run-now-route", "scheduled_task.run_now", {
    scheduledTaskId: "schedule-retry",
  }));
  assert.equal(successfulTask(failed).status, "dispatching");
  await scheduler.flush();
  assert.equal(bridge.scheduledTasks().find((task) => task.requestId === "schedule-retry")?.status, "failed");
  assert.equal(provider.createCalls, 1);
  assert.equal(provider.sends.length, 1);

  const malformedRetry = await router.handle(request(hostId, "retry-route-invalid-time", "scheduled_task.retry", {
    scheduledTaskId: "schedule-retry",
    runAt: start + 20 * 60_000,
  }));
  assert.equal(malformedRetry.ok, false);
  assert.match(malformedRetry.error?.message ?? "", /runAt must be a string/u);
  assert.equal(bridge.scheduledTasks().find((task) => task.requestId === "schedule-retry")?.status, "failed");
  assert.equal(provider.sends.length, 1, "a malformed retry time ran the task immediately");

  const retried = await router.handle(request(hostId, "retry-route", "scheduled_task.retry", {
    scheduledTaskId: "schedule-retry",
  }));
  assert.equal(successfulTask(retried).status, "dispatching");
  await scheduler.flush();
  const started = bridge.scheduledTasks().find((task) => task.requestId === "schedule-retry");
  assert.equal(started?.status, "started");
  assert.notEqual(started?.targetSessionId, scheduledTaskPlaceholderId("schedule-retry"));
  assert.equal(provider.createCalls, 1, "retry created a second provider task instead of reusing the materialized target");
  assert.equal(provider.sends.length, 2);
  assert.equal(provider.sends[0]?.providerSessionId, provider.sends[1]?.providerSessionId);
  assert.deepEqual(provider.sends.map((send) => send.request.requestId), ["schedule-retry", "schedule-retry"]);
  assert.deepEqual(provider.sends.map((send) => send.request.metadata), [
    { tethoqScheduledTaskId: "schedule-retry" },
    { tethoqScheduledTaskId: "schedule-retry" },
  ]);
  assert.deepEqual(provider.sends.map((send) => send.request.content), [
    "Run the codex scheduled task.",
    "Run the codex scheduled task.",
  ]);
  assert.deepEqual(provider.createOptions.map((options) => options.firstInstruction), [undefined]);
});

test("Codex, OpenCode, and Grok dispatch once at the exact five-minute boundary", async (t) => {
  const hostId = "host-five-minute-boundary";
  const providers = ["codex", "opencode", "grok"].map((providerId) => new TrackingFakeProvider({
    hostId,
    providerId,
    sessionCount: 0,
  }));
  const { bridge, router, scheduler, clock } = await fixture(hostId, providers);
  t.after(() => bridge.dispose());

  for (const provider of providers) {
    const response = await router.handle(request(
      hostId,
      `schedule-five-${provider.providerId}`,
      "scheduled_task.create",
      createPayload(provider.providerId, start + 5 * 60_000),
    ));
    const task = successfulTask(response);
    assert.equal(task.status, "pending");
    assert.equal(task.targetSessionId, scheduledTaskPlaceholderId(`schedule-five-${provider.providerId}`));
    assert.equal(response.payload.session, undefined);
    assert.equal(provider.createCalls, 0);
  }

  clock.advanceBy(5 * 60_000 - 1);
  await scheduler.flush();
  assert.deepEqual(providers.map((provider) => provider.createCalls), [0, 0, 0]);
  assert.deepEqual(providers.map((provider) => provider.sends.length), [0, 0, 0]);

  clock.advanceBy(1);
  await scheduler.flush();
  assert.deepEqual(providers.map((provider) => provider.createCalls), [1, 1, 1]);
  assert.deepEqual(providers.map((provider) => provider.sends.length), [1, 1, 1]);
  assert.deepEqual(providers.map((provider) => provider.createOptions[0]?.firstInstruction), [
    undefined,
    undefined,
    undefined,
  ]);
  assert.deepEqual(providers.flatMap((provider) => provider.sends.map((send) => send.request.content)), [
    "Run the codex scheduled task.",
    "Run the opencode scheduled task.",
    "Run the grok scheduled task.",
  ]);
  assert.deepEqual(providers.flatMap((provider) => provider.sends.map((send) => send.request.requestId)), [
    "schedule-five-codex",
    "schedule-five-opencode",
    "schedule-five-grok",
  ]);
  assert.deepEqual(providers.flatMap((provider) => provider.sends.map((send) => send.request.metadata)), [
    { tethoqScheduledTaskId: "schedule-five-codex" },
    { tethoqScheduledTaskId: "schedule-five-opencode" },
    { tethoqScheduledTaskId: "schedule-five-grok" },
  ]);
  assert.deepEqual(bridge.scheduledTasks().map((task) => task.status), ["started", "started", "started"]);
  assert.equal(bridge.scheduledTasks().every((task) => !task.targetSessionId.startsWith("scheduled-task:")), true);

  const activeList = await router.handle(request(hostId, "list-after-five-minute-dispatch", "scheduled_task.list", {}));
  assert.equal(activeList.ok, true);
  assert.deepEqual(activeList.payload.tasks, [], "started audit rows leaked into renderer hydration");

  await bridge.reconcileScheduledTasks();
  assert.deepEqual(providers.map((provider) => provider.createCalls), [1, 1, 1]);
  assert.deepEqual(providers.map((provider) => provider.sends.length), [1, 1, 1]);
});

test("scheduled Mesh prepares one OpenCode parent before dispatching tailored children", async (t) => {
  const hostId = "host-scheduled-mesh";
  const opencode = new TrackingFakeProvider({ hostId, providerId: "opencode", sessionCount: 0 });
  const grok = new TrackingFakeProvider({ hostId, providerId: "grok", sessionCount: 0 });
  const codex = new TrackingFakeProvider({ hostId, providerId: "codex", sessionCount: 0 });
  const { bridge, router, scheduler, clock } = await fixture(hostId, [opencode, grok, codex]);
  t.after(() => bridge.dispose());

  const prompt = "Compare the tiny result http://example.test/mesh and report one word.";
  const meshTargets = [{ providerId: "grok", modelId: "fake-careful", reasoningEffort: "high" }, {
    providerId: "codex",
    modelId: "fake-fast",
    reasoningEffort: "max",
  }];
  const created = await router.handle(request(hostId, "schedule-mesh-once", "scheduled_task.create", {
    providerId: "opencode",
    modelId: "fake-fast",
    reasoningEffort: "max",
    workingDirectory: "C:\\workspaces\\scheduled-mesh",
    title: "Scheduled Mesh",
    content: `/schedule /mesh ${prompt} /schedule /mesh`,
    runAt: new Date(start + 5 * 60_000).toISOString(),
    meshTargets,
  }));
  const pending = successfulTask(created);
  assert.equal(pending.content, prompt, "scheduled command tokens leaked into the durable prompt");
  assert.deepEqual(pending.meshTargets, meshTargets);
  assert.deepEqual([opencode.createCalls, grok.createCalls, codex.createCalls], [0, 0, 0]);

  clock.advanceBy(5 * 60_000);
  await scheduler.flush();
  const started = bridge.scheduledTasks().find((task) => task.requestId === "schedule-mesh-once");
  assert.equal(started?.status, "started");
  assert.ok(started?.targetSessionId);
  assert.deepEqual([opencode.createCalls, grok.createCalls, codex.createCalls], [1, 0, 0]);
  assert.deepEqual([grok.sends.length, codex.sends.length], [0, 0], "the scheduler bypassed parent-authored assignments");
  const parentTurn = opencode.sends.find((send) => send.request.metadata?.kind === "delegation_prepare");
  assert.ok(parentTurn, "the scheduled Mesh parent preparation turn was not sent");
  assert.equal(parentTurn.request.content, prompt, "the scheduled parent did not receive the clean visible prompt");
  assert.equal(parentTurn.request.modelId, "fake-fast", "the scheduled parent lost its durable model selection");
  assert.equal(parentTurn.request.reasoningEffort, "max", "the scheduled parent lost its durable reasoning selection");
  assert.match(parentTurn.request.developerInstructions ?? "", /mesh_dispatch_delegation/u);
  assert.match(parentTurn.request.developerInstructions ?? "", /in your own words/u);
  assert.equal(parentTurn.request.clientToolOverrides?.mesh_dispatch_delegation, true);
  const delegation = bridge.delegations(started?.targetSessionId)[0];
  assert.ok(delegation);
  assert.equal(delegation.state, "awaiting_dispatch");
  assert.equal(delegation.orchestration, "parent");
  assert.deepEqual(delegation.children, []);
  assert.deepEqual(delegation.targets, meshTargets);

  const grokInstruction = "Check only the tiny comparison result and report one concise finding.";
  const codexInstruction = "Check only the one-word reporting constraint and report whether it is satisfied.";
  await bridge.executeMeshTool(started!.targetSessionId, "mesh_dispatch_delegation", {
    delegation_id: delegation.id,
    assignments: [{ target_index: 0, instruction: grokInstruction }, {
      target_index: 1,
      instruction: codexInstruction,
    }],
  });

  assert.deepEqual([opencode.createCalls, grok.createCalls, codex.createCalls], [1, 1, 1]);
  assert.deepEqual(grok.sends.map((send) => send.request.content), [grokInstruction]);
  assert.deepEqual(codex.sends.map((send) => send.request.content), [codexInstruction]);
  assert.equal(grok.sends.some((send) => send.request.content === prompt || send.request.content === codexInstruction), false);
  assert.equal(codex.sends.some((send) => send.request.content === prompt || send.request.content === grokInstruction), false);
  const dispatched = bridge.delegations(started!.targetSessionId)[0]!;
  assert.deepEqual(dispatched.children.map((child) => ({
    providerId: child.providerId,
    modelId: child.modelId,
    reasoningEffort: child.reasoningEffort,
  })), meshTargets);

  await bridge.reconcileScheduledTasks();
  assert.deepEqual([opencode.createCalls, grok.createCalls, codex.createCalls], [1, 1, 1], "reconcile duplicated the Mesh parent or children");
  assert.deepEqual([opencode.sends.length, grok.sends.length, codex.sends.length], [1, 1, 1]);
});

test("scheduled Mesh leaves child dispatch and result waiting to the prepared parent", async (t) => {
  const hostId = "host-scheduled-mesh-coordination";
  const opencode = new TrackingFakeProvider({ hostId, providerId: "opencode", sessionCount: 0 });
  const grok = new TrackingFakeProvider({ hostId, providerId: "grok", sessionCount: 0 });
  const { bridge, router, scheduler, clock } = await fixture(hostId, [opencode, grok]);
  t.after(() => bridge.dispose());

  await router.handle(request(hostId, "schedule-mesh-coordination", "scheduled_task.create", {
    providerId: "opencode",
    modelId: "fake-fast",
    reasoningEffort: "max",
    workingDirectory: "C:\\workspaces\\scheduled-mesh-coordination",
    title: "Scheduled Mesh coordination",
    content: "/mesh Report one word.",
    runAt: new Date(start + 5 * 60_000).toISOString(),
    meshTargets: [{ providerId: "grok", modelId: "fake-careful", reasoningEffort: "high" }],
  }));

  clock.advanceBy(5 * 60_000);
  await scheduler.flush();
  const parent = bridge.sessions().find((session) => session.providerId === "opencode");
  assert.ok(parent);
  const delegation = bridge.delegations(parent.id)[0];
  assert.ok(delegation);
  assert.equal(bridge.scheduledTasks().find((task) => task.requestId === "schedule-mesh-coordination")?.status, "started");
  assert.equal(delegation.state, "awaiting_dispatch");
  assert.deepEqual(delegation.children, []);
  assert.deepEqual([opencode.createCalls, grok.createCalls], [1, 0]);
  const controlTurns = opencode.sends.filter((send) => send.request.metadata?.delegationId === delegation.id);
  assert.deepEqual(controlTurns.map((send) => send.request.metadata?.kind), ["delegation_prepare"]);
  assert.deepEqual(controlTurns.map((send) => ({
    modelId: send.request.modelId,
    reasoningEffort: send.request.reasoningEffort,
  })), [{ modelId: "fake-fast", reasoningEffort: "max" }]);
  assert.equal(opencode.sends.some((send) => send.request.requestId.startsWith("delegation_synthesis_")), false);

  const instruction = "Return one word that summarizes only the scheduled check.";
  await bridge.executeMeshTool(parent.id, "mesh_dispatch_delegation", {
    delegation_id: delegation.id,
    assignments: [{ target_index: 0, instruction }],
  });
  assert.deepEqual([opencode.createCalls, grok.createCalls], [1, 1]);
  assert.deepEqual(grok.sends.map((send) => send.request.content), [instruction]);
  assert.equal(bridge.delegations(parent.id)[0]?.state, "working");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(opencode.sends.some((send) => send.request.requestId.startsWith("delegation_synthesis_")), false,
    "the bridge injected synthesis instead of leaving the wait decision to the parent");
});

test("scheduled Mesh rejects missing, duplicate, same-parent, and incomplete targets before provider creation", async (t) => {
  const hostId = "host-scheduled-mesh-validation";
  const opencode = new TrackingFakeProvider({ hostId, providerId: "opencode", sessionCount: 0 });
  const grok = new TrackingFakeProvider({ hostId, providerId: "grok", sessionCount: 0 });
  const { bridge, router } = await fixture(hostId, [opencode, grok]);
  t.after(() => bridge.dispose());
  const base = {
    ...createPayload("opencode", start + 5 * 60_000, "Invalid scheduled Mesh"),
    content: "/mesh Check one thing",
  };
  const cases: Array<{ readonly id: string; readonly meshTargets?: JsonObject[] }> = [
    { id: "missing" },
    { id: "duplicate", meshTargets: [{ providerId: "grok" }, { providerId: "grok" }] },
    { id: "same-parent", meshTargets: [{ providerId: "opencode" }] },
    { id: "effort-without-model", meshTargets: [{ providerId: "grok", reasoningEffort: "max" }] },
  ];
  for (const entry of cases) {
    const response = await router.handle(request(hostId, `invalid-${entry.id}`, "scheduled_task.create", {
      ...base,
      ...(entry.meshTargets ? { meshTargets: entry.meshTargets } : {}),
    }));
    assert.equal(response.ok, false, `${entry.id} scheduled Mesh was accepted`);
  }
  assert.deepEqual([opencode.createCalls, grok.createCalls], [0, 0]);
  assert.equal(bridge.scheduledTasks().length, 0);
});

test("identical concurrent creation reuses one durable placeholder and dispatches one provider session", async (t) => {
  const hostId = "host-scheduled-deduplication";
  const provider = new TrackingFakeProvider({ hostId, providerId: "opencode", sessionCount: 0 });
  const { bridge, clock, scheduler } = await fixture(hostId, [provider]);
  t.after(() => bridge.dispose());
  const input: Omit<CreateScheduledTaskInput, "targetSessionId"> = {
    requestId: "same-schedule-request",
    providerId: provider.providerId,
    modelId: "opencode-model",
    reasoningEffort: "high",
    workingDirectory: "C:\\workspaces\\same-request",
    title: "Same scheduled task",
    content: "Run the same scheduled task.",
    runAt: new Date(start + 5 * 60_000).toISOString(),
  };

  const firstCreation = bridge.createScheduledTask(input);
  await assert.rejects(
    () => bridge.createScheduledTask({ ...input, title: "Changed while creation is in flight" }),
    /request ID is already in use/,
  );
  const [first, concurrent] = await Promise.all([
    firstCreation,
    bridge.createScheduledTask({ ...input }),
  ]);
  const repeated = await bridge.createScheduledTask({ ...input });
  assert.deepEqual(concurrent, first);
  assert.deepEqual(repeated, first);
  assert.equal(first.targetSessionId, scheduledTaskPlaceholderId(input.requestId));
  assert.equal(provider.createCalls, 0, "idempotent scheduling created a provider session before dispatch");
  assert.equal(bridge.scheduledTasks().length, 1);

  await assert.rejects(
    () => bridge.createScheduledTask({ ...input, title: "Changed scheduled task" }),
    /request ID is already in use/,
  );
  assert.equal(provider.createCalls, 0);

  clock.advanceBy(5 * 60_000);
  await scheduler.flush();
  assert.equal(provider.createCalls, 1, "one durable schedule dispatched more than one provider session");
  assert.equal(bridge.scheduledTasks()[0]?.status, "started");
  assert.notEqual(bridge.scheduledTasks()[0]?.targetSessionId, first.targetSessionId);
});

test("a persistence retry remains local until the recovered schedule becomes due", async (t) => {
  const hostId = "host-scheduled-persistence-retry";
  const provider = new TrackingFakeProvider({ hostId, providerId: "codex", sessionCount: 0 });
  const { bridge, clock, scheduler, store } = await fixture(hostId, [provider]);
  t.after(() => bridge.dispose());
  const input: Omit<CreateScheduledTaskInput, "targetSessionId"> = {
    requestId: "persist-retry",
    providerId: provider.providerId,
    workingDirectory: "C:\\workspaces\\persist-retry",
    title: "Persist retry",
    content: "Reuse the provisioned task after persistence recovers.",
    runAt: new Date(start + 5 * 60_000).toISOString(),
  };

  store.failNextWrite = true;
  await assert.rejects(() => bridge.createScheduledTask(input), /persistence failure/u);
  assert.equal(provider.createCalls, 0);
  assert.equal(bridge.scheduledTasks().length, 0);

  const recovered = await bridge.createScheduledTask(input);
  assert.equal(recovered.requestId, input.requestId);
  assert.equal(recovered.targetSessionId, scheduledTaskPlaceholderId(input.requestId));
  assert.equal(provider.createCalls, 0, "persistence retry created a provider session before dispatch");
  assert.equal(bridge.scheduledTasks().length, 1);

  clock.advanceBy(5 * 60_000);
  await scheduler.flush();
  assert.equal(provider.createCalls, 1);
  assert.equal(bridge.scheduledTasks()[0]?.status, "started");
});

test("provider identity is durable before post-create bridge work can fail", async (t) => {
  const hostId = "host-scheduled-post-create-failure";
  const provider = new PostCreateFailureProvider({ hostId, providerId: "codex", sessionCount: 0 });
  const { bridge, scheduler } = await fixture(hostId, [provider]);
  t.after(() => bridge.dispose());
  const input: Omit<CreateScheduledTaskInput, "targetSessionId"> = {
    requestId: "post-create-durable-target",
    providerId: provider.providerId,
    workingDirectory: "C:\\workspaces\\post-create-durable-target",
    title: "Persist before bridge normalization",
    content: "Reuse the provider task after bridge recovery.",
    runAt: new Date(start + 60 * 60_000).toISOString(),
  };

  await bridge.createScheduledTask(input);
  await bridge.runScheduledTaskNow(input.requestId);
  await scheduler.flush();
  const failed = bridge.scheduledTasks().find((task) => task.requestId === input.requestId);
  assert.equal(failed?.status, "failed");
  assert.notEqual(failed?.targetSessionId, scheduledTaskPlaceholderId(input.requestId));
  assert.equal(provider.createCalls, 1);
  assert.equal(provider.sends.length, 0);

  await bridge.retryScheduledTask(input.requestId);
  await scheduler.flush();
  assert.equal(bridge.scheduledTasks().find((task) => task.requestId === input.requestId)?.status, "started");
  assert.equal(provider.createCalls, 1, "retry orphaned the first provider task and created another");
  assert.equal(provider.sends.length, 1);
  assert.equal(provider.sends[0]?.providerSessionId, failed?.targetSessionId.split("/").at(-1));
});

test("bridge shutdown drains scheduled provider creation and prompt acceptance before adapter disposal", async () => {
  const hostId = "host-scheduled-shutdown-drain";
  const provider = new BlockingCreateProvider({ hostId, providerId: "opencode", sessionCount: 0 });
  const { bridge, scheduler, store } = await fixture(hostId, [provider]);
  const input: Omit<CreateScheduledTaskInput, "targetSessionId"> = {
    requestId: "shutdown-drain",
    providerId: provider.providerId,
    workingDirectory: "C:\\workspaces\\shutdown-drain",
    title: "Finish dispatch during shutdown",
    content: "Send this before the provider is disposed.",
    runAt: new Date(start + 60 * 60_000).toISOString(),
  };

  await bridge.createScheduledTask(input);
  await bridge.runScheduledTaskNow(input.requestId);
  await provider.createStarted;
  const disposal = bridge.dispose();
  provider.releaseCreate();
  await disposal;

  assert.equal(provider.createCalls, 1);
  assert.equal(provider.sends.length, 1);
  assert.equal(store.state.tasks[0]?.status, "started");
  assert.notEqual(store.state.tasks[0]?.targetSessionId, scheduledTaskPlaceholderId(input.requestId));
  await scheduler.flush();
});

test("startup preserves a pending placeholder and creates the provider task only when due", async (t) => {
  const hostId = "host-process-bound-restart";
  const provider = new TrackingFakeProvider({ hostId, providerId: "codex", sessionCount: 0 });
  const placeholderId = scheduledTaskPlaceholderId("restart-schedule");
  const initial = validateScheduledTask({
    kind: "new_task",
    requestId: "restart-schedule",
    targetSessionId: placeholderId,
    providerId: "codex",
    workingDirectory: "C:\\workspaces\\restart-schedule",
    title: "Survive app restart",
    content: "Run after the app has restarted.",
    runAt: new Date(start + 5 * 60_000).toISOString(),
    createdAt: new Date(start - 60_000).toISOString(),
    status: "pending",
  });
  const { bridge, clock, scheduler, store } = await fixture(hostId, [provider], { version: 1, tasks: [initial] });
  t.after(() => bridge.dispose());

  const restored = bridge.scheduledTasks()[0];
  assert.ok(restored);
  assert.equal(restored.targetSessionId, placeholderId);
  assert.equal(store.state.tasks[0]?.targetSessionId, placeholderId);
  assert.equal(provider.createCalls, 0);
  assert.equal(bridge.sessions().some((session) => session.id === placeholderId), false);
  const openedPlaceholder = await bridge.openSession(placeholderId);
  assert.equal(openedPlaceholder.session.id, placeholderId);
  assert.equal(openedPlaceholder.session.providerId, "codex");
  assert.equal(openedPlaceholder.session.title, initial.title);
  assert.equal(openedPlaceholder.session.workingDirectory, initial.workingDirectory);
  assert.deepEqual(openedPlaceholder.messages, []);
  assert.equal(openedPlaceholder.nextCursor, null);
  assert.equal(await bridge.watchSession(placeholderId), false);
  assert.equal(provider.messageReads, 0, "opening a restored placeholder touched provider history");

  clock.advanceBy(5 * 60_000);
  await scheduler.flush();
  const started = bridge.scheduledTasks()[0];
  assert.equal(provider.createCalls, 1);
  assert.equal(provider.createOptions[0]?.firstInstruction, undefined);
  assert.equal(provider.sends[0]?.request.requestId, initial.requestId);
  assert.equal(provider.sends[0]?.request.content, initial.content);
  assert.equal(started?.status, "started");
  assert.notEqual(started?.targetSessionId, placeholderId);
  assert.equal(store.state.tasks[0]?.targetSessionId, started?.targetSessionId);
  assert.equal(bridge.sessions().some((session) => session.id === started?.targetSessionId), true);
});

function failedCapacityTask(hostId: string, providerId: string, index: number): ScheduledTask {
  return validateScheduledTask({
    kind: "new_task",
    requestId: `capacity-${index}`,
    targetSessionId: `${hostId}/${providerId}/capacity-${index}`,
    providerId,
    workingDirectory: "C:\\workspaces\\capacity",
    title: `Existing scheduled task ${index}`,
    content: `Existing content ${index}`,
    runAt: new Date(start + 60 * 60_000).toISOString(),
    createdAt: new Date(start - 60_000).toISOString(),
    status: "failed",
    dispatchingAt: new Date(start - 30_000).toISOString(),
    failedAt: new Date(start - 20_000).toISOString(),
    failureMessage: "Provider rejected the scheduled task.",
  });
}

function pendingCapacityTask(requestId: string, providerId: string, title: string, content: string): ScheduledTask {
  const runAt = new Date(start + 2 * 60 * 60_000).toISOString();
  return validateScheduledTask({
    kind: "new_task",
    requestId,
    targetSessionId: scheduledTaskPlaceholderId(requestId),
    providerId,
    workingDirectory: "C:\\workspaces\\capacity",
    title,
    content,
    runAt,
    originalRunAt: runAt,
    createdAt: new Date(start).toISOString(),
    status: "pending",
  });
}

function largestCapacityPrefix(tasks: readonly ScheduledTask[], suffix: readonly ScheduledTask[] = []): ScheduledTask[] {
  let lower = 0;
  let upper = tasks.length;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (projectedScheduledTaskStateBytes([...tasks.slice(0, middle), ...suffix]) <= maxScheduledTaskStateBytes) lower = middle;
    else upper = middle - 1;
  }
  return tasks.slice(0, lower);
}

test("a predictably full schedule store rejects before creating an empty provider session", async (t) => {
  const hostId = "host-scheduled-capacity";
  const provider = new TrackingFakeProvider({ hostId, providerId: "grok", sessionCount: 0 });
  const capacityCandidates = Array.from({ length: 1_000 }, (_, index) => failedCapacityTask(hostId, provider.providerId, index));
  const tasks = largestCapacityPrefix(capacityCandidates);
  assert.ok(tasks.length > 0);
  assert.ok(projectedScheduledTaskStateBytes([...tasks, failedCapacityTask(hostId, provider.providerId, tasks.length)]) > maxScheduledTaskStateBytes);
  const { bridge } = await fixture(hostId, [provider], { version: 1, tasks });
  t.after(() => bridge.dispose());

  await assert.rejects(() => bridge.createScheduledTask({
    requestId: "over-capacity",
    providerId: provider.providerId,
    workingDirectory: "C:\\workspaces\\capacity",
    title: "Must not create an orphan",
    content: "This task cannot fit in the durable store.",
    runAt: new Date(start + 2 * 60 * 60_000).toISOString(),
  }), /capacity is full/);
  assert.equal(provider.createCalls, 0);
});

test("concurrent different requests reserve the final capacity without provider creation", async (t) => {
  const hostId = "host-scheduled-final-capacity";
  const provider = new TrackingFakeProvider({ hostId, providerId: "opencode", sessionCount: 0 });
  const candidateA = pendingCapacityTask("final-slot-a", provider.providerId, "Final slot A", "Claim the final scheduled-task slot.");
  const candidateB = pendingCapacityTask("final-slot-b", provider.providerId, "Final slot B", "Must not create an orphan provider task.");
  const capacityCandidates = Array.from({ length: 1_000 }, (_, index) => failedCapacityTask(hostId, provider.providerId, index));
  const tasks = largestCapacityPrefix(capacityCandidates, [candidateA]);
  assert.ok(projectedScheduledTaskStateBytes([...tasks, candidateA]) <= maxScheduledTaskStateBytes);
  assert.ok(projectedScheduledTaskStateBytes([...tasks, candidateA, candidateB]) > maxScheduledTaskStateBytes);
  const { bridge } = await fixture(hostId, [provider], { version: 1, tasks });
  t.after(() => bridge.dispose());

  const first = bridge.createScheduledTask({
    requestId: "final-slot-a",
    providerId: provider.providerId,
    workingDirectory: "C:\\workspaces\\capacity",
    title: "Final slot A",
    content: "Claim the final scheduled-task slot.",
    runAt: new Date(start + 2 * 60 * 60_000).toISOString(),
  });
  const second = bridge.createScheduledTask({
    requestId: "final-slot-b",
    providerId: provider.providerId,
    workingDirectory: "C:\\workspaces\\capacity",
    title: "Final slot B",
    content: "Must not create an orphan provider task.",
    runAt: new Date(start + 2 * 60 * 60_000).toISOString(),
  });
  const results = await Promise.allSettled([first, second]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(provider.createCalls, 0, "capacity reservation created a provider session before either task was due");
  assert.equal(bridge.scheduledTasks().length, tasks.length + 1);
});

test("schedule events retain a bounded preview instead of the full durable prompt", async (t) => {
  const hostId = "host-scheduled-event-preview";
  const provider = new TrackingFakeProvider({ hostId, providerId: "codex", sessionCount: 0 });
  const { bridge, router, clock, scheduler } = await fixture(hostId, [provider]);
  t.after(() => bridge.dispose());
  const content = `${"Long scheduled instruction. ".repeat(500)}UNIQUE_PROMPT_TAIL`;

  await bridge.createScheduledTask({
    requestId: "bounded-event-preview",
    providerId: provider.providerId,
    workingDirectory: "C:\\workspaces\\bounded-event-preview",
    title: "Bound event prompt retention",
    content,
    runAt: new Date(start + 5 * 60_000).toISOString(),
  });

  const event = bridge.eventReplaySince(0).events.find((candidate) =>
    candidate.type === "scheduled_task.created"
    && candidate.payload.task
    && object(candidate.payload.task, "event task").requestId === "bounded-event-preview");
  assert.ok(event);
  const eventTask = object(event.payload.task, "event task");
  assert.equal(typeof eventTask.content, "string");
  const eventContent = String(eventTask.content);
  assert.ok(eventContent.length <= 180);
  assert.notEqual(eventContent, content);
  assert.equal(eventContent, `${content.slice(0, 177).trimEnd()}…`);
  assert.equal(eventContent.includes("UNIQUE_PROMPT_TAIL"), false);
  assert.equal(bridge.scheduledTasks()[0]?.content, content, "event redaction changed the durable prompt");

  const listed = await router.handle(request(hostId, "list-full-prompt", "scheduled_task.list", {}));
  assert.equal(listed.ok, true);
  const listedTask = object((listed.payload.tasks as unknown[])[0], "listed task");
  assert.equal(listedTask.content, content, "renderer hydration lost the authoritative prompt");

  clock.advanceBy(5 * 60_000);
  await scheduler.flush();
  assert.equal(provider.sends[0]?.request.content, content, "event redaction changed the provider prompt");
});
