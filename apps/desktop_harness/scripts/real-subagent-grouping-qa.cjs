'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { stopTethoq } = require('./stop-unpacked.cjs');
const { cleanupOldScreenshotArtifacts } = require('./fake-model/artifact-cleanup.cjs');

const appRoot = path.resolve(__dirname, '..');
const executable = path.join(appRoot, 'release', 'win-unpacked', 'Tethoq.exe');
const artifactDirectory = path.join(appRoot, 'qa-artifacts');
const reportPath = path.join(artifactDirectory, 'real-subagents.json');
const screenshotPath = path.join(artifactDirectory, 'real-subagents.png');
const hoverScreenshotPath = path.join(artifactDirectory, 'real-subagents-hover.png');
const popoverScreenshotPath = path.join(artifactDirectory, 'real-subagents-popover.png');
const debugPort = 9347;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) { lastError = error; }
    await delay(100);
  }
  throw new Error(`${description} timed out${lastError ? `: ${lastError.message ?? lastError}` : ''}`);
}

async function connectCdp() {
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return null;
    const targets = await response.json();
    return targets.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl && /^file:/iu.test(entry.url ?? ''));
  }, 'real unpacked renderer');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const value = JSON.parse(String(event.data));
    const entry = pending.get(value.id);
    if (!entry) return;
    pending.delete(value.id);
    value.error ? entry.reject(new Error(value.error.message)) : entry.resolve(value.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await Promise.all([send('Runtime.enable'), send('Page.enable')]);
  return {
    evaluate: async (expression) => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'Renderer evaluation failed');
      return result.result?.value;
    },
    mouseMove: (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }),
    mouseClick: async (x, y) => {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    },
    screenshot: async () => (await send('Page.captureScreenshot', { format: 'png', fromSurface: true })).data,
    close: () => socket.close(),
  };
}

async function main() {
  const artifactCleanup = await cleanupOldScreenshotArtifacts(artifactDirectory);
  assert.equal(stopTethoq(), true, 'The existing Tethoq process did not stop cleanly.');
  const appProcess = spawn(executable, [`--remote-debugging-port=${debugPort}`], {
    cwd: appRoot,
    windowsHide: true,
    detached: true,
    stdio: 'ignore',
  });
  appProcess.unref();
  let cdp;
  try {
    cdp = await connectCdp();
    await waitFor(() => cdp.evaluate('Boolean(window.tethoqDesktop && document.querySelector(".desktop-app"))'), 'Tethoq shell');
    const expectedAuditTitles = (process.env.TETHOQ_QA_EXPECTED_SUBAGENT_TITLES ?? '')
      .split(/\r?\n/u)
      .map((title) => title.trim())
      .filter(Boolean);
    const expectedAudits = expectedAuditTitles.length === 0 ? [] : await waitFor(() => cdp.evaluate(`(async () => {
      const response = await window.tethoqDesktop.request('sessions.refresh', {});
      if (!response?.ok) return null;
      const expected = ${JSON.stringify(expectedAuditTitles)};
      const sessions = response.payload?.sessions ?? [];
      const matches = expected.map((title) => sessions.find((session) => session.title === title) ?? null);
      if (matches.some((session) => session === null)) return null;
      return matches.map((session) => ({
        id: session.id,
        title: session.title,
        relationship: session.relationship ?? null,
        parentSessionId: session.parentSessionId ?? null,
      }));
    })()`), 'configured audit worker sessions', 60_000);
    const expectedTopLevelIds = await cdp.evaluate(`[...document.querySelectorAll('[data-session-id]')].map((row) => row.getAttribute('data-session-id'))`);
    for (const audit of expectedAudits) {
      assert.equal(audit.relationship?.kind, 'subagent', `${audit.title} was not classified from its exact Codex launch evidence.`);
      assert.equal(typeof audit.relationship?.sourceSessionId, 'string', `${audit.title} has no owning Codex session.`);
      assert.equal(expectedTopLevelIds.includes(audit.id), false, `${audit.title} is still painted as a top-level task.`);
      assert.equal(expectedTopLevelIds.includes(audit.relationship.sourceSessionId), true, `${audit.title} is hidden under another hidden worker instead of a rail-visible mother task.`);
    }
    const groupedParents = await waitFor(() => cdp.evaluate(`(async () => {
      const response = await window.tethoqDesktop.request('sessions.refresh', {});
      if (!response?.ok) return null;
      const sessions = response.payload?.sessions ?? [];
      const byId = new Map(sessions.map((session) => [session.id, session]));
      const grouped = new Map();
      for (const child of sessions) {
        if (child.providerId !== 'opencode' || child.relationship?.kind !== 'subagent') continue;
        const parent = byId.get(child.relationship.sourceSessionId);
        if (!parent || parent.providerId !== 'codex') continue;
        const current = grouped.get(parent.id) ?? { id: parent.id, title: parent.title ?? '', openCodeChildIds: [] };
        current.openCodeChildIds.push(child.id);
        grouped.set(parent.id, current);
      }
      return grouped.size ? [...grouped.values()] : null;
    })()`), 'Codex parents with confirmed OpenCode children', 60_000);
    const topLevelIds = await cdp.evaluate(`[...document.querySelectorAll('[data-session-id]')].map((row) => row.getAttribute('data-session-id'))`);
    for (const grouped of groupedParents) {
      assert.equal(grouped.openCodeChildIds.some((id) => topLevelIds.includes(id)), false, `Grouped children leaked into the task list for ${grouped.title}.`);
    }
    const parent = [...groupedParents].sort((left, right) => right.openCodeChildIds.length - left.openCodeChildIds.length)[0];
    const visibleParent = await waitFor(() => cdp.evaluate(`(() => {
      const row = document.querySelector(${JSON.stringify(`[data-session-id="${parent.id}"]`)});
      const trigger = row?.querySelector('.session-subagents-trigger');
      return trigger ? { label: trigger.getAttribute('aria-label') ?? '' } : null;
    })()`), 'grouped parent task row');
    parent.label = visibleParent.label;
    const triggerPoint = await cdp.evaluate(`(() => {
      const trigger = document.querySelector(${JSON.stringify(`[data-session-id="${parent.id}"] .session-subagents-trigger`)});
      trigger?.scrollIntoView({ block: 'center' });
      const bounds = trigger?.getBoundingClientRect();
      return bounds ? { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 } : null;
    })()`);
    assert.ok(triggerPoint, 'The real grouped parent hover target is missing.');
    await cdp.mouseMove(triggerPoint.x, triggerPoint.y);
    const hover = await waitFor(() => cdp.evaluate(`(() => {
      const trigger = document.querySelector(${JSON.stringify(`[data-session-id="${parent.id}"] .session-subagents-trigger`)});
      const tooltips = [...document.querySelectorAll('.session-subagents-tooltip')].filter((tooltip) => {
        const style = getComputedStyle(tooltip);
        const bounds = tooltip.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && bounds.width > 1 && bounds.height > 1;
      });
      const tooltip = tooltips[0];
      const bounds = tooltip?.getBoundingClientRect();
      return tooltip && bounds ? {
        visibleCount: tooltips.length,
        text: tooltip.textContent?.trim() ?? '',
        parentIsBody: tooltip.parentElement === document.body,
        nestedTooltipSources: trigger?.querySelectorAll('[data-tooltip]').length ?? -1,
        triggerHasTooltipSource: trigger?.hasAttribute('data-tooltip') ?? true,
        bounds: { x: bounds.x, y: bounds.y, right: bounds.right, bottom: bounds.bottom },
        viewport: { width: innerWidth, height: innerHeight },
      } : null;
    })()`), 'real sub-agent hover tooltip');
    assert.equal(hover.visibleCount, 1, 'The real sub-agent hover painted more than one tooltip.');
    assert.equal(hover.text, parent.label, 'The real sub-agent hover label does not match its count.');
    assert.equal(hover.parentIsBody, true, 'The real sub-agent tooltip is still trapped inside the task rail.');
    assert.equal(hover.nestedTooltipSources, 0, 'The real sub-agent trigger still contains a nested tooltip source.');
    assert.equal(hover.triggerHasTooltipSource, false, 'The real sub-agent trigger still paints the clipped pseudo-tooltip.');
    assert.ok(hover.bounds.x >= 8 && hover.bounds.y >= 8 && hover.bounds.right <= hover.viewport.width - 8 + 1 && hover.bounds.bottom <= hover.viewport.height - 8 + 1, 'The real sub-agent hover tooltip is clipped by the viewport.');
    await mkdir(artifactDirectory, { recursive: true });
    await writeFile(hoverScreenshotPath, Buffer.from(await cdp.screenshot(), 'base64'));
    await cdp.mouseClick(triggerPoint.x, triggerPoint.y);
    const visible = await waitFor(() => cdp.evaluate(`(async () => {
      const panel = document.querySelector('.session-subagents-popover');
      if (!panel) return null;
      const response = await window.tethoqDesktop.request('session.children', { sessionId: ${JSON.stringify(parent.id)} });
      if (!response?.ok) throw new Error(response?.error?.message ?? 'session.children failed');
      const childIds = (response.payload?.sessions ?? []).map((session) => session.id);
      const childStates = Object.fromEntries((response.payload?.sessions ?? []).map((session) => [session.id, session.state]));
      const topLevelIds = [...document.querySelectorAll('[data-session-id]')].map((row) => row.getAttribute('data-session-id'));
      const bounds = panel.getBoundingClientRect();
      const childRows = [...panel.querySelectorAll(':scope > button')].map((button) => ({
        title: button.querySelector('strong')?.textContent?.trim() ?? '',
        stateLabel: button.querySelector('small')?.textContent?.trim() ?? '',
        spinnerCount: button.querySelectorAll('.spinner').length,
        spinnerAnimation: button.querySelector('.spinner') ? getComputedStyle(button.querySelector('.spinner')).animationName : 'none',
      }));
      // The panel is mounted immediately with a loading row, while the real
      // cross-provider child request resolves asynchronously. Do not mistake
      // that intentional transient state for an empty/omitted child list.
      if (childRows.length !== childIds.length) return null;
      const trigger = document.querySelector(${JSON.stringify(`[data-session-id="${parent.id}"] .session-subagents-trigger`)});
      return {
        childIds,
        childStates,
        childRows,
        childTitles: [...panel.querySelectorAll(':scope > button strong')].map((label) => label.textContent?.trim() ?? ''),
        topLevelIds,
        bounds: { x: bounds.x, y: bounds.y, right: bounds.right, bottom: bounds.bottom },
        viewport: { width: innerWidth, height: innerHeight },
        childRowHeights: [...panel.querySelectorAll(':scope > button')].map((button) => button.getBoundingClientRect().height),
        triggerLabel: trigger?.getAttribute('aria-label') ?? '',
      };
    })()`), 'sub-agent popover');
    assert.ok(visible.childIds.length > 0, 'The real grouped parent returned no children.');
    assert.equal(visible.childTitles.length, visible.childIds.length, 'The popover omitted a grouped child.');
    assert.equal(visible.triggerLabel, `${visible.childIds.length} sub-agent${visible.childIds.length === 1 ? '' : 's'}`, 'The parent count did not update to the live child list.');
    assert.equal(visible.childIds.some((id) => visible.topLevelIds.includes(id)), false, 'A grouped child remained in the top-level task list.');
    visible.childIds.forEach((id, index) => {
      const row = visible.childRows[index];
      const working = visible.childStates[id] === 'working';
      assert.equal(row.spinnerCount, working ? 1 : 0, `${row.title} spinner disagrees with its current provider state.`);
      if (working) assert.notEqual(row.spinnerAnimation, 'none', `${row.title} working spinner is not animated.`);
    });
    await writeFile(popoverScreenshotPath, Buffer.from(await cdp.screenshot(), 'base64'));
    assert.ok(visible.bounds.x >= 0 && visible.bounds.y >= 0 && visible.bounds.right <= visible.viewport.width + 1 && visible.bounds.bottom <= visible.viewport.height + 1, 'The real popover is clipped by the viewport.');
    assert.equal(visible.childRowHeights.every((height) => height >= 43), true, 'A real child row lost its usable hit height.');

    await cdp.evaluate(`document.querySelector('.session-subagents-popover > button')?.click()`);
    const opened = await waitFor(() => cdp.evaluate(`(() => ({
      title: document.querySelector('.workspace-title h1')?.textContent?.trim() ?? '',
      hasParentBack: Boolean(document.querySelector('[aria-label="Back to parent task"]')),
    }))()`), 'opened child task');
    assert.equal(opened.hasParentBack, true, 'Opening the child did not expose direct parent return navigation.');

    await writeFile(screenshotPath, Buffer.from(await cdp.screenshot(), 'base64'));
    const report = { artifactCleanup, expectedAuditTitles, expectedAudits, groupedParents, parent, hover, childIds: visible.childIds, childStates: visible.childStates, childRows: visible.childRows, childTitles: visible.childTitles, popoverBounds: visible.bounds, viewport: visible.viewport, opened };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`Real sub-agent grouping QA passed: ${reportPath}\n`);
  } finally {
    cdp?.close();
    stopTethoq();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
