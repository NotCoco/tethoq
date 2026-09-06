'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  BROWSER_TOOL_NAMES,
  assertCompleteBrowserToolInventory,
  assertScheduledParentSelection,
  assertSuccessfulBrowserGetStateActivity,
  assertQueuePromotionSamples,
  assertSinglePdfPresentation,
  assertStableSideChatShape,
  browserToolNames,
  futureLocalMinuteValue,
  hasPaintedLiveState,
  matchingNewMeshChildren,
  midMessageMeshPrompt,
  sessionModelId,
  sessionReasoningEffort,
  sessionRelationshipKind,
  scheduledMeshDraftPrompt,
  visibleSimplifyPrompt,
  waitForTerminalResponse,
} = require('./opencode-edge-qa.cjs');

test('simplify QA follows the app-visible prompt after removing the command token', () => {
  assert.equal(visibleSimplifyPrompt('/simplify Reply exactly SIMPLIFY_OK.'), 'Reply exactly SIMPLIFY_OK.');
  assert.equal(visibleSimplifyPrompt('Please /simplify explain this.'), 'Please explain this.');
  assert.equal(visibleSimplifyPrompt('/simplify'), 'Simplify the previous answer.');
  assert.equal(visibleSimplifyPrompt('For /simplify.exe keep this.'), 'For /simplify.exe keep this.');
});

test('scheduled Mesh QA opens both commands while the task is still a local draft', () => {
  assert.equal(scheduledMeshDraftPrompt('Reply exactly READY. '), 'Reply exactly READY. /mesh /schedule');
});

test('genuine scheduled QA chooses a minute with the requested lead time', () => {
  const now = new Date(2026, 7, 30, 11, 22, 45, 250);
  const value = futureLocalMinuteValue(now, 90_000);
  assert.equal(value, '2026-08-30T11:25');
  const due = new Date(2026, 7, 30, 11, 25, 0, 0);
  assert.ok(due.getTime() - now.getTime() >= 90_000);
  assert.throws(() => futureLocalMinuteValue(now, 59_999), /at least one minute/u);
});

test('scheduled Mesh QA requires DeepSeek Max and exact materialized parent selection', () => {
  const scheduled = { modelId: 'opencode-go/deepseek-v4-flash-vision-exp', reasoningEffort: 'max' };
  const parent = { modelId: 'opencode-go/deepseek-v4-flash-vision-exp', reasoningEffort: 'max' };
  assert.deepEqual(assertScheduledParentSelection(scheduled, parent), {
    modelId: 'opencode-go/deepseek-v4-flash-vision-exp', reasoningEffort: 'max',
  });
  assert.throws(() => assertScheduledParentSelection(
    scheduled,
    { modelId: 'opencode-go/gpt-5.6-luna', reasoningEffort: 'default' },
  ), /materialized scheduled parent selected/u);
  assert.throws(() => assertScheduledParentSelection(
    { modelId: 'opencode-go/gpt-5.6-luna', reasoningEffort: 'max' },
  ), /durable scheduled task selected/u);
  assert.throws(() => assertScheduledParentSelection(
    { modelId: 'opencode-go/deepseek-v4-flash-vision-exp', reasoningEffort: 'default' },
  ), /durable scheduled task selected/u);
});

test('live runner accepts both Bridge-native and renderer-flattened delegated-session metadata', () => {
  assert.equal(sessionRelationshipKind({ relationship: { kind: 'subagent' } }), 'subagent');
  assert.equal(sessionRelationshipKind({ relationshipKind: 'subagent' }), 'subagent');
  assert.equal(sessionModelId({ modelId: 'grok-4.6' }), 'grok-4.6');
  assert.equal(sessionModelId({ model: 'gpt-5.6-luna' }), 'gpt-5.6-luna');
  assert.equal(sessionReasoningEffort({ reasoningEffort: 'low' }), 'low');
  assert.equal(sessionReasoningEffort({ effort: 'max' }), 'max');
});

test('browser terminal assertions normalize provider-native names and require exactly the complete 16-tool inventory', () => {
  const response = [...BROWSER_TOOL_NAMES].reverse().join('\n');
  assert.deepEqual(browserToolNames(response), [...BROWSER_TOOL_NAMES].sort());
  assert.doesNotThrow(() => assertCompleteBrowserToolInventory(response));
  assert.throws(() => assertCompleteBrowserToolInventory(BROWSER_TOOL_NAMES.slice(1).join('\n')));
  assert.throws(() => assertCompleteBrowserToolInventory(`${response}\nbrowser_not_real`));

  const prefixes = ['', 'uar_mesh_', 'uar_mesh__', 'mcp__uar_mesh__'];
  for (const prefix of prefixes) {
    const nativeResponse = BROWSER_TOOL_NAMES.map((name) => `${prefix}${name}`).join('\n');
    assert.deepEqual(browserToolNames(nativeResponse), [...BROWSER_TOOL_NAMES].sort());
    assert.doesNotThrow(() => assertCompleteBrowserToolInventory(nativeResponse));
    assert.throws(() => assertCompleteBrowserToolInventory(
      `${nativeResponse}\n${prefix}browser_not_real`,
    ));
  }

  const mixedNativeResponse = BROWSER_TOOL_NAMES
    .map((name, index) => `${prefixes[index % prefixes.length]}${name}`)
    .join('\n');
  assert.doesNotThrow(() => assertCompleteBrowserToolInventory(mixedNativeResponse));
  assert.deepEqual(browserToolNames('Uar_mesh_browser_get_state'), ['browser_get_state']);
  assert.throws(() => assertCompleteBrowserToolInventory(
    BROWSER_TOOL_NAMES.slice(1).map((name) => `uar_mesh_${name}`).join('\n'),
  ));
});

test('browser state proof requires a successful visible result rather than an activity name', () => {
  const success = {
    label: 'Read',
    target: 'Uar_mesh_browser_get_state',
    failed: false,
    details: '{"active_tab_id":"tab-one","visible":false,"tabs":[{"title":"Google"}]}',
  };
  assert.equal(assertSuccessfulBrowserGetStateActivity([success]), success);
  assert.throws(() => assertSuccessfulBrowserGetStateActivity([{
    ...success, label: 'Issue', failed: true, details: 'tool-error: ENOENT browser bridge',
  }]), /painted as Issue/u);
  assert.throws(() => assertSuccessfulBrowserGetStateActivity([{
    ...success, details: 'tool-error while opening the browser bridge',
  }]), /tool error/u);
  assert.throws(() => assertSuccessfulBrowserGetStateActivity([{
    ...success, details: 'ENOENT: browser bridge executable was not found',
  }]), /tool error/u);
  assert.throws(() => assertSuccessfulBrowserGetStateActivity([{
    ...success, details: '',
  }]), /no successful browser state result/u);
});

class TerminalCdpFixture {
  constructor({ messages, snapshots, state = 'completed' }) {
    this.snapshots = snapshots ?? [{ messages, alerts: [], workingIndicators: 0, livePresentation: {} }];
    this.state = state;
    this.evaluateCalls = 0;
  }

  async evaluate() {
    const snapshot = this.snapshots[Math.min(this.evaluateCalls, this.snapshots.length - 1)];
    this.evaluateCalls += 1;
    return snapshot;
  }

  async request(type) {
    assert.equal(type, 'sessions.refresh');
    return { sessions: [{ id: 'child-one', state: this.state }] };
  }
}

test('terminal response assertion accepts one canonical queued user row and a new final answer', async () => {
  const baseline = {
    messages: [{ index: 0, anchor: 'old-user', kind: 'user', text: 'Old prompt', busy: false }],
    alerts: [],
    workingIndicators: 0,
  };
  const queuedPrompt = 'List every browser tool.';
  const response = BROWSER_TOOL_NAMES.join(' ');
  const cdp = new TerminalCdpFixture({ messages: [
    ...baseline.messages,
    { index: 1, anchor: 'queued-user', kind: 'user', text: queuedPrompt, busy: false },
    { index: 2, anchor: 'new-answer', kind: 'assistant', text: response, busy: false },
  ] });
  const terminal = await waitForTerminalResponse(cdp, {
    sessionId: 'child-one', baseline, expectedUserPrompt: queuedPrompt, expectBrowserTools: true, timeoutMilliseconds: 1_000,
  });
  assert.equal(terminal.response.text, response);
});

test('PDF presentation requires one canonical message, one card, and no synthetic note', () => {
  const baseline = { messages: [], alerts: [], workingIndicators: 0, livePresentation: {} };
  const prompt = 'Read the attached PDF.';
  const valid = { messages: [
    { index: 0, anchor: 'optimistic-user', kind: 'user', text: prompt, busy: false,
      files: [{ name: 'canary.pdf', label: 'PDF' }] },
  ] };
  assert.doesNotThrow(() => assertSinglePdfPresentation(valid, baseline, prompt, 'canary.pdf'));
  assert.throws(() => assertSinglePdfPresentation({ messages: [
    { ...valid.messages[0], text: `${prompt} Attached file: canary.pdf` },
  ] }, baseline, prompt, 'canary.pdf'), /synthetic "Attached file:" prose/u);
  assert.throws(() => assertSinglePdfPresentation({ messages: [
    { ...valid.messages[0], files: [...valid.messages[0].files, ...valid.messages[0].files] },
  ] }, baseline, prompt, 'canary.pdf'), /exactly one canary\.pdf card/u);
});

test('terminal response assertion rejects a duplicated queued user row', async () => {
  const queuedPrompt = 'Reply once.';
  const baseline = { messages: [], alerts: [], workingIndicators: 0 };
  const cdp = new TerminalCdpFixture({ messages: [
    { index: 0, anchor: 'user-a', kind: 'user', text: queuedPrompt, busy: false },
    { index: 1, anchor: 'user-b', kind: 'user', text: queuedPrompt, busy: false },
    { index: 2, anchor: 'answer', kind: 'assistant', text: 'Done.', busy: false },
  ] });
  await assert.rejects(waitForTerminalResponse(cdp, {
    sessionId: 'child-one', baseline, expectedUserPrompt: queuedPrompt, timeoutMilliseconds: 1_000,
  }), /exactly one new canonical user row/u);
});

test('terminal response waits until every painted live-state marker is gone', async () => {
  const baseline = { messages: [], alerts: [], workingIndicators: 0, livePresentation: {} };
  const messages = [
    { index: 0, anchor: 'user', kind: 'user', text: 'Reply once.', busy: false },
    { index: 1, anchor: 'answer', kind: 'assistant', text: 'Done.', busy: false },
  ];
  for (const marker of [
    { workingIndicators: 1 },
    { livePresentation: { workingStatus: true } },
    { livePresentation: { stopAction: true } },
    { livePresentation: { reasoningAnimations: 1 } },
  ]) assert.equal(hasPaintedLiveState({ workingIndicators: 0, livePresentation: {}, ...marker }), true);
  const cdp = new TerminalCdpFixture({ snapshots: [
    { messages, alerts: [], workingIndicators: 1, livePresentation: { reasoningAnimations: 1, workingStatus: true, stopAction: true } },
    { messages, alerts: [], workingIndicators: 0, livePresentation: {} },
  ] });
  const terminal = await waitForTerminalResponse(cdp, {
    sessionId: 'child-one', baseline, expectedUserPrompt: 'Reply once.', expectedText: 'Done.', timeoutMilliseconds: 1_200,
  });
  assert.equal(terminal.response.text, 'Done.');
  assert.equal(cdp.evaluateCalls, 3);
});

test('terminal response does not accept a stale assistant row painted before the new user turn', async () => {
  const baseline = { messages: [], alerts: [], workingIndicators: 0, livePresentation: {} };
  const cdp = new TerminalCdpFixture({ messages: [
    { index: 0, anchor: 'stale-answer', kind: 'assistant', text: 'Done.', busy: false },
    { index: 1, anchor: 'new-user', kind: 'user', text: 'Reply once.', busy: false },
  ] });
  await assert.rejects(waitForTerminalResponse(cdp, {
    sessionId: 'child-one', baseline, expectedUserPrompt: 'Reply once.', expectedText: 'Done.', timeoutMilliseconds: 10,
  }), /did not produce a visible terminal response/u);
});

test('queue promotion keeps exactly one queue-or-transcript owner on every sampled frame', () => {
  const samples = [
    { queueRows: 1, userRows: 2 },
    { queueRows: 0, userRows: 3 },
    { queueRows: 0, userRows: 3 },
  ];
  assert.doesNotThrow(() => assertQueuePromotionSamples(samples, 2));
  assert.throws(() => assertQueuePromotionSamples([samples[0], { queueRows: 0, userRows: 2 }], 2), /painted 0 queue rows and 0 promoted/u);
  assert.throws(() => assertQueuePromotionSamples([samples[0], { queueRows: 1, userRows: 3 }], 2), /painted 1 queue rows and 1 promoted/u);
});

test('Mesh QA uses a genuine mid-message token and isolates exactly one matching new child', () => {
  assert.equal(midMessageMeshPrompt('Reply READY.'), 'Delegate via /mesh Reply READY.');
  assert.equal(midMessageMeshPrompt('Please /mesh reply READY.'), 'Please /mesh reply READY.');
  const beforeIds = new Set(['old']);
  const available = [
    { id: 'old', relationshipKind: 'subagent', parentSessionId: 'parent', providerId: 'grok' },
    { id: 'wanted', relationshipKind: 'subagent', parentSessionId: 'parent', providerId: 'grok' },
    { id: 'other', relationshipKind: 'subagent', parentSessionId: 'parent', providerId: 'codex' },
  ];
  assert.deepEqual(matchingNewMeshChildren(available, beforeIds, 'parent', 'grok').map((child) => child.id), ['wanted']);
});

test('side-chat QA keeps its panel, transcript, composer, input, and send geometry stable', () => {
  const rect = { x: 10, y: 20, right: 210, bottom: 320, width: 200, height: 300, borderRadius: '10px' };
  const state = {
    sideChat: rect,
    sideChatComposer: { ...rect, y: 260, height: 60 },
    sideChatTextarea: { ...rect, x: 20, y: 270, width: 150, height: 40 },
    sideChatSend: { ...rect, x: 175, y: 270, width: 30, height: 40 },
    sideChatTranscript: { ...rect, y: 40, height: 210 },
  };
  assert.doesNotThrow(() => assertStableSideChatShape(state, structuredClone(state)));
  assert.throws(() => assertStableSideChatShape(state, { ...structuredClone(state), sideChatSend: { ...state.sideChatSend, y: 272 } }), /send control y jumped/u);
});
