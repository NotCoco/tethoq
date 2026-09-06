'use strict';

const port = Number(process.argv[2] ?? 9225);
const summaryOnly = process.argv.includes('--summary');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let socket;
let nextId = 0;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function main() {
  let target;
  for (let attempt = 0; attempt < 50 && !target; attempt += 1) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json()).catch(() => []);
    target = targets.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl && /^file:/iu.test(entry.url ?? ''));
    if (!target) await delay(100);
  }
  if (!target) throw new Error('Tethoq renderer is unavailable.');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', (message) => {
    const response = JSON.parse(String(message.data));
    const handler = pending.get(response.id);
    if (!handler) return;
    pending.delete(response.id);
    response.error ? handler.reject(new Error(response.error.message)) : handler.resolve(response.result);
  });
  const response = await send('Runtime.evaluate', {
    awaitPromise: true,
    returnByValue: true,
    expression: `(async () => {
      const withTimeout = (promise, name, timeoutMs = 5000) => Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(name + ' timed out')), timeoutMs)),
      ]);
      const unwrap = (response, name) => {
        if (!response?.ok) throw new Error(response?.error?.message ?? name + ' failed');
        return response.payload;
      };
      const [bootstrap, sessionsResponse, preferences, localOpen] = await Promise.all([
        window.tethoqDesktop.bootstrap(),
        window.tethoqDesktop.request('sessions.refresh', {}),
        window.tethoqDesktop.preferencesState(),
        window.tethoqDesktop.localOpenHandlers(),
      ]);
      const providers = bootstrap?.providers ?? [];
      const modelEntries = await Promise.all(providers.map(async (provider) => {
        try {
          const modelResponse = await withTimeout(
            window.tethoqDesktop.request('models.list', { providerId: provider.providerId }),
            provider.providerId + ' models.list',
          );
          return [provider.providerId, modelResponse?.ok ? (modelResponse.payload.models ?? []) : { error: modelResponse?.error?.message ?? 'failed' }];
        } catch (error) {
          return [provider.providerId, { error: error instanceof Error ? error.message : String(error) }];
        }
      }));
      const models = Object.fromEntries(modelEntries);
      const sessions = unwrap(sessionsResponse, 'sessions.refresh').sessions ?? [];
      if (${summaryOnly ? 'true' : 'false'}) {
        const summarizedModels = Object.fromEntries(Object.entries(models).map(([providerId, value]) => {
          if (!Array.isArray(value)) return [providerId, value];
          const eligible = value.filter((model) => {
            const modalities = Array.isArray(model.inputModalities) ? model.inputModalities : [];
            return providerId === 'grok' || modalities.includes('image') || modalities.includes('audio');
          }).map((model) => ({ id: model.id, displayName: model.displayName, inputModalities: model.inputModalities ?? [], efforts: model.efforts ?? model.nativeMetadata?.supportedReasoningEfforts ?? [] }));
          return [providerId, { count: value.length, eligible }];
        }));
        return { providers: providers.map(({ providerId, displayName, state, detected, authenticated }) => ({ providerId, displayName, state, detected, authenticated })), sessionCounts: Object.fromEntries(providers.map((provider) => [provider.providerId, sessions.filter((session) => session.providerId === provider.providerId).length])), preferences, localOpen, models: summarizedModels };
      }
      return { providers, sessions, preferences, localOpen, models };
    })()`,
  });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  process.stdout.write(`${JSON.stringify(response.result?.value, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}).finally(() => socket?.close());
