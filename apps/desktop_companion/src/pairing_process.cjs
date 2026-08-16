'use strict';

const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { existsSync } = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const START_TIMEOUT_MS = 45_000;
const CONTROL_REQUEST_TIMEOUT_MS = 45_000;
const MAX_CONTROL_RESPONSE_BYTES = 64 * 1024;
const MAX_PAIRING_PAGE_BYTES = 128 * 1024;
const MAX_RESTART_ATTEMPTS = 5;
const RESTART_BASE_DELAY_MS = 500;
const RESTART_MAX_DELAY_MS = 8_000;
const STABLE_ENGINE_WINDOW_MS = 60_000;
const PAIRING_CONFIRMED_MARKER = 'TETHOQ_PAIRING_CONFIRMED';
const CONTROL_PORT_PREFIX = 'TETHOQ_COMPANION_CONTROL_PORT=';

function hasPairingConfirmedMarker(output) {
  return new RegExp(`(?:^|\\r?\\n)${PAIRING_CONFIRMED_MARKER}(?:\\r?\\n|$)`).test(output);
}

function isSafePairingPageUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:'
      && parsed.hostname === '127.0.0.1'
      && /^\/pair\/[A-Za-z0-9_-]{20,128}$/.test(parsed.pathname)
      && parsed.username === ''
      && parsed.password === ''
      && parsed.search === ''
      && parsed.hash === '';
  } catch {
    return false;
  }
}

function resolveBridgeRuntime({ resourcesPath, configuredPath, fallbackExecutable = process.execPath } = {}) {
  const candidates = [
    configuredPath,
    resourcesPath && path.join(resourcesPath, 'bridge', 'runtime', 'node.exe'),
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? fallbackExecutable;
}

function resolveBridgeEntrypoint({ resourcesPath, dirname = __dirname, configuredPath } = {}) {
  const candidates = [
    configuredPath,
    resourcesPath && path.join(resourcesPath, 'bridge', 'app', 'apps', 'agent_bridge', 'src', 'main.js'),
    resourcesPath && path.join(resourcesPath, 'bridge', 'src', 'main.js'),
    path.resolve(dirname, '..', '..', '..', 'dist', 'apps', 'agent_bridge', 'src', 'main.js'),
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate));
}

function pairingQrDataUrl(html) {
  if (typeof html !== 'string' || Buffer.byteLength(html, 'utf8') > MAX_PAIRING_PAGE_BYTES) {
    throw new Error('The local pairing page was invalid.');
  }
  const container = html.match(/<div class="qr">\s*(<svg[\s\S]*?<\/svg>)\s*<\/div>/);
  if (!container) throw new Error('The local pairing page did not contain a QR code.');
  const svg = container[1].trim();
  const match = svg.match(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 ([1-9]\d{0,3}) \1" shape-rendering="crispEdges"><path fill="#ffffff" d="([^"]{1,65536})"\/><path stroke="#000000" d="([^"]{1,65536})"\/><\/svg>$/);
  if (!match || !/^[MmLlHhVvZz0-9.\s-]+$/.test(match[2]) || !/^[MmLlHhVvZz0-9.\s-]+$/.test(match[3])) {
    throw new Error('The local pairing QR code was invalid.');
  }
  const size = match[1];
  const sanitized = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><path fill="#ffffff" d="${match[2]}"/><path stroke="#000000" d="${match[3]}"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(sanitized, 'utf8').toString('base64')}`;
}

async function fetchPairingQrDataUrl(pageUrl, fetchPage = globalThis.fetch) {
  if (!isSafePairingPageUrl(pageUrl) || typeof fetchPage !== 'function') {
    throw new Error('The local pairing page address was invalid.');
  }
  const response = await fetchPage(pageUrl, {
    method: 'GET',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error('The local pairing page could not be loaded.');
  const contentType = response.headers?.get?.('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('text/html')) {
    throw new Error('The local pairing page returned an unexpected response.');
  }
  return pairingQrDataUrl(await response.text());
}

function requestCompanionControl({ port, token, method = 'GET', pathname, signal, timeoutMs = CONTROL_REQUEST_TIMEOUT_MS }) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return Promise.reject(new Error('The Bridge control address was invalid.'));
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !['GET', 'POST'].includes(method) || !/^\/[a-z/]+$/.test(pathname)) {
    return Promise.reject(new Error('The Bridge control request was invalid.'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const request = http.request({
      protocol: 'http:',
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      agent: false,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        ...(method === 'POST' ? { 'content-length': '0' } : {}),
      },
    }, (response) => {
      let bytes = 0;
      const chunks = [];
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_CONTROL_RESPONSE_BYTES) {
          request.destroy(new Error('The Bridge control response was too large.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        let value;
        try {
          value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          finish(new Error('The Bridge control response was invalid.'));
          return;
        }
        if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
          const message = value && typeof value.message === 'string' ? value.message : 'The Bridge rejected the request.';
          finish(new Error(message));
          return;
        }
        finish(undefined, value);
      });
    });
    const onAbort = () => request.destroy(new Error('The Bridge control request was cancelled.'));
    signal?.addEventListener('abort', onAbort, { once: true });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('The Bridge control request timed out.')));
    request.once('error', (error) => finish(error));
    if (signal?.aborted) onAbort();
    else request.end();
  });
}

class PairingProcessManager {
  constructor({
    executable,
    entrypoint,
    cloudflaredPath,
    electronRuntime = executable === process.execPath,
    spawnProcess = spawn,
    now = Date.now,
    stopProcess,
    fetchPage,
    controlRequest,
    onProgress,
    onStateChange,
    restartBaseDelayMs = RESTART_BASE_DELAY_MS,
    restartMaxDelayMs = RESTART_MAX_DELAY_MS,
    shutdownGraceMs = 2_500,
  } = {}) {
    this.executable = executable;
    this.entrypoint = entrypoint;
    this.cloudflaredPath = cloudflaredPath;
    this.electronRuntime = electronRuntime;
    this.spawnProcess = spawnProcess;
    this.now = now;
    this.stopProcess = stopProcess ?? stopChildProcess;
    this.fetchPage = fetchPage ?? globalThis.fetch;
    this.controlRequest = controlRequest ?? requestCompanionControl;
    this.onProgress = onProgress;
    this.onStateChange = onStateChange;
    this.restartBaseDelayMs = restartBaseDelayMs;
    this.restartMaxDelayMs = restartMaxDelayMs;
    this.shutdownGraceMs = shutdownGraceMs;
    this.child = undefined;
    this.engineStartPromise = undefined;
    this.pairStartPromise = undefined;
    this.pairAbort = undefined;
    this.controlPort = undefined;
    this.controlToken = undefined;
    this.ready = undefined;
    this.paired = false;
    this.pairErrorMessage = undefined;
    this.engineState = 'stopped';
    this.errorMessage = undefined;
    this.restartAttempts = 0;
    this.restartTimer = undefined;
    this.engineStartedAt = undefined;
    this.pairingPollTimer = undefined;
    this.shuttingDown = false;
    this.generation = 0;
  }

  status() {
    if (this.paired) return { state: 'paired' };
    if (this.ready && Date.parse(this.ready.expiresAt) > this.now()) {
      return { state: 'ready', expiresAt: this.ready.expiresAt, qrDataUrl: this.ready.qrDataUrl };
    }
    if (this.pairStartPromise) return { state: 'starting' };
    if (this.pairErrorMessage) return { state: 'error', message: this.pairErrorMessage };
    if (this.engineState === 'error') return { state: 'error', message: this.errorMessage ?? 'The Bridge engine could not start.' };
    return { state: this.engineState };
  }

  async startEngine() {
    if (this.shuttingDown) throw new Error('The Bridge is shutting down.');
    if (this.child && this.controlPort && this.engineState === 'running') return this.status();
    if (this.engineStartPromise) return this.engineStartPromise;
    if (!this.executable || !this.entrypoint) {
      const error = new Error('The Tethoq Bridge engine is not installed. Reinstall Tethoq Bridge and try again.');
      this.#setEngineError(error.message);
      throw error;
    }
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    this.engineState = this.restartAttempts > 0 ? 'restarting' : 'booting';
    this.errorMessage = undefined;
    this.#notifyStateChange();
    const generation = ++this.generation;
    this.engineStartPromise = this.#spawnEngine(generation);
    try {
      await this.engineStartPromise;
      if (generation !== this.generation || this.shuttingDown) throw new Error('The Bridge startup was cancelled.');
      this.engineState = 'running';
      this.engineStartedAt = this.now();
      this.errorMessage = undefined;
      this.#notifyStateChange();
      return this.status();
    } catch (error) {
      if (!this.shuttingDown && generation === this.generation) {
        const child = this.child;
        this.child = undefined;
        this.controlPort = undefined;
        this.controlToken = undefined;
        if (child) void this.stopProcess(child);
        this.#scheduleRestart(error);
      }
      throw error;
    } finally {
      if (generation === this.generation) this.engineStartPromise = undefined;
    }
  }

  async abortStarting() {
    if (this.pairStartPromise) {
      const pending = this.pairStartPromise;
      await this.cancel();
      await pending.catch(() => undefined);
    }
    return this.status();
  }

  async start() {
    if (this.ready && Date.parse(this.ready.expiresAt) > this.now()) return this.ready;
    if (this.pairStartPromise) return this.pairStartPromise;
    await this.startEngine();
    this.paired = false;
    this.errorMessage = undefined;
    this.pairErrorMessage = undefined;
    const generation = this.generation;
    const abort = new AbortController();
    this.pairAbort = abort;
    this.onProgress?.('Creating a secure phone connection...');
    this.pairStartPromise = (async () => {
      try {
        const launched = await this.#requestControl('POST', '/pair/start', abort.signal);
        if (generation !== this.generation || abort.signal.aborted) throw new Error('Pairing was cancelled.');
        if (!launched || launched.state !== 'ready' || !isSafePairingPageUrl(launched.pageUrl)) {
          throw new Error('The Bridge returned an invalid pairing response.');
        }
        const expiresAtMs = Date.parse(launched.expiresAt);
        if (!Number.isFinite(expiresAtMs) || expiresAtMs <= this.now()) {
          throw new Error('The Bridge returned an expired pairing code.');
        }
        this.onProgress?.('Verifying the phone connection...');
        const qrDataUrl = await fetchPairingQrDataUrl(launched.pageUrl, this.fetchPage);
        if (generation !== this.generation || abort.signal.aborted) throw new Error('Pairing was cancelled.');
        this.ready = { pageUrl: launched.pageUrl, expiresAt: new Date(expiresAtMs).toISOString(), qrDataUrl };
        this.#schedulePairingPoll();
        this.#notifyStateChange();
        return this.ready;
      } catch (error) {
        if (!abort.signal.aborted && generation === this.generation) {
          this.pairErrorMessage = error instanceof Error ? error.message : 'Pairing could not be started.';
        }
        throw error;
      } finally {
        if (this.pairAbort === abort) this.pairAbort = undefined;
        this.pairStartPromise = undefined;
        this.#notifyStateChange();
      }
    })();
    this.#notifyStateChange();
    return this.pairStartPromise;
  }

  async cancel() {
    const pending = this.pairStartPromise;
    const abort = this.pairAbort;
    this.pairAbort = undefined;
    abort?.abort();
    clearTimeout(this.pairingPollTimer);
    this.pairingPollTimer = undefined;
    this.ready = undefined;
    this.paired = false;
    this.pairErrorMessage = undefined;
    if (this.controlPort && this.controlToken && this.child) {
      await this.#requestControl('POST', '/pair/cancel').catch(() => undefined);
    }
    await pending?.catch(() => undefined);
    if (this.child && this.controlPort) {
      this.engineState = 'running';
      this.errorMessage = undefined;
    }
    this.#notifyStateChange();
  }

  async shutdown() {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    ++this.generation;
    clearTimeout(this.restartTimer);
    clearTimeout(this.pairingPollTimer);
    this.restartTimer = undefined;
    this.pairingPollTimer = undefined;
    this.pairAbort?.abort();
    this.pairAbort = undefined;
    const child = this.child;
    if (child && this.controlPort && this.controlToken) {
      await this.#requestControl('POST', '/shutdown', undefined, 2_000).catch(() => undefined);
      await waitForChildExit(child, this.shutdownGraceMs);
    }
    if (child && child.exitCode === null && !child.killed) await this.stopProcess(child);
    this.child = undefined;
    this.controlPort = undefined;
    this.controlToken = undefined;
    this.ready = undefined;
    this.paired = false;
    this.pairErrorMessage = undefined;
    this.engineStartedAt = undefined;
    this.engineState = 'stopped';
    this.errorMessage = undefined;
    this.#notifyStateChange();
  }

  #requestControl(method, pathname, signal, timeoutMs) {
    if (!this.controlPort || !this.controlToken) return Promise.reject(new Error('The Bridge control service is not ready.'));
    return this.controlRequest({ port: this.controlPort, token: this.controlToken, method, pathname, signal, timeoutMs });
  }

  #spawnEngine(generation) {
    return new Promise((resolve, reject) => {
      const token = randomBytes(32).toString('base64url');
      const env = {
        ...process.env,
        TETHOQ_COMPANION_CONTROL_TOKEN: token,
        UAR_BRIDGE_HOST: '127.0.0.1',
        UAR_BRIDGE_PORT: '0',
        ...(this.cloudflaredPath ? { UAR_CLOUDFLARED_COMMAND: this.cloudflaredPath } : {}),
      };
      if (this.electronRuntime) env.ELECTRON_RUN_AS_NODE = '1';
      else delete env.ELECTRON_RUN_AS_NODE;
      const child = this.spawnProcess(
        this.executable,
        [this.entrypoint, '--companion-control', '--host', '127.0.0.1', '--port', '0'],
        {
          cwd: path.dirname(this.entrypoint),
          env,
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      this.child = child;
      this.controlToken = token;
      let settled = false;
      let startupSucceeded = false;
      let lineBuffer = '';
      const timeout = setTimeout(() => finish(new Error('The Tethoq Bridge engine took too long to start.')), START_TIMEOUT_MS);
      timeout.unref?.();
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else {
          startupSucceeded = true;
          resolve(value);
        }
      };
      const inspectLine = (line) => {
        if (!line.startsWith(CONTROL_PORT_PREFIX)) return;
        const value = line.slice(CONTROL_PORT_PREFIX.length);
        if (!/^\d{1,5}$/.test(value)) return;
        const port = Number(value);
        if (port < 1 || port > 65_535 || generation !== this.generation || this.child !== child) return;
        this.controlPort = port;
        this.controlToken = token;
        void this.#requestControl('GET', '/status', undefined, 5_000).then(
          (status) => finish(undefined, status),
          () => finish(new Error('The Tethoq Bridge control service did not become ready.')),
        );
      };
      child.stdout?.on('data', (chunk) => {
        lineBuffer = (lineBuffer + chunk.toString('utf8')).slice(-4096);
        const lines = lineBuffer.split(/\r?\n/);
        lineBuffer = lines.pop() ?? '';
        for (const line of lines) inspectLine(line);
      });
      child.stderr?.on('data', () => {});
      child.once('error', () => {
        if (!startupSucceeded) finish(new Error('Tethoq could not start the local Bridge engine.'));
        else this.#handleUnexpectedExit(child, 'error', generation);
      });
      child.once('exit', (code) => {
        if (!startupSucceeded) finish(new Error(`The Bridge engine stopped before it was ready (code ${code ?? 'unknown'}).`));
        else this.#handleUnexpectedExit(child, code, generation);
      });
    });
  }

  #handleUnexpectedExit(child, code, generation) {
    if (this.child !== child || generation !== this.generation) return;
    this.child = undefined;
    this.controlPort = undefined;
    this.controlToken = undefined;
    this.ready = undefined;
    this.paired = false;
    this.pairErrorMessage = undefined;
    if (this.engineStartedAt !== undefined && this.now() - this.engineStartedAt >= STABLE_ENGINE_WINDOW_MS) {
      this.restartAttempts = 0;
    }
    this.engineStartedAt = undefined;
    clearTimeout(this.pairingPollTimer);
    this.pairingPollTimer = undefined;
    if (this.shuttingDown) return;
    this.#scheduleRestart(new Error(`The Bridge engine stopped unexpectedly (code ${code ?? 'unknown'}).`));
  }

  #scheduleRestart(error) {
    if (this.shuttingDown || this.restartTimer) return;
    if (this.restartAttempts >= MAX_RESTART_ATTEMPTS) {
      this.#setEngineError(`${error instanceof Error ? error.message : String(error)} Restart Tethoq Bridge to try again.`);
      return;
    }
    const delay = Math.min(this.restartMaxDelayMs, this.restartBaseDelayMs * (2 ** this.restartAttempts));
    this.restartAttempts += 1;
    this.engineState = 'restarting';
    this.errorMessage = 'The Bridge engine stopped. Restarting it now.';
    this.#notifyStateChange();
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.startEngine().catch(() => undefined);
    }, delay);
    this.restartTimer.unref?.();
  }

  #schedulePairingPoll() {
    clearTimeout(this.pairingPollTimer);
    if (!this.ready || this.shuttingDown) return;
    const delay = Math.min(1_000, Math.max(0, Date.parse(this.ready.expiresAt) - this.now()));
    this.pairingPollTimer = setTimeout(() => {
      this.pairingPollTimer = undefined;
      void this.#pollPairingStatus();
    }, delay);
    this.pairingPollTimer.unref?.();
  }

  async #pollPairingStatus() {
    if (!this.ready || this.shuttingDown) return;
    if (Date.parse(this.ready.expiresAt) <= this.now()) {
      await this.cancel();
      return;
    }
    try {
      const status = await this.#requestControl('GET', '/status', undefined, 5_000);
      if (status?.pairingState === 'paired') {
        this.paired = true;
        this.ready = undefined;
        this.errorMessage = undefined;
        this.pairErrorMessage = undefined;
        this.#notifyStateChange();
        return;
      }
    } catch {
      // The child exit handler owns engine recovery; a transient status miss is harmless.
    }
    this.#schedulePairingPoll();
  }

  #setEngineError(message) {
    this.engineState = 'error';
    this.errorMessage = message;
    this.#notifyStateChange();
  }

  #notifyStateChange() {
    this.onStateChange?.(this.status());
  }
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.killed || timeoutMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, timeoutMs);
    function done() {
      clearTimeout(timeout);
      child.off?.('exit', done);
      resolve();
    }
    child.once?.('exit', done);
  });
}

async function stopChildProcess(child) {
  if (child.exitCode !== null || child.killed) return;
  if (process.platform === 'win32' && Number.isInteger(child.pid)) {
    await new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.once('error', resolve);
      killer.once('exit', resolve);
    });
    return;
  }
  child.kill('SIGTERM');
}

module.exports = {
  CONTROL_PORT_PREFIX,
  PAIRING_CONFIRMED_MARKER,
  PairingProcessManager,
  fetchPairingQrDataUrl,
  hasPairingConfirmedMarker,
  isSafePairingPageUrl,
  pairingQrDataUrl,
  requestCompanionControl,
  resolveBridgeEntrypoint,
  resolveBridgeRuntime,
};
