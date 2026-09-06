'use strict';

/**
 * Deterministic, zero-provider fake model host for Tethoq desktop QA.
 *
 * The host implements the desktop request contract (bootstrap, sessions,
 * timeline pages, send_message, queues, approvals) entirely in memory and
 * plays back pre-written scenario event streams. It makes no network calls,
 * never reads provider tokens, and only emits batches through the supplied
 * onBatch callback. The manual clock makes the whole play reproducible in
 * plain node tests; the Electron QA driver supplies the real clock instead.
 *
 * This module is test-only. Nothing under src/ imports it.
 */

const { createRealClock } = require('./deterministic-clock.cjs');
const {
  FAKE_HOST_ID,
  FAKE_PROVIDER_ID,
  buildScenario,
  longHistoryMessages,
  attachmentHistory,
} = require('./scenarios.cjs');

const FAKE_MODEL_ID = 'fake/deterministic-v1';
const MAX_QUEUE_PREVIEW_BYTES = 256 * 1024;

const clone = (value) => structuredClone(value);

const fakeProviderCatalogue = [
  ['fake', 'Fake Model'],
  ['direct', 'Direct API'],
  ['codex', 'Codex'],
  ['opencode', 'OpenCode'],
  ['grok', 'Grok'],
];

const fakeModels = {
  fake: [
    { id: FAKE_MODEL_ID, displayName: 'Deterministic Text v1', isDefault: true, inputModalities: ['text'], efforts: ['Low', 'Medium', 'High'] },
  ],
  direct: [
    { id: 'direct/vision-audio', displayName: 'Direct Vision + Audio', isDefault: true, inputModalities: ['text', 'image', 'audio'], efforts: ['low', 'high'] },
    { id: 'direct/text-only', displayName: 'Direct Text Only', isDefault: false, inputModalities: ['text'], efforts: ['low'] },
  ],
  codex: [
    { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', isDefault: true, inputModalities: ['text', 'image'], efforts: ['low', 'high', 'xhigh'] },
    { id: 'codex/text-only', displayName: 'Codex Text Only', isDefault: false, inputModalities: ['text'], efforts: ['low'] },
  ],
  opencode: [
    { id: 'deepseek/deepseek-v4-flash', displayName: 'DeepSeek V4 Flash', isDefault: true, inputModalities: ['text', 'image', 'audio'], efforts: ['low', 'max'] },
    { id: 'deepseek/deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', isDefault: false, inputModalities: ['text'], efforts: ['high', 'max'] },
  ],
  grok: [
    { id: 'grok/vision', displayName: 'Grok Vision', isDefault: true, inputModalities: ['text', 'image'], efforts: ['low', 'high'] },
    // Advertised audio is deliberate: EARS must still exclude this route until
    // the Grok adapter can actually transport non-image attachments.
    { id: 'grok/advertised-audio', displayName: 'Grok Advertised Audio', isDefault: false, inputModalities: ['text', 'audio'], efforts: ['low'] },
  ],
};

function fakeProvider(providerId, displayName, override = {}) {
  return {
    providerId,
    displayName,
    state: override.state ?? 'online',
    detected: override.detected ?? true,
    authenticated: override.authenticated ?? true,
    capabilities: fakeProviderCapabilities(),
    nativeVersion: '0.0.0-test',
    ...(override.lastError ? { lastError: override.lastError } : {}),
  };
}

function modelsFor(providerId) {
  return (fakeModels[providerId] ?? []).map((model) => ({
    ...model,
    providerId,
    description: 'Test-only capability fixture. No tokens, no network.',
    nativeMetadata: {
      supportedReasoningEfforts: model.efforts,
      defaultReasoningEffort: model.efforts[0],
      inputModalities: model.inputModalities,
    },
  }));
}

function fakeModelRoute(providerId, modelId) {
  return (fakeModels[providerId] ?? []).find((model) => model.id === modelId);
}

function validRouteSelection(selection, modality) {
  if (!selection || typeof selection !== 'object') return null;
  const providerId = typeof selection.providerId === 'string' ? selection.providerId : '';
  const modelId = typeof selection.modelId === 'string' ? selection.modelId : '';
  const reasoningEffort = typeof selection.reasoningEffort === 'string' ? selection.reasoningEffort : '';
  const model = fakeModelRoute(providerId, modelId);
  if (!model || !model.inputModalities.includes(modality) || (reasoningEffort && !model.efforts.includes(reasoningEffort))) return null;
  return { providerId, modelId, ...(reasoningEffort ? { reasoningEffort } : {}) };
}

function attachmentDataUrl(attachment) {
  return `data:${attachment.mimeType};base64,${attachment.dataBase64}`;
}

function attachmentContentPart(attachment) {
  const mimeType = typeof attachment.mimeType === 'string' && attachment.mimeType
    ? attachment.mimeType
    : 'application/octet-stream';
  const name = typeof attachment.name === 'string' && attachment.name ? attachment.name : 'Attachment';
  const lowerMimeType = mimeType.toLowerCase();
  if (lowerMimeType.startsWith('image/')) {
    return { type: 'image', uri: attachmentDataUrl({ ...attachment, mimeType }), mimeType, name };
  }
  if (lowerMimeType.startsWith('audio/')) {
    return {
      type: 'audio',
      uri: attachmentDataUrl({ ...attachment, mimeType }),
      mimeType,
      name,
      ...(typeof attachment.durationSeconds === 'number' && Number.isFinite(attachment.durationSeconds) && attachment.durationSeconds > 0
        ? { durationSeconds: attachment.durationSeconds }
        : {}),
    };
  }
  return { type: 'file', name, mimeType };
}

function outgoingMessageParts(content, attachments) {
  return [
    ...(typeof content === 'string' && content.trim() ? [{ type: 'text', text: content }] : []),
    ...attachments.map((attachment) => attachmentContentPart(attachment)),
  ];
}

function queuedAttachmentMetadata(attachment) {
  const mimeType = typeof attachment.mimeType === 'string' && attachment.mimeType
    ? attachment.mimeType
    : 'application/octet-stream';
  const previewable = /^(?:image|audio)\//iu.test(mimeType);
  const dataUrl = previewable && attachment.byteLength <= MAX_QUEUE_PREVIEW_BYTES
    ? attachmentDataUrl({ ...attachment, mimeType })
    : undefined;
  return {
    name: typeof attachment.name === 'string' && attachment.name ? attachment.name : 'Attachment',
    mimeType,
    byteLength: Number.isSafeInteger(attachment.byteLength) ? attachment.byteLength : 0,
    ...(dataUrl !== undefined ? { dataUrl } : {}),
    ...(typeof attachment.durationSeconds === 'number' && Number.isFinite(attachment.durationSeconds) && attachment.durationSeconds > 0
      ? { durationSeconds: attachment.durationSeconds }
      : {}),
  };
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

const FAKE_GOAL_STATUSES = new Set(['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete']);
const FAKE_GOAL_GUIDANCE_HEADER = 'Tethoq persistent task goal (private control context; do not quote this block):';

function fakeGoalGuidance(goal) {
  if (!goal) return undefined;
  const budget = goal.tokenBudget === null ? 'No token budget is set.' : `Token budget: ${goal.tokenBudget} tokens. This fake-provider fallback has no usage accounting or enforcement; treat the budget as advisory.`;
  return `${FAKE_GOAL_GUIDANCE_HEADER}\n\nObjective: ${goal.objective}\nStatus: ${goal.status}. ${budget} Keep this objective in view across turns. The goal lifecycle is controlled by Tethoq and is independent of whether this turn is busy or finished.`;
}

function mapEntries(value) {
  if (value instanceof Map) return [...value.entries()];
  if (Array.isArray(value)) return value.filter((entry) => Array.isArray(entry) && entry.length === 2);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value);
}

function fakeProviderCapabilities() {
  return {
    authentication: false,
    listSessions: true,
    paginatedSessions: false,
    sessionHistory: true,
    createSession: true,
    resumeSession: true,
    sendMessage: true,
    steering: true,
    streamingText: true,
    toolEvents: true,
    commandEvents: true,
    fileChanges: true,
    approvals: true,
    userInput: true,
    interrupt: true,
    modelEnumeration: true,
    projectAssociation: true,
    sessionRelationships: true,
    messageEditing: true,
    remoteConnectivity: 'local',
    notes: [],
  };
}

function sessionBase(sessionId, providerSessionId, title, workingDirectory, baseIso) {
  return {
    id: sessionId,
    hostId: FAKE_HOST_ID,
    providerId: FAKE_PROVIDER_ID,
    providerSessionId,
    title,
    project: workingDirectory.split(/[\\/]/u).filter(Boolean).at(-1) ?? 'FakeModel',
    workingDirectory,
    state: 'idle',
    createdAt: baseIso,
    lastActivityAt: baseIso,
    preview: 'Deterministic fixture session.',
    modelId: FAKE_MODEL_ID,
    reasoningEffort: 'medium',
    needsApproval: false,
    stale: false,
    nativeMetadata: {},
  };
}

function approvalRecord(requestId, sessionId, baseIso, providerId = FAKE_PROVIDER_ID) {
  return {
    requestId,
    hostId: FAKE_HOST_ID,
    providerId,
    sessionId,
    providerRequestId: requestId,
    createdAt: baseIso,
    title: 'Run the deterministic migration?',
    reason: 'The fixture migration updates the refresh-token index used by the repaired path.',
    command: 'npm run db:migrate',
    workingDirectory: 'C:\\FakeModel\\main',
    affectedFiles: ['migrations/20260821_fixture.sql'],
    networkDestinations: [],
    riskMetadata: {},
    choices: [
      { id: 'approve', label: 'Run migration', kind: 'approve' },
      { id: 'reject', label: 'Not now', kind: 'reject' },
    ],
  };
}

function createFakeModelHost(options = {}) {
  const clock = options.clock ?? createRealClock();
  const onBatch = options.onBatch ?? (() => {});
  // A caller may provide a ready local speech source for the isolated
  // microphone journey. The ordinary fake host keeps the catalogue empty so
  // unit tests that do not need dictation retain their existing contract.
  const dictationSources = Array.isArray(options.dictationSources) ? clone(options.dictationSources) : [];
  const baseIso = options.baseIso ?? clock.nowIso();
  const baseMs = Date.parse(baseIso);

  const parentSession = {
    ...sessionBase('fake-main', 'fake-main-native', 'Fake model main task', 'C:\\FakeModel\\main', baseIso),
    ...(options.imageSendFixture === true ? { providerId: 'direct', modelId: 'direct/vision-audio', reasoningEffort: 'low' } : {}),
    childCount: 1,
  };
  const subagentSession = {
    ...sessionBase('fake-subagent', 'fake-subagent-native', 'Hidden deterministic sub-agent', 'C:\\FakeModel\\main', new Date(baseMs + 30_000).toISOString()),
    parentSessionId: parentSession.id,
    relationship: { kind: 'subagent', sourceSessionId: parentSession.id, strategy: 'native' },
    agentNickname: 'Fixture worker',
    agentRole: 'cross_harness_delegate',
    state: 'working',
  };
  const providerParentedUserSession = {
    ...sessionBase('fake-provider-parented', 'fake-provider-parented-native', 'Visible provider-parented user task', 'C:\\FakeModel\\main', new Date(baseMs + 60_000).toISOString()),
    parentSessionId: parentSession.id,
    providerId: 'direct',
    modelId: 'direct/vision-audio',
  };
  const audioSession = {
    ...sessionBase('fake-audio', 'fake-audio-native', 'Fake Codex audio task', 'C:\\FakeModel\\audio', new Date(baseMs + 90_000).toISOString()),
    providerId: 'codex',
    modelId: 'gpt-5.6-sol',
  };
  const sessions = [
    parentSession,
    subagentSession,
    providerParentedUserSession,
    audioSession,
    sessionBase('fake-side', 'fake-side-native', 'Fake model attachments task', 'C:\\FakeModel\\side', new Date(baseMs + 120_000).toISOString()),
  ];
  const messagesBySession = new Map([
    ['fake-main', longHistoryMessages('fake-main', baseIso)],
    ['fake-subagent', []],
    ['fake-provider-parented', []],
    ['fake-audio', []],
    ['fake-side', attachmentHistory('fake-side', baseIso)],
  ]);
  if (options.projectGroupingFixture === true) {
    const projectFixtures = [
      sessionBase('fake-project-alpha', 'fake-project-alpha-native', 'Payments alpha', 'C:\\FakeModel\\repo-a\\payments', new Date(baseMs + 150_000).toISOString()),
      sessionBase('fake-project-beta', 'fake-project-beta-native', 'Payments beta', 'C:\\FakeModel\\repo-b\\payments', new Date(baseMs + 180_000).toISOString()),
      { ...sessionBase('fake-project-root', 'fake-project-root-native', 'Root task', 'C:\\', new Date(baseMs + 210_000).toISOString()) },
      { ...sessionBase('fake-project-unassigned', 'fake-project-unassigned-native', 'Provider-only task', '', new Date(baseMs + 240_000).toISOString()), project: 'Provider-only' },
    ];
    sessions.push(...projectFixtures);
    for (const session of projectFixtures) messagesBySession.set(session.id, []);
  }

  function addProjectGroupingFixtureForTests() {
    if (sessions.some((session) => session.id === 'fake-project-alpha')) return false;
    const projectFixtures = [
      sessionBase('fake-project-alpha', 'fake-project-alpha-native', 'Payments alpha', 'C:\\FakeModel\\repo-a\\payments', new Date(baseMs + 150_000).toISOString()),
      sessionBase('fake-project-beta', 'fake-project-beta-native', 'Payments beta', 'C:\\FakeModel\\repo-b\\payments', new Date(baseMs + 180_000).toISOString()),
      { ...sessionBase('fake-project-root', 'fake-project-root-native', 'Root task', 'C:\\', new Date(baseMs + 210_000).toISOString()) },
      { ...sessionBase('fake-project-unassigned', 'fake-project-unassigned-native', 'Provider-only task', '', new Date(baseMs + 240_000).toISOString()), project: 'Provider-only' },
    ];
    sessions.push(...projectFixtures);
    for (const session of projectFixtures) messagesBySession.set(session.id, []);
    return true;
  }
  let queue = [];
  const scheduledTasks = [];
  const approvals = [];
  let latestSequence = 0;
  let runCounter = 0;
  let playing = null;
  let deferredTerminal = null;
  let sendCounter = 0;
  const requests = [];
  const configuredVisionBySession = new Map();
  const delegations = [];
  const contextThresholds = new Map();
  const pendingUploads = new Map();
  const completedUploads = new Map();
  const queueAttachmentIds = new Map();
  const queuedNewTaskDeliveries = new Map();
  const executionRecords = [];
  const providerStatusOverrides = new Map();
  const oneShotFailures = new Map();
  const requestLedger = new Map();
  const historyReplayBySession = new Map();
  const goalsBySession = new Map();
  let goalRevision = 0;
  let modelTurnCount = 0;
  let modelTokenCount = 0;

  const persistedState = options.persistedState;
  if (persistedState && typeof persistedState === 'object') {
    if (Array.isArray(persistedState.sessions)) {
      sessions.splice(0, sessions.length, ...clone(persistedState.sessions));
    }
    if (persistedState.messagesBySession !== undefined) {
      messagesBySession.clear();
      for (const [sessionId, messages] of mapEntries(persistedState.messagesBySession)) {
        messagesBySession.set(sessionId, clone(messages));
      }
    }
    if (Array.isArray(persistedState.queue)) queue = clone(persistedState.queue);
    if (Array.isArray(persistedState.scheduledTasks)) scheduledTasks.push(...clone(persistedState.scheduledTasks));
    if (Array.isArray(persistedState.approvals)) approvals.push(...clone(persistedState.approvals));
    if (Array.isArray(persistedState.delegations)) delegations.push(...clone(persistedState.delegations));
    if (Array.isArray(persistedState.executionRecords)) executionRecords.push(...clone(persistedState.executionRecords));
    for (const [sessionId, selection] of mapEntries(persistedState.configuredVisionBySession)) {
      configuredVisionBySession.set(sessionId, clone(selection));
    }
    for (const [sessionId, threshold] of mapEntries(persistedState.contextThresholds)) {
      contextThresholds.set(sessionId, threshold);
    }
    for (const [messageId, attachmentIds] of mapEntries(persistedState.queueAttachmentIds)) {
      queueAttachmentIds.set(messageId, clone(attachmentIds));
    }
    for (const [attachmentId, attachment] of mapEntries(persistedState.completedUploads)) {
      completedUploads.set(attachmentId, clone(attachment));
    }
    for (const [providerId, status] of mapEntries(persistedState.providerStatusOverrides)) {
      providerStatusOverrides.set(providerId, clone(status));
    }
    if (Number.isSafeInteger(persistedState.latestSequence)) latestSequence = persistedState.latestSequence;
    if (Number.isSafeInteger(persistedState.runCounter)) runCounter = persistedState.runCounter;
    if (Number.isSafeInteger(persistedState.sendCounter)) sendCounter = persistedState.sendCounter;
    for (const [sessionId, goal] of mapEntries(persistedState.goalsBySession)) {
      if (goal && typeof goal === 'object') goalsBySession.set(sessionId, clone(goal));
    }
    if (Number.isSafeInteger(persistedState.goalRevision)) goalRevision = persistedState.goalRevision;
    if (Number.isSafeInteger(persistedState.modelTurnCount)) modelTurnCount = persistedState.modelTurnCount;
    if (Number.isSafeInteger(persistedState.modelTokenCount)) modelTokenCount = persistedState.modelTokenCount;
  }

  const sessionById = (sessionId) => sessions.find((session) => session.id === sessionId);

  function goalForSession(sessionId) {
    return goalsBySession.get(sessionId) ?? null;
  }

  function goalEvent(sessionId, type, goal, revision) {
    emit([nextEvent(sessionId, 'goal', type, type === 'session.goal_updated' ? { goal: clone(goal) } : { revision }, clock.nowIso())]);
    // The fake never spends model tokens for a goal mutation. Keeping this
    // explicit makes the zero-token contract observable in unit and Electron QA.
  }

  function setGoal(sessionId, update) {
    if (!sessionById(sessionId)) return { ok: false, message: 'That fake model task does not exist.' };
    const previous = goalForSession(sessionId);
    const objective = update.objective === undefined ? previous?.objective : update.objective.trim();
    if (!objective) return { ok: false, message: 'Set a goal objective before changing its state.' };
    if (objective.length > 4_000) return { ok: false, message: 'Goal objective must contain between 1 and 4000 characters.' };
    const status = update.status ?? previous?.status ?? 'active';
    if (!FAKE_GOAL_STATUSES.has(status)) return { ok: false, message: 'Goal status is invalid.' };
    const tokenBudget = update.tokenBudget === undefined ? previous?.tokenBudget ?? null : update.tokenBudget;
    if (tokenBudget !== null && (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)) return { ok: false, message: 'Goal token budget must be a positive whole number.' };
    const now = clock.nowIso();
    const replaced = previous !== null && update.objective !== undefined && objective !== previous.objective;
    const goal = {
      sessionId,
      objective,
      status,
      source: 'tethoq',
      tokenBudget,
      tokensUsed: replaced ? 0 : previous?.tokensUsed ?? 0,
      timeUsedSeconds: replaced ? 0 : previous?.timeUsedSeconds ?? 0,
      createdAt: replaced ? now : previous?.createdAt ?? now,
      updatedAt: now,
      revision: ++goalRevision,
    };
    goalsBySession.set(sessionId, goal);
    goalEvent(sessionId, 'session.goal_updated', goal, goal.revision);
    return { ok: true, goal };
  }

  function clearGoal(sessionId) {
    if (!sessionById(sessionId)) return { ok: false, message: 'That fake model task does not exist.' };
    const hadGoal = goalsBySession.delete(sessionId);
    if (hadGoal) goalEvent(sessionId, 'session.goal_cleared', null, ++goalRevision);
    return { ok: true, cleared: hadGoal, revision: goalRevision };
  }

  function injectGoalGuidance(type, input) {
    if (type !== 'session.send_message' && type !== 'session.steer_message' && type !== 'message_queue.enqueue') return input;
    const goal = typeof input.sessionId === 'string' ? goalForSession(input.sessionId) : null;
    const guidance = fakeGoalGuidance(goal);
    if (!guidance || (typeof input.developerInstructions === 'string' && input.developerInstructions.includes(FAKE_GOAL_GUIDANCE_HEADER))) return input;
    return {
      ...input,
      developerInstructions: typeof input.developerInstructions === 'string' && input.developerInstructions.length > 0
        ? `${input.developerInstructions}\n\n${guidance}`
        : guidance,
    };
  }

  const providerIdForSession = (sessionId) => sessionById(sessionId)?.providerId ?? FAKE_PROVIDER_ID;

  function resolveAttachmentIds(attachmentIds) {
    const ids = Array.isArray(attachmentIds)
      ? attachmentIds.filter((id) => typeof id === 'string' && id.length > 0)
      : [];
    const attachments = ids.map((id) => completedUploads.get(id));
    if (attachments.some((attachment) => !attachment)) return null;
    return { ids, attachments };
  }

  function attachmentsForQueuedMessage(message) {
    const attachmentIds = queueAttachmentIds.get(message.id) ?? [];
    return attachmentIds.map((id) => completedUploads.get(id)).filter(Boolean);
  }

  function attachmentRouteError(session, selection, attachments) {
    const modelId = nonEmptyString(selection.modelId) ?? nonEmptyString(session.modelId) ?? FAKE_MODEL_ID;
    const model = fakeModelRoute(session.providerId, modelId);
    if (!model && attachments.length > 0) return `The selected fake model ${modelId} is unavailable for ${session.providerId}.`;
    for (const attachment of attachments) {
      const mimeType = typeof attachment.mimeType === 'string' ? attachment.mimeType.toLowerCase() : '';
      const modality = mimeType.startsWith('image/') ? 'image' : mimeType.startsWith('audio/') ? 'audio' : null;
      if (modality && !model.inputModalities.includes(modality)) {
        return `The selected fake model ${modelId} does not support ${modality} attachments.`;
      }
    }
    return null;
  }

  function executionSelection(session, selection = {}) {
    const modelId = nonEmptyString(selection.modelId) ?? nonEmptyString(session.modelId) ?? FAKE_MODEL_ID;
    const reasoningEffort = nonEmptyString(selection.reasoningEffort) ?? nonEmptyString(session.reasoningEffort) ?? 'medium';
    return {
      providerId: nonEmptyString(session.providerId) ?? FAKE_PROVIDER_ID,
      modelId,
      reasoningEffort,
    };
  }

  function beginExecution(session, runId, scenarioId, selection, startedAt) {
    const selected = executionSelection(session, selection);
    session.modelId = selected.modelId;
    session.reasoningEffort = selected.reasoningEffort;
    const proof = {
      runId,
      scenarioId,
      providerId: selected.providerId,
      modelId: selected.modelId,
      reasoningEffort: selected.reasoningEffort,
      startedAt,
    };
    const record = { sessionId: session.id, ...proof, status: 'working' };
    executionRecords.push(record);
    session.nativeMetadata = {
      ...(session.nativeMetadata ?? {}),
      fakeExecution: clone(record),
    };
    return { selected, proof, record };
  }

  function streamingHistoryMessage(message) {
    if (message.role === 'user') return clone(message);
    return {
      ...clone(message),
      status: 'streaming',
      parts: message.parts.map((part) => {
        if (part.type === 'text' || part.type === 'reasoning') return { ...part, text: '' };
        if (part.type === 'command') {
          const { output: _output, ...withoutOutput } = part;
          return { ...withoutOutput, status: 'pending' };
        }
        if (part.type === 'tool') {
          const { output: _output, ...withoutOutput } = part;
          return { ...withoutOutput, status: 'pending' };
        }
        return part;
      }),
    };
  }

  function updateExecution(runId, status, atIso) {
    const record = executionRecords.findLast((candidate) => candidate.runId === runId);
    if (!record) return;
    record.status = status;
    record.endedAt = atIso;
    const session = sessionById(record.sessionId);
    if (!session) return;
    session.nativeMetadata = {
      ...(session.nativeMetadata ?? {}),
      fakeExecution: clone({ ...record, sessionId: record.sessionId }),
    };
  }

  function setSessionState(sessionId, state, atIso) {
    const session = sessionById(sessionId);
    if (!session) return;
    session.state = state;
    session.lastActivityAt = atIso;
    if (state === 'working') session.preview = 'Streaming deterministic fake model output.';
    if (state === 'idle') session.preview = 'The deterministic fake model turn completed.';
    if (state === 'failed') session.preview = 'The deterministic fake model turn failed.';
  }

  function contextState(sessionId) {
    const thresholdTokens = contextThresholds.get(sessionId) ?? 96_000;
    const session = sessionById(sessionId);
    return {
      sessionId,
      modelId: session?.modelId ?? FAKE_MODEL_ID,
      usedTokens: 4_200,
      contextWindowTokens: 128_000,
      usedPercent: (4_200 / 128_000) * 100,
      compactionThresholdTokens: thresholdTokens,
      minimumThresholdTokens: 8_000,
      supportsManualCompaction: true,
      supportsThreshold: true,
      isCompacting: false,
      compactionKind: null,
      updatedAt: clock.nowIso(),
      usage: { inputTokens: 3_900, outputTokens: 300, totalTokens: 4_200, cost: 0.0, currency: 'USD' },
    };
  }

  function emit(events, sequence) {
    latestSequence = sequence ?? latestSequence;
    if (!events.length) return;
    onBatch({ events, latestSequence, replayGap: false });
  }

  function nextEvent(sessionId, runId, type, payload, atIso) {
    latestSequence += 1;
    return {
      eventId: `fake-${runId}-${latestSequence}`,
      sequence: latestSequence,
      type,
      hostId: FAKE_HOST_ID,
      providerId: providerIdForSession(sessionId),
      sessionId,
      occurredAt: atIso,
      payload,
    };
  }

  function scheduledTaskById(requestId) {
    return scheduledTasks.find((task) => task.requestId === requestId);
  }

  function scheduledTaskWithStatus(task, status, options = {}) {
    const {
      dispatchingAt: _dispatchingAt,
      startedAt: _startedAt,
      failedAt: _failedAt,
      failureMessage: _failureMessage,
      ...base
    } = task;
    const at = typeof options.at === 'string' ? options.at : clock.nowIso();
    const runAt = typeof options.runAt === 'string' ? options.runAt : base.runAt;
    const targetSessionId = typeof options.targetSessionId === 'string' && options.targetSessionId
      ? options.targetSessionId
      : base.targetSessionId;
    if (status === 'pending') return { ...base, targetSessionId, runAt, status };
    const dispatchingAt = typeof task.dispatchingAt === 'string' ? task.dispatchingAt : at;
    if (status === 'dispatching') return { ...base, targetSessionId, runAt, status, dispatchingAt };
    if (status === 'started') return { ...base, targetSessionId, runAt, status, dispatchingAt, startedAt: at };
    if (status === 'failed') {
      return {
        ...base,
        targetSessionId,
        runAt,
        status,
        dispatchingAt,
        failedAt: at,
        failureMessage: typeof options.failureMessage === 'string' && options.failureMessage.trim()
          ? options.failureMessage.trim()
          : 'Deterministic scheduled-task dispatch failure.',
      };
    }
    throw new Error(`Unsupported fake scheduled-task status: ${status}`);
  }

  function setScheduledTaskStatusForTests(requestId, status, options = {}) {
    const index = scheduledTasks.findIndex((task) => task.requestId === requestId);
    if (index < 0) throw new Error('That fake scheduled task does not exist.');
    const current = scheduledTasks[index];
    let materializedSession = null;
    let previousTargetSessionId;
    if (status === 'started' && current.targetSessionId.startsWith('scheduled-task:')) {
      previousTargetSessionId = current.targetSessionId;
      const sessionId = `fake-scheduled-session-${++sendCounter}`;
      materializedSession = {
        ...sessionBase(sessionId, `${sessionId}-native`, current.title, current.workingDirectory, clock.nowIso()),
        providerId: current.providerId,
        modelId: current.modelId ?? FAKE_MODEL_ID,
        reasoningEffort: current.reasoningEffort ?? 'medium',
        preview: current.content.slice(0, 180),
      };
      sessions.unshift(materializedSession);
      messagesBySession.set(sessionId, []);
      options = { ...options, targetSessionId: sessionId };
    }
    const task = scheduledTaskWithStatus(current, status, options);
    scheduledTasks[index] = task;
    const at = clock.nowIso();
    const events = [];
    if (materializedSession) {
      events.push(nextEvent(task.targetSessionId, `schedule-${requestId}`, 'session.created', { sessionId: task.targetSessionId }, at));
    }
    events.push(nextEvent(task.targetSessionId, `schedule-${requestId}`, 'scheduled_task.updated', {
      change: 'updated',
      task: clone(task),
      ...(previousTargetSessionId ? { previousTargetSessionId } : {}),
    }, at));
    if (status === 'started') {
      setSessionState(task.targetSessionId, 'working', at);
      events.push(nextEvent(task.targetSessionId, `schedule-${requestId}`, 'session.updated', { state: 'working' }, at));
    }
    emit(events);
    return clone(task);
  }

  function eventIdentity(event) {
    const payload = event.payload ?? {};
    if (typeof payload.messageId === 'string') return payload.messageId;
    if (typeof payload.toolCallId === 'string') return payload.toolCallId;
    if (typeof payload.commandId === 'string') return payload.commandId;
    if (typeof payload.id === 'string') return payload.id;
    return undefined;
  }

  function noteRunEvents(sessionId, runId, events) {
    const active = playing;
    if (!active || active.runId !== runId || active.sessionId !== sessionId) return;
    for (const event of events) {
      const identity = eventIdentity(event);
      if (!identity) continue;
      active.emittedMessageIds.add(identity);
      if (event.type === 'message.completed' || event.type === 'tool.completed' || event.type === 'command.completed') {
        active.completedMessageIds.add(identity);
      }
    }
  }

  function playSteps(sessionId, runId, steps, baseIso) {
    const handles = [];
    for (const step of steps) {
      const atIso = new Date(Date.parse(baseIso) + step.at).toISOString();
      handles.push(clock.schedule(() => {
        const events = step.events.map((event) => nextEvent(sessionId, runId, event.type, event.payload, atIso));
        noteRunEvents(sessionId, runId, events);
        for (const event of events) {
          if (event.type === 'approval.requested' && typeof event.payload.requestId === 'string') {
            approvals.push(approvalRecord(event.payload.requestId, sessionId, event.occurredAt, providerIdForSession(sessionId)));
          }
          applyHistoryEvent(sessionId, event, runId);
        }
        emit(events);
      }, step.at));
    }
    return { handles, lastOffset: steps.length ? Math.max(...steps.map((step) => step.at)) : 0 };
  }

  /**
   * Mirrors a real provider: the turn's messages exist in history from the
   * start (streaming), and each event extends or settles them. A mid-stream
   * history reload therefore sees the in-flight rows instead of an empty page.
   */
  function applyHistoryEvent(sessionId, event, runId) {
    if (event.type !== 'message.delta' && event.type !== 'message.completed'
      && event.type !== 'tool.started' && event.type !== 'tool.completed'
      && event.type !== 'command.started' && event.type !== 'command.output' && event.type !== 'command.completed'
      && event.type !== 'agent.error') return;
    const store = messagesBySession.get(sessionId);
    if (!store) return;
    if (event.type === 'agent.error') {
      const message = event.payload?.message;
      if (typeof message !== 'string' || !message) return;
      const providerMessageId = `${runId ?? 'fake'}-error`;
      if (store.some((candidate) => candidate.providerMessageId === providerMessageId)) return;
      const execution = playing?.runId === runId ? playing.executionProof : { runId };
      store.push({
        id: `${providerMessageId}-message`,
        sessionId,
        providerMessageId,
        role: 'assistant',
        createdAt: event.occurredAt,
        completedAt: event.occurredAt,
        parts: [{ type: 'error', message }],
        status: 'failed',
        nativeMetadata: { phase: 'error', fakeExecution: clone(execution) },
      });
      return;
    }
    const identity = eventIdentity(event);
    if (!identity) return;
    const message = store.find((candidate) => candidate.providerMessageId === identity);
    if (!message) return;
    const payload = event.payload ?? {};
    const part = message.parts[0];
    if (event.type === 'message.delta') {
      if (part && (part.type === 'reasoning' || part.type === 'text')) {
        part.text = `${part.text}${typeof payload.delta === 'string' ? payload.delta : ''}`;
      }
      return;
    }
    if (event.type === 'tool.started' || event.type === 'tool.completed') {
      if (part && part.type === 'text' && typeof payload.text === 'string') part.text = payload.text;
      message.status = event.type === 'tool.completed' ? 'completed' : 'streaming';
      return;
    }
    if (event.type === 'command.started' || event.type === 'command.output' || event.type === 'command.completed') {
      if (part && part.type === 'command') {
        if (typeof payload.command === 'string') part.command = payload.command;
        if (typeof payload.output === 'string') part.output = payload.output;
        part.status = event.type === 'command.completed' ? 'completed' : 'running';
      }
      message.status = event.type === 'command.completed' ? 'completed' : 'streaming';
      return;
    }
    message.status = 'completed';
    if (part && typeof payload.text === 'string' && (part.type === 'reasoning' || part.type === 'text')) {
      part.text = payload.text;
    }
  }

  function finalizePlan() {
    const active = playing;
    if (!active) return;
    playing = null;
    const { plan, sessionId, playStartedAtIso } = active;
    const planIds = new Set(plan.history.map((message) => message.providerMessageId));
    const retained = (messagesBySession.get(sessionId) ?? []).filter((message) => !planIds.has(message.providerMessageId));
    messagesBySession.set(sessionId, [...retained, ...plan.history]);
    const settledAt = new Date(Date.parse(playStartedAtIso) + active.lastOffset + 40).toISOString();
    updateExecution(active.runId, plan.endState === 'failed' ? 'failed' : 'completed', settledAt);
    setSessionState(sessionId, plan.endState, settledAt);
    // Emit the provider's terminal state once, directly beside the last chunk.
    // The renderer must retain this early signal and apply it after its own
    // quiet boundary; a second fixture event would conceal a dropped-signal bug.
    emit([nextEvent(sessionId, active.runId, 'session.status_changed', { state: plan.endState, providerStatus: null }, settledAt)]);
  }

  function terminalizeDeferredPlan() {
    const active = playing;
    if (!active || !active.plan.deferFinalHistory) return;
    playing = null;
    active.handles.forEach((handle) => clock.cancel(handle));
    const atIso = clock.nowIso();
    deferredTerminal = { ...active, terminalAt: atIso };
    updateExecution(active.runId, 'completed', atIso);
    setSessionState(active.sessionId, 'completed', atIso);
    // The provider is terminal, but its final answer is intentionally absent
    // until releaseDeferredFinalHistoryForTests() publishes authoritative
    // persisted history and prompts the renderer to catch up again.
    emit([nextEvent(active.sessionId, active.runId, 'session.updated', { state: 'completed', deferredHistory: true }, atIso)]);
  }

  function releaseDeferredFinalHistoryForTests() {
    const active = deferredTerminal;
    if (!active) return { released: false };
    const { plan, sessionId, runId } = active;
    const planIds = new Set(plan.history.map((message) => message.providerMessageId));
    const retained = (messagesBySession.get(sessionId) ?? []).filter((message) => !planIds.has(message.providerMessageId));
    messagesBySession.set(sessionId, [...retained, ...plan.history]);
    deferredTerminal = null;
    // The first post-release read is reordered; the next two include a
    // duplicate row. The canonical store above remains deduplicated so the
    // real renderer reconciliation path—not fixture mutation—does the work.
    historyReplayBySession.set(sessionId, { remaining: 3 });
    const atIso = clock.nowIso();
    setSessionState(sessionId, 'completed', atIso);
    emit([nextEvent(sessionId, runId, 'session.updated', { state: 'completed', historyReleased: true }, atIso)]);
    clock.schedule(() => {
      if (!sessionById(sessionId)) return;
      emit([nextEvent(sessionId, runId, 'session.updated', { state: 'completed', historyReleased: true }, clock.nowIso())]);
    }, 800);
    return {
      released: true,
      sessionId,
      runId,
      answerId: plan.history.find((message) => message.nativeMetadata?.phase === 'final_answer')?.providerMessageId ?? null,
      canonicalMessageCount: plan.history.length,
    };
  }

  /** A provider can retract an early terminal report by producing newer work. */
  function emitDeferredLiveActivityForTests() {
    const active = deferredTerminal;
    if (!active) return { emitted: false };
    const atIso = clock.nowIso();
    setSessionState(active.sessionId, 'working', atIso);
    emit([nextEvent(active.sessionId, active.runId, 'session.updated', { state: 'working', resumedAfterTerminal: true }, atIso)]);
    return { emitted: true, sessionId: active.sessionId, runId: active.runId, occurredAt: atIso };
  }

  function audioPlan(sessionId, context, attachments) {
    const userId = `${context.runId}-fake-audio-user`;
    const reasoningId = `${context.runId}-fake-audio-reasoning`;
    const answerId = `${context.runId}-fake-audio-answer`;
    const byteLength = attachments.reduce((total, attachment) => total + attachment.byteLength, 0);
    const answer = `Fresh fake audio response ${context.runId}: received ${byteLength} MP3 bytes.`;
    return {
      id: 'audio',
      gate: null,
      endState: 'idle',
      history: [{
        id: `${userId}-message`, sessionId, providerMessageId: userId, role: 'user', createdAt: context.at(0), completedAt: context.at(0),
        parts: outgoingMessageParts(context.content, attachments),
        status: 'completed', nativeMetadata: {},
      }, {
        id: `${reasoningId}-message`, sessionId, providerMessageId: reasoningId, role: 'assistant', createdAt: context.at(80), completedAt: context.at(240),
        parts: [{ type: 'reasoning', text: 'Checking the newly received MP3 bytes.', redacted: false }], status: 'completed', nativeMetadata: { phase: 'commentary' },
      }, {
        id: `${answerId}-message`, sessionId, providerMessageId: answerId, role: 'assistant', createdAt: context.at(300), completedAt: context.at(520),
        parts: [{ type: 'text', text: answer }], status: 'completed', nativeMetadata: { phase: 'final_answer' },
      }],
      steps: [
        { at: 0, events: [context.event('message.started', { role: 'user', messageId: userId, text: '' })] },
        { at: 80, events: [context.event('message.delta', { messageId: reasoningId, partType: 'reasoning', delta: 'Checking the newly received MP3 bytes.' })] },
        { at: 240, events: [context.event('message.completed', { messageId: reasoningId, partType: 'reasoning', text: 'Checking the newly received MP3 bytes.' })] },
        { at: 300, events: [context.event('message.delta', { messageId: answerId, phase: 'final_answer', delta: answer })] },
        { at: 520, events: [context.event('message.completed', { messageId: answerId, phase: 'final_answer', text: answer })] },
      ],
    };
  }

  function startPlay(sessionId, content, attachments = [], selection = {}) {
    const session = sessionById(sessionId);
    if (!session) throw new Error('That fake model task does not exist.');
    if (playing) return { alreadyPlaying: true };
    modelTurnCount += 1;
    const runId = `run-${++runCounter}`;
    const playStartedAtIso = clock.nowIso();
    const context = {
      sessionId,
      content,
      runId,
      playStartedAtIso,
      at: (offsetMs) => new Date(Date.parse(playStartedAtIso) + offsetMs).toISOString(),
      event: (type, payload) => ({ type, payload }),
    };
    const plan = attachments.length ? audioPlan(sessionId, context, attachments) : buildScenario(content, context);
    const execution = beginExecution(session, runId, plan.id, selection, playStartedAtIso);
    plan.history = plan.history.map((message) => ({
      ...message,
      nativeMetadata: {
        ...(message.nativeMetadata ?? {}),
        fakeExecution: clone(execution.proof),
      },
    }));
    setSessionState(sessionId, 'working', playStartedAtIso);
    emit([nextEvent(sessionId, runId, 'session.updated', { state: 'working' }, playStartedAtIso)]);
    // The whole turn is visible to history from the start, streaming until each
    // part settles - exactly like a real provider, so a mid-stream reload never
    // loses the in-flight rows.
    const planIds = new Set(plan.history.map((message) => message.providerMessageId));
    const retained = (messagesBySession.get(sessionId) ?? []).filter((message) => !planIds.has(message.providerMessageId));
    const initialHistory = plan.deferFinalHistory
      ? plan.history.filter((message) => message.nativeMetadata?.phase !== 'final_answer')
      : plan.history;
    messagesBySession.set(sessionId, [
      ...retained,
      ...initialHistory.map(streamingHistoryMessage),
    ]);
    const scheduled = playSteps(sessionId, runId, plan.steps, playStartedAtIso);
    playing = {
      runId,
      sessionId,
      content,
      plan,
      playStartedAtIso,
      handles: scheduled.handles,
      lastOffset: scheduled.lastOffset,
      gate: plan.gate ? { ...plan.gate, resumed: false } : null,
      finalizeScheduled: false,
      executionProof: execution.proof,
      emittedMessageIds: new Set(),
      completedMessageIds: new Set(),
      finalizeHandle: null,
    };
    // A gated plan only finalizes once the gate resolves; an unanswered
    // approval keeps the session in needs_approval instead of pretending the
    // turn completed.
    if (!plan.gate) {
      playing.finalizeHandle = clock.schedule(
        () => plan.deferFinalHistory ? terminalizeDeferredPlan() : finalizePlan(),
        scheduled.lastOffset + 80,
      );
    }
    return { accepted: true, runId, execution: clone(execution.proof) };
  }

  function stopPlay(interrupted) {
    const active = playing;
    if (!active) return;
    playing = null;
    active.handles.forEach((handle) => clock.cancel(handle));
    if (active.finalizeHandle !== null) clock.cancel(active.finalizeHandle);
    const atIso = clock.nowIso();
    if (interrupted) {
      emit([nextEvent(active.sessionId, active.runId, 'agent.interrupted', { reason: 'user' }, atIso)]);
      finalizePlanAt(active, 'idle', atIso, true);
    } else {
      finalizePlanAt(active, active.plan.endState, atIso);
    }
  }

  function finalizePlanAt(active, endState, atIso, interrupted = false) {
    const { plan, sessionId } = active;
    const planIds = new Set(plan.history.map((message) => message.providerMessageId));
    const existing = messagesBySession.get(sessionId) ?? [];
    const retained = existing.filter((message) => !planIds.has(message.providerMessageId));
    if (interrupted) {
      const partial = existing
        .filter((message) => planIds.has(message.providerMessageId) && active.emittedMessageIds.has(message.providerMessageId))
        .map((message) => {
          const complete = active.completedMessageIds.has(message.providerMessageId) || message.status === 'completed';
          return {
            ...message,
            status: complete ? 'completed' : 'failed',
            completedAt: atIso,
            nativeMetadata: {
              ...(message.nativeMetadata ?? {}),
              fakeExecution: {
                ...(message.nativeMetadata?.fakeExecution ?? active.executionProof),
                status: 'interrupted',
                interruptedAt: atIso,
              },
            },
          };
        });
      messagesBySession.set(sessionId, [...retained, ...partial]);
    } else {
      messagesBySession.set(sessionId, [...retained, ...plan.history]);
    }
    updateExecution(active.runId, interrupted ? 'interrupted' : endState === 'failed' ? 'failed' : 'completed', atIso);
    setSessionState(sessionId, endState, atIso);
    emit([nextEvent(sessionId, active.runId, 'session.updated', { state: endState }, atIso)]);
  }

  function response(type, payload, requestId, ok, errorMessage, errorOptions = {}) {
    return {
      protocolVersion: 1,
      messageId: `fake-response-${++sendCounter}`,
      hostId: FAKE_HOST_ID,
      sentAt: clock.nowIso(),
      kind: 'response',
      type,
      requestId: requestId ?? `fake-request-${sendCounter}`,
      ok,
      payload: clone(payload),
      ...(ok ? {} : {
        error: {
          code: 'fake-model',
          message: errorMessage,
          retryable: errorOptions.retryable === true,
          ...(errorOptions.details && typeof errorOptions.details === 'object' ? { details: clone(errorOptions.details) } : {}),
        },
      }),
    };
  }

  function handleRequest(type, payload = {}, requestId) {
    const requestKey = typeof requestId === 'string' && requestId.length > 0 ? requestId : null;
    if (requestKey !== null && requestLedger.has(requestKey)) return clone(requestLedger.get(requestKey));
    payload = injectGoalGuidance(type, payload);
    requests.push({ type, payload: JSON.parse(JSON.stringify(payload)), requestId: requestId ?? null });
    const injectedFailure = oneShotFailures.get(type);
    if (injectedFailure !== undefined) {
      oneShotFailures.delete(type);
      const failure = typeof injectedFailure === 'string' ? { message: injectedFailure } : injectedFailure;
      const result = response(type, {}, requestId, false, failure.message, failure);
      if (requestKey !== null) requestLedger.set(requestKey, clone(result));
      return result;
    }
    const result = (() => {
      switch (type) {
      case 'provider.list':
        return response(type, {
          providers: fakeProviderCatalogue.map(([providerId, displayName]) => fakeProvider(providerId, displayName, providerStatusOverrides.get(providerId))),
        }, requestId, true);
      case 'provider.reconnect':
        if (typeof payload.providerId === 'string') providerStatusOverrides.delete(payload.providerId);
        return response(type, { reconnected: true }, requestId, true);
      case 'models.list':
        return response(type, {
          models: modelsFor(typeof payload.providerId === 'string' ? payload.providerId : FAKE_PROVIDER_ID),
        }, requestId, true);
      case 'session.goal.get':
        return response(type, { goal: goalForSession(payload.sessionId) }, requestId, true);
      case 'session.goal.set': {
        const result = setGoal(payload.sessionId, payload);
        return result.ok
          ? response(type, { goal: result.goal }, requestId, true)
          : response(type, {}, requestId, false, result.message);
      }
      case 'session.goal.clear': {
        const result = clearGoal(payload.sessionId);
        return result.ok
          ? response(type, { cleared: result.cleared, revision: result.revision }, requestId, true)
          : response(type, {}, requestId, false, result.message);
      }
      case 'sessions.refresh':
      case 'sessions.list':
        return response(type, { sessions: sessions.map((session) => ({ ...session })) }, requestId, true);
      case 'scheduled_task.list': {
        const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : null;
        const tasks = sessionId === null
          ? scheduledTasks
          : scheduledTasks.filter((task) => task.targetSessionId === sessionId);
        return response(type, { tasks: clone(tasks) }, requestId, true);
      }
      case 'scheduled_task.create': {
        const content = typeof payload.content === 'string' ? payload.content.trim() : '';
        const providerId = typeof payload.providerId === 'string' && payload.providerId ? payload.providerId : FAKE_PROVIDER_ID;
        const workingDirectory = typeof payload.workingDirectory === 'string' ? payload.workingDirectory.trim() : '';
        const runAt = typeof payload.runAt === 'string' ? payload.runAt : '';
        if (!content || !workingDirectory || !Number.isFinite(Date.parse(runAt))) {
          return response(type, {}, requestId, false, 'The fake scheduled task needs content, a project folder, and a valid run time.');
        }
        const ordinal = ++sendCounter;
        const scheduledTaskId = typeof requestId === 'string' && requestId.length > 0
          ? requestId
          : `fake-scheduled-task-${ordinal}`;
        const sessionId = `scheduled-task:${scheduledTaskId}`;
        const createdAt = clock.nowIso();
        const title = typeof payload.title === 'string' && payload.title.trim()
          ? payload.title.trim().slice(0, 96)
          : content.split(/\r?\n/u)[0]?.slice(0, 96) || 'Scheduled fake task';
        const task = {
          kind: 'new_task',
          requestId: scheduledTaskId,
          targetSessionId: sessionId,
          providerId,
          ...(typeof payload.modelId === 'string' && payload.modelId ? { modelId: payload.modelId } : {}),
          ...(typeof payload.reasoningEffort === 'string' && payload.reasoningEffort ? { reasoningEffort: payload.reasoningEffort } : {}),
          workingDirectory,
          title,
          content,
          runAt: new Date(Date.parse(runAt)).toISOString(),
          createdAt,
          status: 'pending',
        };
        scheduledTasks.push(task);
        emit([nextEvent(sessionId, `schedule-${scheduledTaskId}`, 'scheduled_task.created', { change: 'created', task: clone(task) }, createdAt)]);
        return response(type, { task }, requestId, true);
      }
      case 'scheduled_task.cancel': {
        const index = scheduledTasks.findIndex((task) => task.requestId === payload.scheduledTaskId);
        if (index < 0) return response(type, {}, requestId, false, 'That fake scheduled task does not exist.');
        const task = scheduledTasks[index];
        if (task.status !== 'pending' && task.status !== 'failed') {
          return response(type, {}, requestId, false, 'Only a pending or failed fake scheduled task can be cancelled.');
        }
        scheduledTasks.splice(index, 1);
        emit([nextEvent(task.targetSessionId, `schedule-${task.requestId}`, 'scheduled_task.updated', { change: 'cancelled', task: clone(task) }, clock.nowIso())]);
        return response(type, { task }, requestId, true);
      }
      case 'scheduled_task.run_now': {
        const task = scheduledTaskById(payload.scheduledTaskId);
        if (!task) return response(type, {}, requestId, false, 'That fake scheduled task does not exist.');
        if (task.status !== 'pending') return response(type, {}, requestId, false, 'Only a pending fake scheduled task can run now.');
        const updated = setScheduledTaskStatusForTests(task.requestId, 'dispatching', { runAt: clock.nowIso() });
        return response(type, { task: updated }, requestId, true);
      }
      case 'scheduled_task.retry': {
        const task = scheduledTaskById(payload.scheduledTaskId);
        if (!task) return response(type, {}, requestId, false, 'That fake scheduled task does not exist.');
        if (task.status !== 'failed') return response(type, {}, requestId, false, 'Only a failed fake scheduled task can be retried.');
        const updated = setScheduledTaskStatusForTests(task.requestId, 'pending', {
          runAt: typeof payload.runAt === 'string' && Number.isFinite(Date.parse(payload.runAt))
            ? new Date(Date.parse(payload.runAt)).toISOString()
            : clock.nowIso(),
        });
        return response(type, { task: updated }, requestId, true);
      }
      case 'session.open': {
        const sessionId = payload.sessionId;
        const limit = typeof payload.limit === 'number' ? payload.limit : 40;
        let messages = messagesBySession.get(sessionId) ?? [];
        const replay = historyReplayBySession.get(sessionId);
        if (replay && replay.remaining > 0) {
          const pass = 3 - replay.remaining;
          replay.remaining -= 1;
          if (replay.remaining === 0) historyReplayBySession.delete(sessionId);
          const answer = [...messages].reverse().find((message) => message.nativeMetadata?.phase === 'final_answer');
          if (pass === 0) messages = [...messages].reverse();
          else if (answer) messages = [...messages, answer];
        }
        const cursor = typeof payload.cursor === 'string' ? Number.parseInt(payload.cursor, 10) : messages.length;
        const end = Number.isFinite(cursor) ? Math.max(0, Math.min(messages.length, cursor)) : messages.length;
        const start = Math.max(0, end - limit);
        return response(type, {
          messages: messages.slice(start, end).map((message) => ({ ...message })),
          nextCursor: start > 0 ? String(start) : null,
        }, requestId, true);
      }
      case 'session.watch':
      case 'session.unwatch':
        return response(type, { watched: true }, requestId, true);
      case 'session.send_message':
      case 'session.steer_message': {
        const sessionId = payload.sessionId;
        const content = typeof payload.content === 'string' ? payload.content : '';
        const resolved = resolveAttachmentIds(payload.attachmentIds);
        const attachments = resolved?.attachments ?? [];
        if (!resolved) return response(type, {}, requestId, false, 'One fake attachment is missing.');
        if (!sessionId || (!content.trim() && attachments.length === 0)) return response(type, {}, requestId, false, 'The fake model needs a task or an attachment.');
        const session = sessionById(sessionId);
        if (!session) return response(type, {}, requestId, false, 'That fake model task does not exist.');
        const selection = {
          modelId: payload.modelId,
          reasoningEffort: payload.reasoningEffort,
        };
        const routeError = attachmentRouteError(session, selection, attachments);
        if (routeError) return response(type, {}, requestId, false, routeError);
        let started;
        if (type === 'session.steer_message' && playing) {
          if (playing.sessionId !== sessionId) return response(type, {}, requestId, false, 'The fake model is steering a different active task.');
          started = steerTurn(sessionId, content, attachments, selection);
        } else if (type === 'session.steer_message') {
          started = startPlay(sessionId, content, attachments, selection);
        } else {
          started = startPlay(sessionId, content, attachments, selection);
        }
        if (started?.alreadyPlaying) return response(type, {}, requestId, false, 'The fake model already has an active turn.');
        return response(type, {
          accepted: started?.accepted === true,
          ...(started?.runId ? { runId: started.runId } : {}),
          ...(started?.execution ? { execution: started.execution } : {}),
        }, requestId, true);
      }
      case 'session.interrupt': {
        if (playing && (payload.sessionId === undefined || payload.sessionId === playing.sessionId)) {
          stopPlay(true);
          return response(type, { interrupted: true }, requestId, true);
        }
        return response(type, { interrupted: false }, requestId, true);
      }
      case 'session.create': {
        const content = typeof payload.firstInstruction === 'string' ? payload.firstInstruction : 'New fake task';
        const id = `fake-created-${++sendCounter}`;
        const title = typeof payload.title === 'string' && payload.title.trim()
          ? payload.title.trim().slice(0, 96)
          : content.trim().split(/\r?\n/u)[0]?.slice(0, 72) || 'New fake task';
        const workingDirectory = typeof payload.workingDirectory === 'string' && payload.workingDirectory
          ? payload.workingDirectory
          : 'C:\\FakeModel\\new';
        const session = {
          ...sessionBase(id, `${id}-native`, title, workingDirectory, clock.nowIso()),
          providerId: typeof payload.providerId === 'string' && payload.providerId ? payload.providerId : FAKE_PROVIDER_ID,
          modelId: typeof payload.modelId === 'string' && payload.modelId ? payload.modelId : FAKE_MODEL_ID,
          reasoningEffort: typeof payload.reasoningEffort === 'string' ? payload.reasoningEffort : 'medium',
          preview: typeof payload.firstInstruction === 'string' ? payload.firstInstruction.slice(0, 160) : '',
        };
        sessions.unshift(session);
        messagesBySession.set(id, []);
        emit([nextEvent(id, 'create', 'session.created', { sessionId: id }, clock.nowIso())]);
        if (typeof payload.firstInstruction === 'string' && payload.firstInstruction.trim()) {
          const started = startPlay(id, payload.firstInstruction, [], {
            modelId: session.modelId,
            reasoningEffort: session.reasoningEffort,
          });
          if (started?.alreadyPlaying) return response(type, {}, requestId, false, 'The fake model already has an active turn.');
          session.preview = payload.firstInstruction.slice(0, 160);
        }
        return response(type, { session }, requestId, true);
      }
      case 'approval.list':
        return response(type, { approvals: approvals.map((approval) => ({ ...approval })) }, requestId, true);
      case 'approval.respond': {
        const requestIdValue = payload.requestId;
        const index = approvals.findIndex((approval) => approval.requestId === requestIdValue);
        if (index < 0) return response(type, {}, requestId, false, 'That fake model approval is not awaiting a decision.');
        const [approval] = approvals.splice(index, 1);
        const atIso = clock.nowIso();
        latestSequence += 1;
        emit([{
          eventId: `fake-approval-resolved-${latestSequence}`,
          sequence: latestSequence,
          type: 'approval.resolved',
          hostId: FAKE_HOST_ID,
          providerId: approval.providerId,
          sessionId: approval.sessionId,
          occurredAt: atIso,
          payload: { requestId: requestIdValue },
        }]);
        const active = playing;
        if (active && active.gate && !active.gate.resumed && active.gate.requestId === requestIdValue) {
          active.gate.resumed = true;
          const afterPlay = playSteps(active.sessionId, active.runId, active.gate.after, clock.nowIso());
          active.handles.push(...afterPlay.handles);
          active.lastOffset = Date.parse(clock.nowIso()) - Date.parse(active.playStartedAtIso) + afterPlay.lastOffset;
          active.finalizeHandle = clock.schedule(() => finalizePlan(), afterPlay.lastOffset + 80);
        }
        return response(type, { resolved: true }, requestId, true);
      }
      case 'user_input.list':
        return response(type, { requests: [] }, requestId, true);
      case 'user_input.respond':
        return response(type, { resolved: true }, requestId, true);
      case 'message_queue.enqueue': {
        const sessionId = payload.sessionId;
        const content = typeof payload.content === 'string' ? payload.content : '';
        const resolved = resolveAttachmentIds(payload.attachmentIds);
        if (!resolved) return response(type, {}, requestId, false, 'One fake attachment is missing.');
        if (!sessionId || (!content.trim() && resolved.attachments.length === 0)) {
          return response(type, {}, requestId, false, 'The fake model needs a queued task or an attachment.');
        }
        const message = {
          id: `fake-queued-${++sendCounter}`,
          sessionId,
          content,
          mode: 'queue',
          state: 'queued',
          createdAt: clock.nowIso(),
          attachments: resolved.attachments.map(queuedAttachmentMetadata),
          ...(nonEmptyString(payload.modelId) ? { modelId: payload.modelId } : {}),
          ...(nonEmptyString(payload.reasoningEffort) ? { reasoningEffort: payload.reasoningEffort } : {}),
        };
        queueAttachmentIds.set(message.id, [...resolved.ids]);
        queue = [...queue, message];
        latestSequence += 1;
        emit([{
          eventId: `fake-queued-event-${latestSequence}`,
          sequence: latestSequence,
          type: 'message.queued',
          hostId: FAKE_HOST_ID,
          providerId: providerIdForSession(sessionId),
          sessionId,
          occurredAt: clock.nowIso(),
          payload: { message: clone(message), messageId: message.id, content },
        }]);
        return response(type, { message: clone(message) }, requestId, true);
      }
      case 'message_queue.list':
        return response(type, { messages: clone(queue) }, requestId, true);
      case 'message_queue.edit': {
        const message = queue.find((candidate) => candidate.id === payload.messageId);
        if (!message) return response(type, {}, requestId, false, 'That queued fake instruction is unavailable.');
        if (typeof payload.content === 'string') message.content = payload.content;
        if (payload.attachmentIds !== undefined) {
          const resolved = resolveAttachmentIds(payload.attachmentIds);
          if (!resolved) return response(type, {}, requestId, false, 'One fake attachment is missing.');
          if (!message.content.trim() && resolved.attachments.length === 0) {
            return response(type, {}, requestId, false, 'The fake model needs a queued task or an attachment.');
          }
          queueAttachmentIds.set(message.id, [...resolved.ids]);
          message.attachments = resolved.attachments.map(queuedAttachmentMetadata);
        }
        latestSequence += 1;
        emit([{
          eventId: `fake-queue-updated-${latestSequence}`,
          sequence: latestSequence,
          type: 'message.queue_updated',
          hostId: FAKE_HOST_ID,
          providerId: providerIdForSession(message.sessionId),
          sessionId: message.sessionId,
          occurredAt: clock.nowIso(),
          payload: { message: clone(message) },
        }]);
        return response(type, { message: clone(message) }, requestId, true);
      }
      case 'message_queue.cancel': {
        const index = queue.findIndex((candidate) => candidate.id === payload.messageId);
        if (index < 0) return response(type, { cancelled: false }, requestId, true);
        const [message] = queue.splice(index, 1);
        queueAttachmentIds.delete(message.id);
        latestSequence += 1;
        emit([{
          eventId: `fake-queue-removed-${latestSequence}`,
          sequence: latestSequence,
          type: 'message.queue_removed',
          hostId: FAKE_HOST_ID,
          providerId: providerIdForSession(message.sessionId),
          sessionId: message.sessionId,
          occurredAt: clock.nowIso(),
          payload: { messageId: message.id },
        }]);
        return response(type, { cancelled: true }, requestId, true);
      }
      case 'message_queue.deliver': {
        const index = queue.findIndex((candidate) => candidate.id === payload.messageId);
        if (index < 0) return response(type, {}, requestId, false, 'That queued fake instruction is unavailable.');
        const message = queue[index];
        const attachments = attachmentsForQueuedMessage(message);
        const selection = { modelId: message.modelId, reasoningEffort: message.reasoningEffort };
        const session = sessionById(message.sessionId);
        if (!session) return response(type, {}, requestId, false, 'That queued fake task does not exist.');
        const routeError = attachmentRouteError(session, selection, attachments);
        if (routeError) return response(type, {}, requestId, false, routeError);
        let started;
        if (payload.mode === 'steer') {
          if (!playing || playing.sessionId !== message.sessionId) {
            return response(type, {}, requestId, false, 'Steering requires the queued task to have an active fake turn.');
          }
          started = steerTurn(message.sessionId, message.content, attachments, selection);
        } else if (payload.mode === 'send') {
          started = startPlay(message.sessionId, message.content, attachments, selection);
        } else {
          return response(type, {}, requestId, false, 'The fake queue delivery mode must be send or steer.');
        }
        if (started?.alreadyPlaying) return response(type, {}, requestId, false, 'The fake model already has an active turn.');
        queue.splice(index, 1);
        latestSequence += 1;
        emit([{
          eventId: `fake-queue-removed-${latestSequence}`,
          sequence: latestSequence,
          type: 'message.queue_removed',
          hostId: FAKE_HOST_ID,
          providerId: providerIdForSession(message.sessionId),
          sessionId: message.sessionId,
          occurredAt: clock.nowIso(),
          payload: { messageId: message.id },
        }]);
        queueAttachmentIds.delete(message.id);
        return response(type, { delivered: true, ...(started?.runId ? { runId: started.runId } : {}) }, requestId, true);
      }
      case 'message_queue.move_to_new_task': {
        const index = queue.findIndex((candidate) => candidate.id === payload.messageId);
        if (index < 0) return response(type, {}, requestId, false, 'That queued fake instruction is unavailable.');
        const message = queue[index];
        const content = message.content;
        const attachments = attachmentsForQueuedMessage(message);
        const id = `fake-queued-task-${++sendCounter}`;
        const providerId = typeof payload.providerId === 'string' && payload.providerId ? payload.providerId : FAKE_PROVIDER_ID;
        const modelId = typeof payload.modelId === 'string' && payload.modelId ? payload.modelId : message.modelId ?? FAKE_MODEL_ID;
        const reasoningEffort = typeof payload.reasoningEffort === 'string' && payload.reasoningEffort ? payload.reasoningEffort : message.reasoningEffort;
        const session = {
          ...sessionBase(id, `${id}-native`, content.slice(0, 72) || 'Queued fake task', 'C:\\FakeModel\\queued', clock.nowIso()),
          providerId,
          modelId,
          ...(reasoningEffort ? { reasoningEffort } : {}),
          preview: content,
          state: 'working',
        };
        sessions.unshift(session);
        messagesBySession.set(id, []);
        queue.splice(index, 1);
        queueAttachmentIds.delete(message.id);
        latestSequence += 1;
        emit([{
          eventId: `fake-queue-removed-${latestSequence}`,
          sequence: latestSequence,
          type: 'message.queue_removed',
          hostId: FAKE_HOST_ID,
          providerId: providerIdForSession(message.sessionId),
          sessionId: message.sessionId,
          occurredAt: clock.nowIso(),
          payload: { messageId: message.id },
        }]);
        latestSequence += 1;
        emit([nextEvent(id, 'create', 'session.created', { sessionId: id }, clock.nowIso())]);
        const delivery = { id: `fake-queued-delivery-${sendCounter}`, sessionId: id, state: 'pending' };
        queuedNewTaskDeliveries.set(delivery.id, {
          delivery,
          content,
          attachments,
          selection: { modelId, reasoningEffort },
        });
        return response(type, { session, delivery }, requestId, true);
      }
      case 'message_queue.deliver_new_task': {
        const record = queuedNewTaskDeliveries.get(payload.deliveryId);
        if (!record) return response(type, {}, requestId, false, 'That queued fake delivery is unavailable.');
        if (record.delivery.state === 'sent') return response(type, { delivery: record.delivery }, requestId, true);
        const started = startPlay(record.delivery.sessionId, record.content, record.attachments, record.selection);
        if (started?.alreadyPlaying) {
          record.delivery = { ...record.delivery, state: 'failed', error: 'The fake model already has an active turn.' };
        } else {
          record.delivery = { id: record.delivery.id, sessionId: record.delivery.sessionId, state: 'sent' };
        }
        return response(type, { delivery: record.delivery }, requestId, true);
      }
      case 'session.children':
        return response(type, { sessions: sessions.filter((session) => session.relationship?.kind === 'subagent' && session.relationship.sourceSessionId === payload.sessionId) }, requestId, true);
      case 'session.side_chats':
      case 'side_chat.list':
        return response(type, {
          sessions: sessions.filter((session) => session.sessionKind === 'side_chat'
            && (typeof payload.parentSessionId !== 'string' || session.parentSessionId === payload.parentSessionId)),
        }, requestId, true);
      case 'side_chat.create': {
        const parentSessionId = payload.parentSessionId;
        const parent = sessionById(parentSessionId);
        if (!parent) return response(type, {}, requestId, false, 'That fake model task is unavailable.');
        const queuedIndex = typeof payload.queuedMessageId === 'string'
          ? queue.findIndex((candidate) => candidate.id === payload.queuedMessageId && candidate.sessionId === parentSessionId)
          : -1;
        if (typeof payload.queuedMessageId === 'string' && queuedIndex < 0) {
          return response(type, {}, requestId, false, 'That queued fake instruction is unavailable.');
        }
        const queuedMessage = queuedIndex >= 0 ? queue[queuedIndex] : undefined;
        const initialContent = queuedMessage?.content ?? (typeof payload.prompt === 'string' ? payload.prompt : '');
        const queuedAttachments = queuedMessage ? attachmentsForQueuedMessage(queuedMessage) : [];
        const id = `fake-side-chat-${++sendCounter}`;
        const session = {
          ...sessionBase(id, `${id}-native`, `Side chat: ${parent.title}`, parent.workingDirectory, clock.nowIso()),
          providerId: parent.providerId,
          modelId: parent.modelId,
          ...(queuedMessage?.modelId ? { modelId: queuedMessage.modelId } : {}),
          ...(queuedMessage?.reasoningEffort ? { reasoningEffort: queuedMessage.reasoningEffort } : {}),
          sessionKind: 'side_chat',
          parentSessionId,
          preview: initialContent || `Side chat: ${parent.title}`,
        };
        sessions.unshift(session);
        messagesBySession.set(id, []);
        if (queuedMessage) {
          queue.splice(queuedIndex, 1);
          queueAttachmentIds.delete(queuedMessage.id);
          latestSequence += 1;
          emit([{
            eventId: `fake-queue-removed-${latestSequence}`,
            sequence: latestSequence,
            type: 'message.queue_removed',
            hostId: FAKE_HOST_ID,
            providerId: providerIdForSession(parentSessionId),
            sessionId: parentSessionId,
            occurredAt: clock.nowIso(),
            payload: { messageId: queuedMessage.id },
          }]);
        }
        emit([nextEvent(id, 'side-chat-create', 'side_chat.created', { session: clone(session), sourceSessionId: parentSessionId }, clock.nowIso())]);
        if (initialContent.trim() || queuedAttachments.length) {
          const routeError = attachmentRouteError(session, { modelId: session.modelId, reasoningEffort: session.reasoningEffort }, queuedAttachments);
          if (routeError) return response(type, {}, requestId, false, routeError);
          const started = startPlay(id, initialContent, queuedAttachments, { modelId: session.modelId, reasoningEffort: session.reasoningEffort });
          if (started?.alreadyPlaying) return response(type, {}, requestId, false, 'The fake model already has an active turn.');
          session.preview = initialContent;
        }
        return response(type, { session }, requestId, true);
      }
      case 'side_chat.promote': {
        const source = sessions[0];
        if (!source) return response(type, {}, requestId, false, 'That fake model side chat is unavailable.');
        const id = `fake-promoted-${++sendCounter}`;
        const session = { ...sessionBase(id, `${id}-native`, 'Promoted fake side chat', source.workingDirectory, clock.nowIso()), sessionKind: 'task' };
        sessions.unshift(session);
        messagesBySession.set(id, []);
        return response(type, { session }, requestId, true);
      }
      case 'session.context.set_threshold': {
        const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : 'fake-main';
        const requested = Number(payload.thresholdTokens);
        const thresholdTokens = Number.isFinite(requested) ? Math.max(8_000, Math.min(128_000, Math.round(requested))) : 96_000;
        contextThresholds.set(sessionId, thresholdTokens);
        return response(type, { context: contextState(sessionId) }, requestId, true);
      }
      case 'session.context.get': {
        const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : 'fake-main';
        return response(type, { context: contextState(sessionId) }, requestId, true);
      }
      case 'session.image.get':
        return response(type, {}, requestId, false, 'The fake model history uses inline images only.');
      case 'session.branch':
      case 'session.context_handoff':
        return response(type, { sessions: [] }, requestId, true);
      case 'vision.targets':
        return response(type, {
          targets: fakeProviderCatalogue.flatMap(([providerId, displayName]) => {
            const models = modelsFor(providerId).filter((model) => model.inputModalities.includes('image'));
            return models.length ? [{ providerId, displayName, models }] : [];
          }),
          incomplete: false,
        }, requestId, true);
      case 'session.vision.get': {
        const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
        return response(type, { vision: { sessionId, primaryModelSupportsImageInput: false, configured: configuredVisionBySession.get(sessionId) ?? null } }, requestId, true);
      }
      case 'session.vision.configure': {
        const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
        if (payload.selection === null || payload.selection === undefined) configuredVisionBySession.delete(sessionId);
        else {
          const configured = validRouteSelection(payload.selection, 'image');
          if (!configured) return response(type, {}, requestId, false, 'That fake Eyes model, modality, or reasoning effort is unavailable.');
          configuredVisionBySession.set(sessionId, configured);
        }
        return response(type, { vision: { sessionId, primaryModelSupportsImageInput: false, configured: configuredVisionBySession.get(sessionId) ?? null } }, requestId, true);
      }
      case 'session.vision.ask':
        return response(type, { observation: 'Deterministic fake vision observation.' }, requestId, true);
      case 'wallet.get':
      case 'wallet.configure':
        return response(type, { wallet: { providerId: FAKE_PROVIDER_ID, kind: 'subscription', label: 'Fake model subscription', detail: 'Test-only deterministic model usage.', currency: 'USD', apiKeyConfigured: false } }, requestId, true);
      case 'dictation.source.list':
      case 'dictation.source.configure':
        return response(type, { sources: clone(dictationSources) }, requestId, true);
      case 'delegation.list':
        return response(type, { delegations: delegations.map((item) => ({ ...item })) }, requestId, true);
      case 'delegation.prepare': {
        const targets = Array.isArray(payload.targets) ? payload.targets : [];
        if (targets.length === 0 || targets.length > 4) return response(type, {}, requestId, false, 'A fake mesh needs one to four targets.');
        const parent = sessionById(payload.parentSessionId);
        const providerIds = new Set();
        const validatedTargets = [];
        for (const target of targets) {
          const providerId = typeof target?.providerId === 'string' ? target.providerId : '';
          const route = validRouteSelection(target, 'text');
          if (!route || providerId === parent?.providerId || providerIds.has(providerId)) {
            return response(type, {}, requestId, false, 'That fake mesh target is duplicated, belongs to the parent harness, or has an invalid model or reasoning effort.');
          }
          providerIds.add(providerId);
          validatedTargets.push(route);
        }
        const task = {
          id: typeof requestId === 'string' && requestId ? requestId : `fake-prepared-delegation-${delegations.length + 1}`,
          parentSessionId: payload.parentSessionId,
          prompt: typeof payload.prompt === 'string' ? payload.prompt : '',
          state: 'awaiting_dispatch',
          createdAt: clock.nowIso(),
          updatedAt: clock.nowIso(),
          children: [],
          orchestration: 'parent',
          targets: validatedTargets,
          presentationSegments: Array.isArray(payload.presentationSegments) ? clone(payload.presentationSegments) : [],
          ...(typeof payload.modelId === 'string' && payload.modelId ? { parentModelId: payload.modelId } : {}),
          ...(typeof payload.reasoningEffort === 'string' && payload.reasoningEffort ? { parentReasoningEffort: payload.reasoningEffort } : {}),
        };
        delegations.push(task);
        return response(type, { delegation: task, delivery: { accepted: true, details: ['The fake parent Mesh turn was accepted.'] } }, requestId, true);
      }
      case 'delegation.start': {
        const targets = Array.isArray(payload.targets) ? payload.targets : [];
        if (targets.length === 0 || targets.length > 4) return response(type, {}, requestId, false, 'A fake mesh needs one to four targets.');
        const parent = sessionById(payload.parentSessionId);
        const providerIds = new Set();
        const validatedTargets = [];
        for (const target of targets) {
          const providerId = typeof target?.providerId === 'string' ? target.providerId : '';
          const route = validRouteSelection(target, 'text');
          if (!route || providerId === parent?.providerId || providerIds.has(providerId)) {
            return response(type, {}, requestId, false, 'That fake mesh target is duplicated, belongs to the parent harness, or has an invalid model or reasoning effort.');
          }
          providerIds.add(providerId);
          validatedTargets.push(route);
        }
        const task = {
          id: `fake-delegation-${delegations.length + 1}`,
          parentSessionId: payload.parentSessionId,
          prompt: payload.prompt,
          state: 'working',
          createdAt: clock.nowIso(),
          updatedAt: clock.nowIso(),
          children: validatedTargets.map((target, index) => ({
            id: `fake-delegation-child-${index + 1}`,
            providerId: target.providerId,
            modelId: target.modelId,
            reasoningEffort: target.reasoningEffort,
            sessionId: `fake-delegated-session-${index + 1}`,
            state: 'working',
          })),
        };
        delegations.push(task);
        return response(type, { delegation: task }, requestId, true);
      }
      case 'sync.since':
        return response(type, { events: [], throughSequence: latestSequence, replayGap: false }, requestId, true);
      case 'ears.process': {
        const route = validRouteSelection(payload, 'audio');
        if (!route || route.providerId === 'grok') return response(type, {}, requestId, false, 'That fake EARS route cannot transport native audio.');
        const attachmentIds = Array.isArray(payload.attachmentIds) ? payload.attachmentIds.filter((id) => typeof id === 'string') : [];
        if (attachmentIds.length === 0) return response(type, {}, requestId, false, 'EARS needs at least one fake dictation recording.');
        const attachments = attachmentIds.map((id) => completedUploads.get(id));
        if (attachments.some((attachment) => !attachment)) return response(type, {}, requestId, false, 'One fake EARS attachment is missing.');
        if (attachments.some((attachment) => attachment.mimeType !== 'audio/mpeg')) return response(type, {}, requestId, false, 'EARS only accepts fake MP3 recordings.');
        return response(type, {
          texts: attachments.map((attachment, index) => `Deterministic EARS transcript ${index + 1}: ${attachment.name}.`),
        }, requestId, true);
      }
      case 'ears.cancel':
        return response(type, { cancelled: false }, requestId, true);
      case 'dictation.transcribe': {
        const attachment = completedUploads.get(payload.attachmentId);
        if (!attachment) return response(type, {}, requestId, false, 'That fake dictation attachment is unavailable.');
        if (!attachment.mimeType?.startsWith('audio/')) return response(type, {}, requestId, false, 'Fake dictation only accepts audio recordings.');
        return response(type, { text: `Deterministic dictation transcript: ${attachment.name}.` }, requestId, true);
      }
      case 'attachment.upload.begin': {
        const uploadId = `fake-upload-${++sendCounter}`;
        pendingUploads.set(uploadId, {
          name: payload.name,
          mimeType: payload.mimeType,
          byteLength: payload.byteLength,
          ...(typeof payload.durationSeconds === 'number' ? { durationSeconds: payload.durationSeconds } : {}),
          chunks: [],
          offset: 0,
        });
        return response(type, { uploadId, chunkBytes: 32 * 1024 }, requestId, true);
      }
      case 'attachment.upload.chunk': {
        const upload = pendingUploads.get(payload.uploadId);
        if (!upload || payload.offset !== upload.offset || typeof payload.dataBase64 !== 'string') return response(type, {}, requestId, false, 'Invalid fake attachment chunk.');
        const bytes = Buffer.from(payload.dataBase64, 'base64');
        upload.chunks.push(bytes);
        upload.offset += bytes.length;
        return response(type, { receivedBytes: upload.offset }, requestId, true);
      }
      case 'attachment.upload.complete': {
        const upload = pendingUploads.get(payload.uploadId);
        if (!upload || upload.offset !== upload.byteLength) return response(type, {}, requestId, false, 'Incomplete fake attachment upload.');
        const attachmentId = `fake-attachment-${++sendCounter}`;
        pendingUploads.delete(payload.uploadId);
        completedUploads.set(attachmentId, {
          name: upload.name,
          mimeType: upload.mimeType,
          byteLength: upload.byteLength,
          dataBase64: Buffer.concat(upload.chunks).toString('base64'),
          ...(upload.durationSeconds !== undefined ? { durationSeconds: upload.durationSeconds } : {}),
        });
        return response(type, { attachmentId }, requestId, true);
      }
      case 'attachment.upload.cancel':
        return response(type, { discarded: pendingUploads.delete(payload.uploadId) }, requestId, true);
        default:
          return response(type, {}, requestId, false, `The fake model does not implement ${type}.`);
      }
    })();
    if (requestKey !== null) requestLedger.set(requestKey, clone(result));
    return result;
  }

  function steerTurn(sessionId, content, attachments = [], selection = {}) {
    const session = sessionById(sessionId);
    if (!session) throw new Error('That fake model task does not exist.');
    if (playing && playing.sessionId !== sessionId) throw new Error('The fake model is steering a different active task.');
    if (playing) stopPlay(true);
    const runId = `run-${++runCounter}`;
    const startedAt = clock.nowIso();
    const execution = beginExecution(session, runId, 'fake-scenario-steer', selection, startedAt);
    const userId = `${runId}-fake-steer-user`;
    const answerId = `${runId}-fake-steer-answer`;
    const answer = 'Steered: the running turn picked up the queued instruction.';
    const plan = {
      id: 'fake-scenario-steer',
      gate: null,
      endState: 'idle',
      history: [
        {
          id: `${userId}-message`,
          sessionId,
          providerMessageId: userId,
          role: 'user',
          createdAt: startedAt,
          completedAt: startedAt,
          parts: outgoingMessageParts(content, attachments),
          status: 'completed',
          nativeMetadata: { fakeExecution: clone(execution.proof) },
        },
        {
          id: `${answerId}-message`,
          sessionId,
          providerMessageId: answerId,
          role: 'assistant',
          createdAt: new Date(Date.parse(startedAt) + 160).toISOString(),
          completedAt: new Date(Date.parse(startedAt) + 420).toISOString(),
          parts: [{ type: 'text', text: answer }],
          status: 'completed',
          nativeMetadata: { phase: 'final_answer', fakeExecution: clone(execution.proof) },
        },
      ],
      steps: [
        { at: 0, events: [{ type: 'message.started', payload: { role: 'user', messageId: userId, text: content } }] },
        { at: 160, events: [{ type: 'message.delta', payload: { messageId: answerId, phase: 'final_answer', delta: answer } }] },
        { at: 420, events: [{ type: 'message.completed', payload: { messageId: answerId, phase: 'final_answer', text: answer } }] },
      ],
    };
    const planIds = new Set(plan.history.map((message) => message.providerMessageId));
    const retained = (messagesBySession.get(sessionId) ?? []).filter((message) => !planIds.has(message.providerMessageId));
    messagesBySession.set(sessionId, [...retained, ...plan.history.map(streamingHistoryMessage)]);
    setSessionState(sessionId, 'working', startedAt);
    emit([nextEvent(sessionId, runId, 'session.updated', { state: 'working' }, startedAt)]);
    const scheduled = playSteps(sessionId, runId, plan.steps, startedAt);
    playing = {
      runId,
      sessionId,
      content,
      plan,
      playStartedAtIso: startedAt,
      handles: scheduled.handles,
      lastOffset: scheduled.lastOffset,
      gate: null,
      finalizeScheduled: false,
      executionProof: execution.proof,
      emittedMessageIds: new Set(),
      completedMessageIds: new Set(),
      finalizeHandle: null,
    };
    playing.finalizeHandle = clock.schedule(() => finalizePlan(), scheduled.lastOffset + 80);
    return { accepted: true, runId, execution: clone(execution.proof) };
  }

  function normalizeProviderStatus(status) {
    if (status === null || status === undefined) return null;
    if (typeof status === 'string') {
      if (['connecting', 'online', 'degraded', 'offline', 'disconnected'].includes(status)) return { state: status };
      return { kind: 'retry', message: status };
    }
    if (!status || typeof status !== 'object') return null;
    const message = nonEmptyString(status.message);
    const retryAt = nonEmptyString(status.retryAt);
    if (message) return { kind: 'retry', message, ...(retryAt ? { retryAt } : {}) };
    if (['connecting', 'online', 'degraded', 'offline', 'disconnected'].includes(status.state)) {
      return {
        state: status.state,
        ...(typeof status.detected === 'boolean' ? { detected: status.detected } : {}),
        ...(typeof status.authenticated === 'boolean' ? { authenticated: status.authenticated } : {}),
        ...(nonEmptyString(status.lastError) ? { lastError: status.lastError } : nonEmptyString(status.errorMessage) ? { lastError: status.errorMessage } : {}),
      };
    }
    return null;
  }

  function setProviderStatusForTests(target, status) {
    let targetId = target;
    let nextStatus = status;
    if (arguments.length === 1) {
      targetId = FAKE_PROVIDER_ID;
      nextStatus = target;
    }
    if (typeof targetId !== 'string' || targetId.length === 0) return;
    const normalized = normalizeProviderStatus(nextStatus);
    const session = sessionById(targetId);
    if (session) {
      if (normalized?.kind === 'retry') session.providerStatus = clone(normalized);
      else delete session.providerStatus;
      return;
    }
    if (normalized) providerStatusOverrides.set(targetId, clone(normalized));
    else providerStatusOverrides.delete(targetId);
  }

  function bootstrap() {
    return {
      app: { name: 'Tethoq (fake model)', version: '0.0.0-test', platform: process.platform, packaged: false },
      host: {
        id: FAKE_HOST_ID,
        displayName: 'Fake model host',
        platform: 'windows',
        connectionState: 'online',
        protocolVersion: 1,
        lastSeenAt: clock.nowIso(),
        relayConnected: false,
      },
      providers: [{
        ...fakeProvider(FAKE_PROVIDER_ID, 'Fake Model', providerStatusOverrides.get(FAKE_PROVIDER_ID)),
      }, ...fakeProviderCatalogue.filter(([providerId]) => providerId !== FAKE_PROVIDER_ID).map(([providerId, displayName]) => fakeProvider(providerId, displayName, providerStatusOverrides.get(providerId)))],
      allowedProviders: fakeProviderCatalogue.map(([providerId]) => providerId),
      connectors: { directory: 'C:\\FakeModel\\connectors', loaded: [], pending: [], diagnostics: [] },
      latestSequence,
      openCode: { state: 'unavailable', url: '', managed: false, message: 'Fake model mode: no OpenCode process is started.' },
    };
  }

  return {
    bootstrap,
    handleRequest,
    addProjectGroupingFixtureForTests,
    failNextRequestForTests(type, message = `Injected fake failure for ${type}.`, options = {}) {
      oneShotFailures.set(type, {
        message,
        ...(options && typeof options === 'object' ? {
          retryable: options.retryable === true,
          ...(options.details && typeof options.details === 'object' ? { details: clone(options.details) } : {}),
        } : {}),
      });
    },
    setProviderStatusForTests,
    setScheduledTaskStatusForTests,
    emitGoalUpdateForTests(sessionId, goal) {
      const candidate = goal && typeof goal === 'object' ? clone(goal) : goalForSession(sessionId);
      if (!candidate) return false;
      emit([nextEvent(sessionId, 'goal-test', 'session.goal_updated', { goal: candidate }, clock.nowIso())]);
      return true;
    },
    emitGoalClearedForTests(sessionId, revision = goalRevision) {
      emit([nextEvent(sessionId, 'goal-test', 'session.goal_cleared', { revision }, clock.nowIso())]);
      return true;
    },
    emitDeferredLiveActivityForTests,
    releaseDeferredFinalHistoryForTests,
    dispose() {
      if (playing) {
        playing.handles.forEach((handle) => clock.cancel(handle));
        if (playing.finalizeHandle !== null) clock.cancel(playing.finalizeHandle);
        playing = null;
      }
      deferredTerminal = null;
      historyReplayBySession.clear();
      if (clock.kind === 'manual') clock.cancelAll();
    },
    stateForTests() {
      return {
        sessions: clone(sessions),
        scheduledTasks: clone(scheduledTasks),
        messagesBySession: new Map([...messagesBySession.entries()].map(([id, messages]) => [id, clone(messages)])),
        queue: clone(queue),
        approvals: clone(approvals),
        requests: requests.map((request) => JSON.parse(JSON.stringify(request))),
        configuredVisionBySession: new Map([...configuredVisionBySession.entries()].map(([id, selection]) => [id, clone(selection)])),
        delegations: clone(delegations),
        contextThresholds: new Map(contextThresholds),
        completedUploads: new Map([...completedUploads.entries()].map(([id, attachment]) => [id, clone(attachment)])),
        queueAttachmentIds: new Map([...queueAttachmentIds.entries()].map(([id, attachmentIds]) => [id, clone(attachmentIds)])),
        executionRecords: clone(executionRecords),
        providerStatusOverrides: new Map([...providerStatusOverrides.entries()].map(([id, status]) => [id, clone(status)])),
        goalsBySession: new Map([...goalsBySession.entries()].map(([id, goal]) => [id, clone(goal)])),
        goalRevision,
        modelTurnCount,
        modelTokenCount,
        latestSequence,
        playing: playing ? { runId: playing.runId, sessionId: playing.sessionId, scenarioId: playing.plan.id, gate: playing.gate ? playing.gate.kind : null } : null,
        deferredTerminal: deferredTerminal ? { runId: deferredTerminal.runId, sessionId: deferredTerminal.sessionId, scenarioId: deferredTerminal.plan.id } : null,
        historyReplayRemaining: [...historyReplayBySession.entries()].map(([sessionId, replay]) => ({ sessionId, remaining: replay.remaining })),
      };
    },
    exportStateForTests() {
      return {
        sessions: clone(sessions),
        scheduledTasks: clone(scheduledTasks),
        messagesBySession: Object.fromEntries([...messagesBySession.entries()].map(([id, messages]) => [id, clone(messages)])),
        queue: clone(queue),
        approvals: clone(approvals),
        configuredVisionBySession: Object.fromEntries([...configuredVisionBySession.entries()].map(([id, selection]) => [id, clone(selection)])),
        delegations: clone(delegations),
        contextThresholds: Object.fromEntries(contextThresholds),
        completedUploads: Object.fromEntries([...completedUploads.entries()].map(([id, attachment]) => [id, clone(attachment)])),
        queueAttachmentIds: Object.fromEntries([...queueAttachmentIds.entries()].map(([id, attachmentIds]) => [id, clone(attachmentIds)])),
        executionRecords: clone(executionRecords),
        providerStatusOverrides: Object.fromEntries([...providerStatusOverrides.entries()].map(([id, status]) => [id, clone(status)])),
        goalsBySession: Object.fromEntries([...goalsBySession.entries()].map(([id, goal]) => [id, clone(goal)])),
        goalRevision,
        modelTurnCount,
        modelTokenCount,
        latestSequence,
        runCounter,
        sendCounter,
      };
    },
  };
}

module.exports = { createFakeModelHost, FAKE_MODEL_ID };
