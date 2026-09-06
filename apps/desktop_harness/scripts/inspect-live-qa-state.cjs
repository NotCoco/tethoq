'use strict';

const debugPort = Number(process.argv[2] ?? 9225);
const targetThreadId = process.argv[3] ?? null;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(operation, description, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`${description} timed out${lastError ? `: ${lastError.message ?? lastError}` : ''}`);
}

async function main() {
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, {
      signal: AbortSignal.timeout(2_000),
    });
    const targets = await response.json();
    return targets.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl && /^file:/iu.test(entry.url ?? ''));
  }, 'Tethoq renderer');

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', (message) => {
    const response = JSON.parse(String(message.data));
    const handler = pending.get(response.id);
    if (!handler) return;
    pending.delete(response.id);
    response.error ? handler.reject(new Error(response.error.message)) : handler.resolve(response.result);
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const response = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? 'Evaluation failed');
    }
    return response.result?.value;
  };

  await send('Runtime.enable');
  const state = await evaluate(`(async () => {
    const rows = [...document.querySelectorAll('[data-session-id]')].map((container) => {
      const row = container.querySelector(':scope > .session-row');
      if (!(row instanceof HTMLElement)) return null;
      const rect = row.getBoundingClientRect();
      return {
        id: container.getAttribute('data-session-id'),
        selected: row.classList.contains('selected'),
        title: row.querySelector('.session-title')?.textContent?.trim() ?? row.textContent?.replace(/\\s+/gu, ' ').trim() ?? '',
        visible: rect.width > 0 && rect.height > 0,
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
      };
    }).filter(Boolean);
    let sessions = null;
    try {
      const response = await window.tethoqDesktop.request('sessions.list', {});
      sessions = response?.ok ? response.payload : { error: response?.error ?? 'sessions.list failed' };
    } catch (error) {
      sessions = { error: error instanceof Error ? error.message : String(error) };
    }
    const preferences = await window.tethoqDesktop.preferencesState();
    const composer = document.querySelector('.composer-wrap');
    return {
      visibility: document.visibilityState,
      preferences: {
        taskListMode: preferences.taskListMode,
        reasoningDisplay: preferences.reasoningDisplay,
        experimentalFeatures: preferences.experimentalFeatures,
        targetOverride: Object.entries(preferences.taskOverrides ?? {}).find(([id]) => id.includes(${JSON.stringify(targetThreadId)}))?.[1] ?? null,
      },
      selected: rows.find((row) => row.selected) ?? null,
      targetRows: ${JSON.stringify(targetThreadId)} ? rows.filter((row) => row.id?.includes(${JSON.stringify(targetThreadId)})) : [],
      rowCount: rows.length,
      visibleRows: rows.filter((row) => row.visible && row.bottom >= 0 && row.top <= innerHeight),
      composer: {
        draft: composer?.querySelector('textarea[aria-label="Message"]')?.value ?? null,
        attachments: [...(composer?.querySelectorAll('.image-attachment-chip, .file-attachment-chip, .audio-attachment-chip') ?? [])].map((node) => ({
          className: node.className,
          text: node.textContent?.replace(/\\s+/gu, ' ').trim() ?? '',
        })),
      },
      sessions: (() => {
        const listed = Array.isArray(sessions?.sessions) ? sessions.sessions : [];
        const target = ${JSON.stringify(targetThreadId)}
          ? listed.filter((session) => session.providerSessionId === ${JSON.stringify(targetThreadId)} || session.id?.includes(${JSON.stringify(targetThreadId)}))
          : [];
        return {
          count: listed.length,
          target,
          error: sessions?.error ?? null,
        };
      })(),
    };
  })()`);
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
  socket.close();
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
