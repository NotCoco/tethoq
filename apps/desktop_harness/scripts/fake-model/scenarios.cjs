'use strict';

/**
 * Deterministic scenarios for the test-only fake model.
 *
 * Every scenario is a pure builder over a run context: given the same session,
 * run id, and start time it emits exactly the same AgentEvent payloads at the
 * same offsets and writes exactly the same settled history. Nothing here makes
 * provider or network calls, and nothing here depends on Electron.
 */

const FAKE_PROVIDER_ID = 'fake';
const FAKE_HOST_ID = 'desktop-fake-model';

const ONE_PIXEL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const TINY_WAV = 'data:audio/wav;base64,UklGRiwAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQgAAACAgICAgICAgA==';

const MASTER_REASONING_LINES = [
  'Reading the deterministic fixture state before answering. This first pass checks the active task, the latest provider event, the visible transcript, and the stable identity of every row already on screen. The reasoning surface should remain calm while this evidence is collected, but it should also keep the newest sentence visible as the provider continues to add text. '.repeat(2).trim(),
  'The transcript and the thought are separate reading surfaces. The main conversation owns its place relative to messages, while this bounded reasoning view owns its place inside the current thought. Each surface must respond only to gestures directed at it, and neither may silently revoke the other surface’s bottom-follow choice. '.repeat(2).trim(),
  'Tool and command rows keep their identities across the stream; no remount is acceptable. The same continuity rule applies to the prose around them, which now contains enough deterministic detail to overflow the reasoning viewport and prove that new chunks follow the physical bottom by default instead of remaining hidden below it. '.repeat(2).trim(),
  'Reader-owned position checkpoint: this later reasoning chunk arrives after the reader has deliberately moved upward inside the thought. Its added height must not drag that nested viewport back to the newest line, even though the main transcript remains free to follow its own live tail.',
  'Bottom-follow restoration checkpoint: after the reader returns the reasoning viewport to its exact end, this final reasoning chunk must become visible automatically. The final answer can now be composed from the verified state without changing either scroll surface’s independent ownership.',
];

const MASTER_ANSWER_LINES = [
  'The fake model completed its deterministic pass.',
  'Reasoning, tool, and command activity streamed through the real event path.',
  'Row identities survived history reconciliation without duplicates.',
  'The turn settles to idle with exactly one reasoning group, one tool row, and one command row.',
];

const QUEUE_REASONING_LINES = [
  'Starting a deliberately long stream so the reader can scroll away.',
  'The queue strip and steer controls must stay reachable while this turn runs.',
  'Output continues at a calm cadence so viewport stability is observable.',
];

const ERROR_REASONING_LINES = [
  'Attempting the deterministic failure path.',
];

const APPROVAL_REASONING_LINES = [
  'The deterministic change is ready but requires explicit permission.',
  'Permission granted; continuing from the exact paused step.',
];

const scenarioTriggers = {
  compaction: /compact|compaction/iu,
  terminalHistory: /terminal.*history|history.*race|restart.*mid[- ]turn|mid[- ]turn/iu,
  stream: /stream|fake model|everything/iu,
  error: /error|fail/iu,
  approval: /approval|permission/iu,
  queue: /queue|long|keep streaming|stability/iu,
};

/** Human-readable scenario ids, kept stable so QA assertions never drift. */
const SCENARIO_IDS = {
  compaction: 'fake-scenario-compaction',
  terminalHistory: 'fake-scenario-terminal-history',
  stream: 'fake-scenario-stream',
  error: 'fake-scenario-error',
  approval: 'fake-scenario-approval',
  queue: 'fake-scenario-queue',
};

function fillReasoning(body) {
  return { type: 'reasoning', text: body, redacted: false };
}

function fillText(body) {
  return { type: 'text', text: body };
}

/** The settled, authoritative history the host serves after a scenario ends. */
function masterHistory(sessionId, ctx, content) {
  const userAt = ctx.at(0);
  const id = (part) => `${ctx.runId}-fake-stream-${part}`;
  return [
    {
      id: `${id('user')}-message`,
      sessionId,
      providerMessageId: id('user'),
      role: 'user',
      createdAt: userAt,
      completedAt: userAt,
      parts: [fillText(content)],
      status: 'completed',
      nativeMetadata: {},
    },
    {
      id: `${id('reasoning')}-message`,
      sessionId,
      providerMessageId: id('reasoning'),
      role: 'assistant',
      createdAt: ctx.at(60),
      completedAt: ctx.at(7000),
      parts: [fillReasoning('')],
      status: 'completed',
      nativeMetadata: { phase: 'commentary' },
    },
    {
      id: `${id('tool')}-message`,
      sessionId,
      providerMessageId: id('tool'),
      role: 'tool',
      createdAt: ctx.at(460),
      completedAt: ctx.at(780),
      parts: [fillText('Deterministic tool output.')],
      status: 'completed',
      nativeMetadata: { toolName: 'Read repo state', callId: id('tool') },
    },
    {
      id: `${id('command')}-message`,
      sessionId,
      providerMessageId: id('command'),
      role: 'tool',
      createdAt: ctx.at(940),
      completedAt: ctx.at(1260),
      parts: [{ type: 'command', command: 'npm run fake-check', cwd: 'C:\\FakeModel\\main', output: 'fake check passed', status: 'completed' }],
      status: 'completed',
      nativeMetadata: {},
    },
    {
      id: `${id('answer')}-message`,
      sessionId,
      providerMessageId: id('answer'),
      role: 'assistant',
      createdAt: ctx.at(7500),
      completedAt: ctx.at(9540),
      parts: [fillText('')],
      status: 'completed',
      nativeMetadata: { phase: 'final_answer' },
    },
  ];
}

function masterSteps(ctx, content) {
  const id = (part) => `${ctx.runId}-fake-stream-${part}`;
  const answerDeltaOffsets = [7500, 7860, 8220, 8580, 8940, 9300];
  const steps = [
    { at: 0, events: [ctx.event('message.started', { role: 'user', messageId: id('user'), text: content })] },
    { at: 60, events: [ctx.event('message.delta', { messageId: id('reasoning'), partType: 'reasoning', delta: `${MASTER_REASONING_LINES[0]}\n` })] },
    { at: 240, events: [ctx.event('message.delta', { messageId: id('reasoning'), partType: 'reasoning', delta: `${MASTER_REASONING_LINES[1]}\n` })] },
    { at: 460, events: [ctx.event('tool.started', { toolCallId: id('tool'), name: 'Read repo state', text: 'Reading deterministic repository state.' })] },
    { at: 620, events: [ctx.event('message.delta', { messageId: id('reasoning'), partType: 'reasoning', delta: `${MASTER_REASONING_LINES[2]}\n` })] },
    { at: 780, events: [ctx.event('tool.completed', { toolCallId: id('tool'), name: 'Read repo state', text: 'Deterministic tool output.' })] },
    { at: 940, events: [ctx.event('command.started', { commandId: id('command'), id: id('command'), command: 'npm run fake-check', text: 'npm run fake-check' })] },
    { at: 1100, events: [ctx.event('command.output', { commandId: id('command'), id: id('command'), command: 'npm run fake-check', output: 'fake check passed' })] },
    { at: 1260, events: [ctx.event('command.completed', { commandId: id('command'), id: id('command'), command: 'npm run fake-check', output: 'fake check passed' })] },
    { at: 5000, events: [ctx.event('message.delta', { messageId: id('reasoning'), partType: 'reasoning', delta: `${MASTER_REASONING_LINES[3]}\n` })] },
    { at: 7000, events: [ctx.event('message.delta', { messageId: id('reasoning'), partType: 'reasoning', delta: `${MASTER_REASONING_LINES[4]}\n` })] },
    ...answerDeltaOffsets.map((offset, index) => ({ at: offset, events: [ctx.event('message.delta', { messageId: id('answer'), phase: 'final_answer', delta: `${MASTER_ANSWER_LINES[index]}\n` })] })),
    { at: 9540, events: [ctx.event('message.completed', { messageId: id('answer'), phase: 'final_answer', text: MASTER_ANSWER_LINES.join('\n') })] },
    { at: 9620, events: [ctx.event('agent.completed', { state: 'completed' })] },
  ];
  return steps;
}

function queueHistory(sessionId, ctx, content) {
  const lines = [];
  for (let index = 0; index < 24; index += 1) lines.push(`Queue stream line ${index + 1}: deterministically long output for stability sampling.`);
  const answer = lines.join('\n');
  const userAt = ctx.at(0);
  return [
    {
      id: 'fake-queue-user-message',
      sessionId,
      providerMessageId: 'fake-queue-user',
      role: 'user',
      createdAt: userAt,
      completedAt: userAt,
      parts: [fillText(content)],
      status: 'completed',
      nativeMetadata: {},
    },
    {
      id: 'fake-queue-reasoning-message',
      sessionId,
      providerMessageId: 'fake-queue-reasoning',
      role: 'assistant',
      createdAt: ctx.at(80),
      completedAt: ctx.at(1280),
      parts: [fillReasoning('')],
      status: 'completed',
      nativeMetadata: { phase: 'commentary' },
    },
    {
      id: 'fake-queue-answer-message',
      sessionId,
      providerMessageId: 'fake-queue-answer',
      role: 'assistant',
      createdAt: ctx.at(1500),
      completedAt: ctx.at(16_200),
      parts: [fillText('')],
      status: 'completed',
      nativeMetadata: { phase: 'final_answer' },
    },
  ];
}

function queueSteps(ctx, content) {
  const steps = [
    { at: 0, events: [ctx.event('message.started', { role: 'user', messageId: 'fake-queue-user', text: content })] },
    { at: 80, events: [ctx.event('message.delta', { messageId: 'fake-queue-reasoning', partType: 'reasoning', delta: `${QUEUE_REASONING_LINES[0]}\n` })] },
    { at: 480, events: [ctx.event('message.delta', { messageId: 'fake-queue-reasoning', partType: 'reasoning', delta: `${QUEUE_REASONING_LINES[1]}\n` })] },
    { at: 880, events: [ctx.event('message.delta', { messageId: 'fake-queue-reasoning', partType: 'reasoning', delta: `${QUEUE_REASONING_LINES[2]}\n` })] },
    { at: 1280, events: [ctx.event('message.completed', { messageId: 'fake-queue-reasoning', partType: 'reasoning', text: QUEUE_REASONING_LINES.join('\n') })] },
  ];
  for (let index = 0; index < 24; index += 1) {
    steps.push({ at: 1500 + index * 600, events: [ctx.event('message.delta', { messageId: 'fake-queue-answer', phase: 'final_answer', delta: `Queue stream line ${index + 1}: deterministically long output for stability sampling.\n` })] });
  }
  steps.push({ at: 16_200, events: [ctx.event('message.completed', { messageId: 'fake-queue-answer', phase: 'final_answer', text: Array.from({ length: 24 }, (_, index) => `Queue stream line ${index + 1}: deterministically long output for stability sampling.`).join('\n') })] });
  steps.push({ at: 16_300, events: [ctx.event('agent.completed', { state: 'completed' })] });
  return steps;
}

const COMPACTION_DETAIL = '## Current task progress\n\nThe deterministic summary is retained inside one disclosure.\n\n## Next steps\n\nVerify the compact control without repeating this prose.';
const COMPACTION_RECORD = `Another language model started to solve this problem and produced a summary of its thinking process.\n\n${COMPACTION_DETAIL}`;

function compactionHistory(sessionId, ctx, content) {
  return [
    {
      id: 'fake-compaction-user-message',
      sessionId,
      providerMessageId: 'fake-compaction-user',
      role: 'user',
      createdAt: ctx.at(0),
      completedAt: ctx.at(0),
      parts: [fillText(content)],
      status: 'completed',
      nativeMetadata: {},
    },
    {
      id: 'fake-compaction-readable-message',
      sessionId,
      providerMessageId: 'fake-compaction-readable',
      role: 'assistant',
      createdAt: ctx.at(60),
      completedAt: ctx.at(60),
      parts: [fillReasoning(COMPACTION_DETAIL)],
      status: 'completed',
      nativeMetadata: { phase: 'commentary' },
    },
    {
      id: 'fake-compaction-event-message',
      sessionId,
      providerMessageId: 'fake-compaction-event',
      role: 'assistant',
      createdAt: ctx.at(160),
      completedAt: ctx.at(160),
      parts: [fillText(COMPACTION_RECORD)],
      status: 'completed',
      nativeMetadata: { phase: 'commentary' },
    },
  ];
}

function compactionSteps(ctx, content) {
  return [
    { at: 0, events: [ctx.event('message.started', { role: 'user', messageId: 'fake-compaction-user', text: content })] },
    { at: 60, events: [ctx.event('message.completed', { messageId: 'fake-compaction-readable', partType: 'reasoning', text: COMPACTION_DETAIL })] },
    { at: 160, events: [ctx.event('message.completed', { messageId: 'fake-compaction-event', phase: 'commentary', text: COMPACTION_RECORD })] },
    { at: 1_800, events: [ctx.event('agent.completed', { state: 'completed' })] },
  ];
}

const TERMINAL_HISTORY_REASONING = 'Checking the persisted transcript after the provider reported completion.';
const TERMINAL_HISTORY_ANSWER = 'The final reply arrived through persisted history after the terminal event.';

function terminalHistoryHistory(sessionId, ctx, content) {
  const id = (part) => `${ctx.runId}-fake-terminal-history-${part}`;
  return [
    {
      id: `${id('user')}-message`,
      sessionId,
      providerMessageId: id('user'),
      role: 'user',
      createdAt: ctx.at(0),
      completedAt: ctx.at(0),
      parts: [fillText(content)],
      status: 'completed',
      nativeMetadata: {},
    },
    {
      id: `${id('reasoning')}-message`,
      sessionId,
      providerMessageId: id('reasoning'),
      role: 'assistant',
      createdAt: ctx.at(60),
      completedAt: ctx.at(520),
      parts: [fillReasoning(TERMINAL_HISTORY_REASONING)],
      status: 'completed',
      nativeMetadata: { phase: 'commentary' },
    },
    {
      id: `${id('answer')}-message`,
      sessionId,
      providerMessageId: id('answer'),
      role: 'assistant',
      createdAt: ctx.at(760),
      completedAt: ctx.at(900),
      parts: [fillText(TERMINAL_HISTORY_ANSWER)],
      status: 'completed',
      nativeMetadata: { phase: 'final_answer' },
    },
  ];
}

function terminalHistorySteps(ctx, content) {
  const id = (part) => `${ctx.runId}-fake-terminal-history-${part}`;
  return [
    { at: 0, events: [ctx.event('message.started', { role: 'user', messageId: id('user'), text: content })] },
    { at: 60, events: [ctx.event('message.delta', { messageId: id('reasoning'), partType: 'reasoning', delta: `${TERMINAL_HISTORY_REASONING}\n` })] },
    // Deliberately no final-answer event: the reply only becomes available in
    // the authoritative history released after this terminal signal.
    { at: 420, events: [ctx.event('agent.completed', { state: 'completed' })] },
  ];
}

function errorHistory(sessionId, ctx, content) {
  const userAt = ctx.at(0);
  return [
    {
      id: 'fake-error-user-message',
      sessionId,
      providerMessageId: 'fake-error-user',
      role: 'user',
      createdAt: userAt,
      completedAt: userAt,
      parts: [fillText(content)],
      status: 'completed',
      nativeMetadata: {},
    },
    {
      id: 'fake-error-reasoning-message',
      sessionId,
      providerMessageId: 'fake-error-reasoning',
      role: 'assistant',
      createdAt: ctx.at(60),
      completedAt: ctx.at(60),
      parts: [fillReasoning('')],
      status: 'completed',
      nativeMetadata: { phase: 'commentary' },
    },
  ];
}

function errorSteps(ctx, content) {
  return [
    { at: 0, events: [ctx.event('message.started', { role: 'user', messageId: 'fake-error-user', text: content })] },
    { at: 60, events: [ctx.event('message.delta', { messageId: 'fake-error-reasoning', partType: 'reasoning', delta: `${ERROR_REASONING_LINES[0]}\n` })] },
    { at: 420, events: [ctx.event('agent.error', { message: 'Deterministic failure: retry budget exhausted (429).' })] },
  ];
}

function approvalHistory(sessionId, ctx, content) {
  const userAt = ctx.at(0);
  return [
    {
      id: 'fake-approval-user-message',
      sessionId,
      providerMessageId: 'fake-approval-user',
      role: 'user',
      createdAt: userAt,
      completedAt: userAt,
      parts: [fillText(content)],
      status: 'completed',
      nativeMetadata: {},
    },
    {
      id: 'fake-approval-reasoning-message',
      sessionId,
      providerMessageId: 'fake-approval-reasoning',
      role: 'assistant',
      createdAt: ctx.at(60),
      completedAt: ctx.at(60),
      parts: [fillReasoning('')],
      status: 'completed',
      nativeMetadata: { phase: 'commentary' },
    },
    {
      id: 'fake-approval-answer-message',
      sessionId,
      providerMessageId: 'fake-approval-answer',
      role: 'assistant',
      createdAt: ctx.at(900),
      completedAt: ctx.at(980),
      parts: [fillText('')],
      status: 'completed',
      nativeMetadata: { phase: 'final_answer' },
    },
  ];
}

function approvalSteps(ctx, content) {
  const before = [
    { at: 0, events: [ctx.event('message.started', { role: 'user', messageId: 'fake-approval-user', text: content })] },
    { at: 60, events: [ctx.event('message.delta', { messageId: 'fake-approval-reasoning', partType: 'reasoning', delta: `${APPROVAL_REASONING_LINES[0]}\n` })] },
    { at: 620, events: [ctx.event('approval.requested', {
      requestId: 'fake-approval-request',
      title: 'Run the deterministic migration?',
      reason: 'The fixture migration updates the refresh-token index used by the repaired path.',
      command: 'npm run db:migrate',
      workingDirectory: 'C:\\FakeModel\\main',
      affectedFiles: ['migrations/20260821_fixture.sql'],
      choices: [
        { id: 'approve', label: 'Run migration', kind: 'approve' },
        { id: 'reject', label: 'Not now', kind: 'reject' },
      ],
    })] },
  ];
  const after = [
    { at: 0, events: [ctx.event('approval.resolved', { requestId: 'fake-approval-request' })] },
    { at: 120, events: [ctx.event('message.delta', { messageId: 'fake-approval-reasoning', partType: 'reasoning', delta: `${APPROVAL_REASONING_LINES[1]}\n` })] },
    { at: 520, events: [ctx.event('message.delta', { messageId: 'fake-approval-answer', phase: 'final_answer', delta: 'Permission granted; the deterministic migration completed.' })] },
    { at: 900, events: [ctx.event('message.completed', { messageId: 'fake-approval-answer', phase: 'final_answer', text: 'Permission granted; the deterministic migration completed.' })] },
    { at: 980, events: [ctx.event('agent.completed', { state: 'completed' })] },
  ];
  return { before, after };
}

/** Long, settled fixture history so scroll ownership is observable. */
function longHistoryMessages(sessionId, baseIso) {
  // Keep every fixture row strictly before the live turn. Future-dated
  // history can sort ahead of streamed rows and manufacture reconciliation
  // failures that a real chronological provider history would never create.
  const base = Date.parse(baseIso) - 43 * 60_000;
  const messages = [];
  for (let index = 0; index < 40; index += 1) {
    const userTurn = index % 2 === 0;
    const createdAt = new Date(base + index * 60_000).toISOString();
    const body = `${userTurn ? 'User' : 'Assistant'} fixture message ${index + 1}. This row intentionally wraps across several lines so the transcript is genuinely long enough to test reader-owned scrolling while background refreshes and new output continue.`;
    messages.push({
      id: `fake-fixture-${index}`,
      sessionId,
      providerMessageId: `fake-fixture-${index}`,
      role: userTurn ? 'user' : 'assistant',
      createdAt,
      completedAt: createdAt,
      parts: [fillText(body)],
      status: 'completed',
      nativeMetadata: {},
    });
  }
  const settledReasoning = Array.from({ length: 18 }, (_, index) => `Settled reasoning detail ${index + 1}: this row is intentionally tall when opened so the viewport anchor can be tested.`).join('\n');
  messages.push(
    {
      id: 'fake-fixture-settled-reasoning',
      sessionId,
      providerMessageId: 'fake-fixture-settled-reasoning',
      role: 'assistant',
      createdAt: new Date(base + 40 * 60_000).toISOString(),
      completedAt: new Date(base + 40 * 60_000).toISOString(),
      parts: [fillReasoning(settledReasoning)],
      status: 'completed',
      nativeMetadata: { phase: 'commentary' },
    },
    {
      id: 'fake-fixture-settled-command',
      sessionId,
      providerMessageId: 'fake-fixture-settled-command',
      role: 'tool',
      createdAt: new Date(base + 41 * 60_000).toISOString(),
      completedAt: new Date(base + 41 * 60_000).toISOString(),
      parts: [{ type: 'command', command: 'npm run deterministic-check', cwd: 'C:\\FakeModel\\main', output: 'deterministic check completed', status: 'completed' }],
      status: 'completed',
      nativeMetadata: {},
    },
    {
      id: 'fake-fixture-settled-answer',
      sessionId,
      providerMessageId: 'fake-fixture-settled-answer',
      role: 'assistant',
      createdAt: new Date(base + 42 * 60_000).toISOString(),
      completedAt: new Date(base + 42 * 60_000).toISOString(),
      parts: [fillText('The previous synthetic turn settled normally. The next turn is started through the real composer.')],
      status: 'completed',
      nativeMetadata: { phase: 'final_answer' },
    },
  );
  return messages;
}

/** Attachments fixture: image, audio, file, and file-change parts through real history. */
function attachmentHistory(sessionId, baseIso) {
  const base = Date.parse(baseIso);
  const userAt = new Date(base).toISOString();
  const answerAt = new Date(base + 60_000).toISOString();
  return [
    {
      id: 'fake-attach-user',
      sessionId,
      providerMessageId: 'fake-attach-user',
      role: 'user',
      createdAt: userAt,
      completedAt: userAt,
      parts: [
        fillText('Review the attached fixture evidence.'),
        { type: 'image', uri: ONE_PIXEL_PNG, mimeType: 'image/png', name: 'fixture-layout.png' },
        { type: 'audio', uri: TINY_WAV, mimeType: 'audio/wav', name: 'fixture-note.wav', durationSeconds: 0.4 },
        { type: 'file', name: 'fixture-notes.md', mimeType: 'text/markdown' },
      ],
      status: 'completed',
      nativeMetadata: {},
    },
    {
      id: 'fake-attach-file-change',
      sessionId,
      providerMessageId: 'fake-attach-file-change',
      role: 'assistant',
      createdAt: answerAt,
      completedAt: answerAt,
      parts: [
        { type: 'file_change', path: 'src/fixture.ts', change: 'modified', patch: 'const ready = true;' },
        fillText('The fixture evidence is attached and the deterministic file change is recorded.'),
      ],
      status: 'completed',
      nativeMetadata: { phase: 'final_answer' },
    },
  ];
}

function scenarioContentId(content) {
  for (const [id, pattern] of Object.entries(scenarioTriggers)) {
    if (pattern.test(content)) return id;
  }
  return 'stream';
}

/**
 * Builds the full deterministic plan for one turn.
 * ctx: { sessionId, content, runId, playStartedAtIso, sequence, event() }
 */
function buildScenario(content, ctx) {
  const id = scenarioContentId(content);
  if (id === 'compaction') {
    return { id: SCENARIO_IDS.compaction, steps: compactionSteps(ctx, content), gate: null, history: compactionHistory(ctx.sessionId, ctx, content), endState: 'idle' };
  }
  if (id === 'terminalHistory') {
    return {
      id: SCENARIO_IDS.terminalHistory,
      steps: terminalHistorySteps(ctx, content),
      gate: null,
      history: terminalHistoryHistory(ctx.sessionId, ctx, content),
      endState: 'completed',
      deferFinalHistory: true,
    };
  }
  if (id === 'stream') {
    return { id: SCENARIO_IDS.stream, steps: masterSteps(ctx, content), gate: null, history: masterHistory(ctx.sessionId, ctx, content), endState: 'idle' };
  }
  if (id === 'queue') {
    return { id: SCENARIO_IDS.queue, steps: queueSteps(ctx, content), gate: null, history: queueHistory(ctx.sessionId, ctx, content), endState: 'idle' };
  }
  if (id === 'error') {
    return { id: SCENARIO_IDS.error, steps: errorSteps(ctx, content), gate: null, history: errorHistory(ctx.sessionId, ctx, content), endState: 'failed' };
  }
  const { before, after } = approvalSteps(ctx, content);
  return {
    id: SCENARIO_IDS.approval,
    steps: before,
    gate: { kind: 'approval', requestId: 'fake-approval-request', after },
    history: approvalHistory(ctx.sessionId, ctx, content),
    endState: 'idle',
  };
}

module.exports = {
  FAKE_PROVIDER_ID,
  FAKE_HOST_ID,
  SCENARIO_IDS,
  buildScenario,
  scenarioContentId,
  longHistoryMessages,
  attachmentHistory,
  MASTER_ANSWER_LINES,
  ONE_PIXEL_PNG,
  TINY_WAV,
};
