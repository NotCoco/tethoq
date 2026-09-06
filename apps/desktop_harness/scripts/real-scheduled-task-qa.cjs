'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const electronExecutable = path.join(appRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const outputArgument = process.argv.slice(2).find((argument) => !argument.startsWith('--'));
const artifactRoot = path.resolve(outputArgument ?? path.join(appRoot, '..', '..', 'local-artifacts', 'real-scheduled-task-qa'));
const workspace = path.join(artifactRoot, 'workspace');
const scheduleDelayMs = 5 * 60_000;
const providerTimeoutMs = 120_000;
const finalTimeoutMs = 5 * 60_000;
const duePresentationSampleIntervalMs = 50;
const windowSampleIntervalMs = 125;
const maximumProviderAcceptanceDelayMs = 30_000;
const maximumProviderAcceptanceSkewMs = 30_000;
const windowWatcherReadyMarker = 'TETHOQ_QA_WINDOW_WATCHER_READY';
const windowWatcherCompleteMarker = 'TETHOQ_QA_WINDOW_WATCHER_COMPLETE';
const windowWatcherRunningMarker = 'TETHOQ_QA_WINDOW_WATCHER_RUNNING';
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const topLevelWindowTypeDefinition = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class TethoqQaTopLevelWindows
{
    private delegate bool EnumWindowsCallback(IntPtr handle, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr handle);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextLength(IntPtr handle);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr handle, StringBuilder text, int maximumCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr handle, StringBuilder className, int maximumCount);

    public sealed class WindowInfo
    {
        public long Handle { get; set; }
        public int ProcessId { get; set; }
        public string ProcessName { get; set; }
        public string Title { get; set; }
        public string ClassName { get; set; }
    }

    public static WindowInfo[] VisibleFor(int[] processIds)
    {
        var targets = new HashSet<uint>();
        if (processIds != null)
        {
            foreach (var processId in processIds)
            {
                if (processId > 0) targets.Add((uint)processId);
            }
        }

        var visible = new List<WindowInfo>();
        EnumWindows(delegate (IntPtr handle, IntPtr parameter)
        {
            uint processId;
            GetWindowThreadProcessId(handle, out processId);
            if (!targets.Contains(processId) || !IsWindowVisible(handle)) return true;

            var title = new StringBuilder(Math.Max(1, GetWindowTextLength(handle) + 1));
            GetWindowText(handle, title, title.Capacity);
            var className = new StringBuilder(256);
            GetClassName(handle, className, className.Capacity);
            string processName;
            try { processName = Process.GetProcessById((int)processId).ProcessName; }
            catch { processName = "<exited>"; }
            visible.Add(new WindowInfo
            {
                Handle = handle.ToInt64(),
                ProcessId = (int)processId,
                ProcessName = processName,
                Title = title.ToString(),
                ClassName = className.ToString()
            });
            return true;
        }, IntPtr.Zero);
        return visible.ToArray();
    }
}`;
const encodedTopLevelWindowTypeDefinition = Buffer.from(topLevelWindowTypeDefinition, 'utf16le').toString('base64');

function execFileAsync(executable, arguments_, options) {
  return new Promise((resolve, reject) => {
    execFile(executable, arguments_, options, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

const specifications = {
  codex: {
    token: 'SCHEDULED_OK_CODEX',
    preferredModels: ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'],
    preferredEffort: 'low',
  },
  opencode: {
    token: 'SCHEDULED_OK_OPENCODE',
    preferredModels: ['opencode-go/deepseek-v4-pro', 'opencode-go/deepseek-v4-flash'],
    preferredEffort: 'high',
  },
  grok: {
    token: 'SCHEDULED_OK_GROK',
    preferredModels: ['grok-4.6', 'grok-4.5'],
    preferredEffort: 'low',
  },
};

function formatError(error) {
  if (error instanceof AggregateError) {
    return [error.stack ?? error.message, ...error.errors.map((entry) => formatError(entry))].join('\nCaused by: ');
  }
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

async function waitFor(operation, description, timeoutMs = 30_000, intervalMs = 125) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  throw new Error(`${description} timed out${lastError ? `: ${formatError(lastError)}` : ''}`);
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function visibleTopLevelWindows(processIds) {
  assert.ok(Array.isArray(processIds) && processIds.every((processId) => Number.isInteger(processId) && processId > 0));
  const command = `$ErrorActionPreference = 'Stop'; Add-Type -TypeDefinition ([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedTopLevelWindowTypeDefinition}'))); $processIds = [int[]]@(${processIds.join(',')}); $visible = @([TethoqQaTopLevelWindows]::VisibleFor($processIds)); ConvertTo-Json -InputObject @($visible) -Compress`;
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true,
    timeout: 10_000,
  });
  const parsed = JSON.parse(stdout.trim());
  return Array.isArray(parsed) ? parsed : [parsed];
}

function startTopLevelWindowWatcher(processId, label) {
  assert.ok(Number.isInteger(processId) && processId > 0);
  const command = `$ErrorActionPreference = 'Stop'; Add-Type -TypeDefinition ([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedTopLevelWindowTypeDefinition}'))); $rootProcessId = ${processId}; $root = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $rootProcessId) -ErrorAction Stop; if (-not $root) { [Console]::Error.WriteLine('${windowWatcherReadyMarker}'); [Console]::Error.WriteLine('${windowWatcherCompleteMarker} samples=0 tracked=0 root=missing'); exit 0 }; $trackedProcessInstances = @{}; $trackedProcessInstances[$rootProcessId] = ([DateTime]$root.CreationDate).ToUniversalTime().Ticks; $sampleCount = 0; [Console]::Error.WriteLine('${windowWatcherReadyMarker}'); while ($true) { $sampleCount += 1; $rows = @(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId, ParentProcessId, CreationDate); $rowsById = @{}; foreach ($row in $rows) { $rowsById[[int]$row.ProcessId] = $row }; foreach ($trackedProcessId in @($trackedProcessInstances.Keys)) { $row = $rowsById[[int]$trackedProcessId]; if ($null -eq $row -or ([DateTime]$row.CreationDate).ToUniversalTime().Ticks -ne $trackedProcessInstances[$trackedProcessId]) { $trackedProcessInstances.Remove($trackedProcessId) } }; do { $added = $false; foreach ($row in $rows) { $parentId = [int]$row.ParentProcessId; if (-not $trackedProcessInstances.ContainsKey($parentId)) { continue }; $parent = $rowsById[$parentId]; if ($null -eq $parent) { continue }; $childCreated = ([DateTime]$row.CreationDate).ToUniversalTime().Ticks; $parentCreated = ([DateTime]$parent.CreationDate).ToUniversalTime().Ticks; $childId = [int]$row.ProcessId; if ($childCreated -ge $parentCreated -and -not $trackedProcessInstances.ContainsKey($childId)) { $trackedProcessInstances[$childId] = $childCreated; $added = $true } } } while ($added); $runningProcessIds = @($trackedProcessInstances.Keys | ForEach-Object { [int]$_ }); if (($sampleCount % 80) -eq 0) { $runningSummary = @($runningProcessIds | ForEach-Object { $process = Get-Process -Id $_ -ErrorAction SilentlyContinue; if ($process) { [string]$_ + ':' + $process.ProcessName } }); [Console]::Error.WriteLine('${windowWatcherRunningMarker} ' + ($runningSummary -join ',')) }; $visible = @([TethoqQaTopLevelWindows]::VisibleFor([int[]]$runningProcessIds)); if ($visible.Count -gt 0) { ConvertTo-Json -InputObject @($visible) -Compress; exit 9 }; if ($runningProcessIds.Count -eq 0) { [Console]::Error.WriteLine('${windowWatcherCompleteMarker} samples=' + $sampleCount + ' tracked=' + $trackedProcessInstances.Count); exit 0 }; Start-Sleep -Milliseconds ${windowSampleIntervalMs} }`;
  const watcher = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    label,
    rootProcessId: processId,
    child: watcher,
    stdout: processCapture(watcher.stdout),
    stderr: processCapture(watcher.stderr),
  };
}

async function waitForTopLevelWindowWatcherReady(watcher) {
  await waitFor(() => {
    if (watcher.stderr().includes(windowWatcherReadyMarker)) return true;
    if (watcher.child.exitCode !== null || watcher.child.signalCode !== null) {
      throw new Error(`${watcher.label} top-level-window watcher exited before becoming ready: ${watcher.stderr().trim() || `exit ${watcher.child.exitCode}`}`);
    }
    return false;
  }, `${watcher.label} top-level-window watcher readiness`, 15_000, 50);
}

function assertTopLevelWindowsHidden(watcher, application, checkpoint) {
  const visible = watcher.stdout().trim();
  assert.equal(visible, '', `A ${watcher.label} root or descendant opened a visible top-level window during ${checkpoint}: ${visible}`);
  if (watcher.child.exitCode !== null && application.exitCode === null && application.signalCode === null) {
    throw new Error(`The ${watcher.label} top-level-window watcher stopped during ${checkpoint}: ${watcher.stderr().trim() || `exit ${watcher.child.exitCode}`}`);
  }
}

async function waitForProcessExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

function watcherSummary(watcher) {
  const visibleWindows = watcher.stdout().trim()
    ? watcher.stdout().trim().split(/\r?\n/u).flatMap((line) => {
      const parsed = JSON.parse(line);
      return Array.isArray(parsed) ? parsed : [parsed];
    })
    : [];
  return {
    label: watcher.label,
    rootProcessId: watcher.rootProcessId,
    sampleIntervalMs: windowSampleIntervalMs,
    exitCode: watcher.child.exitCode,
    signalCode: watcher.child.signalCode,
    visibleWindows,
    diagnostics: watcher.stderr().trim().split(/\r?\n/u).filter((line) => line && line !== windowWatcherReadyMarker),
  };
}

async function finishTopLevelWindowWatcher(watcher, timeoutMs = 20_000) {
  if (!watcher) return null;
  const errors = [];
  if (!await waitForProcessExit(watcher.child, timeoutMs)) {
    errors.push(new Error(`${watcher.label} top-level-window watcher did not observe the complete process tree exit within ${timeoutMs} ms.`));
    watcher.child.kill();
    if (!await waitForProcessExit(watcher.child, 5_000)) {
      errors.push(new Error(`${watcher.label} top-level-window watcher could not be terminated after its timeout.`));
    }
  }
  const summary = watcherSummary(watcher);
  if (summary.visibleWindows.length > 0) {
    errors.push(new Error(`${watcher.label} opened visible top-level windows: ${JSON.stringify(summary.visibleWindows)}`));
  }
  if (watcher.child.exitCode !== 0 && summary.visibleWindows.length === 0) {
    errors.push(new Error(`${watcher.label} top-level-window watcher failed: ${summary.diagnostics.join(' | ') || `exit ${watcher.child.exitCode}, signal ${watcher.child.signalCode}`}`));
  }
  if (watcher.child.exitCode === 0 && !watcher.stderr().includes(windowWatcherCompleteMarker)) {
    errors.push(new Error(`${watcher.label} top-level-window watcher exited without proving complete process-tree shutdown.`));
  }
  if (errors.length > 0) throw new AggregateError(errors, `${watcher.label} top-level-window evidence failed.`);
  return summary;
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    socket.addEventListener('message', (message) => {
      const response = JSON.parse(String(message.data));
      if (!response.id) return;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.error) pending.reject(new Error(response.error.message));
      else pending.resolve(response.result);
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? 'Renderer evaluation failed');
    }
    return response.result?.value;
  }

  async bridgeRequest(type, payload = {}, requestId) {
    const response = await this.evaluate(`window.tethoqDesktop.request(${JSON.stringify(type)}, ${JSON.stringify(payload)}, ${JSON.stringify(requestId)})`);
    if (!response?.ok) throw new Error(response?.error?.message ?? `${type} failed`);
    return response.payload;
  }

  async clickExpression(expression, description, verticalFraction = 0.5) {
    const point = await waitFor(() => this.evaluate(`(async () => {
      const element = ${expression};
      if (!(element instanceof HTMLElement)) return null;
      element.scrollIntoView({ block: 'center', inline: 'nearest' });
      let bounds = element.getBoundingClientRect();
      let previous = bounds;
      let stableSamples = 0;
      for (let sample = 0; sample < 120 && stableSamples < 3; sample += 1) {
        await new Promise((resolve) => setTimeout(resolve, 16));
        bounds = element.getBoundingClientRect();
        const stable = Math.abs(bounds.left - previous.left) < 0.25
          && Math.abs(bounds.top - previous.top) < 0.25
          && Math.abs(bounds.width - previous.width) < 0.25
          && Math.abs(bounds.height - previous.height) < 0.25;
        stableSamples = stable ? stableSamples + 1 : 0;
        previous = bounds;
      }
      const style = getComputedStyle(element);
      return bounds.width > 0 && bounds.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
        ? { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height * ${verticalFraction} }
        : null;
    })()`), description);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
  }

  async insertText(text) {
    await this.send('Input.insertText', { text });
  }

  async screenshot(targetPath) {
    const response = await this.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      optimizeForSpeed: true,
    });
    await writeFile(targetPath, Buffer.from(response.data, 'base64'));
  }

  async close() {
    for (const pending of this.pending.values()) pending.reject(new Error('CDP connection closed'));
    this.pending.clear();
    this.socket.close();
  }
}

async function connectCdp(port) {
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2_000) });
    const targets = await response.json();
    return targets.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl && /^file:/iu.test(entry.url ?? '')) ?? null;
  }, 'hidden Tethoq renderer', 60_000, 200);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const client = new CdpClient(socket);
  await Promise.all([client.send('Runtime.enable'), client.send('Page.enable')]);
  return client;
}

function processCapture(stream, maximumBytes = 64 * 1024) {
  let captured = '';
  stream?.setEncoding('utf8');
  stream?.on('data', (chunk) => {
    captured = `${captured}${chunk}`.slice(-maximumBytes);
  });
  return () => captured;
}

async function stopApplication(child, userData, applicationWindowWatcher) {
  const errors = [];
  let stopper;
  let stopperWindowWatcher;
  let stopperLaunchError;
  let stopperStdout = () => '';
  let stopperStderr = () => '';
  let stopperInitialVisibleWindows = [];
  let forcedApplicationTermination = false;
  let forcedStopperTermination = false;

  if (child.exitCode === null && child.signalCode === null) {
    stopper = spawn(electronExecutable, [appRoot, `--user-data-dir=${userData}`, '--hidden', '--quit-other', '--stop-managed-opencode'], {
      cwd: appRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    stopperStdout = processCapture(stopper.stdout);
    stopperStderr = processCapture(stopper.stderr);
    stopper.once('error', (error) => { stopperLaunchError = error; });
    if (Number.isInteger(stopper.pid) && stopper.pid > 0) {
      stopperWindowWatcher = startTopLevelWindowWatcher(stopper.pid, 'hidden quit-helper Electron process tree');
      try {
        await waitForTopLevelWindowWatcherReady(stopperWindowWatcher);
        stopperInitialVisibleWindows = await visibleTopLevelWindows([stopper.pid]);
        if (stopperInitialVisibleWindows.length > 0) {
          errors.push(new Error(`The hidden quit-helper opened visible top-level windows: ${JSON.stringify(stopperInitialVisibleWindows)}`));
        }
      } catch (error) {
        errors.push(error);
      }
    }

    if (!await waitForProcessExit(stopper, 10_000)) {
      forcedStopperTermination = true;
      errors.push(new Error('The hidden quit-helper did not exit within 10000 ms.'));
      stopper.kill();
      if (!await waitForProcessExit(stopper, 5_000)) {
        errors.push(new Error('The hidden quit-helper remained alive after forced termination.'));
      }
    }
    if (stopperLaunchError) errors.push(new Error(`The hidden quit-helper failed to launch: ${formatError(stopperLaunchError)}`));
    if (!forcedStopperTermination && stopper.exitCode !== 0) {
      errors.push(new Error(`The hidden quit-helper exited abnormally: exit ${stopper.exitCode}, signal ${stopper.signalCode}; ${stopperStderr().trim()}`));
    }

    if (!await waitForProcessExit(child, 15_000)) {
      forcedApplicationTermination = true;
      errors.push(new Error('The isolated Tethoq process did not exit after the graceful quit request within 15000 ms.'));
      child.kill();
      if (!await waitForProcessExit(child, 5_000)) {
        errors.push(new Error('The isolated Tethoq process remained alive after forced termination.'));
      }
    }
  }
  if (!forcedApplicationTermination && (child.exitCode !== 0 || child.signalCode !== null)) {
    errors.push(new Error(`The isolated Tethoq process exited abnormally: exit ${child.exitCode}, signal ${child.signalCode}.`));
  }

  let applicationWindowEvidence;
  let stopperWindowEvidence;
  try {
    applicationWindowEvidence = await finishTopLevelWindowWatcher(applicationWindowWatcher);
  } catch (error) {
    errors.push(error);
  }
  try {
    stopperWindowEvidence = await finishTopLevelWindowWatcher(stopperWindowWatcher);
  } catch (error) {
    errors.push(error);
  }

  const evidence = {
    application: {
      processId: child.pid,
      exitCode: child.exitCode,
      signalCode: child.signalCode,
      forcedTermination: forcedApplicationTermination,
      windowEvidence: applicationWindowEvidence ?? null,
    },
    quitHelper: stopper ? {
      processId: stopper.pid,
      exitCode: stopper.exitCode,
      signalCode: stopper.signalCode,
      forcedTermination: forcedStopperTermination,
      initialVisibleWindows: stopperInitialVisibleWindows,
      windowEvidence: stopperWindowEvidence ?? null,
      stdout: stopperStdout(),
      stderr: stopperStderr(),
    } : null,
  };
  if (errors.length > 0) {
    const error = new AggregateError(errors, 'Hidden application teardown did not complete cleanly.');
    error.evidence = evidence;
    throw error;
  }
  return evidence;
}

function advertisedEfforts(model) {
  const direct = model?.nativeMetadata?.supportedReasoningEfforts;
  if (Array.isArray(direct)) {
    return direct
      .map((entry) => typeof entry === 'string' ? entry : entry?.reasoningEffort)
      .filter((entry) => typeof entry === 'string');
  }
  const variants = model?.nativeMetadata?.variants;
  return variants && typeof variants === 'object' ? Object.keys(variants) : [];
}

function pickModel(providerId, models) {
  const specification = specifications[providerId];
  const model = specification.preferredModels
    .map((id) => models.find((candidate) => candidate.id === id))
    .find(Boolean)
    ?? models.find((candidate) => candidate.isDefault)
    ?? models[0];
  if (!model) return {};
  const efforts = advertisedEfforts(model);
  const reasoningEffort = efforts.includes(specification.preferredEffort)
    ? specification.preferredEffort
    : undefined;
  return {
    model,
    selection: {
      modelId: model.id,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    },
    efforts,
  };
}

async function readScheduleState(statePath) {
  const raw = await readFile(statePath, 'utf8');
  return JSON.parse(raw);
}

async function readScheduleStateIfPresent(statePath) {
  try {
    return await readScheduleState(statePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, tasks: [] };
    throw error;
  }
}

function localDateTimeValue(date) {
  const part = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}T${part(date.getHours())}:${part(date.getMinutes())}`;
}

function scheduledPrompt(qaMarker, token) {
  return `QA marker ${qaMarker}. This deliberately long scheduled instruction verifies that Tethoq preserves the complete optimistic user message instead of substituting a shortened schedule preview while the provider task is materializing. First use your shell tool once to run exactly powershell.exe -NoProfile -Command "Start-Sleep -Seconds 14" so the active UI can be observed without spending model tokens. After it finishes, reply exactly ${token}. Do not modify files or do anything else.`;
}

async function switchTaskListToRecent(cdp) {
  const projectMode = await cdp.evaluate('Boolean(document.querySelector(\'button[aria-label="Arrange tasks by recency"]\'))');
  if (!projectMode) return;
  await cdp.clickExpression('document.querySelector(\'button[aria-label="Arrange tasks by recency"]\')', 'recent task-list mode');
  await waitFor(() => cdp.evaluate('Boolean(document.querySelector(\'button[aria-label="Arrange tasks by project"]\'))'), 'recent task-list mode activation');
}

async function createScheduledTaskThroughComposer(cdp, statePath, input) {
  await selectTask(cdp, { providerId: input.providerId, title: input.sourceSession.title }, input.sourceSession.id);
  await cdp.clickExpression('document.querySelector(\'.new-task-button\')', `${input.providerId} new-task button`);
  const draftSessionId = await waitFor(() => cdp.evaluate(`(() => {
    const selected = document.querySelector('[data-session-id^="draft-"] > .session-row.selected');
    return selected?.parentElement?.getAttribute('data-session-id') ?? null;
  })()`), `${input.providerId} draft task`);
  try {
    await waitFor(() => cdp.evaluate(`(() =>
      document.querySelector('.workspace h1')?.textContent?.trim() === 'New task'
      && document.querySelector('#composer-message')?.getAttribute('placeholder') === 'Describe the task…'
    )()`), `${input.providerId} draft composer`);
  } catch (error) {
    const diagnostics = await cdp.evaluate(`(() => ({
      draftSessionId: ${JSON.stringify(draftSessionId)},
      workspaceTitle: document.querySelector('.workspace h1')?.textContent?.trim() ?? null,
      composerPlaceholder: document.querySelector('#composer-message')?.getAttribute('placeholder') ?? null,
      selectedSessionIds: [...document.querySelectorAll('[data-session-id] > .session-row.selected')]
        .map((node) => node.parentElement?.getAttribute('data-session-id')).filter(Boolean),
      draftSessionIds: [...document.querySelectorAll('[data-session-id^="draft-"]')]
        .map((node) => node.getAttribute('data-session-id')).filter(Boolean),
    }))()`);
    const screenshot = path.join(artifactRoot, `${input.providerId}-draft-composer-failure.png`);
    await cdp.screenshot(screenshot);
    throw new Error(`${input.providerId} draft composer did not materialize: ${JSON.stringify({ diagnostics, screenshot })}`, { cause: error });
  }
  await cdp.clickExpression('document.querySelector(\'#composer-message\')', `${input.providerId} draft composer`);
  await waitFor(() => cdp.evaluate("document.activeElement?.id === 'composer-message'"), `${input.providerId} focused draft composer`);
  await cdp.insertText(`/schedule ${input.prompt}`);
  await waitFor(() => cdp.evaluate(`(() => Boolean(
    document.querySelector('.composer-schedule-panel')
    && document.querySelector('#composer-message')?.value === ${JSON.stringify(input.prompt)}
    && document.activeElement?.matches('.composer-schedule-panel input[type="datetime-local"]') === true
  ))()`), `${input.providerId} composer scheduling command`);
  const commandEvidence = await cdp.evaluate(`(() => ({
    panel: Boolean(document.querySelector('.composer-schedule-panel')),
    content: document.querySelector('#composer-message')?.value ?? null,
    focused: document.activeElement?.matches('.composer-schedule-panel input[type="datetime-local"]') === true,
  }))()`);
  assert.deepEqual(commandEvidence, { panel: true, content: input.prompt, focused: true }, `${input.providerId} /schedule did not open the ordinary composer panel and preserve the exact prompt.`);

  const localValue = localDateTimeValue(new Date(input.runAt));
  await cdp.evaluate(`(() => {
    const field = document.querySelector('.composer-schedule-panel input[type="datetime-local"]');
    if (!(field instanceof HTMLInputElement)) throw new Error('Schedule date field is unavailable');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) throw new Error('Schedule date field setter is unavailable');
    setter.call(field, ${JSON.stringify(localValue)});
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor(() => cdp.evaluate(`(() => {
    const field = document.querySelector('.composer-schedule-panel input[type="datetime-local"]');
    return field?.value === ${JSON.stringify(localValue)}
      && document.querySelector('.composer-schedule-resolved')?.textContent?.trim().startsWith('Runs ')
      && !document.querySelector('.composer-schedule-error');
  })()`), `${input.providerId} local schedule-time parsing`);
  await cdp.clickExpression('document.querySelector(\'.composer-schedule-panel button[type="submit"]\')', `${input.providerId} schedule submit`);

  const scheduledTask = await waitFor(async () => {
    const state = await readScheduleStateIfPresent(statePath);
    const matches = state.tasks.filter((task) => !input.baselineRequestIds.has(task.requestId) && task.content === input.prompt);
    if (matches.length > 1) throw new Error(`${input.providerId} composer scheduling created ${matches.length} durable rows.`);
    return matches[0] ?? null;
  }, `${input.providerId} composer-created durable schedule`, 30_000, 50);
  assert.equal(scheduledTask.providerId, input.providerId, 'Composer scheduling changed harness provider.');
  assert.equal(scheduledTask.runAt, input.runAt, 'Composer scheduling changed the resolved local due time.');
  assert.equal(scheduledTask.targetSessionId, `scheduled-task:${scheduledTask.requestId}`, 'Composer scheduling lost stable placeholder identity.');
  await waitFor(() => cdp.evaluate(`(() => {
    const selected = document.querySelector(${JSON.stringify(`[data-session-id="${scheduledTask.targetSessionId}"] > .session-row.selected`)});
    return Boolean(selected) && !document.querySelector('.composer-schedule-panel') && !document.querySelector('#composer-message');
  })()`), `${input.providerId} composer schedule completion`);
  return {
    draftSessionId,
    commandEvidence,
    localValue,
    scheduledTask,
  };
}

async function selectTask(cdp, task, sessionId) {
  const visibleIdentity = task.qaMarker ?? task.title;
  assert.equal(typeof visibleIdentity === 'string' && visibleIdentity.length > 0, true, `${task.providerId} task selection has no visible identity.`);
  const selector = `[data-session-id=${JSON.stringify(sessionId)}] > .session-row`;
  const rowExpression = `(() => {
    const exact = document.querySelector(${JSON.stringify(selector)});
    if (exact instanceof HTMLElement) return exact;
    const shell = [...document.querySelectorAll('[data-session-id]')]
      .find((candidate) => candidate.textContent?.includes(${JSON.stringify(visibleIdentity)}));
    const row = shell?.querySelector(':scope > .session-row');
    return row instanceof HTMLElement ? row : null;
  })()`;
  try {
    await waitFor(async () => {
      const selectedWorkspace = await cdp.evaluate(`(() => {
        const row = ${rowExpression};
        return row?.classList.contains('selected') === true
          && document.querySelector('.workspace h1')?.textContent?.includes(${JSON.stringify(visibleIdentity)}) === true;
      })()`);
      if (selectedWorkspace) return true;
      await cdp.clickExpression(rowExpression, `${task.providerId} scheduled task row`, 0.18);
      return await cdp.evaluate(`document.querySelector('.workspace h1')?.textContent?.includes(${JSON.stringify(visibleIdentity)}) === true`);
    }, `${task.providerId} task selection`, 10_000, 100);
  } catch (error) {
    const diagnostics = await cdp.evaluate(`(() => {
      const selector = ${JSON.stringify(selector)};
      const row = document.querySelector(selector);
      const bounds = row?.getBoundingClientRect();
      const hit = bounds ? document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2) : null;
      return {
        selector,
        rowExists: Boolean(row),
        rowClass: row?.className ?? null,
        rowAriaCurrent: row?.getAttribute('aria-current') ?? null,
        rowText: row?.textContent?.trim() ?? null,
        rowBounds: bounds ? { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height } : null,
        rowDisplay: row ? getComputedStyle(row).display : null,
        rowVisibility: row ? getComputedStyle(row).visibility : null,
        rowPointerEvents: row ? getComputedStyle(row).pointerEvents : null,
        hitClass: hit instanceof HTMLElement ? hit.className : null,
        hitText: hit?.textContent?.trim()?.slice(0, 240) ?? null,
        selectedSessionIds: [...document.querySelectorAll('[data-session-id] > .session-row.selected')]
          .map((node) => node.parentElement?.getAttribute('data-session-id')).filter(Boolean),
        scheduledSessionIds: [...document.querySelectorAll('[data-session-id^="scheduled-task:"]')]
          .map((node) => node.getAttribute('data-session-id')).filter(Boolean),
        workspaceTitle: document.querySelector('.workspace h1')?.textContent?.trim() ?? null,
      };
    })()`);
    const screenshot = path.join(artifactRoot, `selection-failure-${task.providerId}.png`);
    await cdp.screenshot(screenshot);
    throw new Error(`${task.providerId} task selection failed: ${JSON.stringify({ diagnostics, screenshot })}`, { cause: error });
  }
  await waitFor(() => cdp.evaluate(`document.querySelector('.workspace h1')?.textContent?.includes(${JSON.stringify(visibleIdentity)}) === true`), `${task.providerId} workspace title`);
}

function visibleErrorSurfaceExpression() {
  return `(() => [...document.querySelectorAll('.toast-error, .timeline-error-notice')]
    .filter((node) => {
      const style = getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0;
    })
    .map((node) => node.textContent?.trim() ?? '')
    .filter(Boolean))()`;
}

async function pendingEvidence(cdp, task) {
  await selectTask(cdp, task, task.pendingSessionId);
  const evidence = await waitFor(() => cdp.evaluate(`(() => {
    const notice = document.querySelector('.scheduled-task-notice');
    if (notice?.getAttribute('data-status') !== 'pending') return null;
    const matchingUsers = [...document.querySelectorAll('.message-user .message-body')]
      .filter((node) => node.textContent?.trim() === ${JSON.stringify(task.prompt)}).length;
    return {
      status: notice.getAttribute('data-status'),
      noticeText: notice.textContent?.trim() ?? '',
      matchingUsers,
      emptyStateVisible: [...document.querySelectorAll('.conversation *')].some((node) => node.textContent?.trim() === 'No messages yet'),
      placeholderRows: document.querySelectorAll(${JSON.stringify(`[data-session-id="${task.pendingSessionId}"]`)}).length,
      visibleErrors: ${visibleErrorSurfaceExpression()},
    };
  })()`), `${task.providerId} pending schedule surface`, 20_000);
  assert.equal(evidence.matchingUsers, 0, `${task.providerId} painted the future instruction before dispatch.`);
  assert.equal(evidence.placeholderRows, 1, `${task.providerId} did not paint exactly one scheduled placeholder row.`);
  assert.deepEqual(evidence.visibleErrors, [], `${task.providerId} showed an error while opening a pending scheduled task.`);
  await cdp.screenshot(path.join(artifactRoot, `pending-${task.providerId}.png`));
  return evidence;
}

async function duePresentationSample(cdp, tasks) {
  const configuration = tasks.map((task) => ({
    providerId: task.providerId,
    qaMarker: task.qaMarker,
    pendingSessionId: task.pendingSessionId,
    prompt: task.prompt,
    token: task.token,
  }));
  return await cdp.evaluate(`(() => {
    const tasks = ${JSON.stringify(configuration)};
    const shells = [...document.querySelectorAll('[data-session-id]')];
    const selectedShell = shells.find((shell) => shell.querySelector(':scope > .session-row.selected')) ?? null;
    const workspaceTitle = document.querySelector('.workspace h1')?.textContent ?? '';
    const selectedTask = selectedShell && workspaceTitle
      ? tasks.find((task) => selectedShell.textContent?.includes(task.qaMarker) && workspaceTitle.includes(task.qaMarker)) ?? null
      : null;
    const taskRows = Object.fromEntries(tasks.map((task) => {
      const matching = shells.filter((shell) => shell.textContent?.includes(task.qaMarker));
      return [task.providerId, {
        rowIds: matching.map((shell) => shell.getAttribute('data-session-id')).filter(Boolean),
        placeholderRows: matching.filter((shell) => shell.getAttribute('data-session-id') === task.pendingSessionId).length,
        materializedRows: matching.filter((shell) => shell.getAttribute('data-session-id') !== task.pendingSessionId).length,
      }];
    }));
    const visibleErrors = ${visibleErrorSurfaceExpression()};
    if (!selectedTask) return { sampledAt: new Date().toISOString(), taskRows, visibleErrors, selected: null };
    const userBodies = [...document.querySelectorAll('.message-user .message-body')]
      .map((node) => node.textContent?.trim() ?? '')
      .filter(Boolean);
    const assistantBodies = [...document.querySelectorAll('.message-assistant .message-body')]
      .map((node) => node.textContent?.trim() ?? '')
      .filter(Boolean);
    const finalAssistantBodies = [...document.querySelectorAll('.message-assistant')]
      .filter((node) => node.querySelector('.assistant-identity[data-mode="final"]'))
      .map((node) => node.querySelector('.message-body')?.textContent?.trim() ?? '')
      .filter(Boolean);
    const busy = Boolean(document.querySelector('.reasoning-group[aria-busy="true"], .message-assistant[aria-busy="true"]'));
    const shimmer = Boolean(document.querySelector('.reasoning-group.working-pulse[aria-busy="true"]'));
    return {
      sampledAt: new Date().toISOString(),
      taskRows,
      visibleErrors,
      selected: {
        providerId: selectedTask.providerId,
        sessionId: selectedShell.getAttribute('data-session-id'),
        userBodies,
        assistantBodies,
        finalAssistantBodies,
        exactUserCount: userBodies.filter((text) => text === selectedTask.prompt).length,
        exactAssistantCount: assistantBodies.filter((text) => text === selectedTask.token).length,
        exactFinalAssistantCount: finalAssistantBodies.filter((text) => text === selectedTask.token).length,
        busy,
        shimmer,
        scheduleNotice: document.querySelector('.scheduled-task-notice')?.getAttribute('data-status') ?? null,
        emptyStateVisible: [...document.querySelectorAll('.conversation *')].some((node) => node.textContent?.trim() === 'No messages yet'),
      },
    };
  })()`);
}

function isStartedScreenshotTarget(sample, task, sessionId) {
  const selected = sample.selected;
  return selected?.providerId === task.providerId
    && selected.sessionId === sessionId
    && sessionId !== task.pendingSessionId
    && selected.exactUserCount === 1
    && selected.busy
    && selected.shimmer
    && selected.scheduleNotice !== 'failed'
    && sample.taskRows[task.providerId].placeholderRows === 0
    && sample.taskRows[task.providerId].materializedRows === 1;
}

async function captureStartedScreenshots(cdp, tasks, evidence) {
  for (const task of tasks) {
    const targetPath = path.join(artifactRoot, `started-${task.providerId}.png`);
    let lastEvidence = null;
    let captured = false;
    for (let attempt = 1; attempt <= 2 && !captured; attempt += 1) {
      const targetSessionId = await waitFor(async () => {
        const sample = await duePresentationSample(cdp, tasks);
        const row = sample.taskRows[task.providerId];
        return row.placeholderRows === 0 && row.materializedRows === 1
          ? row.rowIds.find((sessionId) => sessionId !== task.pendingSessionId) ?? null
          : null;
      }, `${task.providerId} materialized row for started screenshot`, 10_000, 25);
      await selectTask(cdp, task, targetSessionId);
      const before = await waitFor(async () => {
        const sample = await duePresentationSample(cdp, tasks);
        return isStartedScreenshotTarget(sample, task, targetSessionId) ? sample : null;
      }, `${task.providerId} exact started screenshot target`, 5_000, 25);
      assert.deepEqual(before.visibleErrors, [], `${task.providerId} showed an error before its started screenshot.`);
      await cdp.screenshot(targetPath);
      const after = await duePresentationSample(cdp, tasks);
      lastEvidence = { attempt, targetSessionId, before, after };
      captured = isStartedScreenshotTarget(after, task, targetSessionId)
        && after.visibleErrors.length === 0;
    }
    assert.equal(captured, true, `${task.providerId} started screenshot did not remain on its exact materialized working task: ${JSON.stringify(lastEvidence)}`);
    evidence[task.providerId].screenshot = targetPath;
  }
}

async function observeDuePresentation(cdp, tasks, statePath, runAt, applicationWindowWatcher, child) {
  const dueAt = Date.parse(runAt);
  await waitFor(() => Date.now() >= dueAt - 2_000, 'scheduled-task due-time observation window', scheduleDelayMs + 60_000, 100);
  const deadline = dueAt + providerTimeoutMs;
  const evidence = Object.fromEntries(tasks.map((task) => [task.providerId, {
    sampleCount: 0,
    maxRowCount: 0,
    firstOptimisticAt: null,
    firstWorkingAt: null,
    firstShimmerAt: null,
    firstCombinedAt: null,
    firstFinalAt: null,
    screenshot: null,
  }]));
  let selectedProviderId = null;
  let selectedSince = 0;
  let lastSample = null;
  while (Date.now() < deadline) {
    assertTopLevelWindowsHidden(applicationWindowWatcher, child, 'continuous due-time presentation sampling');
    const state = await readScheduleStateIfPresent(statePath);
    const matching = state.tasks.filter((candidate) => tasks.some((task) => task.requestId === candidate.requestId));
    const failed = matching.find((candidate) => candidate.status === 'failed');
    if (failed) throw new Error(`${failed.providerId} scheduled dispatch failed during presentation sampling: ${failed.failureMessage}`);

    const sample = await duePresentationSample(cdp, tasks);
    lastSample = sample;
    assert.deepEqual(sample.visibleErrors, [], `A visible error appeared during due-time sampling: ${sample.visibleErrors.join(' | ')}`);
    for (const task of tasks) {
      const row = sample.taskRows[task.providerId];
      const taskEvidence = evidence[task.providerId];
      taskEvidence.sampleCount += 1;
      taskEvidence.maxRowCount = Math.max(taskEvidence.maxRowCount, row.rowIds.length);
      assert.ok(row.rowIds.length <= 1, `${task.providerId} painted duplicate scheduled/materialized task rows: ${row.rowIds.join(', ')}`);
      assert.equal(row.placeholderRows > 0 && row.materializedRows > 0, false, `${task.providerId} painted its placeholder and materialized task together.`);
    }

    const selected = sample.selected;
    if (selected?.providerId !== selectedProviderId) {
      selectedProviderId = selected?.providerId ?? null;
      selectedSince = Date.now();
    }
    if (selected) {
      const task = tasks.find((candidate) => candidate.providerId === selected.providerId);
      const taskEvidence = evidence[selected.providerId];
      assert.ok(task, `Unknown selected provider ${selected.providerId}.`);
      if (selected.scheduleNotice === 'failed') throw new Error(`${selected.providerId} showed a failed scheduled-task notice.`);
      if (selected.userBodies.length > 0) {
        assert.deepEqual(selected.userBodies, [task.prompt], `${selected.providerId} painted a duplicate, truncated, or placeholder user message.`);
        assert.equal(selected.emptyStateVisible, false, `${selected.providerId} showed a false empty transcript beside its optimistic message.`);
      }
      if (selected.exactUserCount === 1) taskEvidence.firstOptimisticAt ??= sample.sampledAt;
      if (selected.exactUserCount === 1 && selected.busy) taskEvidence.firstWorkingAt ??= sample.sampledAt;
      if (selected.exactUserCount === 1 && selected.shimmer) taskEvidence.firstShimmerAt ??= sample.sampledAt;
      if (selected.exactUserCount === 1 && selected.busy && selected.shimmer) {
        taskEvidence.firstCombinedAt ??= sample.sampledAt;
      }
      if (selected.exactFinalAssistantCount === 1) taskEvidence.firstFinalAt ??= sample.sampledAt;
      assert.ok(selected.exactUserCount <= 1, `${selected.providerId} painted its optimistic user message more than once.`);
      assert.ok(selected.exactAssistantCount <= 1, `${selected.providerId} painted its exact response token more than once.`);
      assert.ok(selected.exactFinalAssistantCount <= 1, `${selected.providerId} painted duplicate final-answer presentations.`);
    }

    const allCombined = tasks.every((task) => evidence[task.providerId].firstCombinedAt !== null);
    const allStarted = matching.length === tasks.length && matching.every((candidate) => candidate.status === 'started');
    if (allCombined && allStarted) {
      await captureStartedScreenshots(cdp, tasks, evidence);
      return { sampleIntervalMs: duePresentationSampleIntervalMs, completedAt: new Date().toISOString(), tasks: evidence, lastSample };
    }

    const rotation = allCombined ? tasks : tasks.filter((task) => evidence[task.providerId].firstCombinedAt === null);
    const currentMissing = selected ? rotation.some((task) => task.providerId === selected.providerId) : false;
    if (!currentMissing || Date.now() - selectedSince >= 125) {
      const currentIndex = Math.max(-1, rotation.findIndex((task) => task.providerId === selected?.providerId));
      const candidates = [...rotation.slice(currentIndex + 1), ...rotation.slice(0, currentIndex + 1)];
      const next = candidates.find((task) => sample.taskRows[task.providerId].rowIds.length === 1);
      if (next && next.providerId !== selected?.providerId) {
        const sessionId = sample.taskRows[next.providerId].rowIds[0];
        await selectTask(cdp, next, sessionId);
        selectedProviderId = next.providerId;
        selectedSince = Date.now();
      }
    }
    await delay(duePresentationSampleIntervalMs);
  }
  for (const task of tasks) {
    assert.ok(evidence[task.providerId].firstOptimisticAt, `${task.providerId} never painted the exact optimistic scheduled prompt.`);
    assert.ok(evidence[task.providerId].firstWorkingAt, `${task.providerId} never presented an active working state beside the optimistic prompt.`);
    assert.ok(evidence[task.providerId].firstShimmerAt, `${task.providerId} never presented the working shimmer beside the optimistic prompt.`);
    assert.ok(evidence[task.providerId].firstCombinedAt, `${task.providerId} never presented the exact optimistic prompt and working shimmer in the same 50 ms sample.`);
  }
  throw new Error(`Scheduled due-time presentation sampling expired: ${JSON.stringify({ evidence, lastSample })}`);
}

async function finalEvidence(cdp, task) {
  await selectTask(cdp, task, task.materializedSessionId);
  const evidence = await waitFor(async () => {
    const rendered = await cdp.evaluate(`(() => {
      const assistantBodies = [...document.querySelectorAll('.message-assistant .message-body')]
        .map((node) => node.textContent?.trim() ?? '')
        .filter(Boolean);
      const finalAssistantBodies = [...document.querySelectorAll('.message-assistant')]
        .filter((node) => node.querySelector('.assistant-identity[data-mode="final"]'))
        .map((node) => node.querySelector('.message-body')?.textContent?.trim() ?? '')
        .filter(Boolean);
      const userBodies = [...document.querySelectorAll('.message-user .message-body')]
        .map((node) => node.textContent?.trim() ?? '');
      return {
        exactAssistantCount: assistantBodies.filter((text) => text === ${JSON.stringify(task.token)}).length,
        exactFinalAssistantCount: finalAssistantBodies.filter((text) => text === ${JSON.stringify(task.token)}).length,
        nonemptyFinalAssistantCount: finalAssistantBodies.length,
        unexpectedFinalAssistantBodies: finalAssistantBodies.filter((text) => text !== ${JSON.stringify(task.token)}),
        exactUserCount: userBodies.filter((text) => text === ${JSON.stringify(task.prompt)}).length,
        nonemptyUserBodies: userBodies.filter(Boolean),
        busy: Boolean(document.querySelector('.reasoning-group[aria-busy="true"], .message-assistant[aria-busy="true"]')),
        errors: [...document.querySelectorAll('.timeline-error-notice')].map((node) => node.textContent?.trim() ?? ''),
        visibleErrors: ${visibleErrorSurfaceExpression()},
        scheduleNotice: document.querySelector('.scheduled-task-notice')?.getAttribute('data-status') ?? null,
        materializedRows: document.querySelectorAll(${JSON.stringify(`[data-session-id="${task.materializedSessionId}"]`)}).length,
        placeholderRows: document.querySelectorAll(${JSON.stringify(`[data-session-id="${task.pendingSessionId}"]`)}).length,
      };
    })()`);
    if (rendered.errors.length > 0) return { fatal: `${task.providerId} failed visibly: ${rendered.errors.join(' | ')}`, rendered };
    if (rendered.visibleErrors.length > 0) return { fatal: `${task.providerId} showed a visible error: ${rendered.visibleErrors.join(' | ')}`, rendered };
    if (rendered.exactUserCount > 1 || rendered.exactAssistantCount > 1 || rendered.exactFinalAssistantCount > 1) {
      return { fatal: `${task.providerId} painted duplicate scheduled transcript content: ${JSON.stringify(rendered)}`, rendered };
    }
    return rendered.exactAssistantCount === 1
      && rendered.exactFinalAssistantCount === 1
      && rendered.nonemptyFinalAssistantCount === 1
      && rendered.exactUserCount === 1
      && rendered.nonemptyUserBodies.length === 1
      && !rendered.busy
      ? rendered
      : null;
  }, `${task.providerId} exact final response`, finalTimeoutMs, 250);
  if (evidence.fatal) throw new Error(evidence.fatal);
  assert.deepEqual(evidence.unexpectedFinalAssistantBodies, [], `${task.providerId} presented an unexpected final answer.`);
  assert.equal(evidence.scheduleNotice, null);
  assert.equal(evidence.materializedRows, 1, `${task.providerId} duplicated its materialized task row.`);
  assert.equal(evidence.placeholderRows, 0, `${task.providerId} resurrected its scheduled placeholder.`);
  await delay(1_000);
  const stable = await cdp.evaluate(`(() => ({
    exactAssistantCount: [...document.querySelectorAll('.message-assistant .message-body')]
      .filter((node) => node.textContent?.trim() === ${JSON.stringify(task.token)}).length,
    exactFinalAssistantCount: [...document.querySelectorAll('.message-assistant')]
      .filter((node) => node.querySelector('.assistant-identity[data-mode="final"]') && node.querySelector('.message-body')?.textContent?.trim() === ${JSON.stringify(task.token)}).length,
    nonemptyFinalAssistantCount: [...document.querySelectorAll('.message-assistant')]
      .filter((node) => node.querySelector('.assistant-identity[data-mode="final"]') && Boolean(node.querySelector('.message-body')?.textContent?.trim())).length,
    exactUserCount: [...document.querySelectorAll('.message-user .message-body')]
      .filter((node) => node.textContent?.trim() === ${JSON.stringify(task.prompt)}).length,
    nonemptyUserCount: [...document.querySelectorAll('.message-user .message-body')]
      .filter((node) => Boolean(node.textContent?.trim())).length,
    busy: Boolean(document.querySelector('.reasoning-group[aria-busy="true"], .message-assistant[aria-busy="true"]')),
  }))()`);
  assert.deepEqual(stable, { exactAssistantCount: 1, exactFinalAssistantCount: 1, nonemptyFinalAssistantCount: 1, exactUserCount: 1, nonemptyUserCount: 1, busy: false }, `${task.providerId} final-answer presentation did not remain stable.`);
  await cdp.screenshot(path.join(artifactRoot, `final-${task.providerId}.png`));
  return { rendered: evidence, stable };
}

function messageTextParts(message) {
  return Array.isArray(message?.parts)
    ? message.parts
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text.trim())
      .filter(Boolean)
    : [];
}

function messageText(message) {
  return messageTextParts(message).join('\n').trim();
}

async function loadCompleteSessionHistory(cdp, sessionId) {
  const messages = [];
  const messageIds = new Set();
  const cursors = new Set();
  let cursor;
  let openedSession;
  let pageCount = 0;
  for (; pageCount < 200; pageCount += 1) {
    const payload = await cdp.bridgeRequest('session.open', {
      sessionId,
      limit: 40,
      ...(cursor ? { cursor } : {}),
      ...(pageCount === 0 ? { refresh: true } : {}),
    });
    openedSession = payload.session ?? openedSession;
    const pageMessages = Array.isArray(payload.messages) ? payload.messages : [];
    for (const message of pageMessages) {
      assert.equal(typeof message?.id, 'string', `Session ${sessionId} returned a message without an ID.`);
      assert.equal(messageIds.has(message.id), false, `Session ${sessionId} repeated message ${message.id} across provider-history pages.`);
      messageIds.add(message.id);
      messages.push(message);
    }
    const nextCursor = typeof payload.nextCursor === 'string' && payload.nextCursor.length > 0
      ? payload.nextCursor
      : null;
    if (nextCursor === null) break;
    assert.equal(cursors.has(nextCursor), false, `Session ${sessionId} repeated history cursor ${nextCursor}.`);
    cursors.add(nextCursor);
    cursor = nextCursor;
  }
  assert.ok(pageCount < 200, `Session ${sessionId} exceeded 200 complete-history pages.`);
  assert.equal(openedSession?.id, sessionId, `Provider history opened ${openedSession?.id ?? '<missing>'} instead of ${sessionId}.`);
  return { session: openedSession, messages, pageCount: pageCount + 1 };
}

async function finalProviderEvidence(cdp, tasks, baselineSessions) {
  const refreshedPayload = await cdp.bridgeRequest('sessions.refresh');
  const listedPayload = await cdp.bridgeRequest('sessions.list');
  const refreshedSessions = Array.isArray(refreshedPayload.sessions) ? refreshedPayload.sessions : [];
  const listedSessions = Array.isArray(listedPayload.sessions) ? listedPayload.sessions : [];
  const baselineIds = new Set(baselineSessions.map((session) => session.id));
  const pendingSessionIds = new Set(tasks.map((task) => task.pendingSessionId));
  assert.equal(refreshedSessions.some((session) => pendingSessionIds.has(session.id)), false, 'A scheduled placeholder survived the final provider refresh.');
  assert.equal(listedSessions.some((session) => pendingSessionIds.has(session.id)), false, 'A scheduled placeholder survived the final provider list.');

  const taskEvidence = {};
  for (const task of tasks) {
    const refreshedTitleMatches = refreshedSessions.filter((session) => session.providerId === task.providerId && session.title === task.title);
    const listedTitleMatches = listedSessions.filter((session) => session.providerId === task.providerId && session.title === task.title);
    assert.equal(refreshedTitleMatches.length, 1, `${task.providerId} final refresh did not contain exactly one task titled ${JSON.stringify(task.title)}.`);
    assert.equal(listedTitleMatches.length, 1, `${task.providerId} final list did not contain exactly one task titled ${JSON.stringify(task.title)}.`);
    assert.equal(refreshedTitleMatches[0].id, task.materializedSessionId, `${task.providerId} final refresh mapped the unique title to the wrong task.`);
    assert.equal(listedTitleMatches[0].id, task.materializedSessionId, `${task.providerId} final list mapped the unique title to the wrong task.`);
    assert.equal(baselineIds.has(task.materializedSessionId), false, `${task.providerId} reused a pre-existing task instead of materializing the scheduled task.`);

    const newProviderSessions = listedSessions.filter((session) => session.providerId === task.providerId && !baselineIds.has(session.id));
    assert.equal(newProviderSessions.some((session) => session.id === task.materializedSessionId), true, `${task.providerId} materialized task was not new relative to the pre-schedule provider refresh.`);
    const histories = [];
    for (const session of newProviderSessions) {
      histories.push(await loadCompleteSessionHistory(cdp, session.id));
    }
    const relatedHistories = histories.filter((history) => {
      const listed = newProviderSessions.find((session) => session.id === history.session.id);
      return listed?.title?.includes(task.qaMarker) === true
        || listed?.preview?.includes(task.qaMarker) === true
        || history.messages.some((message) => messageText(message).includes(task.qaMarker));
    });
    assert.equal(relatedHistories.length, 1, `${task.providerId} produced ${relatedHistories.length} QA-related provider tasks; expected exactly one with no orphan session.`);
    const history = relatedHistories[0];
    assert.equal(history.session.id, task.materializedSessionId, `${task.providerId} QA history belonged to an orphan task instead of the materialized task.`);
    assert.equal(history.session.title, task.title, `${task.providerId} materialized provider task did not retain the exact unique title.`);

    const userMessages = history.messages
      .filter((message) => message.role === 'user')
      .map((message) => ({ id: message.id, providerMessageId: message.providerMessageId, createdAt: message.createdAt, status: message.status, text: messageText(message) }))
      .filter((message) => message.text.length > 0);
    const assistantMessages = history.messages
      .filter((message) => message.role === 'assistant')
      .map((message) => ({
        id: message.id,
        providerMessageId: message.providerMessageId,
        status: message.status,
        phase: message.nativeMetadata?.phase ?? null,
        text: messageText(message),
      }))
      .filter((message) => message.text.length > 0);
    const explicitFinalMessages = assistantMessages.filter((message) => message.phase === 'final_answer');
    const unphasedCompletedMessages = assistantMessages.filter((message) => message.phase === null && message.status === 'completed');
    const finalMessages = explicitFinalMessages.length > 0
      ? explicitFinalMessages
      : unphasedCompletedMessages.slice(-1);
    assert.deepEqual(userMessages.map((message) => message.text), [task.prompt], `${task.providerId} provider history contained a duplicate or orphan user turn.`);
    assert.equal(assistantMessages.filter((message) => message.text === task.token).length, 1, `${task.providerId} provider history contained a duplicate exact response token.`);
    assert.deepEqual(finalMessages.map((message) => message.text), [task.token], `${task.providerId} provider history did not contain exactly one completed final response matching the exact token.`);
    assert.equal(userMessages[0].status, 'completed', `${task.providerId} provider user turn was not completed.`);
    assert.equal(finalMessages[0].status, 'completed', `${task.providerId} provider assistant final response was not completed.`);

    taskEvidence[task.providerId] = {
      exactTitle: task.title,
      refreshedTitleMatches: refreshedTitleMatches.map((session) => session.id),
      listedTitleMatches: listedTitleMatches.map((session) => session.id),
      newProviderSessionIds: newProviderSessions.map((session) => session.id),
      qaRelatedSessionIds: relatedHistories.map((candidate) => candidate.session.id),
      historyPageCount: history.pageCount,
      historyMessageCount: history.messages.length,
      userMessages,
      assistantMessages,
      finalMessages,
    };
  }
  return {
    refreshedSessionCount: refreshedSessions.length,
    listedSessionCount: listedSessions.length,
    tasks: taskEvidence,
  };
}

async function main() {
  await mkdir(artifactRoot, { recursive: true });
  await mkdir(workspace, { recursive: true });
  const userData = await mkdtemp(path.join(os.tmpdir(), 'tethoq-scheduled-qa-'));
  const scheduleStatePath = path.join(userData, 'scheduled-tasks.json');
  const debugPort = await availablePort();
  let child;
  let cdp;
  let heartbeat;
  let applicationWindowWatcher;
  let teardownEvidence;
  let primaryError;
  let result;
  let stdout = () => '';
  let stderr = () => '';
  try {
    const environment = {
      ...process.env,
      TETHOQ_OPENCODE_URL: process.env.TETHOQ_OPENCODE_URL ?? 'http://127.0.0.1:4096',
    };
    child = spawn(electronExecutable, [appRoot, '--hidden', `--user-data-dir=${userData}`, `--remote-debugging-port=${debugPort}`], {
      cwd: appRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: environment,
    });
    stdout = processCapture(child.stdout);
    stderr = processCapture(child.stderr);
    let launchError;
    child.once('error', (error) => { launchError = error; });
    applicationWindowWatcher = startTopLevelWindowWatcher(child.pid, 'isolated scheduling Electron process tree');
    await waitForTopLevelWindowWatcherReady(applicationWindowWatcher);
    process.stdout.write(`real-scheduled-task-qa: hidden app started on CDP ${debugPort}\n`);
    cdp = await connectCdp(debugPort);
    await waitFor(() => cdp.evaluate('Boolean(window.tethoqDesktop && document.querySelector(".desktop-app"))'), 'Tethoq desktop shell', 60_000);
    const launchVisibleTopLevelWindows = await visibleTopLevelWindows([child.pid]);
    assert.deepEqual(launchVisibleTopLevelWindows, [], 'The isolated scheduling Electron root opened a visible top-level window.');
    assertTopLevelWindowsHidden(applicationWindowWatcher, child, 'hidden startup');
    await waitFor(async () => {
      try {
        const config = JSON.parse(await readFile(path.join(userData, 'bridge.json'), 'utf8'));
        return typeof config.hostId === 'string' && config.hostId.startsWith('desktop_') ? config.hostId : null;
      } catch {
        return null;
      }
    }, 'isolated Tethoq user-data profile');
    if (launchError) throw launchError;

    const providerIds = Object.keys(specifications);
    const reconnectAttempted = new Set();
    const providers = await waitFor(async () => {
      const payload = await cdp.bridgeRequest('provider.list');
      const byId = Object.fromEntries((payload.providers ?? []).map((provider) => [provider.providerId, provider]));
      for (const providerId of providerIds) {
        if (byId[providerId]?.state !== 'online') {
          if (!reconnectAttempted.has(providerId)) {
            reconnectAttempted.add(providerId);
            await cdp.bridgeRequest('provider.reconnect', { providerId }).catch(() => undefined);
          }
          return null;
        }
      }
      return byId;
    }, 'Codex, OpenCode, and Grok online', providerTimeoutMs, 1_000);
    process.stdout.write('real-scheduled-task-qa: Codex, OpenCode, and Grok are online\n');
    assertTopLevelWindowsHidden(applicationWindowWatcher, child, 'provider startup');

    const selections = {};
    for (const providerId of providerIds) {
      const catalogue = await cdp.bridgeRequest('models.list', { providerId });
      selections[providerId] = pickModel(providerId, catalogue.models ?? []);
    }
    const qaRunId = randomUUID();
    const baselineRefreshPayload = await cdp.bridgeRequest('sessions.refresh');
    const baselineListPayload = await cdp.bridgeRequest('sessions.list');
    const baselineSessions = Array.isArray(baselineListPayload.sessions) ? baselineListPayload.sessions : [];
    assert.equal(Array.isArray(baselineRefreshPayload.sessions), true, 'The pre-schedule provider refresh did not return a session catalogue.');
    assert.equal(Array.isArray(baselineListPayload.sessions), true, 'The pre-schedule provider list did not return a session catalogue.');
    await switchTaskListToRecent(cdp);
    const renderedSessionIds = new Set(await cdp.evaluate("[...document.querySelectorAll('[data-session-id] > .session-row')].map((node) => node.parentElement?.getAttribute('data-session-id')).filter(Boolean)"));
    const composerSource = providerIds
      .flatMap((providerId) => baselineSessions.filter((session) => session.providerId === providerId))
      .find((session) => typeof session.workingDirectory === 'string' && session.workingDirectory.trim() && renderedSessionIds.has(session.id));
    assert.ok(composerSource, 'No rendered real-provider task with a working directory was available to exercise scheduling through the ordinary new-task composer.');
    const uiProviderId = composerSource.providerId;
    assert.ok(providerIds.includes(uiProviderId), `The composer source uses unsupported provider ${uiProviderId}.`);

    // datetime-local intentionally works at minute precision. Round upward so
    // the ordinary UI route still proves a delay of at least five minutes.
    const runAt = new Date(Math.ceil((Date.now() + scheduleDelayMs) / 60_000) * 60_000).toISOString();
    const createdAt = new Date().toISOString();
    const scheduledDelayFromCreationMs = Date.parse(runAt) - Date.parse(createdAt);
    assert.ok(scheduledDelayFromCreationMs >= scheduleDelayMs && scheduledDelayFromCreationMs < scheduleDelayMs + 60_000, `The composer-compatible due time was not five minutes away: ${scheduledDelayFromCreationMs} ms.`);
    const baselineScheduleState = await readScheduleStateIfPresent(scheduleStatePath);
    const baselineRequestIds = new Set(baselineScheduleState.tasks.map((task) => task.requestId));
    const definitions = Object.fromEntries(providerIds.map((providerId) => {
      const specification = specifications[providerId];
      const qaMarker = `scheduled-qa-${qaRunId}-${providerId}`;
      return [providerId, {
        providerId,
        qaMarker,
        prompt: scheduledPrompt(qaMarker, specification.token),
        title: `Scheduling QA ${providerId} ${qaMarker}`,
        token: specification.token,
      }];
    }));
    assert.equal(providerIds.every((providerId) => definitions[providerId].prompt.length > 180), true, 'The real proof no longer covers long-prompt optimistic reconciliation.');
    const uiDefinition = definitions[uiProviderId];
    const composerCreation = await createScheduledTaskThroughComposer(cdp, scheduleStatePath, {
      ...uiDefinition,
      sourceSession: composerSource,
      runAt,
      baselineRequestIds,
    });
    const uiScheduledTask = composerCreation.scheduledTask;
    const uiTask = {
      ...uiDefinition,
      requestId: uiScheduledTask.requestId,
      runAt,
      title: uiScheduledTask.title,
      pendingSessionId: uiScheduledTask.targetSessionId,
      scheduledTask: uiScheduledTask,
      creationRoute: 'composer',
      model: uiScheduledTask.modelId
        ? { id: uiScheduledTask.modelId, displayName: selections[uiProviderId].model?.displayName ?? uiScheduledTask.modelId, effort: uiScheduledTask.reasoningEffort ?? null }
        : null,
    };
    const directTasks = await Promise.all(providerIds.filter((providerId) => providerId !== uiProviderId).map(async (providerId) => {
      const definition = definitions[providerId];
      const requestId = `schedule_${randomUUID()}`;
      const response = await cdp.bridgeRequest('scheduled_task.create', {
        providerId,
        workingDirectory: workspace,
        title: definition.title,
        content: definition.prompt,
        runAt,
        ...selections[providerId].selection,
      }, requestId);
      return {
        ...definition,
        requestId,
        runAt,
        pendingSessionId: response.task.targetSessionId,
        scheduledTask: response.task,
        creationRoute: 'bridge',
        model: selections[providerId].model
          ? { id: selections[providerId].model.id, displayName: selections[providerId].model.displayName, effort: selections[providerId].selection?.reasoningEffort ?? null }
          : null,
      };
    }));
    const directTasksByProvider = Object.fromEntries(directTasks.map((task) => [task.providerId, task]));
    const tasks = providerIds.map((providerId) => providerId === uiProviderId ? uiTask : directTasksByProvider[providerId]);
    assert.equal(tasks.filter((task) => task.creationRoute === 'composer').length, 1, 'Real scheduling QA did not create exactly one task through the ordinary composer UI.');
    assert.equal(new Set(tasks.map((task) => task.pendingSessionId)).size, 3, 'Scheduling did not create three distinct app placeholders.');
    assert.equal(tasks.every((task) => task.pendingSessionId === `scheduled-task:${task.requestId}`), true, 'Scheduling did not preserve stable placeholder identity.');
    assert.equal(new Set(tasks.map((task) => task.requestId)).size, 3, 'Scheduling did not preserve three distinct stable request IDs.');
    process.stdout.write(`real-scheduled-task-qa: three tasks scheduled for ${runAt}; ${uiProviderId} used the ordinary composer UI\n`);
    assertTopLevelWindowsHidden(applicationWindowWatcher, child, 'schedule creation');

    const pending = {};
    for (const task of tasks) pending[task.providerId] = await pendingEvidence(cdp, task);

    heartbeat = setInterval(() => {
      const remainingSeconds = Math.max(0, Math.ceil((Date.parse(runAt) - Date.now()) / 1_000));
      process.stdout.write(`real-scheduled-task-qa: ${remainingSeconds}s until dispatch\n`);
    }, 30_000);
    const duePresentation = await observeDuePresentation(cdp, tasks, scheduleStatePath, runAt, applicationWindowWatcher, child);
    process.stdout.write('real-scheduled-task-qa: all three exact optimistic prompts and working shimmers were observed at due time\n');
    assertTopLevelWindowsHidden(applicationWindowWatcher, child, 'due-time optimistic and working presentation');
    const dispatchedState = await readScheduleState(scheduleStatePath);
    const dispatchedTasks = dispatchedState.tasks.filter((candidate) => tasks.some((task) => task.requestId === candidate.requestId));
    assert.equal(dispatchedTasks.length, tasks.length, 'A scheduled provider dispatch disappeared after due-time presentation proof.');
    assert.equal(dispatchedTasks.every((candidate) => candidate.status === 'started'), true, 'A scheduled provider dispatch was not durably started after due-time presentation proof.');
    clearInterval(heartbeat);
    heartbeat = undefined;
    process.stdout.write('real-scheduled-task-qa: all three scheduled dispatches were accepted\n');
    assertTopLevelWindowsHidden(applicationWindowWatcher, child, 'scheduled dispatch');

    const persisted = tasks.map((task) => dispatchedState.tasks.find((candidate) => candidate.requestId === task.requestId));
    assert.equal(persisted.every(Boolean), true);
    for (const [index, task] of tasks.entries()) task.materializedSessionId = persisted[index].targetSessionId;
    assert.equal(tasks.every((task) => task.materializedSessionId !== task.pendingSessionId), true, 'A scheduled placeholder was not replaced by a provider task.');
    assert.equal(new Set(tasks.map((task) => task.materializedSessionId)).size, 3, 'Dispatch did not create three distinct provider tasks.');
    const dispatchTimes = persisted.map((task) => Date.parse(task.dispatchingAt));
    assert.equal(dispatchTimes.every(Number.isFinite), true, 'A scheduled dispatch omitted a valid dispatchingAt timestamp.');
    const maximumDispatchSkewMs = Math.max(...dispatchTimes) - Math.min(...dispatchTimes);
    const latestDispatchDelayMs = Math.max(...dispatchTimes) - Date.parse(runAt);
    assert.ok(latestDispatchDelayMs >= 0 && latestDispatchDelayMs <= 5_000, `Latest dispatch was ${latestDispatchDelayMs} ms from the due time.`);
    assert.ok(maximumDispatchSkewMs <= 2_000, `The three harness dispatches were ${maximumDispatchSkewMs} ms apart.`);
    const acceptanceTimes = persisted.map((task) => Date.parse(task.startedAt));
    assert.equal(acceptanceTimes.every(Number.isFinite), true, 'A scheduled dispatch omitted a valid startedAt acceptance timestamp.');
    const acceptanceDelaysMs = acceptanceTimes.map((acceptedAt) => acceptedAt - Date.parse(runAt));
    const maximumAcceptanceSkewMs = Math.max(...acceptanceTimes) - Math.min(...acceptanceTimes);
    assert.equal(
      acceptanceDelaysMs.every((delayMs) => delayMs >= 0 && delayMs <= maximumProviderAcceptanceDelayMs),
      true,
      `A provider accepted its scheduled prompt outside the ${maximumProviderAcceptanceDelayMs} ms due-time budget: ${acceptanceDelaysMs.join(', ')}.`,
    );
    assert.ok(maximumAcceptanceSkewMs <= maximumProviderAcceptanceSkewMs, `The three harness acceptances were ${maximumAcceptanceSkewMs} ms apart.`);

    const finals = {};
    for (const task of tasks) {
      finals[task.providerId] = await finalEvidence(cdp, task);
      process.stdout.write(`real-scheduled-task-qa: ${task.providerId} returned ${task.token}\n`);
    }
    const providerFinal = await finalProviderEvidence(cdp, tasks, baselineSessions);
    const canonicalUserTimes = tasks.map((task) => Date.parse(providerFinal.tasks[task.providerId].userMessages[0].createdAt));
    assert.equal(canonicalUserTimes.every(Number.isFinite), true, 'A canonical provider user turn omitted a valid createdAt timestamp.');
    const canonicalUserDelaysMs = canonicalUserTimes.map((createdAtTime) => createdAtTime - Date.parse(runAt));
    const maximumCanonicalUserSkewMs = Math.max(...canonicalUserTimes) - Math.min(...canonicalUserTimes);
    assert.equal(
      canonicalUserDelaysMs.every((delayMs) => delayMs >= 0 && delayMs <= maximumProviderAcceptanceDelayMs),
      true,
      `A canonical provider user turn appeared outside the ${maximumProviderAcceptanceDelayMs} ms due-time budget: ${canonicalUserDelaysMs.join(', ')}.`,
    );
    assert.ok(maximumCanonicalUserSkewMs <= maximumProviderAcceptanceSkewMs, `The three canonical provider user turns were ${maximumCanonicalUserSkewMs} ms apart.`);
    const finalVisibleTopLevelWindows = await visibleTopLevelWindows([child.pid]);
    assert.deepEqual(finalVisibleTopLevelWindows, [], 'The isolated scheduling Electron root opened a visible top-level window during QA.');
    assertTopLevelWindowsHidden(applicationWindowWatcher, child, 'final provider refresh, listing, and history verification');

    result = {
      passed: true,
      generatedAt: new Date().toISOString(),
      launch: {
        debugPort,
        hidden: true,
        isolatedUserData: true,
        openCodeUrl: environment.TETHOQ_OPENCODE_URL,
        launchVisibleTopLevelWindows,
        finalVisibleTopLevelWindows,
        rootAndDescendantTopLevelWindowSamplingMs: windowSampleIntervalMs,
      },
      providers: providerIds.map((providerId) => ({ id: providerId, state: providers[providerId].state })),
      baseline: {
        refreshedSessionCount: baselineRefreshPayload.sessions.length,
        listedSessionCount: baselineSessions.length,
      },
      providerFinal,
      qaRunId,
      runAt,
      createdAt,
      scheduledDelayFromCreationMs,
      composerCreation: {
        providerId: uiProviderId,
        sourceSessionId: composerSource.id,
        draftSessionId: composerCreation.draftSessionId,
        commandEvidence: composerCreation.commandEvidence,
        localValue: composerCreation.localValue,
      },
      duePresentation,
      maximumDispatchSkewMs,
      latestDispatchDelayMs,
      acceptanceDelaysMs,
      maximumAcceptanceSkewMs,
      canonicalUserDelaysMs,
      maximumCanonicalUserSkewMs,
      tasks: tasks.map((task, index) => ({
        providerId: task.providerId,
        requestId: task.requestId,
        pendingSessionId: task.pendingSessionId,
        materializedSessionId: task.materializedSessionId,
        model: task.model,
        prompt: task.prompt,
        title: task.title,
        qaMarker: task.qaMarker,
        token: task.token,
        dispatchingAt: persisted[index].dispatchingAt,
        startedAt: persisted[index].startedAt,
        pending: pending[task.providerId],
        started: duePresentation.tasks[task.providerId],
        final: finals[task.providerId],
        providerFinal: providerFinal.tasks[task.providerId],
      })),
      screenshots: providerIds.flatMap((providerId) => [
        path.join(artifactRoot, `pending-${providerId}.png`),
        path.join(artifactRoot, `started-${providerId}.png`),
        path.join(artifactRoot, `final-${providerId}.png`),
      ]),
    };
  } catch (error) {
    primaryError = error;
  } finally {
    const cleanupErrors = [];
    if (heartbeat) clearInterval(heartbeat);
    if (cdp) {
      try {
        await cdp.close();
      } catch (error) {
        cleanupErrors.push(new Error(`CDP cleanup failed: ${formatError(error)}`));
      }
    }
    if (child) {
      try {
        teardownEvidence = await stopApplication(child, userData, applicationWindowWatcher);
      } catch (error) {
        teardownEvidence = error?.evidence ?? null;
        cleanupErrors.push(error);
      }
    } else if (applicationWindowWatcher) {
      try {
        await finishTopLevelWindowWatcher(applicationWindowWatcher);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await rm(userData, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(new Error(`Isolated user-data cleanup failed: ${formatError(error)}`));
    }
    if (result) result.launch.teardown = teardownEvidence ?? null;
    if (cleanupErrors.length > 0) {
      const cleanupError = new AggregateError(cleanupErrors, 'Real scheduled-task QA cleanup failed.');
      primaryError = primaryError
        ? new AggregateError([primaryError, cleanupError], 'Real scheduled-task QA and cleanup both failed.')
        : cleanupError;
    }
  }

  if (primaryError) {
    const failure = {
      passed: false,
      generatedAt: new Date().toISOString(),
      error: formatError(primaryError),
      teardown: teardownEvidence ?? null,
      childStdout: stdout(),
      childStderr: stderr(),
    };
    await writeFile(path.join(artifactRoot, 'report.json'), `${JSON.stringify(failure, null, 2)}\n`);
    throw primaryError;
  }
  await writeFile(path.join(artifactRoot, 'report.json'), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`Real scheduled-task QA passed: ${path.join(artifactRoot, 'report.json')}\n`);
}

module.exports = {
  finishTopLevelWindowWatcher,
  startTopLevelWindowWatcher,
  waitForTopLevelWindowWatcherReady,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${formatError(error)}\n`);
    process.exitCode = 1;
  });
}
