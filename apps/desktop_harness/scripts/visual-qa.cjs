'use strict';

const assert = require('node:assert/strict');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const appRoot = path.resolve(__dirname, '..');
const rendererPath = path.join(appRoot, 'out', 'renderer', 'index.html');
const outputArgument = process.argv.slice(2).find((argument) => !argument.startsWith('--'));
const outputDirectory = path.resolve(outputArgument ?? path.join(appRoot, 'qa-artifacts'));
const reducedMotion = process.argv.includes('--reduced-motion');
if (reducedMotion) app.commandLine.appendSwitch('force-prefers-reduced-motion');
const viewports = [
  { name: 'desktop-1440x900', width: 1440, height: 900, kind: 'workspace', selector: '.workspace' },
  { name: 'laptop-1366x768', width: 1366, height: 768, kind: 'workspace', selector: '.workspace' },
  { name: 'compact-1280x720', width: 1280, height: 720, kind: 'workspace', selector: '.workspace' },
  { name: 'compact-1100x760', width: 1100, height: 760, kind: 'workspace', selector: '.workspace' },
  { name: 'minimum-980x680', width: 980, height: 680, kind: 'workspace', selector: '.workspace' },
  { name: 'dpi-200-effective-960x540', width: 960, height: 540, kind: 'workspace', selector: '.workspace' },
  { name: 'minimum-supported-760x480', width: 760, height: 480, kind: 'minimum-workspace', selector: '.workspace' },
  { name: 'tall-1200x1600', width: 1200, height: 1600, kind: 'workspace', selector: '.workspace' },
  { name: 'ultrawide-2560x1080', width: 2560, height: 1080, kind: 'workspace', selector: '.workspace' },
  { name: 'composer-model-menu-980x680', width: 980, height: 680, kind: 'composer-model', selector: '.model-picker-dropup' },
  { name: 'composer-model-browser-1100x760', width: 1100, height: 760, kind: 'composer-model-browser', selector: '.model-library' },
  { name: 'composer-actions-menu-980x680', width: 980, height: 680, kind: 'composer-actions', selector: '.composer-actions-menu .composer-popover' },
  { name: 'dictation-source-hover-980x680', width: 980, height: 680, kind: 'dictation-hover', selector: '.dictation-source-menu > button' },
  { name: 'dictation-empty-state-980x680', width: 980, height: 680, kind: 'dictation-empty', selector: '.dictation-source-empty' },
  { name: 'composer-queue-strip-1100x760', width: 1100, height: 760, kind: 'queue-strip', selector: '.queued-message-menu .composer-popover' },
  { name: 'composer-queue-strip-760x480', width: 760, height: 480, kind: 'queue-strip', selector: '.queued-message-menu .composer-popover' },
  { name: 'queue-new-task-1100x760', width: 1100, height: 760, kind: 'queue-new-task', selector: '.queue-new-task-picker' },
  { name: 'composer-stream-follow-1100x760', width: 1100, height: 760, kind: 'composer-stream-follow', selector: '.conversation-tail-spacer' },
  { name: 'composer-stream-follow-760x480', width: 760, height: 480, kind: 'composer-stream-follow', selector: '.conversation-tail-spacer' },
  { name: 'side-chat-1100x760', width: 1100, height: 760, kind: 'side-chat', selector: '.side-chat-panel' },
  { name: 'composer-handoff-980x680', width: 980, height: 680, kind: 'composer-handoff', selector: '.handoff-chat-picker' },
  { name: 'composer-delegation-980x680', width: 980, height: 680, kind: 'composer-delegation', selector: '.delegation-chat-picker' },
  { name: 'composer-vision-eyes-980x680', width: 980, height: 680, kind: 'composer-vision', selector: '.vision-eyes-picker' },
  { name: 'context-compaction-1100x760', width: 1100, height: 760, kind: 'context-compaction', selector: '.context-usage-popover' },
  { name: 'task-details-1100x760', width: 1100, height: 760, kind: 'task-details', selector: '.task-details-popover' },
  { name: 'subagents-hover-1100x760', width: 1100, height: 760, kind: 'subagents-hover', selector: '.session-subagents-tooltip.visible' },
  { name: 'subagents-hover-800x560', width: 800, height: 560, kind: 'subagents-hover', selector: '.session-subagents-tooltip.visible' },
  { name: 'subagents-1100x760', width: 1100, height: 760, kind: 'subagents', selector: '.session-subagents-popover' },
  { name: 'subagents-800x560', width: 800, height: 560, kind: 'subagents', selector: '.session-subagents-popover' },
  { name: 'local-open-menu-1100x760', width: 1100, height: 760, kind: 'local-open', selector: '.workspace-local-open-menu' },
  { name: 'slash-command-palette-1100x760', width: 1100, height: 760, kind: 'slash-command', selector: '.slash-command-palette' },
  { name: 'simplify-settings-1100x760', width: 1100, height: 760, kind: 'simplify-settings', selector: '.simplify-settings' },
  { name: 'trace-collapsed-sidebar-1100x760', width: 1100, height: 760, kind: 'trace-collapsed', selector: '.reasoning-disclosure[aria-expanded="false"]' },
  { name: 'sidebar-resized-1100x760', width: 1100, height: 760, kind: 'sidebar-resized', selector: '.navigation-resize-handle' },
  { name: 'trace-compacting-1100x760', width: 1100, height: 760, kind: 'trace-compacting', selector: '.timeline-compaction-active' },
  { name: 'trace-compacted-1100x760', width: 1100, height: 760, kind: 'trace-compacted', selector: '.timeline-compaction-toggle[aria-expanded="false"]' },
  { name: 'trace-compacted-expanded-1100x760', width: 1100, height: 760, kind: 'trace-compacted-expanded', selector: '.timeline-compaction-toggle' },
  { name: 'trace-expanded-1100x760', width: 1100, height: 760, kind: 'trace-expanded', selector: '.reasoning-segments' },
  { name: 'trace-thinking-expanded-1100x760', width: 1100, height: 760, kind: 'trace-thinking-expanded', selector: '.reasoning-thinking-segment .reasoning-flow' },
  { name: 'trace-thinking-expanded-760x480', width: 760, height: 480, kind: 'trace-thinking-expanded', selector: '.reasoning-thinking-segment .reasoning-flow' },
  { name: 'trace-snippet-1100x760', width: 1100, height: 760, kind: 'trace-snippet', selector: '.activity-snippet' },
  { name: 'final-message-meta-1100x760', width: 1100, height: 760, kind: 'final-message-meta', selector: '.message-footer' },
  { name: 'user-message-meta-1100x760', width: 1100, height: 760, kind: 'user-message-meta', selector: '.message-user .message-footer' },
  { name: 'thinking-message-meta-1100x760', width: 1100, height: 760, kind: 'thinking-message-meta', selector: '.reasoning-thinking-segment .timeline-item-meta' },
  { name: 'message-error-1100x760', width: 1100, height: 760, kind: 'message-error', selector: '.timeline-error-notice' },
  { name: 'user-attachment-1100x760', width: 1100, height: 760, kind: 'user-attachment', selector: '.message-user .message-images-before' },
  { name: 'dictation-audio-source-980x680', width: 980, height: 680, kind: 'dictation-audio-source', selector: '.dictation-source-menu .composer-popover' },
  { name: 'audio-message-1100x760', width: 1100, height: 760, kind: 'audio-message', selector: '.message-audio-before' },
  { name: 'workflow-message-1100x760', width: 1100, height: 760, kind: 'workflow-message', selector: '.message-workflow-panel' },
  { name: 'wallet-dropdown-1100x760', width: 1100, height: 760, kind: 'wallet', selector: '.wallet-popover' },
  { name: 'wallet-direct-advanced-1100x760', width: 1100, height: 760, kind: 'wallet-direct-advanced', selector: '.wallet-advanced' },
  { name: 'dashboard-1440x900', width: 1440, height: 900, kind: 'dashboard', selector: '.dashboard-page' },
  { name: 'settings-defaults-1440x900', width: 1440, height: 900, kind: 'settings-defaults', selector: '.agent-defaults' },
  { name: 'settings-global-agents-1440x900', width: 1440, height: 900, kind: 'settings-global-agents', selector: '.global-agents-settings' },
  { name: 'settings-agents-1440x900', width: 1440, height: 900, kind: 'settings-agents', selector: '.provider-settings' },
  { name: 'settings-dictation-1100x760', width: 1100, height: 760, kind: 'settings-dictation', selector: '.dictation-settings-editor' },
  { name: 'settings-runtime-1440x900', width: 1440, height: 900, kind: 'settings-runtime', selector: '.settings-compact-grid' },
  { name: 'settings-connectors-1440x900', width: 1440, height: 900, kind: 'settings', selector: '.connector-card[data-connector-id="tethoq-example"]' },
  { name: 'browser-private-profile-1440x900', width: 1440, height: 900, kind: 'browser', selector: '.browser-page .browser-privacy-note' },
  { name: 'browser-downloads-1440x900', width: 1440, height: 900, kind: 'browser-downloads', selector: '.browser-download-panel .browser-download-progress' },
  { name: 'browser-downloads-minimum-980x680', width: 980, height: 680, kind: 'browser-downloads', selector: '.browser-download-panel .browser-download-progress' },
  { name: 'browser-downloads-minimum-supported-760x480', width: 760, height: 480, kind: 'browser-downloads', selector: '.browser-download-panel .browser-download-progress' },
  { name: 'workflows-1440x900', width: 1440, height: 900, kind: 'workflows', selector: '#workflow-settings' },
  { name: 'workflow-screenshot-preview-1440x900', width: 1440, height: 900, kind: 'workflow-screenshot-preview', selector: '.workflow-screenshot-lightbox' },
  { name: 'new-task-1100x760', width: 1100, height: 760, kind: 'new-task-draft', selector: '.workspace .composer-wrap' },
  { name: 'new-task-minimum-760x480', width: 760, height: 480, kind: 'new-task-draft', selector: '.workspace .composer-wrap' },
  { name: 'approval-1100x760', width: 1100, height: 760, kind: 'approval', selector: '.workspace .approval-card' },
];
if (process.argv.includes('--context-only')) {
  const contextViewport = viewports.find((viewport) => viewport.kind === 'context-compaction');
  viewports.splice(0, viewports.length, contextViewport);
} else if (process.argv.includes('--task-details-only')) {
  const taskDetailsViewport = viewports.find((viewport) => viewport.kind === 'task-details');
  viewports.splice(0, viewports.length, taskDetailsViewport);
} else if (process.argv.includes('--subagents-only')) {
  const subagentsViewports = viewports.filter((viewport) => viewport.kind.startsWith('subagents'));
  viewports.splice(0, viewports.length, ...subagentsViewports);
} else if (process.argv.includes('--compaction-events-only')) {
  const compactionViewports = viewports.filter((viewport) => viewport.kind === 'trace-compacting' || viewport.kind.startsWith('trace-compacted'));
  viewports.splice(0, viewports.length, ...compactionViewports);
} else if (process.argv.includes('--trace-only')) {
  const traceViewports = viewports.filter((viewport) => viewport.kind.startsWith('trace-'));
  viewports.splice(0, viewports.length, ...traceViewports);
} else if (process.argv.includes('--trace-thinking-only')) {
  const traceThinkingViewports = viewports.filter((viewport) => viewport.kind === 'trace-thinking-expanded');
  viewports.splice(0, viewports.length, ...traceThinkingViewports);
} else if (process.argv.includes('--trace-snippet-only')) {
  const traceSnippetViewport = viewports.find((viewport) => viewport.kind === 'trace-snippet');
  viewports.splice(0, viewports.length, traceSnippetViewport);
} else if (process.argv.includes('--sidebar-only')) {
  const sidebarViewport = viewports.find((viewport) => viewport.kind === 'trace-collapsed');
  viewports.splice(0, viewports.length, sidebarViewport);
} else if (process.argv.includes('--sidebar-resize-only')) {
  const sidebarResizeViewport = viewports.find((viewport) => viewport.kind === 'sidebar-resized');
  viewports.splice(0, viewports.length, sidebarResizeViewport);
} else if (process.argv.includes('--queue-only')) {
  const queueViewports = viewports.filter((viewport) => viewport.kind === 'queue-strip');
  viewports.splice(0, viewports.length, ...queueViewports);
} else if (process.argv.includes('--queue-new-task-only')) {
  const queueNewTaskViewport = viewports.find((viewport) => viewport.kind === 'queue-new-task');
  viewports.splice(0, viewports.length, queueNewTaskViewport);
} else if (process.argv.includes('--composer-stream-only')) {
  const composerStreamViewports = viewports.filter((viewport) => viewport.kind === 'composer-stream-follow');
  viewports.splice(0, viewports.length, ...composerStreamViewports);
} else if (process.argv.includes('--side-chat-only')) {
  const sideChatViewport = viewports.find((viewport) => viewport.kind === 'side-chat');
  viewports.splice(0, viewports.length, sideChatViewport);
} else if (process.argv.includes('--local-open-only')) {
  const localOpenViewport = viewports.find((viewport) => viewport.kind === 'local-open');
  viewports.splice(0, viewports.length, localOpenViewport);
} else if (process.argv.includes('--slash-command-only')) {
  const slashCommandViewport = viewports.find((viewport) => viewport.kind === 'slash-command');
  viewports.splice(0, viewports.length, slashCommandViewport);
} else if (process.argv.includes('--simplify-only')) {
  const simplifyViewport = viewports.find((viewport) => viewport.kind === 'simplify-settings');
  viewports.splice(0, viewports.length, simplifyViewport);
} else if (process.argv.includes('--settings-defaults-only')) {
  const defaultsViewport = viewports.find((viewport) => viewport.kind === 'settings-defaults');
  viewports.splice(0, viewports.length, defaultsViewport);
} else if (process.argv.includes('--settings-global-only')) {
  const globalAgentsViewport = viewports.find((viewport) => viewport.kind === 'settings-global-agents');
  viewports.splice(0, viewports.length, globalAgentsViewport);
} else if (process.argv.includes('--settings-agents-only')) {
  const agentsViewport = viewports.find((viewport) => viewport.kind === 'settings-agents');
  viewports.splice(0, viewports.length, agentsViewport);
} else if (process.argv.includes('--dictation-setup-only')) {
  const dictationSetupViewport = viewports.find((viewport) => viewport.kind === 'settings-dictation');
  viewports.splice(0, viewports.length, dictationSetupViewport);
} else if (process.argv.includes('--settings-fixes-only')) {
  const settingsViewports = viewports.filter((viewport) => viewport.kind === 'settings-defaults' || viewport.kind === 'settings-agents' || viewport.kind === 'settings-runtime');
  viewports.splice(0, viewports.length, ...settingsViewports);
} else if (process.argv.includes('--workflows-only')) {
  const workflowsViewports = viewports.filter((viewport) => viewport.kind === 'workflows' || viewport.kind === 'workflow-screenshot-preview');
  viewports.splice(0, viewports.length, ...workflowsViewports);
} else if (process.argv.includes('--workflow-message-only')) {
  const workflowMessageViewport = viewports.find((viewport) => viewport.kind === 'workflow-message');
  viewports.splice(0, viewports.length, workflowMessageViewport);
} else if (process.argv.includes('--composer-actions-only')) {
  const composerActionsViewport = viewports.find((viewport) => viewport.kind === 'composer-actions');
  viewports.splice(0, viewports.length, composerActionsViewport);
} else if (process.argv.includes('--composer-model-only')) {
  const modelViewport = viewports.find((viewport) => viewport.kind === 'composer-model');
  viewports.splice(0, viewports.length, modelViewport);
} else if (process.argv.includes('--dictation-only')) {
  const dictationViewport = viewports.find((viewport) => viewport.kind === 'dictation-hover');
  viewports.splice(0, viewports.length, dictationViewport);
} else if (process.argv.includes('--dictation-empty-only')) {
  const dictationEmptyViewport = viewports.find((viewport) => viewport.kind === 'dictation-empty');
  viewports.splice(0, viewports.length, dictationEmptyViewport);
} else if (process.argv.includes('--message-meta-only')) {
  const metadataViewports = viewports.filter((viewport) => viewport.kind.endsWith('message-meta'));
  viewports.splice(0, viewports.length, ...metadataViewports);
} else if (process.argv.includes('--message-error-only')) {
  const errorViewport = viewports.find((viewport) => viewport.kind === 'message-error');
  viewports.splice(0, viewports.length, errorViewport);
} else if (process.argv.includes('--user-attachment-only')) {
  const attachmentViewport = viewports.find((viewport) => viewport.kind === 'user-attachment');
  viewports.splice(0, viewports.length, attachmentViewport);
} else if (process.argv.includes('--dictation-audio-only')) {
  const audioViewports = viewports.filter((viewport) => viewport.kind === 'dictation-audio-source' || viewport.kind === 'audio-message');
  viewports.splice(0, viewports.length, ...audioViewports);
} else if (process.argv.includes('--single-workspace')) viewports.splice(1);

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('force-device-scale-factor', '1');

async function waitForRenderer(window, diagnostics) {
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      const app = document.querySelector('.desktop-app');
      if (app) return resolve();
      const failure = document.querySelector('.app-loading .error-banner');
      if (failure) return reject(new Error('Renderer fixture failed: ' + (failure.textContent?.trim() ?? 'unknown error')));
      if (Date.now() - started > 10000) return reject(new Error('Renderer fixture did not become ready: ' + (document.querySelector('#root')?.textContent?.trim() ?? 'empty root')));
      setTimeout(check, 40);
    };
    check();
  })`, true).catch((error) => {
    throw new Error(`${error instanceof Error ? error.message : String(error)}${diagnostics.length ? `\n${diagnostics.join('\n')}` : ''}`);
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
}

async function capture(viewport) {
  const window = new BrowserWindow({
    x: -10_000,
    y: -10_000,
    width: viewport.width,
    height: viewport.height,
    show: false,
    backgroundColor: '#070707',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  const diagnostics = [];
  let subagentTransition = null;
  window.webContents.on('console-message', (event) => {
    diagnostics.push(`console[${event.level ?? 'unknown'}] ${event.message ?? ''} (${event.sourceId ?? ''}:${event.lineNumber ?? 0})`);
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    diagnostics.push(`render-process-gone ${JSON.stringify(details)}`);
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await window.loadFile(rendererPath, { hash: viewport.kind });
  await waitForRenderer(window, diagnostics);
  if (viewport.kind === 'composer-stream-follow') {
    window.showInactive();
    await window.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`, true);
    if (viewport.width <= 780) await window.webContents.executeJavaScript(`document.querySelector('.session-row')?.click()`, true);
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const started = Date.now();
      let previousClearance = -1;
      let stableFrames = 0;
      const check = () => {
        const scroller = document.querySelector('.conversation-scroll');
        const spacer = document.querySelector('.conversation-tail-spacer');
        const streamBodies = [...document.querySelectorAll('.message-body')].filter((body) => body.textContent?.includes('QA_STREAM_START') && body.textContent?.includes('QA_STREAM_END'));
        const clearance = spacer?.getBoundingClientRect().height ?? 0;
        const remaining = scroller ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight : Infinity;
        const ready = Boolean(document.querySelector('.workspace')) && streamBodies.length === 1 && clearance > 20 && remaining <= 1.5;
        stableFrames = ready && Math.abs(clearance - previousClearance) < .5 ? stableFrames + 1 : 0;
        previousClearance = clearance;
        if (stableFrames >= 2) return resolve();
        if (Date.now() - started > 5000) return reject(new Error('Same-message stream did not settle above the composer: ' + JSON.stringify({ hash: location.hash, streamBodies: streamBodies.length, startBodies: [...document.querySelectorAll('.message-body')].filter((body) => body.textContent?.includes('QA_STREAM_START')).length, endBodies: [...document.querySelectorAll('.message-body')].filter((body) => body.textContent?.includes('QA_STREAM_END')).length, clearance, remaining, appClass: document.querySelector('.desktop-app')?.className })));
        requestAnimationFrame(check);
      };
      check();
    })`, true);
    await window.webContents.executeJavaScript(`(async () => {
      const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      const settle = async () => { await nextFrame(); await nextFrame(); };
      const scroller = document.querySelector('.conversation-scroll');
      const spacer = document.querySelector('.conversation-tail-spacer');
      const textarea = document.querySelector('.workspace textarea[aria-label="Message"]');
      const conversation = document.querySelector('.conversation');
      if (!scroller || !spacer || !textarea || !conversation) throw new Error('Composer follow proof fixture is incomplete');
      const measure = () => ({
        clearance: spacer.getBoundingClientRect().height,
        remaining: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
      });
      const beforeGrowth = measure();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, ${JSON.stringify(Array.from({ length: 6 }, (_, index) => `Composer height probe line ${index + 1}`).join('\n'))});
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      const growthStarted = Date.now();
      while (true) {
        await nextFrame();
        const current = measure();
        if (current.clearance > beforeGrowth.clearance + 20 && current.remaining <= 1.5) break;
        if (Date.now() - growthStarted > 3000) throw new Error('Growing composer did not update the pinned tail clearance: ' + JSON.stringify({ beforeGrowth, current, textareaHeight: textarea.getBoundingClientRect().height, textareaStyleHeight: textarea.style.height, textareaValueLength: textarea.value.length }));
      }
      await settle();
      const afterGrowth = measure();
      scroller.scrollTop = Math.max(0, scroller.scrollTop - 120);
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await settle();
      const manualBefore = measure();
      const manualGrowth = document.createElement('div');
      manualGrowth.setAttribute('aria-hidden', 'true');
      manualGrowth.style.height = '96px';
      conversation.append(manualGrowth);
      await settle();
      const manualAfter = measure();
      manualGrowth.remove();
      await settle();
      scroller.scrollTop = scroller.scrollHeight;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await settle();
      window.__tethoqComposerFollowProof = {
        beforeGrowth,
        afterGrowth,
        manualBefore,
        manualAfter,
        manualScrollChange: manualAfter.scrollTop - manualBefore.scrollTop,
        restored: measure(),
      };
    })()`, true);
  } else if (viewport.kind === 'user-attachment') {
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        const gallery = document.querySelector('.message-user .message-images-before');
        const thumbnail = gallery?.querySelector('button');
        if (gallery && thumbnail) {
          gallery.scrollIntoView({ block: 'center' });
          thumbnail.click();
          return requestAnimationFrame(() => requestAnimationFrame(() => {
            window.__tethoqAttachmentLightboxOpened = Boolean(document.querySelector('.image-lightbox'));
            document.querySelector('.image-lightbox > button')?.click();
            gallery.scrollIntoView({ block: 'center' });
            requestAnimationFrame(resolve);
          }));
        }
        if (Date.now() - started > 5000) return reject(new Error('User attachment thumbnail did not render'));
        requestAnimationFrame(check);
      };
      check();
    })`, true);
  } else if (viewport.kind === 'workflow-message') {
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        const trigger = document.querySelector('.message-workflow-chip');
        if (trigger) {
          trigger.scrollIntoView({ block: 'center' });
          trigger.click();
          return requestAnimationFrame(() => requestAnimationFrame(resolve));
        }
        if (Date.now() - started > 5000) return reject(new Error('Workflow attachment widget did not render'));
        requestAnimationFrame(check);
      };
      check();
    })`, true);
  } else if (viewport.kind === 'minimum-workspace') {
    await window.webContents.executeJavaScript(`document.querySelector('.session-row')?.click()`, true);
  } else if (viewport.kind === 'composer-model') {
    await window.webContents.executeJavaScript(`document.querySelector('.model-picker-trigger')?.click()`, true);
    if (process.argv.includes('--provider-groups')) {
      await window.webContents.executeJavaScript(`document.querySelector('[data-route-group="opencode:deepseek"]')?.scrollIntoView({ block: 'start' })`, true);
    }
  } else if (viewport.kind === 'composer-model-browser') {
    await window.webContents.executeJavaScript(`document.querySelector('.model-picker-trigger')?.click()`, true);
    await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="Open full model browser"]')?.click()`, true);
  } else if (viewport.kind === 'composer-actions') {
    await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="More message actions"]')?.click()`, true);
  } else if (viewport.kind === 'queue-strip') {
    if (viewport.width <= 780) {
      await window.webContents.executeJavaScript(`document.querySelector('.session-row')?.click()`, true);
      await window.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`, true);
    }
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        const trigger = document.querySelector('.queued-message-menu > button');
        if (!trigger) {
          if (Date.now() - started > 5000) return reject(new Error('Queued instruction actions did not render'));
          return requestAnimationFrame(check);
        }
        trigger.click();
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const clickOpened = Boolean(document.querySelector('.queued-message-menu .composer-popover'));
          trigger.click();
          requestAnimationFrame(() => requestAnimationFrame(() => {
            document.querySelector('.queued-message-row')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
            requestAnimationFrame(() => requestAnimationFrame(() => {
              window.__tethoqQueueMenuRoutes = {
                click: clickOpened,
                context: Boolean(document.querySelector('.queued-message-menu .composer-popover')),
              };
              resolve();
            }));
          }));
        }));
      };
      check();
    })`, true);
  } else if (viewport.kind === 'queue-new-task') {
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        const trigger = document.querySelector('.queued-message-menu > button');
        if (!trigger) {
          if (Date.now() - started > 5000) return reject(new Error('Queued instruction actions did not render'));
          return requestAnimationFrame(check);
        }
        trigger.click();
        requestAnimationFrame(() => {
          const action = [...document.querySelectorAll('.queued-message-menu [role="menuitem"]')]
            .find((button) => button.textContent?.includes('Send to new task'));
          if (!action) return reject(new Error('Send to new task action did not render'));
          action.click();
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        });
      };
      check();
    })`, true);
  } else if (viewport.kind === 'side-chat') {
    await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="More message actions"]')?.click()`, true);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('.composer-actions-menu [role="menuitem"]')].find((button) => button.textContent?.includes('Open side chat'))?.click()`, true);
  } else if (viewport.kind === 'dictation-audio-source' || viewport.kind === 'audio-message') {
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        const row = [...document.querySelectorAll('.session-row')].find((candidate) => candidate.textContent?.includes('Listen to my recording'));
        if (row) { row.click(); return requestAnimationFrame(() => requestAnimationFrame(resolve)); }
        if (Date.now() - started > 5000) return reject(new Error('Voice notes demo session did not render'));
        requestAnimationFrame(check);
      };
      check();
    })`, true);
    if (viewport.kind === 'dictation-audio-source') {
      await window.webContents.executeJavaScript(`document.querySelector('.dictation-source-menu > button')?.click()`, true);
    }
  } else if (viewport.kind === 'composer-handoff') {
    await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="More message actions"]')?.click()`, true);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('.composer-actions-menu [role="menuitem"]')].find((button) => button.textContent?.includes('Context Handoff'))?.click()`, true);
  } else if (viewport.kind === 'composer-delegation') {
    await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="More message actions"]')?.click()`, true);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('.composer-actions-menu [role="menuitem"]')].find((button) => button.textContent?.includes('Delegate task'))?.click()`, true);
  } else if (viewport.kind === 'composer-vision') {
    await window.webContents.executeJavaScript(`document.querySelectorAll('.session-row')[1]?.click()`, true);
    await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="Add attachment"]')?.click()`, true);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('.composer-attachment-menu [role="menuitem"]')].find((button) => button.textContent?.includes('Attach workflow'))?.click()`, true);
  } else if (viewport.kind === 'dashboard') {
    await window.webContents.executeJavaScript(`document.querySelector('.primary-nav button')?.click()`, true);
  } else if (viewport.kind === 'settings' || viewport.kind === 'settings-defaults' || viewport.kind === 'settings-global-agents' || viewport.kind === 'settings-agents' || viewport.kind === 'settings-dictation' || viewport.kind === 'settings-runtime') {
    await window.webContents.executeJavaScript(`document.querySelector('.sidebar-settings')?.click()`, true);
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        const section = document.querySelector(${JSON.stringify(viewport.kind === 'settings-defaults' ? '.agent-defaults' : viewport.kind === 'settings-global-agents' ? '.global-agents-settings' : viewport.kind === 'settings-agents' ? '.provider-settings' : viewport.kind === 'settings-dictation' ? '.dictation-settings-block' : viewport.kind === 'settings-runtime' ? '.settings-compact-grid' : '.connector-section')});
        if (section) { section.scrollIntoView({ block: 'center' }); return requestAnimationFrame(() => resolve()); }
        if (Date.now() - started > 5000) return reject(new Error('Requested settings did not render'));
        requestAnimationFrame(check);
      };
      check();
    })`, true);
    if (viewport.kind === 'settings-global-agents') {
      await window.webContents.executeJavaScript(`document.querySelector('.settings-page')?.scrollBy({ top: 120, behavior: 'instant' })`, true);
    }
    if (viewport.kind === 'settings-agents') {
      const retryPoint = await window.webContents.executeJavaScript(`(() => {
        const retry = document.querySelector('button[aria-label="Retry Grok Build"]');
        const rect = retry?.getBoundingClientRect();
        return rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } : null;
      })()`, true);
      if (retryPoint) {
        window.webContents.sendInputEvent({ type: 'mouseMove', x: retryPoint.x, y: retryPoint.y });
        await new Promise((resolve) => setTimeout(resolve, 650));
      }
    }
    if (viewport.kind === 'settings-dictation') {
      await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const started = Date.now();
        const check = () => {
          const section = document.querySelector('.dictation-settings-block');
          const button = section?.querySelector('.settings-list article > button:not(:disabled)');
          if (button) {
            button.click();
            return requestAnimationFrame(() => requestAnimationFrame(() => {
              document.querySelector('.dictation-settings-editor')?.scrollIntoView({ block: 'center' });
              requestAnimationFrame(resolve);
            }));
          }
          if (Date.now() - started > 5000) return reject(new Error('Dictation provider setup action did not render'));
          requestAnimationFrame(check);
        };
        check();
      })`, true);
    }
    if (viewport.kind === 'settings-runtime') {
      await window.webContents.executeJavaScript(`new Promise((resolve) => {
        document.querySelector('.settings-compact-details > summary')?.click();
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const cards = [...document.querySelectorAll('.settings-compact-details')];
          window.__tethoqSettingsRuntimeCheck = cards.length >= 2 ? {
            firstOpen: cards[0].open,
            secondOpen: cards[1].open,
            firstHeight: cards[0].getBoundingClientRect().height,
            secondHeight: cards[1].getBoundingClientRect().height,
          } : null;
          resolve();
        }));
      })`, true);
    }
    if (viewport.kind === 'settings-defaults') {
      await window.webContents.executeJavaScript(`(async () => {
        const waitFor = (predicate) => new Promise((resolve, reject) => {
          const started = Date.now();
          const check = () => {
            if (predicate()) return requestAnimationFrame(() => resolve());
            if (Date.now() - started > 3000) return reject(new Error('Settings dismiss interaction timed out'));
            requestAnimationFrame(check);
          };
          check();
        });
        const settingsButton = document.querySelector('.sidebar-settings');
        settingsButton?.click();
        await waitFor(() => !document.querySelector('.settings-page'));
        const closedByToggle = Boolean(document.querySelector('.workspace'));
        settingsButton?.click();
        await waitFor(() => Boolean(document.querySelector('.settings-close-button')));
        document.querySelector('.settings-close-button')?.click();
        await waitFor(() => !document.querySelector('.settings-page'));
        const closedByX = Boolean(document.querySelector('.workspace'));
        settingsButton?.click();
        await waitFor(() => Boolean(document.querySelector('.agent-defaults')));
        document.querySelector('.agent-defaults')?.scrollIntoView({ block: 'center' });
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const finalClose = document.querySelector('.settings-close-button');
        const closeRect = finalClose?.getBoundingClientRect();
        window.__tethoqSettingsDismissCheck = {
          closedByToggle,
          closedByX,
          footerActiveClass: settingsButton?.classList.contains('active') ?? null,
          footerBackground: settingsButton ? getComputedStyle(settingsButton).backgroundColor : null,
          closeVisible: Boolean(closeRect && closeRect.width >= 30 && closeRect.height >= 30 && closeRect.top >= 0 && closeRect.bottom <= innerHeight),
          closeLabel: finalClose?.getAttribute('aria-label') ?? null,
        };
      })()`, true);
      window.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(viewport.width * .7), y: Math.round(viewport.height * .5) });
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
  } else if (viewport.kind === 'new-task-draft') {
    await window.webContents.executeJavaScript(`document.querySelector('.new-task-button')?.click()`, true);
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        const draft = document.querySelector('.workspace .workspace-location.draft-location');
        const picker = document.querySelector('.workspace .model-picker-trigger');
        const connectorModel = [...document.querySelectorAll('.model-picker-dropup [data-provider-group="tethoq-example"] button')]
          .find((button) => button.textContent?.includes('Tethoq Example Reasoning'));
        if (connectorModel) { connectorModel.click(); return requestAnimationFrame(() => {
          document.querySelector('.workspace .model-picker-trigger')?.click();
          const finish = () => {
            const selected = document.querySelector('.model-picker-dropup [data-provider-group="tethoq-example"] button[aria-current="true"]');
            if (selected) { selected.scrollIntoView({ block: 'nearest' }); return requestAnimationFrame(() => {
              const catalog = document.querySelector('.model-picker-dropup');
              const bounds = catalog?.getBoundingClientRect();
              window.__tethoqDraftPickerCheck = {
                selectedConnectorModel: selected.textContent?.trim() ?? null,
                bounds: bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, right: bounds.right, bottom: bounds.bottom } : null,
              };
              document.querySelector('.workspace .model-picker-trigger')?.click();
              requestAnimationFrame(resolve);
            }); }
            if (Date.now() - started > 5000) return reject(new Error('Selected connector model did not remain in the local draft'));
            requestAnimationFrame(finish);
          };
          requestAnimationFrame(finish);
        }); }
        if (draft && picker && !document.querySelector('.model-picker-dropup')) { picker.click(); return requestAnimationFrame(check); }
        if (Date.now() - started > 5000) return reject(new Error('Local draft connector model did not render'));
        requestAnimationFrame(check);
      };
      check();
    })`, true);
  } else if (viewport.kind === 'approval') {
    await window.webContents.executeJavaScript(`document.querySelectorAll('.session-row')[1]?.click()`, true);
  } else if (viewport.kind === 'browser') {
    await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="More message actions"]')?.click()`, true);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('.composer-actions-menu [role="menuitem"]')].find((button) => button.textContent?.includes('Open session browser'))?.click()`, true);
  } else if (viewport.kind === 'browser-downloads') {
    await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="More message actions"]')?.click()`, true);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('.composer-actions-menu [role="menuitem"]')].find((button) => button.textContent?.includes('Open session browser'))?.click()`, true);
    await window.webContents.executeJavaScript(`window.__tethoqDownloadViewportBefore = (() => { const rect = document.querySelector('.browser-viewport')?.getBoundingClientRect(); return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null; })()`, true);
    await window.webContents.executeJavaScript(`document.querySelector('.browser-downloads')?.click()`, true);
  } else if (viewport.kind === 'workflows' || viewport.kind === 'workflow-screenshot-preview') {
    await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="More message actions"]')?.click()`, true);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('.composer-actions-menu [role="menuitem"]')].find((button) => button.textContent?.includes('Manage workflows'))?.click()`, true);
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        const workflow = document.querySelector('.workflow-entry-trigger');
        if (!workflow) {
          if (Date.now() - started > 5000) return reject(new Error('Workflow preview fixture did not render'));
          return requestAnimationFrame(check);
        }
        if (workflow.getAttribute('aria-expanded') !== 'true') workflow.click();
        const details = document.querySelector('.workflow-capture-details');
        if (details && !details.open) details.querySelector('summary')?.click();
        const gallery = document.querySelector('.workflow-screenshot-gallery');
        const images = gallery?.querySelectorAll('.workflow-screenshot-item img') ?? [];
        if (gallery && images.length >= 4) {
          gallery.scrollIntoView({ block: 'center' });
          gallery.querySelector('.workflow-screenshot-item')?.click();
          return requestAnimationFrame(() => requestAnimationFrame(() => {
            window.__tethoqWorkflowLightboxOpened = Boolean(document.querySelector('.workflow-screenshot-lightbox img'));
            if (${JSON.stringify(viewport.kind === 'workflow-screenshot-preview')}) return requestAnimationFrame(resolve);
            document.querySelector('.workflow-screenshot-lightbox-close')?.click();
            gallery.scrollIntoView({ block: 'center' });
            requestAnimationFrame(resolve);
          }));
        }
        if (Date.now() - started > 5000) return reject(new Error('Workflow screenshot gallery did not finish loading'));
        requestAnimationFrame(check);
      };
      check();
    })`, true);
  } else if (viewport.kind === 'context-compaction') {
    const clickPoint = async (point) => {
      if (!point) throw new Error('Context compaction control did not render');
      window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
      window.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      window.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      await new Promise((resolve) => setTimeout(resolve, 90));
    };
    const elementPoint = async (expression) => await window.webContents.executeJavaScript(`(() => {
      const element = ${expression};
      const rect = element?.getBoundingClientRect();
      return rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } : null;
    })()`, true);
    const triggerPoint = async () => await elementPoint(`document.querySelector('.context-usage-trigger')`);
    const applyPoint = async () => await elementPoint(`[...document.querySelectorAll('.context-threshold button')].find((button) => button.textContent?.trim() === 'Apply')`);
    const contextReading = async () => await window.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('.context-threshold-meter input[type="range"]');
      const meter = document.querySelector('.context-usage-track');
      const applied = [...document.querySelectorAll('.context-usage-stats > div')].find((row) => row.querySelector('dt')?.textContent?.trim() === 'Compacts at');
      return {
        sliderValue: input ? Number(input.value) : null,
        thresholdText: document.querySelector('.context-usage-heading b')?.textContent?.trim() ?? null,
        percentText: document.querySelector('.context-usage-percent')?.textContent?.trim() ?? null,
        ariaNow: meter?.getAttribute('aria-valuenow') ?? null,
        meterLabel: meter?.getAttribute('aria-label') ?? null,
        appliedText: applied?.querySelector('dd')?.textContent?.trim() ?? null,
        noteText: document.querySelector('.context-threshold-note')?.textContent?.trim() ?? null,
      };
    })()`, true);
    const dragThresholdToMinimum = async () => {
      const drag = await window.webContents.executeJavaScript(`(() => {
        const input = document.querySelector('.context-threshold-meter input[type="range"]');
        const rect = input?.getBoundingClientRect();
        if (!input || !rect) return null;
        const minimum = Number(input.min);
        const maximum = Number(input.max);
        const value = Number(input.value);
        const fraction = maximum > minimum ? (value - minimum) / (maximum - minimum) : 0;
        return {
          startX: Math.round(rect.left + Math.max(0, Math.min(1, fraction)) * rect.width),
          endX: Math.round(rect.left + 1),
          y: Math.round(rect.top + rect.height / 2),
        };
      })()`, true);
      if (!drag) throw new Error('Context threshold slider did not render');
      window.webContents.sendInputEvent({ type: 'mouseMove', x: drag.startX, y: drag.y });
      window.webContents.sendInputEvent({ type: 'mouseDown', x: drag.startX, y: drag.y, button: 'left', clickCount: 1 });
      window.webContents.sendInputEvent({ type: 'mouseMove', x: drag.endX, y: drag.y, button: 'left' });
      window.webContents.sendInputEvent({ type: 'mouseUp', x: drag.endX, y: drag.y, button: 'left', clickCount: 1 });
      await new Promise((resolve) => setTimeout(resolve, 120));
    };

    await clickPoint(await triggerPoint());
    const initial = await contextReading();
    await dragThresholdToMinimum();
    const draft = await contextReading();
    await clickPoint(await triggerPoint());
    await clickPoint(await triggerPoint());
    const reopened = await contextReading();
    await dragThresholdToMinimum();
    await clickPoint(await applyPoint());
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        if (!document.querySelector('.context-usage-popover')) return resolve();
        if (Date.now() - started > 3000) return reject(new Error('Context Apply did not close the popover'));
        requestAnimationFrame(check);
      };
      check();
    })`, true);
    await clickPoint(await triggerPoint());
    const applied = await contextReading();
    await window.webContents.executeJavaScript(`window.__tethoqContextInteraction = ${JSON.stringify({ initial, draft, reopened, applied })}`, true);
  } else if (viewport.kind === 'trace-compacted-expanded') {
    await window.webContents.executeJavaScript(`document.querySelector('.timeline-compaction-toggle[aria-expanded="false"]')?.click()`, true);
  } else if (viewport.kind === 'task-details') {
    await window.webContents.executeJavaScript(`document.querySelector('.task-details-trigger')?.click()`, true);
  } else if (viewport.kind === 'subagents-hover') {
    const point = await window.webContents.executeJavaScript(`(() => { const rect = document.querySelector('.session-subagents-trigger')?.getBoundingClientRect(); return rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } : null; })()`, true);
    if (!point) throw new Error('Sub-agent hover target is missing');
    window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
    await new Promise((resolve) => setTimeout(resolve, 650));
  } else if (viewport.kind === 'subagents') {
    const point = await window.webContents.executeJavaScript(`(() => { const rect = document.querySelector('.session-subagents-trigger')?.getBoundingClientRect(); return rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } : null; })()`, true);
    if (!point) throw new Error('Sub-agent disclosure target is missing');
    window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
    window.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    const readChildState = async () => await window.webContents.executeJavaScript(`(() => {
      const row = document.querySelector('.session-subagents-popover > button');
      const label = row?.querySelector('small')?.textContent ?? '';
      const spinner = row?.querySelector('.spinner');
      return row ? {
        label,
        spinnerCount: row.querySelectorAll('.spinner').length,
        spinnerAnimation: spinner ? getComputedStyle(spinner).animationName : 'none',
      } : null;
    })()`, true);
    const waitForChildLabel = async (expected) => await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        const row = document.querySelector('.session-subagents-popover > button');
        const label = row?.querySelector('small')?.textContent ?? '';
        if (label.includes(${JSON.stringify(expected)})) return resolve();
        if (Date.now() - started > 4500) return reject(new Error('Sub-agent did not reach ${expected}: ' + label));
        setTimeout(check, 40);
      };
      check();
    })`, true);
    await waitForChildLabel('Idle');
    const idle = await readChildState();
    await waitForChildLabel('Working');
    const working = await readChildState();
    await waitForChildLabel('Completed');
    const completed = await readChildState();
    subagentTransition = { idle, working, completed };
  } else if (viewport.kind === 'local-open') {
    await window.webContents.executeJavaScript(`document.querySelector('.workspace-local-open-arrow')?.click()`, true);
  } else if (viewport.kind === 'slash-command') {
    await window.webContents.executeJavaScript(`(() => {
      const textarea = document.querySelector('.workspace textarea[aria-label="Message"]');
      if (!textarea) return;
      textarea.focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, '/');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    })()`, true);
  } else if (viewport.kind === 'simplify-settings') {
    await window.webContents.executeJavaScript(`(() => {
      const textarea = document.querySelector('.workspace textarea[aria-label="Message"]');
      if (!textarea) return;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, '/simplify explain this clearly');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    })()`, true);
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        const trigger = document.querySelector('button[aria-label="Simplify settings"]');
        if (trigger) { trigger.click(); return requestAnimationFrame(() => requestAnimationFrame(resolve)); }
        if (Date.now() - started > 5000) return reject(new Error('Simplify settings trigger did not render'));
        requestAnimationFrame(check);
      };
      check();
    })`, true);
  } else if (viewport.kind === 'trace-expanded' || viewport.kind === 'trace-thinking-expanded' || viewport.kind === 'trace-snippet' || viewport.kind === 'thinking-message-meta') {
    if (viewport.width <= 780) {
      await window.webContents.executeJavaScript(`document.querySelector('.session-row')?.click()`, true);
      await window.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`, true);
    }
    await window.webContents.executeJavaScript(`document.querySelector('.reasoning-disclosure[aria-expanded="false"]')?.click()`, true);
    if (viewport.kind === 'trace-thinking-expanded') {
      await window.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`, true);
      await window.webContents.executeJavaScript(`document.querySelector('.reasoning-group')?.scrollIntoView({ block: 'center' })`, true);
    } else if (viewport.kind === 'trace-snippet') {
      await window.webContents.executeJavaScript(`document.querySelector('.reasoning-activity-segment > .reasoning-segment-row[aria-expanded="false"]')?.click()`, true);
      await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const started = Date.now();
        const check = () => {
          const row = document.querySelector('.reasoning-activities .activity-row[aria-expanded="false"]');
          if (row) { row.click(); return requestAnimationFrame(resolve); }
          if (Date.now() - started > 5000) return reject(new Error('Collapsed trace activity did not render'));
          requestAnimationFrame(check);
        };
        check();
      })`, true);
      await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const started = Date.now();
        const check = () => {
          const snippet = document.querySelector('.activity-snippet pre');
          if (snippet) {
            snippet.textContent = Array.from({ length: 80 }, (_, index) => String(index + 1).padStart(3, '0') + '  const fixtureLine = "bounded trace detail";').join('\\n');
            const surface = snippet.closest('.activity-snippet');
            const scroller = document.querySelector('.conversation-scroll');
            if (surface && scroller) {
              const surfaceBounds = surface.getBoundingClientRect();
              const scrollerBounds = scroller.getBoundingClientRect();
              scroller.scrollTop += surfaceBounds.top - scrollerBounds.top - 8;
            }
            return requestAnimationFrame(() => requestAnimationFrame(resolve));
          }
          if (Date.now() - started > 5000) return reject(new Error('Expanded trace snippet did not render'));
          requestAnimationFrame(check);
        };
        check();
      })`, true);
    }
  } else if (viewport.kind === 'dictation-empty') {
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        const button = document.querySelector('.workspace .dictation-main');
        if (button) {
          button.click();
          return requestAnimationFrame(() => requestAnimationFrame(resolve));
        }
        if (Date.now() - started > 5000) return reject(new Error('Dictation sources did not load'));
        requestAnimationFrame(check);
      };
      check();
    })`, true);
  } else if (viewport.kind === 'wallet') {
    await window.webContents.executeJavaScript(`document.querySelector('.wallet-trigger')?.click()`, true);
  } else if (viewport.kind === 'wallet-direct-advanced') {
    await window.webContents.executeJavaScript(`document.querySelector('.wallet-trigger')?.click()`, true);
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        const button = [...document.querySelectorAll('.wallet-popover button')].find((item) => item.textContent?.includes('Configure Direct API'));
        if (button) { button.click(); return resolve(); }
        if (Date.now() - started > 5000) return reject(new Error('Direct wallet action did not render'));
        requestAnimationFrame(check);
      };
      check();
    })`, true);
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        const button = document.querySelector('.wallet-advanced-toggle');
        if (button) { button.click(); return requestAnimationFrame(() => { document.querySelector('.wallet-popover')?.scrollTo({ top: 10000 }); resolve(); }); }
        if (Date.now() - started > 5000) return reject(new Error('Direct wallet settings did not render'));
        requestAnimationFrame(check);
      };
      check();
    })`, true);
  }
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (document.querySelector(${JSON.stringify(viewport.selector)})) return resolve();
      if (Date.now() - started > 5000) return reject(new Error('Expected visual state did not render: ${viewport.selector}'));
      requestAnimationFrame(check);
    };
    check();
  })`, true);
  window.showInactive();
  await window.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`, true);
  if (viewport.kind === 'sidebar-resized') {
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const handle = document.querySelector('.navigation-resize-handle');
      if (!handle) return reject(new Error('Sidebar resize handle did not render'));
      handle.focus();
      handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const sidebar = document.querySelector('.sidebar');
        const row = document.querySelector('.session-row');
        const title = row?.querySelector('.session-row-title');
        const preview = row?.querySelector('.session-row-preview');
        const newTask = document.querySelector('.new-task-button');
        if (!sidebar || !row || !title || !preview || !newTask) return reject(new Error('Sidebar resize fixture is incomplete'));
        const measure = () => ({
          sidebarWidth: sidebar.getBoundingClientRect().width,
          rowWidth: row.getBoundingClientRect().width,
          titleWidth: title.getBoundingClientRect().width,
          previewWidth: preview.getBoundingClientRect().width,
          newTaskWidth: newTask.getBoundingClientRect().width,
        });
        const before = measure();
        const bounds = handle.getBoundingClientRect();
        const startX = bounds.left + bounds.width / 2;
        handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: startX, clientY: bounds.top + 40 }));
        window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, clientX: startX + 120, clientY: bounds.top + 40 }));
        requestAnimationFrame(() => requestAnimationFrame(() => {
          window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: startX + 120, clientY: bounds.top + 40 }));
          requestAnimationFrame(() => {
            const after = measure();
            const handleBounds = handle.getBoundingClientRect();
            window.__tethoqSidebarResizeCheck = {
              before,
              after,
              cursor: getComputedStyle(handle).cursor,
              role: handle.getAttribute('role'),
              orientation: handle.getAttribute('aria-orientation'),
              valueNow: Number(handle.getAttribute('aria-valuenow')),
              handleWidth: handleBounds.width,
              handleSidebarDelta: handleBounds.left + handleBounds.width / 2 - sidebar.getBoundingClientRect().right,
            };
            resolve();
          });
        }));
      }));
    })`, true);
  } else if (viewport.kind === 'dictation-hover') {
    const point = await window.webContents.executeJavaScript(`(() => { const rect = document.querySelector('.dictation-source-menu > button')?.getBoundingClientRect(); return rect ? { x: Math.round(rect.left + rect.width / 2 - 1), y: Math.round(rect.bottom - 7) } : null; })()`, true);
    if (!point) throw new Error('Dictation source hover target is missing');
    window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
    await new Promise((resolve) => setTimeout(resolve, 180));
  } else if (viewport.kind === 'trace-snippet') {
    await window.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const surface = document.querySelector('.activity-snippet');
      const scroller = document.querySelector('.conversation-scroll');
      if (surface && scroller) {
        const surfaceBounds = surface.getBoundingClientRect();
        const scrollerBounds = scroller.getBoundingClientRect();
        scroller.scrollTop += surfaceBounds.top - scrollerBounds.top - 8;
      }
      requestAnimationFrame(resolve);
    })))`, true);
  } else if (viewport.kind === 'final-message-meta' || viewport.kind === 'user-message-meta' || viewport.kind === 'thinking-message-meta') {
    const hoverSelector = viewport.kind === 'final-message-meta'
      ? '.message-with-identity .message-body'
      : viewport.kind === 'user-message-meta'
        ? '.message-user .message-body'
        : '.reasoning-thinking-segment .reasoning-segment-row';
    await window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(hoverSelector)})?.scrollIntoView({ block: 'center' })`, true);
    const point = await window.webContents.executeJavaScript(`(() => { const rect = document.querySelector(${JSON.stringify(hoverSelector)})?.getBoundingClientRect(); return rect ? { x: Math.round(rect.left + Math.min(rect.width / 2, 120)), y: Math.round(rect.top + rect.height / 2) } : null; })()`, true);
    if (!point) throw new Error('Message metadata hover target is missing');
    window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
  window.webContents.invalidate();
  await new Promise((resolve) => setTimeout(resolve, 300));
  let composerCoverPixels = null;
  if (viewport.kind === 'composer-stream-follow') {
    const probePoints = await window.webContents.executeJavaScript(`(() => {
      const wrap = document.querySelector('.composer-wrap');
      const box = document.querySelector('.composer-box');
      const wrapBounds = wrap?.getBoundingClientRect();
      const boxBounds = box?.getBoundingClientRect();
      if (!wrapBounds || !boxBounds) throw new Error('Composer compositor probe has no surface bounds');
      const points = {
        cover: { x: Math.round(wrapBounds.left + 18), y: Math.round(boxBounds.bottom + (wrapBounds.bottom - boxBounds.bottom) / 2) },
        transparent: { x: Math.round(wrapBounds.left + 18), y: Math.round(boxBounds.top - 12) },
      };
      for (const point of Object.values(points)) {
        const marker = document.createElement('i');
        marker.className = 'tethoq-compositor-probe';
        marker.setAttribute('aria-hidden', 'true');
        marker.style.cssText = 'position:fixed;z-index:1;width:11px;height:11px;pointer-events:none;background:#ff00ff;';
        marker.style.left = (point.x - 5) + 'px';
        marker.style.top = (point.y - 5) + 'px';
        (document.querySelector('.desktop-app') ?? document.body).append(marker);
      }
      return points;
    })()`, true);
    await window.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`, true);
    window.webContents.invalidate();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const magentaImage = await window.webContents.capturePage();
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('.tethoq-compositor-probe')].forEach((element) => { element.style.background = '#00ff00'; })`, true);
    await window.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`, true);
    window.webContents.invalidate();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const greenImage = await window.webContents.capturePage();
    const sample = (image, point) => [...image.crop({ x: point.x, y: point.y, width: 1, height: 1 }).toBitmap().subarray(0, 4)];
    const colors = {
      cover: { magenta: sample(magentaImage, probePoints.cover), green: sample(greenImage, probePoints.cover) },
      transparent: { magenta: sample(magentaImage, probePoints.transparent), green: sample(greenImage, probePoints.transparent) },
    };
    const delta = (pair) => pair.magenta.slice(0, 3).map((channel, index) => Math.abs(channel - pair.green[index]));
    composerCoverPixels = {
      format: 'BGRA',
      points: probePoints,
      ...colors,
      coverDelta: delta(colors.cover),
      transparentDelta: delta(colors.transparent),
    };
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('.tethoq-compositor-probe')].forEach((element) => element.remove())`, true);
    await window.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`, true);
    window.webContents.invalidate();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const layout = await window.webContents.executeJavaScript(`(() => {
    const root = document.querySelector('#root');
    const bodyStyle = getComputedStyle(document.body);
    const buttons = [...document.querySelectorAll('button')];
    const inputs = [...document.querySelectorAll('input, textarea, select')];
    const visible = (element) => {
      let current = element;
      while (current) {
        const ancestorStyle = getComputedStyle(current);
        if (ancestorStyle.display === 'none' || ancestorStyle.visibility === 'hidden' || Number(ancestorStyle.opacity) === 0) return false;
        current = current.parentElement;
      }
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return rect.width > 1 && rect.height > 1;
    };
    const overflow = [...document.querySelectorAll('*')].filter((element) => {
      const rect = element.getBoundingClientRect();
      return visible(element) && (rect.left < -2 || rect.right > innerWidth + 2);
    }).slice(0, 8).map((element) => ({ tag: element.tagName, className: String(element.className), text: element.textContent?.trim().slice(0, 48) }));
    const clippedControls = [...document.querySelectorAll('button, input, textarea, select, [role="dialog"], [role="menu"]')].filter((element) => {
      if (!visible(element)) return false;
      const rect = element.getBoundingClientRect();
      const scrollContainer = element.closest('.session-list-scroll, .conversation-scroll, .settings-page, .dashboard-page, .browser-download-list, .workflow-settings-list, .modal, .composer-popover, .chat-picker, .model-picker-scroll, .model-library-scroll, .wallet-popover');
      const scrollRect = scrollContainer?.getBoundingClientRect();
      const verticallyClippedByScroll = scrollRect && (rect.bottom > scrollRect.bottom || rect.top < scrollRect.top);
      return !verticallyClippedByScroll && (rect.left < -2 || rect.top < -2 || rect.right > innerWidth + 2 || rect.bottom > innerHeight + 2);
    }).slice(0, 8).map((element) => ({ tag: element.tagName, className: String(element.className), label: element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 48) }));
    const tinyReadableText = [...document.querySelectorAll('button, input, textarea, select, p, small, time, dt, dd, code, strong, .status')].filter((element) => {
      if (!visible(element) || element.closest('.preview-badge')) return false;
      const text = element.textContent?.trim();
      if (!text) return false;
      return Number.parseFloat(getComputedStyle(element).fontSize) < 8;
    }).slice(0, 8).map((element) => ({ tag: element.tagName, className: String(element.className), text: element.textContent?.trim().slice(0, 48), fontSize: getComputedStyle(element).fontSize }));
    return {
      viewport: { width: innerWidth, height: innerHeight },
      document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
      rootChildren: root?.children.length ?? 0,
      rootTextLength: root?.textContent?.trim().length ?? 0,
      appReady: Boolean(document.querySelector('.desktop-app')),
      loading: Boolean(document.querySelector('.app-loading')),
      expectedStateReady: Boolean(document.querySelector(${JSON.stringify(viewport.selector)})),
      expectedStateBounds: (() => { const rect = document.querySelector(${JSON.stringify(viewport.selector)})?.getBoundingClientRect(); return rect ? { width: rect.width, height: rect.height } : null; })(),
      slashCommandPalette: ${JSON.stringify(viewport.kind === 'slash-command')} ? (() => {
        const palette = document.querySelector('.slash-command-palette');
        const textarea = document.querySelector('.workspace textarea[aria-label="Message"]');
        return palette && textarea ? {
          query: textarea.value,
          commands: [...palette.querySelectorAll('[role="option"]')].map((item) => item.textContent?.trim() ?? ''),
          selected: palette.querySelector('[aria-selected="true"]')?.textContent?.trim() ?? null,
        } : null;
      })() : null,
      newTaskDraft: (() => {
        const modelPicker = document.querySelector('.workspace .model-picker-trigger');
        const directoryControl = document.querySelector('.workspace .workspace-location.draft-location');
        const modelPickerBounds = modelPicker?.getBoundingClientRect();
        const directoryBounds = directoryControl?.getBoundingClientRect();
        return {
          modalCount: document.querySelectorAll('.modal').length,
          title: document.querySelector('.workspace-title h1')?.textContent?.trim() ?? null,
          modelPicker: modelPicker ? { visible: visible(modelPicker), label: modelPicker.getAttribute('aria-label'), text: modelPicker.textContent?.trim() ?? null, bounds: modelPickerBounds ? { x: modelPickerBounds.x, y: modelPickerBounds.y, right: modelPickerBounds.right, bottom: modelPickerBounds.bottom } : null } : null,
          directoryControl: directoryControl ? { visible: visible(directoryControl), label: directoryControl.getAttribute('aria-label'), text: directoryControl.textContent?.trim() ?? null, bounds: directoryBounds ? { x: directoryBounds.x, y: directoryBounds.y, right: directoryBounds.right, bottom: directoryBounds.bottom } : null } : null,
          pickerCheck: window.__tethoqDraftPickerCheck ?? null,
        };
      })(),
      composerAlignment: (() => {
        const model = document.querySelector('.workspace .model-picker-root');
        const effort = document.querySelector('.workspace .effort-choice');
        const modelLabel = model?.querySelector('.composer-setting-label')?.getBoundingClientRect();
        const modelValue = model?.querySelector('.composer-setting-value strong')?.getBoundingClientRect();
        const modelLogo = model?.querySelector('.provider-logo')?.getBoundingClientRect();
        const effortLabel = effort?.querySelector('.composer-setting-label')?.getBoundingClientRect();
        const effortValue = effort?.querySelector('.composer-setting-value strong')?.getBoundingClientRect();
        const microphone = document.querySelector('.workspace .dictation-main > svg')?.getBoundingClientRect();
        const dictationArrow = document.querySelector('.workspace .dictation-source-menu > button svg')?.getBoundingClientRect();
        const send = document.querySelector('.workspace .send-button')?.getBoundingClientRect();
        const center = (rect) => rect ? rect.top + rect.height / 2 : null;
        const horizontalCenter = (rect) => rect ? rect.left + rect.width / 2 : null;
        return modelLabel && modelValue && modelLogo && effortLabel && effortValue && microphone && dictationArrow && send ? {
          modelValueDelta: center(modelValue) - center(modelLabel),
          modelLogoDelta: center(modelLogo) - center(modelLabel),
          effortValueDelta: center(effortValue) - center(effortLabel),
          labelDelta: center(effortLabel) - center(modelLabel),
          microphoneSendDelta: center(microphone) - center(send),
          arrowMicrophoneDelta: horizontalCenter(dictationArrow) - horizontalCenter(microphone),
        } : null;
      })(),
      headerAlignment: (() => {
        const title = document.querySelector('.workspace-title h1');
        const track = document.querySelector('.context-usage-track')?.getBoundingClientRect();
        const text = title?.firstChild;
        if (!track || !text || text.nodeType !== Node.TEXT_NODE || !text.textContent?.length) return null;
        const range = document.createRange();
        range.setStart(text, 0);
        range.setEnd(text, 1);
        const glyph = range.getBoundingClientRect();
        return {
          contextTrackDelta: track.top + track.height / 2 - (glyph.top + glyph.height / 2),
          track: { top: track.top, height: track.height },
          titleGlyph: { top: glyph.top, height: glyph.height },
        };
      })(),
      composerMore: (() => {
        const button = document.querySelector('.workspace .composer-actions-menu > button');
        if (!button) return null;
        const bounds = button.getBoundingClientRect();
        const highlight = getComputedStyle(button, '::before');
        return { hitWidth: bounds.width, hitHeight: bounds.height, highlightWidth: parseFloat(highlight.width), highlightHeight: parseFloat(highlight.height), highlightRadius: parseFloat(highlight.borderRadius) };
      })(),
      dictationShape: (() => {
        const main = document.querySelector('.workspace .dictation-main')?.getBoundingClientRect();
        const menu = document.querySelector('.workspace .dictation-source-menu')?.getBoundingClientRect();
        const button = document.querySelector('.workspace .dictation-source-menu > button');
        const buttonBounds = button?.getBoundingClientRect();
        const fill = button ? getComputedStyle(button, '::before') : null;
        const buttonStyle = button ? getComputedStyle(button) : null;
        const microphone = document.querySelector('.workspace .dictation-main > svg');
        const microphoneStyle = microphone ? getComputedStyle(microphone) : null;
        const upperHit = main ? document.elementFromPoint(main.left + main.width / 2, main.top + 10)?.closest('button') : null;
        const lowerHit = main ? document.elementFromPoint(main.left + main.width / 2, main.bottom - 7)?.closest('button') : null;
        return main && menu && buttonBounds && fill ? {
          main: { left: main.left, right: main.right, bottom: main.bottom, width: main.width, height: main.height },
          menu: { left: menu.left, right: menu.right, bottom: menu.bottom, width: menu.width, height: menu.height },
          button: { left: buttonBounds.left, right: buttonBounds.right, bottom: buttonBounds.bottom, width: buttonBounds.width, height: buttonBounds.height },
          fill: { width: parseFloat(fill.width), height: parseFloat(fill.height), radius: parseFloat(fill.borderRadius), background: fill.backgroundColor },
          clipPath: buttonStyle?.clipPath ?? null,
          fillClipPath: fill.clipPath,
          microphoneZIndex: microphoneStyle?.zIndex ?? null,
          upperHitIsMain: upperHit?.classList.contains('dictation-main') ?? false,
          lowerHitIsSource: lowerHit?.parentElement?.classList.contains('dictation-source-menu') ?? false,
        } : null;
      })(),
      dictationEmpty: (() => {
        const empty = document.querySelector('.dictation-source-empty');
        const popover = empty?.closest('.composer-popover');
        const bounds = popover?.getBoundingClientRect();
        return empty && popover && bounds ? {
          heading: empty.querySelector('strong')?.textContent?.trim() ?? null,
          guidance: empty.querySelector('small')?.textContent?.trim() ?? null,
          setupRows: [...popover.querySelectorAll('.dictation-sources-scroll > button')].filter((button) => button.textContent?.includes('Set up')).length,
          checkedRows: popover.querySelectorAll('.dictation-unlimited-group > button[aria-checked="true"], .dictation-sources-scroll > button[aria-checked="true"]').length,
          bounds: { x: bounds.x, y: bounds.y, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height },
        } : null;
      })(),
      modelCatalog: ${JSON.stringify(viewport.kind === 'composer-model')} ? (() => {
        const panel = document.querySelector('.model-picker-dropup');
        const headings = [...(panel?.querySelectorAll('h4') ?? [])].map((heading) => heading.textContent?.trim() ?? '');
        const badges = [...(panel?.querySelectorAll('.model-row-meta') ?? [])].map((meta) => meta.textContent?.trim() ?? '');
        return panel ? { headings, badges, text: panel.textContent?.replace(/\s+/g, ' ').trim() ?? '' } : null;
      })() : null,
      dictationAudioSource: ${JSON.stringify(viewport.kind === 'dictation-audio-source')} ? (() => {
        const popover = document.querySelector('.dictation-source-menu .composer-popover');
        const option = popover?.querySelector('.dictation-direct-audio-option');
        return popover ? {
          text: popover.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          mp3Label: option?.querySelector('strong')?.textContent?.trim() ?? null,
          checked: option?.getAttribute('aria-checked') ?? null,
        } : null;
      })() : null,
      messageMetadata: (() => {
        const measureFooter = (selector) => {
          const footer = document.querySelector(selector);
          const footerBounds = footer?.getBoundingClientRect();
          const footerStyle = footer ? getComputedStyle(footer) : null;
          const bodyBounds = footer?.closest('.message-content')?.querySelector('.message-body')?.getBoundingClientRect();
          const copyBounds = footer?.querySelector('.copy-message')?.getBoundingClientRect();
          return footerBounds && footerStyle && bodyBounds ? {
            opacity: footerStyle.opacity,
            background: footerStyle.backgroundColor,
            left: footerBounds.left,
            top: footerBounds.top,
            bodyLeft: bodyBounds.left,
            bodyBottom: bodyBounds.bottom,
            copyButtons: footer.querySelectorAll('.copy-message').length,
            copyWidth: copyBounds?.width ?? null,
            copyHeight: copyBounds?.height ?? null,
          } : null;
        };
        const traceMeta = document.querySelector('.reasoning-thinking-segment .timeline-item-meta');
        const traceBounds = traceMeta?.getBoundingClientRect();
        const traceStyle = traceMeta ? getComputedStyle(traceMeta) : null;
        return {
          legacyMessageMetaCount: document.querySelectorAll('.message-meta').length,
          finalFooterCount: document.querySelectorAll('.message-assistant .message-footer').length,
          userFooterCount: document.querySelectorAll('.message-user .message-footer').length,
          assistantIdentityCount: document.querySelectorAll('.message .assistant-identity').length,
          finalFooter: measureFooter('.message-assistant .message-footer'),
          userFooter: measureFooter('.message-user .message-footer'),
          thinkingMeta: traceBounds && traceStyle ? { opacity: traceStyle.opacity, width: traceBounds.width, copyButtons: traceMeta.querySelectorAll('.timeline-copy-button').length } : null,
        };
      })(),
      errorNotice: (() => {
        const notice = document.querySelector('.timeline-error-notice');
        if (!notice) return null;
        const bounds = notice.getBoundingClientRect();
        const style = getComputedStyle(notice);
        return { text: notice.textContent?.trim() ?? '', width: bounds.width, height: bounds.height, color: style.color, background: style.backgroundColor, borderWidth: style.borderWidth };
      })(),
      userAttachment: ${JSON.stringify(viewport.kind === 'user-attachment')} ? (() => {
        const message = document.querySelector('.message-user:has(.message-images-before)');
        const gallery = message?.querySelector('.message-images-before');
        const body = message?.querySelector('.message-body');
        const thumbnail = gallery?.querySelector('button');
        const galleryBounds = gallery?.getBoundingClientRect();
        const bodyBounds = body?.getBoundingClientRect();
        return message && gallery && body && thumbnail && galleryBounds && bodyBounds ? {
          body: body.textContent?.trim() ?? '',
          messageText: message.textContent?.trim() ?? '',
          thumbnails: gallery.querySelectorAll('button').length,
          galleryBottom: galleryBounds.bottom,
          bodyTop: bodyBounds.top,
          lightboxOpened: window.__tethoqAttachmentLightboxOpened === true,
        } : null;
      })() : null,
      workflowMessage: ${JSON.stringify(viewport.kind === 'workflow-message')} ? (() => {
        const message = document.querySelector('.message-user:has(.message-workflow-chip)');
        const trigger = message?.querySelector('.message-workflow-chip');
        const panel = document.querySelector('.message-workflow-panel');
        return message && trigger && panel ? {
          prompt: message.querySelector('.message-body')?.textContent?.trim() ?? '',
          triggerText: trigger.textContent?.trim() ?? '',
          panelText: panel.textContent?.trim() ?? '',
          rawControlText: /Recorded workflow context|events\.ndjson|workflow\.json/u.test(message.textContent ?? ''),
        } : null;
      })() : null,
      failedStatusColor: document.querySelector('.workspace-header .status-failed') ? getComputedStyle(document.querySelector('.workspace-header .status-failed')).color : null,
      sidebarResize: window.__tethoqSidebarResizeCheck ?? null,
      connectorCards: document.querySelectorAll('.connector-card').length,
      agentDefaults: ${JSON.stringify(viewport.kind === 'settings-defaults')} ? {
        rows: document.querySelectorAll('.agent-default-list > article').length,
        selects: document.querySelectorAll('.agent-default-controls select').length,
        text: document.querySelector('.agent-defaults')?.textContent?.trim() ?? '',
      } : null,
      globalAgentsText: document.querySelector('.global-agents-settings')?.textContent?.trim() ?? '',
      settingsRuntime: window.__tethoqSettingsRuntimeCheck ?? null,
      workflowGallery: ${JSON.stringify(viewport.kind === 'workflows' || viewport.kind === 'workflow-screenshot-preview')} ? (() => {
        const gallery = document.querySelector('.workflow-screenshot-gallery');
        const strip = gallery?.querySelector('.workflow-screenshot-strip');
        const items = [...(gallery?.querySelectorAll('.workflow-screenshot-item') ?? [])];
        const first = items[0]?.getBoundingClientRect();
        const image = items[0]?.querySelector('img');
        return gallery && strip && first ? {
          items: items.length,
          loadedImages: items.filter((item) => item.querySelector('img')?.complete).length,
          captions: items.map((item) => item.querySelector('small')?.textContent?.trim() ?? ''),
          itemWidth: first.width,
          itemHeight: first.height,
          stripWidth: strip.clientWidth,
          stripScrollWidth: strip.scrollWidth,
          snapType: getComputedStyle(strip).scrollSnapType,
          firstImageNaturalWidth: image?.naturalWidth ?? 0,
          lightboxOpened: window.__tethoqWorkflowLightboxOpened === true,
          lightboxCaption: document.querySelector('.workflow-screenshot-lightbox figcaption')?.textContent?.trim() ?? null,
        } : null;
      })() : null,
      settingsDismiss: window.__tethoqSettingsDismissCheck ?? null,
      providerSettingsText: document.querySelector('.provider-settings')?.textContent?.trim() ?? '',
      queueNewTask: ${JSON.stringify(viewport.kind === 'queue-new-task')} ? (() => {
        const panel = document.querySelector('.queue-new-task-picker');
        const search = panel?.querySelector('input[aria-label="Search models for new task"]');
        const groups = [...(panel?.querySelectorAll('.model-catalog-results section > h4') ?? [])].map((heading) => heading.textContent?.trim() ?? '');
        const reasoning = panel?.querySelector('select[aria-label="Reasoning for new task"]');
        return panel ? { text: panel.textContent?.trim() ?? '', search: Boolean(search), groups, reasoning: reasoning?.value ?? null } : null;
      })() : null,
      queueStrip: ${JSON.stringify(viewport.kind === 'queue-strip')} ? (() => {
        const strip = document.querySelector('.queued-strip');
        const menu = document.querySelector('.queued-message-menu .composer-popover');
        const firstRow = document.querySelector('.queued-message-row');
        const attachmentStrip = firstRow?.querySelector('.queued-attachment-widgets');
        const messageText = firstRow?.querySelector('.queued-message-content > strong');
        const attachmentBounds = attachmentStrip?.getBoundingClientRect();
        const textBounds = messageText?.getBoundingClientRect();
        const actionBounds = firstRow?.querySelector('.queued-message-actions')?.getBoundingClientRect();
        return strip && menu ? {
          overflowY: getComputedStyle(strip).overflowY,
          clientWidth: strip.clientWidth,
          offsetWidth: strip.offsetWidth,
          clientHeight: strip.clientHeight,
          scrollHeight: strip.scrollHeight,
          rowClientHeight: firstRow?.clientHeight ?? 0,
          rowScrollHeight: firstRow?.scrollHeight ?? 0,
          attachmentWidgets: attachmentStrip?.children.length ?? 0,
          imagePreviews: attachmentStrip?.querySelectorAll('.queued-attachment-image img').length ?? 0,
          imageFallbacks: attachmentStrip?.querySelectorAll('.queued-attachment-image-fallback').length ?? 0,
          audioPlayers: attachmentStrip?.querySelectorAll('.queued-attachment-audio').length ?? 0,
          fileWidgets: attachmentStrip?.querySelectorAll('.queued-attachment-file').length ?? 0,
          attachmentsAboveText: Boolean(attachmentBounds && textBounds && attachmentBounds.bottom <= textBounds.top + .5),
          actionsInsideRow: Boolean(actionBounds && actionBounds.top >= firstRow.getBoundingClientRect().top && actionBounds.right <= firstRow.getBoundingClientRect().right + .5),
          menuText: menu.textContent?.trim() ?? '',
          routes: window.__tethoqQueueMenuRoutes ?? null,
        } : null;
      })() : null,
      downloadPopover: (() => { const rect = document.querySelector('.browser-download-popover')?.getBoundingClientRect(); return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height, rightGap: innerWidth - rect.right } : null; })(),
      downloadButton: (() => { const button = document.querySelector('.browser-downloads'); return button ? { expanded: button.getAttribute('aria-expanded'), hasPopup: button.getAttribute('aria-haspopup'), badge: button.querySelector('span')?.textContent?.trim() ?? null } : null; })(),
      downloadDialog: (() => { const dialog = document.querySelector('.browser-download-popover'); return dialog ? { role: dialog.getAttribute('role'), label: dialog.getAttribute('aria-label') } : null; })(),
      downloadViewportBefore: window.__tethoqDownloadViewportBefore ?? null,
      downloadViewportAfter: (() => { const rect = document.querySelector('.browser-viewport')?.getBoundingClientRect(); return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null; })(),
      selectedStateBounds: (() => { const element = document.querySelector(${JSON.stringify(viewport.selector)}); const rect = element?.getBoundingClientRect(); return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height, bottom: rect.bottom, viewportBottom: innerHeight } : null; })(),
      background: bodyStyle.backgroundColor,
      buttons: buttons.length,
      controls: inputs.length,
      emptyButtons: buttons.filter((button) => !(button.getAttribute('aria-label') || button.textContent?.trim() || button.getAttribute('title'))).length,
      overflow,
      clippedControls,
      tinyReadableText,
      reducedMotion: ${JSON.stringify(reducedMotion)} ? (() => {
        const style = getComputedStyle(document.querySelector('.spinner') ?? document.body);
        const transition = getComputedStyle(document.querySelector('.sidebar-tasks') ?? document.body);
        return { mediaMatches: matchMedia('(prefers-reduced-motion: reduce)').matches, animationDuration: style.animationDuration, animationIterationCount: style.animationIterationCount, transitionDuration: transition.transitionDuration, scrollBehavior: getComputedStyle(document.querySelector('.conversation-scroll') ?? document.body).scrollBehavior };
      })() : null,
      activeDialog: (() => { const element = document.querySelector('[role="dialog"]'); const rect = element?.getBoundingClientRect(); return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight } : null; })(),
      contextCompaction: ${JSON.stringify(viewport.kind === 'context-compaction')} ? {
        title: document.querySelector('.context-usage-heading strong')?.textContent?.trim() ?? null,
        note: document.querySelector('.context-threshold-note')?.textContent?.trim() ?? null,
        interaction: window.__tethoqContextInteraction ?? null,
        noteVisual: (() => {
          const note = document.querySelector('.context-threshold-note');
          const rect = note?.getBoundingClientRect();
          const style = note ? getComputedStyle(note) : null;
          return rect && style ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height, color: style.color, fontSize: style.fontSize, display: style.display, visibility: style.visibility, opacity: style.opacity } : null;
        })(),
        modalCount: document.querySelectorAll('.modal').length,
        background: getComputedStyle(document.querySelector('.context-usage-popover')).backgroundColor,
      } : null,
      taskDetails: ${JSON.stringify(viewport.kind === 'task-details')} ? (() => {
        const panel = document.querySelector('.task-details-popover');
        return panel ? {
          childRows: panel.querySelectorAll('.task-child-list > button').length,
          text: panel.textContent?.trim() ?? '',
          background: getComputedStyle(panel).backgroundColor,
        } : null;
      })() : null,
      subagents: ${JSON.stringify(viewport.kind === 'subagents')} ? (() => {
        const trigger = document.querySelector('.session-subagents-trigger');
        const panel = document.querySelector('.session-subagents-popover');
        return panel ? {
          triggerLabel: trigger?.getAttribute('aria-label') ?? '',
          expanded: trigger?.getAttribute('aria-expanded') ?? '',
          childRows: panel.querySelectorAll(':scope > button').length,
          text: panel.textContent?.trim() ?? '',
          background: getComputedStyle(panel).backgroundColor,
          topLevelTitles: [...document.querySelectorAll('.session-row-title')].map((title) => title.textContent?.trim() ?? ''),
        } : null;
      })() : null,
      subagentTooltip: ${JSON.stringify(viewport.kind === 'subagents-hover')} ? (() => {
        const trigger = document.querySelector('.session-subagents-trigger');
        const tooltips = [...document.querySelectorAll('.session-subagents-tooltip')];
        const visibleTooltips = tooltips.filter((tooltip) => visible(tooltip));
        const tooltip = visibleTooltips[0];
        const bounds = tooltip?.getBoundingClientRect();
        return {
          visibleCount: visibleTooltips.length,
          text: tooltip?.textContent?.trim() ?? '',
          bounds: bounds ? { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height } : null,
          parentIsBody: tooltip?.parentElement === document.body,
          nestedTooltipSources: trigger?.querySelectorAll('[data-tooltip]').length ?? -1,
          triggerHasTooltipSource: trigger?.hasAttribute('data-tooltip') ?? true,
          triggerPseudoContent: trigger ? getComputedStyle(trigger, '::after').content : null,
        };
      })() : null,
      composerTail: ${JSON.stringify(viewport.kind === 'composer-stream-follow')} ? (() => {
        const scroller = document.querySelector('.conversation-scroll');
        const spacer = document.querySelector('.conversation-tail-spacer');
        const wrap = document.querySelector('.composer-wrap');
        const box = document.querySelector('.composer-box');
        const shelf = document.querySelector('.composer-footer');
        const streamBodies = [...document.querySelectorAll('.message-body')].filter((body) => body.textContent?.includes('QA_STREAM_START') && body.textContent?.includes('QA_STREAM_END'));
        const streamBody = streamBodies[0];
        const scrollerBounds = scroller?.getBoundingClientRect();
        const spacerBounds = spacer?.getBoundingClientRect();
        const wrapBounds = wrap?.getBoundingClientRect();
        const boxBounds = box?.getBoundingClientRect();
        const shelfBounds = shelf?.getBoundingClientRect();
        const streamBounds = streamBody?.getBoundingClientRect();
        return scroller && spacer && wrap && box && shelf && scrollerBounds && spacerBounds && wrapBounds && boxBounds && shelfBounds && streamBounds ? {
          streamCount: streamBodies.length,
          streamTextLength: streamBody.textContent?.length ?? 0,
          remaining: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
          gapToShelf: shelfBounds.top - streamBounds.bottom,
          clearance: spacerBounds.height,
          expectedClearance: Math.ceil(scrollerBounds.bottom - wrapBounds.top + 52),
          coverHeight: wrapBounds.bottom - boxBounds.bottom,
          configuredCover: Number.parseFloat(getComputedStyle(wrap).getPropertyValue('--composer-bottom-cover-height')),
          scrollBehavior: getComputedStyle(scroller).scrollBehavior,
          proof: window.__tethoqComposerFollowProof ?? null,
        } : null;
      })() : null,
      trace: ${JSON.stringify(viewport.kind.startsWith('trace-'))} ? (() => {
        const disclosure = document.querySelector('.reasoning-disclosure');
        const segments = document.querySelector('.reasoning-segments');
        const segmentRows = [...document.querySelectorAll('.reasoning-segment-row')];
        const controls = document.querySelector('.reasoning-category-controls');
        const activities = document.querySelector('.reasoning-activities');
        const rows = [...document.querySelectorAll('.reasoning-activities .activity-row')];
        const snippet = document.querySelector('.activity-snippet');
        const snippetPre = snippet?.querySelector('pre');
        const snippetRect = snippet?.getBoundingClientRect();
        const preRect = snippetPre?.getBoundingClientRect();
        const conversationRect = document.querySelector('.conversation-scroll')?.getBoundingClientRect();
        const reasoningFlow = document.querySelector('.reasoning-thinking-segment .reasoning-flow');
        const reasoningFlowStyle = reasoningFlow ? getComputedStyle(reasoningFlow) : null;
        const reasoningFlowRect = reasoningFlow?.getBoundingClientRect();
        const compactionStatus = document.querySelector('.timeline-compaction-active, .timeline-compaction-disclosure');
        const compactionToggle = compactionStatus?.querySelector('.timeline-compaction-toggle');
        const compactionVisual = compactionToggle ?? compactionStatus;
        const compactionStatusRect = compactionStatus?.getBoundingClientRect();
        const compactionStatusStyle = compactionVisual ? getComputedStyle(compactionVisual) : null;
        const reasoningIdentityCount = document.querySelectorAll('.reasoning-group .assistant-identity').length;
        const answerIdentityCount = [...document.querySelectorAll('.message-with-identity')].filter((entry) => visible(entry)).length;
        const assistantMark = (() => {
          const message = [...document.querySelectorAll('.message-with-identity')].find((entry) => visible(entry) && (entry.querySelector('.message-body .rich-text')?.textContent ?? '').trim());
          const mark = message?.querySelector('.assistant-identity');
          const richText = message?.querySelector('.message-body .rich-text');
          if (!mark || !richText) return null;
          const walker = document.createTreeWalker(richText, NodeFilter.SHOW_TEXT);
          let node = walker.nextNode();
          while (node && !/\\S/u.test(node.textContent ?? '')) node = walker.nextNode();
          if (!node) return null;
          const firstVisibleCharacter = (node.textContent ?? '').search(/\\S/u);
          const range = document.createRange();
          range.setStart(node, firstVisibleCharacter);
          range.setEnd(node, Math.min(firstVisibleCharacter + 1, node.length));
          const markRect = mark.getBoundingClientRect();
          const firstLineRect = range.getBoundingClientRect();
          return {
            markTop: markRect.top,
            markCenter: markRect.top + markRect.height / 2,
            firstLineTop: firstLineRect.top,
            firstLineCenter: firstLineRect.top + firstLineRect.height / 2,
            centerDelta: markRect.top + markRect.height / 2 - (firstLineRect.top + firstLineRect.height / 2),
          };
        })();
        const flowGaps = (() => {
          const group = document.querySelector('.reasoning-group');
          if (!group) return null;
          const previous = group.previousElementSibling?.matches('.message') ? group.previousElementSibling : null;
          const next = group.nextElementSibling?.matches('.message') ? group.nextElementSibling : group.nextElementSibling?.querySelector('.message');
          const visibleMessageBounds = (message) => {
            const nodes = [...message?.querySelectorAll('.message-body, .message-images, .message-attachments') ?? []].filter(visible);
            const rects = nodes.map((node) => node.getBoundingClientRect());
            return rects.length ? { top: Math.min(...rects.map((rect) => rect.top)), bottom: Math.max(...rects.map((rect) => rect.bottom)) } : null;
          };
          const groupRect = group.getBoundingClientRect();
          const previousRect = previous?.getBoundingClientRect();
          const nextRect = next?.getBoundingClientRect();
          const previousVisible = visibleMessageBounds(previous);
          const nextVisible = visibleMessageBounds(next);
          const fixture = document.createElement('div');
          fixture.className = 'conversation';
          fixture.setAttribute('aria-hidden', 'true');
          fixture.style.cssText = 'position:fixed;left:-10000px;top:0;width:760px;min-height:0;padding:0;visibility:hidden;';
          const assistantSource = document.querySelector('.message-assistant');
          const userSource = document.querySelector('.message-user');
          let exactTurnBoundaries = null;
          if (assistantSource && userSource) {
            const assistant = assistantSource.cloneNode(true);
            const userAfterAssistant = userSource.cloneNode(true);
            const reasoningAfterUser = group.cloneNode(true);
            const final = document.createElement('div');
            final.className = 'final-answer-block';
            final.append(assistantSource.cloneNode(true));
            const userAfterFinal = userSource.cloneNode(true);
            fixture.append(assistant, userAfterAssistant, reasoningAfterUser, final, userAfterFinal);
            document.body.append(fixture);
            const assistantRect = assistant.getBoundingClientRect();
            const firstUserRect = userAfterAssistant.getBoundingClientRect();
            const reasoningRect = reasoningAfterUser.getBoundingClientRect();
            const finalRect = final.getBoundingClientRect();
            const secondUserRect = userAfterFinal.getBoundingClientRect();
            exactTurnBoundaries = {
              expected: parseFloat(getComputedStyle(fixture).getPropertyValue('--turn-boundary-gap')),
              assistantToUser: firstUserRect.top - assistantRect.bottom,
              userToReasoning: reasoningRect.top - firstUserRect.bottom,
              finalToUser: secondUserRect.top - finalRect.bottom,
            };
            fixture.remove();
          }
          return {
            previousElementToGroup: previousRect ? groupRect.top - previousRect.bottom : null,
            previousVisibleToGroup: previousVisible ? groupRect.top - previousVisible.bottom : null,
            groupToNextElement: nextRect ? nextRect.top - groupRect.bottom : null,
            groupToNextVisible: nextVisible ? nextVisible.top - groupRect.bottom : null,
            finalBoundary: Boolean(document.querySelector('.timeline-final-boundary')),
            exactTurnBoundaries,
          };
        })();
        return {
          disclosureExpanded: disclosure?.getAttribute('aria-expanded') ?? null,
          segmentsVisible: Boolean(segments && visible(segments)),
          segmentRows: segmentRows.filter(visible).length,
          segmentKinds: segmentRows.filter(visible).map((row) => row.closest('.reasoning-thinking-segment') ? 'thinking' : row.closest('.reasoning-activity-segment') ? 'activity' : 'unknown'),
          segmentText: segmentRows.filter(visible).map((row) => row.textContent?.trim() ?? ''),
          outerGroups: document.querySelectorAll('.reasoning-group').length,
          runningGroups: document.querySelectorAll('.reasoning-running').length,
          runningFlows: document.querySelectorAll('.reasoning-flow-running').length,
          unexplainedLiveDots: document.querySelectorAll('.activity-live').length,
          thinkingExpanded: document.querySelectorAll('.reasoning-thinking-segment .reasoning-segment-row[aria-expanded="true"]').length,
          thinkingFlows: [...document.querySelectorAll('.reasoning-thinking-segment .reasoning-flow')].filter(visible).length,
          activitySegmentsExpanded: document.querySelectorAll('.reasoning-activity-segment > .reasoning-segment-row[aria-expanded="true"]').length,
          controlsVisible: Boolean(controls && visible(controls)),
          compactionStatus: compactionStatus && compactionStatusRect && compactionStatusStyle ? {
            text: (compactionToggle?.querySelector('span') ?? compactionStatus.querySelector('span'))?.textContent?.trim() ?? null,
            role: compactionStatus.getAttribute('role'),
            expanded: compactionToggle?.getAttribute('aria-expanded') ?? null,
            detailVisible: Boolean(compactionStatus.querySelector('.timeline-compaction-detail') && visible(compactionStatus.querySelector('.timeline-compaction-detail'))),
            color: compactionStatusStyle.color,
            backgroundColor: compactionStatusStyle.backgroundColor,
            borderTopWidth: compactionStatusStyle.borderTopWidth,
            iconWidth: compactionStatus.querySelector('svg')?.getBoundingClientRect().width ?? null,
            textAnimation: (compactionToggle?.querySelector('span') ?? compactionStatus.querySelector('span')) ? getComputedStyle(compactionToggle?.querySelector('span') ?? compactionStatus.querySelector('span')).animationName : null,
            iconAnimation: compactionStatus.querySelector('svg') ? getComputedStyle(compactionStatus.querySelector('svg')).animationName : null,
          } : null,
          assistantMark,
          messageIdentityCount: document.querySelectorAll('.message .assistant-identity').length,
          reasoningIdentityCount,
          answerIdentityCount,
          chevrons: {
            outer: (() => { const element = document.querySelector('.reasoning-disclosure > svg'); return element ? getComputedStyle(element).opacity : null; })(),
            inner: (() => { const element = document.querySelector('.reasoning-segment-row > svg'); return element ? getComputedStyle(element).opacity : null; })(),
            interactionRules: [...document.styleSheets].flatMap((sheet) => {
              try { return [...sheet.cssRules].map((rule) => rule.selectorText).filter(Boolean); } catch { return []; }
            }).filter((selector) => selector.includes('.reasoning-disclosure:hover > svg') || (selector.includes('.reasoning-segment-row:hover') && selector.includes('> svg'))),
          },
          flowGaps,
          reasoningFlow: reasoningFlow && reasoningFlowStyle && reasoningFlowRect ? {
            height: reasoningFlowRect.height,
            clientHeight: reasoningFlow.clientHeight,
            scrollHeight: reasoningFlow.scrollHeight,
            maxHeight: reasoningFlowStyle.maxHeight,
            overflowY: reasoningFlowStyle.overflowY,
            textAnimation: reasoningFlow.querySelector('.rich-text') ? getComputedStyle(reasoningFlow.querySelector('.rich-text')).animationName : 'none',
            iconAnimation: document.querySelector('.reasoning-running .reasoning-mark i') ? getComputedStyle(document.querySelector('.reasoning-running .reasoning-mark i')).animationName : 'none',
          } : null,
          activitiesVisible: Boolean(activities && visible(activities)),
          activityRows: rows.filter(visible).length,
          snippetCount: document.querySelectorAll('.activity-snippet').length,
          snippet: snippet && snippetPre && snippetRect && preRect ? {
            bounds: { x: snippetRect.x, y: snippetRect.y, width: snippetRect.width, height: snippetRect.height, right: snippetRect.right, bottom: snippetRect.bottom },
            preBounds: { width: preRect.width, height: preRect.height },
            preClientHeight: snippetPre.clientHeight,
            preScrollHeight: snippetPre.scrollHeight,
            preClientWidth: snippetPre.clientWidth,
            preScrollWidth: snippetPre.scrollWidth,
            overflowY: getComputedStyle(snippetPre).overflowY,
            fontSize: getComputedStyle(snippetPre).fontSize,
            conversationBounds: conversationRect ? { top: conversationRect.top, bottom: conversationRect.bottom } : null,
          } : null,
        };
      })() : null,
      sidebar: ${JSON.stringify(viewport.kind === 'trace-collapsed')} ? (() => {
        const newTask = document.querySelector('.new-task-button');
        const dashboard = document.querySelector('.primary-nav button');
        const navigationShell = document.querySelector('.sidebar');
        const footer = document.querySelector('.sidebar-footer');
        const session = document.querySelector('.session-row');
        const title = session?.querySelector('.session-row-title');
        const preview = session?.querySelector('.session-row-preview');
        const newTaskLabel = newTask?.querySelector('span');
        const dashboardLabel = dashboard?.querySelector('span');
        const newTaskRect = newTask?.getBoundingClientRect();
        const dashboardRect = dashboard?.getBoundingClientRect();
        const navigationRect = navigationShell?.getBoundingClientRect();
        const footerRect = footer?.getBoundingClientRect();
        const newTaskLabelRect = newTaskLabel?.getBoundingClientRect();
        const dashboardLabelRect = dashboardLabel?.getBoundingClientRect();
        const titleRect = title?.getBoundingClientRect();
        const previewRect = preview?.getBoundingClientRect();
        const taskSearch = document.querySelector('.sidebar-task-search');
        const taskFilter = document.querySelector('.sidebar-task-filter');
        const taskPlus = document.querySelector('.sidebar-task-header > button');
        const taskFilterRect = taskFilter?.getBoundingClientRect();
        const taskPlusRect = taskPlus?.getBoundingClientRect();
        const taskRows = [...document.querySelectorAll('.session-row')].map((row) => {
          const logo = row.querySelector('.provider-logo');
          const rowTitle = row.querySelector('.session-row-title');
          const rowPreview = row.querySelector('.session-row-preview');
          const workingSpinner = row.querySelector('.session-row-working-spinner');
          const previewContent = rowPreview?.querySelector(':scope > span');
          const rowBounds = row.getBoundingClientRect();
          const logoBounds = logo?.getBoundingClientRect();
          const titleBounds = rowTitle?.getBoundingClientRect();
          const previewBounds = rowPreview?.getBoundingClientRect();
          const spinnerBounds = workingSpinner?.getBoundingClientRect();
          const overflowByGeometry = Boolean(rowPreview && previewContent && previewContent.scrollHeight - rowPreview.clientHeight > 1);
          const overflowDistance = rowPreview && previewContent ? Math.max(0, previewContent.scrollHeight - rowPreview.clientHeight) : 0;
          return logoBounds && titleBounds && previewBounds ? {
            rowHeight: rowBounds.height,
            previewHeight: previewBounds.height,
            titleX: titleBounds.x,
            previewX: previewBounds.x,
            titleGap: titleBounds.left - logoBounds.right,
            previewGap: previewBounds.left - logoBounds.right,
            overflowByGeometry,
            overflowAttribute: rowPreview?.getAttribute('data-overflow') === 'true',
            maskImage: getComputedStyle(rowPreview).maskImage,
            overflowDistance,
            overflowDuration: Number.parseFloat(rowPreview?.style.getPropertyValue('--overflow-duration') || '0'),
            workingSpinner: spinnerBounds ? {
              width: workingSpinner.offsetWidth,
              height: workingSpinner.offsetHeight,
              centerDeltaX: (spinnerBounds.left + spinnerBounds.width / 2) - (logoBounds.left + logoBounds.width / 2),
              gapAbove: spinnerBounds.top - logoBounds.bottom,
              gapBelow: rowBounds.bottom - spinnerBounds.bottom,
            } : null,
          } : null;
        }).filter(Boolean);
        return {
          newTask: newTaskRect && newTaskLabelRect ? { x: newTaskRect.x, width: newTaskRect.width, height: newTaskRect.height, labelCenterDelta: (newTaskLabelRect.x + newTaskLabelRect.width / 2) - (newTaskRect.x + newTaskRect.width / 2) } : null,
          dashboard: dashboardRect && dashboardLabelRect ? { x: dashboardRect.x, width: dashboardRect.width, height: dashboardRect.height, labelCenterDelta: (dashboardLabelRect.x + dashboardLabelRect.width / 2) - (dashboardRect.x + dashboardRect.width / 2) } : null,
          footerDivider: navigationRect && footerRect ? { leftDelta: footerRect.left - navigationRect.left, rightDelta: navigationRect.right - footerRect.right, borderTopWidth: getComputedStyle(footer).borderTopWidth } : null,
          taskText: titleRect && previewRect ? { titleX: titleRect.x, previewX: previewRect.x } : null,
          taskControls: taskFilterRect && taskPlusRect ? { filterBeforePlus: taskFilterRect.right <= taskPlusRect.left, gap: taskPlusRect.left - taskFilterRect.right, centerDelta: (taskFilterRect.top + taskFilterRect.height / 2) - (taskPlusRect.top + taskPlusRect.height / 2), filterInsideSearch: Boolean(taskSearch?.contains(taskFilter)) } : null,
          taskRows,
        };
      })() : null,
    };
  })()`, true);
  if (subagentTransition) layout.subagentTransition = subagentTransition;
  if (layout.composerTail) layout.composerTail.coverPixels = composerCoverPixels;

  const image = await window.webContents.capturePage();
  await writeFile(path.join(outputDirectory, `${viewport.name}.png`), image.toPNG());
  await writeFile(path.join(outputDirectory, `${viewport.name}.json`), `${JSON.stringify(layout, null, 2)}\n`);

  assert.ok(layout.rootChildren > 0, `${viewport.name}: empty renderer root`);
  assert.ok(layout.rootTextLength > 80, `${viewport.name}: renderer content did not load`);
  assert.equal(layout.appReady, true, `${viewport.name}: desktop shell did not finish loading`);
  assert.equal(layout.loading, false, `${viewport.name}: loading state remained visible`);
  assert.equal(layout.expectedStateReady, true, `${viewport.name}: expected ${viewport.selector} state is missing`);
  const thinExpectedState = viewport.selector.includes('progress') || viewport.kind === 'dictation-hover' || viewport.kind === 'sidebar-resized';
  const expectedStateMinimumWidth = viewport.kind === 'sidebar-resized' ? 8 : thinExpectedState ? 20 : 40;
  assert.ok(layout.expectedStateBounds?.width >= expectedStateMinimumWidth && layout.expectedStateBounds?.height > (thinExpectedState ? 1 : 20), `${viewport.name}: expected ${viewport.selector} state has unusable bounds`);
  if (viewport.kind === 'slash-command') {
    assert.equal(layout.slashCommandPalette?.query, '/', `${viewport.name}: opening the palette changed the draft`);
    assert.deepEqual(layout.slashCommandPalette?.commands, ['/simplifyShorten the previous or upcoming answerEnter'], `${viewport.name}: palette does not show the supported command catalogue`);
    assert.equal(layout.slashCommandPalette?.selected, layout.slashCommandPalette?.commands[0], `${viewport.name}: top command is not selected by default`);
  }
  if (viewport.kind === 'settings') assert.ok(layout.connectorCards >= 1, `${viewport.name}: external connector details are missing`);
  if (viewport.kind === 'settings-defaults') {
    assert.ok(layout.agentDefaults?.rows >= 1, `${viewport.name}: agent defaults are missing`);
    assert.ok(layout.agentDefaults?.selects >= 2, `${viewport.name}: concrete model and reasoning controls are missing`);
    assert.doesNotMatch(layout.agentDefaults?.text ?? '', /\bAuto\b/u, `${viewport.name}: ambiguous Auto reasoning is visible`);
    assert.doesNotMatch(layout.agentDefaults?.text ?? '', /Managed by agent/u, `${viewport.name}: unavailable reasoning is presented as a fake setting`);
    assert.match(layout.agentDefaults?.text ?? '', /OpenAI API · API key saved/u, `${viewport.name}: the direct API key route is not explicit`);
    assert.match(layout.agentDefaults?.text ?? '', /OpenAI through OpenCode/u, `${viewport.name}: the OpenCode upstream route is not explicit`);
    assert.equal(layout.settingsDismiss?.closedByToggle, true, `${viewport.name}: clicking Settings again did not return to the app`);
    assert.equal(layout.settingsDismiss?.closedByX, true, `${viewport.name}: the top-left close control did not return to the app`);
    assert.equal(layout.settingsDismiss?.footerActiveClass, false, `${viewport.name}: Settings remains styled as a permanently selected rail item`);
    assert.equal(layout.settingsDismiss?.footerBackground, 'rgba(0, 0, 0, 0)', `${viewport.name}: Settings keeps a selected fill after the pointer leaves`);
    assert.equal(layout.settingsDismiss?.closeVisible, true, `${viewport.name}: the Settings close control is not visibly reachable`);
    assert.equal(layout.settingsDismiss?.closeLabel, 'Close settings', `${viewport.name}: the Settings close control is not labelled`);
  }
  if (viewport.kind === 'settings-global-agents') {
    assert.match(layout.globalAgentsText ?? '', /Global agent instructions/u, `${viewport.name}: global AGENTS.md setting is missing`);
    assert.match(layout.globalAgentsText ?? '', /never appear as chat text/u, `${viewport.name}: private instruction behavior is unclear`);
  }
  if (viewport.kind === 'workflow-message') {
    assert.ok(layout.workflowMessage, `${viewport.name}: structured workflow message is missing`);
    assert.match(layout.workflowMessage?.triggerText ?? '', /Test sending comment/u, `${viewport.name}: workflow widget lost its name`);
    assert.match(layout.workflowMessage?.panelText ?? '', /Events442/u, `${viewport.name}: workflow panel lost its event summary`);
    assert.equal(layout.workflowMessage?.rawControlText, false, `${viewport.name}: raw workflow control metadata is visible`);
  }
  if (viewport.kind === 'settings-agents') {
    assert.match(layout.providerSettingsText ?? '', /Direct API[\s\S]*OpenAI API · API key saved/u, `${viewport.name}: direct API connection detail is unclear`);
    assert.equal(layout.clippedControls.length, 0, `${viewport.name}: an agent action or tooltip is clipped`);
  }
  if (viewport.kind === 'settings-runtime') {
    assert.equal(layout.settingsRuntime?.firstOpen, true, `${viewport.name}: Local runtime did not open`);
    assert.equal(layout.settingsRuntime?.secondOpen, false, `${viewport.name}: Desktop behavior opened with its sibling`);
    assert.ok(layout.settingsRuntime?.firstHeight > layout.settingsRuntime?.secondHeight + 80, `${viewport.name}: the closed sibling stretched with the open card`);
    assert.ok(layout.settingsRuntime?.secondHeight <= 56, `${viewport.name}: the closed Desktop behavior card is too tall`);
  }
  if (viewport.kind === 'workflows' || viewport.kind === 'workflow-screenshot-preview') {
    assert.ok(layout.workflowGallery, `${viewport.name}: screenshot gallery is missing from Capture details`);
    assert.equal(layout.workflowGallery.items, 4, `${viewport.name}: not every captured screenshot is represented`);
    assert.equal(layout.workflowGallery.loadedImages, 4, `${viewport.name}: visible screenshot thumbnails did not load`);
    assert.deepEqual(layout.workflowGallery.captions, ['frame-000001.jpg', 'frame-000002.jpg', 'frame-000003.jpg', 'frame-000004.jpg'], `${viewport.name}: screenshot names are missing or reordered`);
    assert.ok(layout.workflowGallery.itemWidth >= 175 && layout.workflowGallery.itemWidth <= 212, `${viewport.name}: screenshot widgets are not compact and readable`);
    assert.ok(layout.workflowGallery.itemHeight >= 115 && layout.workflowGallery.itemHeight <= 150, `${viewport.name}: screenshot widgets have unusable height`);
    assert.ok(layout.workflowGallery.stripScrollWidth > layout.workflowGallery.stripWidth + 40, `${viewport.name}: screenshot strip does not slide horizontally`);
    assert.match(layout.workflowGallery.snapType, /mandatory/u, `${viewport.name}: screenshot slider does not settle on frames`);
    assert.ok(layout.workflowGallery.firstImageNaturalWidth > 0, `${viewport.name}: screenshot preview is blank`);
    assert.equal(layout.workflowGallery.lightboxOpened, true, `${viewport.name}: screenshot did not open into a large preview`);
    if (viewport.kind === 'workflow-screenshot-preview') assert.equal(layout.workflowGallery.lightboxCaption, 'frame-000001.jpg', `${viewport.name}: enlarged screenshot lost its name`);
  }
  if (viewport.kind === 'composer-stream-follow') {
    assert.ok(layout.composerTail, `${viewport.name}: composer-tail geometry is missing`);
    assert.equal(layout.composerTail.streamCount, 1, `${viewport.name}: streamed deltas did not merge into one message`);
    assert.ok(layout.composerTail.streamTextLength > 1000, `${viewport.name}: streaming fixture is too short to exercise follow-to-latest`);
    assert.ok(layout.composerTail.remaining <= 1.5, `${viewport.name}: live output did not remain pinned to the latest content`);
    assert.ok(layout.composerTail.gapToShelf >= 50 && layout.composerTail.gapToShelf <= 64, `${viewport.name}: latest output does not retain its two-line buffer above the model shelf`);
    assert.ok(Math.abs(layout.composerTail.clearance - layout.composerTail.expectedClearance) <= 1, `${viewport.name}: tail clearance does not match the live composer overlap`);
    assert.ok(Math.abs(layout.composerTail.coverHeight - layout.composerTail.configuredCover) <= .75, `${viewport.name}: composer underside does not match its configured cover height`);
    assert.equal(layout.composerTail.configuredCover, viewport.width <= 780 && viewport.height <= 560 ? 7 : viewport.width <= 780 ? 8 : 14, `${viewport.name}: responsive underside cover height is incorrect`);
    assert.equal(layout.composerTail.scrollBehavior, 'auto', `${viewport.name}: animated scrolling can detach live streaming from the latest output`);
    assert.ok(layout.composerTail.proof?.afterGrowth?.clearance > layout.composerTail.proof?.beforeGrowth?.clearance + 20, `${viewport.name}: growing input did not enlarge the measured clearance`);
    assert.ok(layout.composerTail.proof?.afterGrowth?.remaining <= 1.5, `${viewport.name}: growing input detached live follow-to-latest`);
    assert.ok(layout.composerTail.proof?.manualBefore?.remaining >= 90, `${viewport.name}: manual-scroll proof did not leave the pinned range`);
    assert.ok(layout.composerTail.proof?.manualAfter?.remaining >= layout.composerTail.proof?.manualBefore?.remaining + 90, `${viewport.name}: manual-scroll proof did not grow the conversation`);
    assert.ok(Math.abs(layout.composerTail.proof?.manualScrollChange ?? Infinity) <= 1.5, `${viewport.name}: conversation growth overrode deliberate manual scrolling`);
    assert.ok(layout.composerTail.proof?.restored?.remaining <= 1.5, `${viewport.name}: composer fixture did not restore the latest position`);
    assert.ok(layout.composerTail.coverPixels, `${viewport.name}: compositor pixel proof is missing`);
    assert.ok(Math.max(...layout.composerTail.coverPixels.coverDelta) <= 3, `${viewport.name}: narrow composer underside is not opaque`);
    assert.ok(Math.max(...layout.composerTail.coverPixels.cover.magenta.slice(0, 3)) < 40, `${viewport.name}: narrow composer underside is not the normal dark transcript background`);
    assert.ok(layout.composerTail.coverPixels.transparentDelta.reduce((sum, value) => sum + value, 0) >= 300, `${viewport.name}: composer gained an opaque backdrop above its narrow underside`);
  }
  if (viewport.kind === 'new-task-draft') {
    assert.equal(layout.newTaskDraft.modalCount, 0, `${viewport.name}: new task opened a modal instead of a local draft`);
    assert.equal(layout.newTaskDraft.title, 'New task', `${viewport.name}: local draft workspace is missing`);
    assert.equal(layout.newTaskDraft.modelPicker?.visible, true, `${viewport.name}: draft composer model picker is missing`);
    assert.match(layout.newTaskDraft.modelPicker?.label ?? '', /Tethoq Example Reasoning/, `${viewport.name}: draft composer did not retain the connector model`);
    assert.equal(layout.newTaskDraft.directoryControl?.visible, true, `${viewport.name}: draft directory control is missing`);
    assert.match(layout.newTaskDraft.directoryControl?.label ?? '', /^Choose project folder\./, `${viewport.name}: draft directory control is not actionable`);
    assert.match(layout.newTaskDraft.pickerCheck?.selectedConnectorModel ?? '', /Tethoq Example Reasoning/, `${viewport.name}: dynamic connector model was not selectable in the local draft picker`);
    assert.ok(layout.newTaskDraft.pickerCheck?.bounds && layout.newTaskDraft.pickerCheck.bounds.x >= 0 && layout.newTaskDraft.pickerCheck.bounds.y >= 0 && layout.newTaskDraft.pickerCheck.bounds.right <= layout.viewport.width + 1 && layout.newTaskDraft.pickerCheck.bounds.bottom <= layout.viewport.height + 1, `${viewport.name}: draft model picker is clipped`);
    for (const [name, control] of [['model picker', layout.newTaskDraft.modelPicker], ['directory', layout.newTaskDraft.directoryControl]]) {
      assert.ok(control?.bounds && control.bounds.x >= 0 && control.bounds.y >= 0 && control.bounds.right <= layout.viewport.width + 1 && control.bounds.bottom <= layout.viewport.height + 1, `${viewport.name}: draft ${name} control is outside the visible viewport`);
    }
  }
  if (viewport.kind === 'browser-downloads') {
    assert.ok(layout.downloadPopover, `${viewport.name}: compact download popover is missing`);
    assert.ok(layout.downloadPopover.width <= 380, `${viewport.name}: download popover is too wide`);
    assert.ok(layout.downloadPopover.rightGap <= 12, `${viewport.name}: download popover is not anchored at the top right`);
    assert.ok(layout.downloadPopover.x >= 0 && layout.downloadPopover.y >= 0 && layout.downloadPopover.x + layout.downloadPopover.width <= layout.viewport.width + 1 && layout.downloadPopover.y + layout.downloadPopover.height <= layout.viewport.height + 1, `${viewport.name}: download popover escapes the viewport`);
    assert.deepEqual(layout.downloadButton, { expanded: 'true', hasPopup: 'dialog', badge: '1' }, `${viewport.name}: download trigger state is unclear`);
    assert.deepEqual(layout.downloadDialog, { role: 'dialog', label: 'Downloads' }, `${viewport.name}: download popover semantics are missing`);
    assert.deepEqual(layout.downloadViewportAfter, layout.downloadViewportBefore, `${viewport.name}: opening downloads shifted the browser viewport`);
  }
  if (viewport.kind.startsWith('composer-')) {
    assert.ok(layout.selectedStateBounds, `${viewport.name}: composer overlay is missing`);
    assert.ok(layout.selectedStateBounds.x >= 0 && layout.selectedStateBounds.y >= 0 && layout.selectedStateBounds.x + layout.selectedStateBounds.width <= layout.viewport.width + 1 && layout.selectedStateBounds.bottom <= layout.viewport.height + 1, `${viewport.name}: composer overlay is clipped`);
  }
  if (layout.composerAlignment) {
    assert.ok(Math.abs(layout.composerAlignment.modelValueDelta) <= .75, `${viewport.name}: model label and value are not vertically aligned`);
    assert.ok(Math.abs(layout.composerAlignment.modelLogoDelta - 1) <= .5, `${viewport.name}: provider mark is not optically aligned with the model row`);
    assert.ok(Math.abs(layout.composerAlignment.effortValueDelta) <= .75, `${viewport.name}: reasoning label and value are not vertically aligned`);
    assert.ok(Math.abs(layout.composerAlignment.labelDelta) <= .75, `${viewport.name}: model and reasoning rows do not share a vertical centre`);
    assert.ok(Math.abs(layout.composerAlignment.microphoneSendDelta) <= .75, `${viewport.name}: microphone is not vertically aligned with Send`);
    assert.ok(Math.abs(layout.composerAlignment.arrowMicrophoneDelta) <= .75, `${viewport.name}: dictation arrow is not optically centred under the microphone`);
  }
  if (layout.headerAlignment) assert.ok(layout.headerAlignment.contextTrackDelta >= 1.5 && layout.headerAlignment.contextTrackDelta <= 2.5, `${viewport.name}: context bar is not optically aligned with the task title`);
  if (layout.composerMore) {
    assert.ok(layout.composerMore.hitWidth >= 35 && layout.composerMore.hitHeight >= 35, `${viewport.name}: More lost its usable click target`);
    assert.equal(layout.composerMore.highlightWidth, 30, `${viewport.name}: More highlight is not tightly fitted to the dots`);
    assert.equal(layout.composerMore.highlightHeight, 20, `${viewport.name}: More highlight is too tall around the dots`);
    assert.equal(layout.composerMore.highlightRadius, 7, `${viewport.name}: More highlight does not use the compact rounded rectangle`);
  }
  if (layout.dictationShape) {
    assert.ok(Math.abs(layout.dictationShape.main.left - layout.dictationShape.menu.left) <= .5 && Math.abs(layout.dictationShape.main.right - layout.dictationShape.menu.right) <= .5, `${viewport.name}: dictation selector does not share the microphone pill bounds`);
    assert.ok(Math.abs(layout.dictationShape.main.bottom - layout.dictationShape.menu.bottom) <= .5, `${viewport.name}: dictation selector does not share the microphone pill bottom edge`);
    assert.ok(Math.abs(layout.dictationShape.menu.bottom - layout.dictationShape.button.bottom) <= .5, `${viewport.name}: dictation selector button escapes its clipped pill segment`);
    assert.equal(layout.dictationShape.fill.width, 38, `${viewport.name}: dictation selector fill does not reuse the full pill width`);
    assert.equal(layout.dictationShape.fill.height, 42, `${viewport.name}: dictation selector fill does not reuse the full pill height`);
    assert.equal(layout.dictationShape.fill.radius, 19, `${viewport.name}: dictation selector fill does not reuse the pill curvature`);
    assert.equal(layout.dictationShape.button.height, 18, `${viewport.name}: dictation selector hit area is not limited to the lower pill segment`);
    assert.equal(layout.dictationShape.clipPath, 'none', `${viewport.name}: dictation selector hit target is still relying on clipped hit testing`);
    assert.match(layout.dictationShape.fillClipPath ?? '', /^path\(/u, `${viewport.name}: dictation selector fill does not use the shallow crescent cut`);
    assert.equal(layout.dictationShape.microphoneZIndex, '4', `${viewport.name}: microphone glyph is not painted above the selector segment`);
    assert.equal(layout.dictationShape.upperHitIsMain, true, `${viewport.name}: upper microphone hit region does not start dictation`);
    assert.equal(layout.dictationShape.lowerHitIsSource, true, `${viewport.name}: lower crescent hit region does not open sources`);
    if (viewport.kind === 'dictation-hover') assert.equal(layout.dictationShape.fill.background, 'rgb(58, 58, 55)', `${viewport.name}: dictation selector hover fill is not visible`);
  }
  if (viewport.kind === 'composer-model') {
    assert.ok(layout.modelCatalog, `${viewport.name}: model picker did not open`);
    assert.doesNotMatch(layout.modelCatalog?.text ?? '', /\bDefault\b/u, `${viewport.name}: Default is still stamped on model rows`);
    assert.ok((layout.modelCatalog?.headings ?? []).some((heading) => heading === 'OpenAI Codex' || heading.includes('Codex')), `${viewport.name}: OpenAI Codex group is missing`);
    assert.ok((layout.modelCatalog?.headings ?? []).includes('OpenCode'), `${viewport.name}: OpenCode-native routes are not identified`);
    assert.ok((layout.modelCatalog?.headings ?? []).includes('OpenCode Go via OpenCode'), `${viewport.name}: OpenCode Go routes are not grouped under their reported upstream`);
    assert.ok((layout.modelCatalog?.headings ?? []).includes('DeepSeek via OpenCode'), `${viewport.name}: DeepSeek routes are not grouped under their reported upstream`);
  }
  if (viewport.kind === 'dictation-audio-source') {
    assert.equal(layout.dictationAudioSource?.mp3Label, 'MP3', `${viewport.name}: MP3 is not listed under the dictate crescent`);
    assert.equal(layout.dictationAudioSource?.checked, 'true', `${viewport.name}: MP3 is not the selected dictation source`);
  }
  if (viewport.kind === 'dictation-empty') {
    assert.equal(layout.dictationEmpty?.heading, 'No dictation source is enabled', `${viewport.name}: empty state does not plainly name the missing setup`);
    assert.equal(layout.dictationEmpty?.guidance, 'Choose a provider below to set one up.', `${viewport.name}: empty state lacks one short next step`);
    assert.ok((layout.dictationEmpty?.setupRows ?? 0) >= 1, `${viewport.name}: no provider setup action is available`);
    assert.equal(layout.dictationEmpty?.checkedRows, 0, `${viewport.name}: an unconfigured provider is presented as selected`);
    assert.ok(layout.dictationEmpty.bounds.x >= 0 && layout.dictationEmpty.bounds.right <= layout.viewport.width + 1 && layout.dictationEmpty.bounds.y >= 0 && layout.dictationEmpty.bounds.bottom <= layout.viewport.height + 1, `${viewport.name}: empty-state popover is clipped`);
  }
  if (viewport.kind === 'final-message-meta') {
    assert.equal(layout.messageMetadata?.legacyMessageMetaCount, 0, `${viewport.name}: legacy per-artifact metadata is still rendered`);
    assert.ok((layout.messageMetadata?.finalFooterCount ?? 0) >= 1, `${viewport.name}: final-answer copy footer is missing`);
    assert.equal(layout.messageMetadata?.finalFooterCount, layout.messageMetadata?.assistantIdentityCount, `${viewport.name}: final-answer copy footer is not one-per-answer`);
    assert.equal(layout.messageMetadata?.finalFooter?.opacity, '1', `${viewport.name}: final-answer footer disappears before it can be reached`);
    assert.equal(layout.messageMetadata?.finalFooter?.background, 'rgba(0, 0, 0, 0)', `${viewport.name}: final-answer time and copy icon are wrapped in a container surface`);
    assert.ok((layout.messageMetadata?.finalFooter?.top ?? 0) >= (layout.messageMetadata?.finalFooter?.bodyBottom ?? 1) - .5, `${viewport.name}: final-answer footer is not below the message`);
    assert.ok(Math.abs((layout.messageMetadata?.finalFooter?.left ?? 0) - (layout.messageMetadata?.finalFooter?.bodyLeft ?? 1)) <= .5, `${viewport.name}: final-answer footer is not left-aligned under its answer`);
    assert.equal(layout.messageMetadata?.finalFooter?.copyButtons, 1, `${viewport.name}: final answer has more than one copy action`);
    assert.equal(layout.messageMetadata?.finalFooter?.copyWidth, 21, `${viewport.name}: final-answer copy control is not tightly fitted`);
    assert.equal(layout.messageMetadata?.finalFooter?.copyHeight, 21, `${viewport.name}: final-answer copy control is not tightly fitted`);
  }
  if (viewport.kind === 'user-message-meta') {
    assert.ok((layout.messageMetadata?.userFooterCount ?? 0) >= 1, `${viewport.name}: user-message time and copy footer is missing`);
    assert.equal(layout.messageMetadata?.userFooter?.opacity, '1', `${viewport.name}: user-message footer disappears before it can be reached`);
    assert.equal(layout.messageMetadata?.userFooter?.background, 'rgba(0, 0, 0, 0)', `${viewport.name}: user-message time and copy icon are wrapped in a container surface`);
    assert.ok((layout.messageMetadata?.userFooter?.top ?? 0) >= (layout.messageMetadata?.userFooter?.bodyBottom ?? 1) - .5, `${viewport.name}: user-message footer is not below the bubble`);
    assert.ok(Math.abs((layout.messageMetadata?.userFooter?.left ?? 0) - (layout.messageMetadata?.userFooter?.bodyLeft ?? 1)) <= .5, `${viewport.name}: user-message footer is not aligned to the bubble's left edge`);
    assert.equal(layout.messageMetadata?.userFooter?.copyButtons, 1, `${viewport.name}: user message has more than one copy action`);
    assert.equal(layout.messageMetadata?.userFooter?.copyWidth, 21, `${viewport.name}: user-message copy control is not tightly fitted`);
  }
  if (viewport.kind === 'thinking-message-meta') {
    assert.equal(layout.messageMetadata?.thinkingMeta?.opacity, '1', `${viewport.name}: thinking time/copy control is not reachable on hover`);
    assert.equal(layout.messageMetadata?.thinkingMeta?.copyButtons, 1, `${viewport.name}: thinking detail does not have one copy action`);
  }
  if (viewport.kind === 'message-error') {
    assert.ok(layout.errorNotice, `${viewport.name}: model error is not visible in the transcript`);
    assert.match(layout.errorNotice.text, /429 Too Many Requests/u, `${viewport.name}: model error lost its useful explanation`);
    assert.doesNotMatch(layout.errorNotice.text, /request id|visual-request-secret/iu, `${viewport.name}: raw provider identifiers leaked into the error notice`);
    assert.equal(layout.errorNotice.borderWidth, '0px', `${viewport.name}: error notice has an alarming outlined container`);
    assert.equal(layout.errorNotice.background, 'rgb(39, 39, 37)', `${viewport.name}: error notice does not use the calm neutral surface`);
    assert.equal(layout.failedStatusColor, 'rgb(155, 160, 155)', `${viewport.name}: failed task chrome uses an alarming error color`);
  }
  if (viewport.kind === 'user-attachment') {
    assert.ok(layout.userAttachment, `${viewport.name}: user attachment fixture is missing`);
    assert.equal(layout.userAttachment.thumbnails, 1, `${viewport.name}: retained image did not render as one thumbnail`);
    assert.ok(layout.userAttachment.galleryBottom <= layout.userAttachment.bodyTop + .5, `${viewport.name}: image thumbnail is not above the user request`);
    assert.equal(layout.userAttachment.lightboxOpened, true, `${viewport.name}: clicking the image did not open the large preview`);
    assert.doesNotMatch(layout.userAttachment.messageText, /Files mentioned by the user|My request|Distinguish instructions|<image\b/iu, `${viewport.name}: attachment transport metadata leaked into the message`);
  }
  if (viewport.kind === 'queue-strip' || viewport.kind === 'queue-new-task' || viewport.kind === 'side-chat') {
    assert.ok(layout.selectedStateBounds, `${viewport.name}: compact ${viewport.kind} surface is missing`);
    assert.ok(layout.selectedStateBounds.x >= 0 && layout.selectedStateBounds.y >= 0 && layout.selectedStateBounds.x + layout.selectedStateBounds.width <= layout.viewport.width + 1 && layout.selectedStateBounds.bottom <= layout.viewport.height + 1, `${viewport.name}: compact ${viewport.kind} surface is clipped`);
  }
  if (viewport.kind === 'queue-strip') {
    assert.ok(layout.queueStrip, `${viewport.name}: queued instruction menu did not open`);
    assert.equal(layout.queueStrip.overflowY, 'visible', `${viewport.name}: queued instructions still create an internal scrollbar`);
    assert.equal(layout.queueStrip.offsetWidth, layout.queueStrip.clientWidth, `${viewport.name}: queued instructions still reserve a scrollbar gutter`);
    assert.equal(layout.queueStrip.rowClientHeight, layout.queueStrip.rowScrollHeight, `${viewport.name}: queued attachment row clips or scrolls internally`);
    assert.equal(layout.queueStrip.attachmentWidgets, 4, `${viewport.name}: queued instruction did not render every attachment`);
    assert.equal(layout.queueStrip.imagePreviews, 1, `${viewport.name}: queued image preview is missing`);
    assert.equal(layout.queueStrip.imageFallbacks, 1, `${viewport.name}: queued image without safe bytes lost its fallback widget`);
    assert.equal(layout.queueStrip.audioPlayers, 1, `${viewport.name}: queued audio did not render the playback widget`);
    assert.equal(layout.queueStrip.fileWidgets, 1, `${viewport.name}: queued file widget is missing`);
    assert.equal(layout.queueStrip.attachmentsAboveText, true, `${viewport.name}: queued attachments are not above the instruction text`);
    assert.equal(layout.queueStrip.actionsInsideRow, true, `${viewport.name}: queued actions overlap or escape the attachment row`);
    assert.deepEqual(layout.queueStrip.routes, { click: true, context: true }, `${viewport.name}: queued instruction menu is not reachable from both the three dots and right-click`);
    assert.match(layout.queueStrip.menuText, /Edit message[\s\S]*Open in side chat[\s\S]*Send to new task[\s\S]*Turn off queuing/u, `${viewport.name}: queued instruction actions are incomplete`);
  }
  if (viewport.kind === 'queue-new-task') {
    assert.equal(layout.queueNewTask?.search, true, `${viewport.name}: searchable model catalogue is missing`);
    assert.ok((layout.queueNewTask?.groups?.length ?? 0) >= 2, `${viewport.name}: models are not grouped by Agent`);
    assert.ok(layout.queueNewTask?.reasoning && !/^(auto|default)$/iu.test(layout.queueNewTask.reasoning), `${viewport.name}: reasoning did not resolve to a concrete valid level`);
    assert.match(layout.queueNewTask?.text ?? '', /Send to new task[\s\S]*Start task/u, `${viewport.name}: new-task handoff hierarchy is unclear`);
  }
  if (viewport.kind.startsWith('wallet')) {
    assert.ok(layout.selectedStateBounds, `${viewport.name}: wallet overlay is missing`);
    assert.ok(layout.selectedStateBounds.x >= 0 && layout.selectedStateBounds.y >= 0 && layout.selectedStateBounds.x + layout.selectedStateBounds.width <= layout.viewport.width + 1 && layout.selectedStateBounds.bottom <= layout.viewport.height + 1, `${viewport.name}: wallet overlay is clipped`);
  }
  if (viewport.kind === 'context-compaction') {
    assert.ok(layout.selectedStateBounds, `${viewport.name}: context settings are missing`);
    assert.ok(layout.selectedStateBounds.x >= 0 && layout.selectedStateBounds.y >= 0 && layout.selectedStateBounds.x + layout.selectedStateBounds.width <= layout.viewport.width + 1 && layout.selectedStateBounds.bottom <= layout.viewport.height + 1, `${viewport.name}: context settings are clipped`);
    assert.equal(layout.contextCompaction?.title, 'Set automatic compaction', `${viewport.name}: context title is unclear`);
    assert.equal(layout.contextCompaction?.modalCount, 0, `${viewport.name}: context Apply still opens a confirmation modal`);
    assert.equal(layout.contextCompaction?.background, 'rgb(24, 24, 23)', `${viewport.name}: context panel is not fully opaque`);
    assert.deepEqual(layout.contextCompaction?.interaction?.initial, {
      sliderValue: 96_000,
      thresholdText: '96.0k',
      percentText: '45%',
      ariaNow: '45',
      meterLabel: 'Automatic compaction limit used',
      appliedText: '96.0k',
      noteText: null,
    }, `${viewport.name}: the initial meter does not reflect the applied automatic-compaction limit`);
    assert.equal(layout.contextCompaction?.interaction?.draft?.sliderValue, 8_000, `${viewport.name}: physical threshold drag did not reach the supported minimum`);
    assert.equal(layout.contextCompaction?.interaction?.draft?.percentText, '100%', `${viewport.name}: the percentage did not preview the draft threshold live`);
    assert.equal(layout.contextCompaction?.interaction?.draft?.appliedText, '96.0k', `${viewport.name}: dragging falsely changed the applied threshold before Apply`);
    assert.equal(layout.contextCompaction?.interaction?.draft?.noteText, 'Applying now may compact while this turn is still running.', `${viewport.name}: active-turn threshold guidance is not concise and inline`);
    assert.deepEqual(layout.contextCompaction?.interaction?.reopened, layout.contextCompaction?.interaction?.initial, `${viewport.name}: closing without Apply did not discard the draft threshold`);
    assert.equal(layout.contextCompaction?.interaction?.applied?.sliderValue, 8_000, `${viewport.name}: Apply did not retain the chosen threshold`);
    assert.equal(layout.contextCompaction?.interaction?.applied?.percentText, '100%', `${viewport.name}: the applied percentage did not stay relative to the compaction limit`);
    assert.equal(layout.contextCompaction?.interaction?.applied?.appliedText, '8.0k', `${viewport.name}: Usage did not show the bridge-confirmed applied threshold`);
  }
  if (viewport.kind === 'task-details') {
    assert.ok(layout.selectedStateBounds, `${viewport.name}: task details are missing`);
    assert.ok(layout.selectedStateBounds.x >= 0 && layout.selectedStateBounds.y >= 0 && layout.selectedStateBounds.x + layout.selectedStateBounds.width <= layout.viewport.width + 1 && layout.selectedStateBounds.bottom <= layout.viewport.height + 1, `${viewport.name}: task details are clipped`);
    assert.equal(layout.taskDetails?.childRows, 1, `${viewport.name}: spawned sub-agent row is missing`);
    assert.match(layout.taskDetails?.text ?? '', /Sub-agents[\s\S]*Layout review[\s\S]*Location/u, `${viewport.name}: task details hierarchy is unclear`);
    assert.equal(layout.taskDetails?.background, 'rgb(24, 24, 23)', `${viewport.name}: task details panel is not opaque`);
  }
  if (viewport.kind === 'subagents') {
    assert.ok(layout.selectedStateBounds, `${viewport.name}: sub-agent disclosure is missing`);
    assert.ok(layout.selectedStateBounds.x >= 0 && layout.selectedStateBounds.y >= 0 && layout.selectedStateBounds.x + layout.selectedStateBounds.width <= layout.viewport.width + 1 && layout.selectedStateBounds.bottom <= layout.viewport.height + 1, `${viewport.name}: sub-agent disclosure is clipped`);
    assert.equal(layout.subagents?.triggerLabel, '2 sub-agents', `${viewport.name}: parent row does not expose the child count`);
    assert.equal(layout.subagents?.expanded, 'true', `${viewport.name}: sub-agent disclosure did not open`);
    assert.equal(layout.subagents?.childRows, 2, `${viewport.name}: sub-agent disclosure did not render every child`);
    assert.match(layout.subagents?.text ?? '', /Layout review[\s\S]*Provider research/u, `${viewport.name}: child task names are missing or out of order`);
    assert.equal(layout.subagents?.background, 'rgb(24, 24, 23)', `${viewport.name}: sub-agent disclosure is not opaque`);
    assert.equal(layout.subagents?.topLevelTitles.includes('Review the desktop layout'), false, `${viewport.name}: a child leaked into the top-level task list`);
    assert.equal(layout.subagents?.topLevelTitles.includes('Research the provider boundary'), false, `${viewport.name}: a child leaked into the top-level task list`);
    assert.match(layout.subagentTransition?.idle?.label ?? '', /Idle/u, `${viewport.name}: initial child state did not render`);
    assert.equal(layout.subagentTransition?.idle?.spinnerCount, 0, `${viewport.name}: idle child displayed a working spinner`);
    assert.match(layout.subagentTransition?.working?.label ?? '', /Working/u, `${viewport.name}: child did not update live to working`);
    assert.equal(layout.subagentTransition?.working?.spinnerCount, 1, `${viewport.name}: working child is missing its spinner`);
    assert.notEqual(layout.subagentTransition?.working?.spinnerAnimation, 'none', `${viewport.name}: working child spinner is not animated`);
    assert.match(layout.subagentTransition?.completed?.label ?? '', /Completed/u, `${viewport.name}: child did not update live to completed`);
    assert.equal(layout.subagentTransition?.completed?.spinnerCount, 0, `${viewport.name}: completed child kept a stale spinner`);
  }
  if (viewport.kind === 'subagents-hover') {
    assert.ok(layout.selectedStateBounds, `${viewport.name}: sub-agent hover tooltip is missing`);
    assert.equal(layout.subagentTooltip?.visibleCount, 1, `${viewport.name}: sub-agent hover produced overlapping tooltip layers`);
    assert.equal(layout.subagentTooltip?.text, '2 sub-agents', `${viewport.name}: sub-agent hover label is incorrect`);
    assert.equal(layout.subagentTooltip?.parentIsBody, true, `${viewport.name}: sub-agent tooltip is still trapped inside the task rail`);
    assert.equal(layout.subagentTooltip?.nestedTooltipSources, 0, `${viewport.name}: provider logo still creates a second tooltip`);
    assert.equal(layout.subagentTooltip?.triggerHasTooltipSource, false, `${viewport.name}: trigger still creates the clipped pseudo-element tooltip`);
    assert.ok(layout.subagentTooltip?.triggerPseudoContent === 'none' || layout.subagentTooltip?.triggerPseudoContent === 'normal', `${viewport.name}: an underlying trigger pseudo-tooltip is still painted`);
    assert.ok(layout.subagentTooltip?.bounds && layout.subagentTooltip.bounds.left >= 8 && layout.subagentTooltip.bounds.top >= 8 && layout.subagentTooltip.bounds.right <= layout.viewport.width - 8 + 1 && layout.subagentTooltip.bounds.bottom <= layout.viewport.height - 8 + 1, `${viewport.name}: sub-agent hover tooltip is clipped by the viewport`);
  }
  if (viewport.kind === 'local-open') {
    assert.ok(layout.selectedStateBounds, `${viewport.name}: Open in menu is missing`);
    assert.ok(layout.selectedStateBounds.width >= 180 && layout.selectedStateBounds.width <= 230, `${viewport.name}: Open in menu is not compact`);
    assert.ok(layout.selectedStateBounds.x >= 0 && layout.selectedStateBounds.y >= 0 && layout.selectedStateBounds.x + layout.selectedStateBounds.width <= layout.viewport.width + 1 && layout.selectedStateBounds.bottom <= layout.viewport.height + 1, `${viewport.name}: Open in menu is clipped`);
  }
  if (viewport.kind === 'sidebar-resized') {
    const resize = layout.sidebarResize;
    assert.ok(resize, `${viewport.name}: sidebar resize metrics are missing`);
    assert.equal(resize.cursor, 'col-resize', `${viewport.name}: divider does not advertise horizontal resizing`);
    assert.equal(resize.role, 'separator', `${viewport.name}: resize handle is not an accessible separator`);
    assert.equal(resize.orientation, 'vertical', `${viewport.name}: separator orientation is incorrect`);
    assert.ok(resize.handleWidth >= 8, `${viewport.name}: divider drag target is too thin`);
    assert.ok(Math.abs(resize.handleSidebarDelta) <= .75, `${viewport.name}: resize handle drifted away from the task-list wall`);
    assert.ok(resize.after.sidebarWidth - resize.before.sidebarWidth >= 115, `${viewport.name}: dragging did not widen the task list`);
    assert.ok(resize.after.rowWidth - resize.before.rowWidth >= 115, `${viewport.name}: task cards did not grow with the task list`);
    assert.ok(resize.after.titleWidth - resize.before.titleWidth >= 115, `${viewport.name}: title lane did not use the added width`);
    assert.ok(resize.after.previewWidth - resize.before.previewWidth >= 115, `${viewport.name}: preview wrapping lane did not use the added width`);
    assert.ok(resize.after.newTaskWidth - resize.before.newTaskWidth >= 115, `${viewport.name}: full-width navigation controls did not grow with the task list`);
    assert.ok(Math.abs(resize.valueNow - resize.after.sidebarWidth) <= 1, `${viewport.name}: separator value does not match the rendered task-list width`);
  }
  if (viewport.kind.startsWith('trace-')) {
    assert.equal(layout.trace?.reasoningIdentityCount, 0, `${viewport.name}: Reasoning should not carry a provider mark`);
    if (viewport.kind !== 'trace-thinking-expanded') assert.equal(layout.trace?.answerIdentityCount, 1, `${viewport.name}: the turn should have exactly one provider mark on its answer`);
    if (layout.trace.assistantMark) assert.ok(Math.abs(layout.trace.assistantMark.centerDelta) <= 2, `${viewport.name}: assistant mark is not aligned with the first rendered line`);
    assert.ok(layout.trace?.flowGaps, `${viewport.name}: reasoning transition metrics are missing`);
    if (viewport.kind !== 'trace-thinking-expanded') {
      assert.ok(layout.trace.flowGaps.exactTurnBoundaries, `${viewport.name}: exact turn-boundary fixture is missing`);
      assert.ok(layout.trace.flowGaps.exactTurnBoundaries.expected >= 18, `${viewport.name}: configured turn-boundary gap is not materially larger than assistant-internal spacing`);
      assert.ok(Math.abs(layout.trace.flowGaps.previousElementToGroup - layout.trace.flowGaps.exactTurnBoundaries.expected) <= 0.75, `${viewport.name}: actual user to reasoning spacing does not match the shared turn boundary`);
      assert.ok(Math.abs(layout.trace.flowGaps.previousVisibleToGroup - layout.trace.flowGaps.exactTurnBoundaries.expected) <= 0.75, `${viewport.name}: visible user content is not evenly spaced before reasoning`);
      assert.ok(Math.abs(layout.trace.flowGaps.exactTurnBoundaries.assistantToUser - layout.trace.flowGaps.exactTurnBoundaries.expected) <= 0.75, `${viewport.name}: assistant to user spacing does not match the shared turn boundary`);
      assert.ok(Math.abs(layout.trace.flowGaps.exactTurnBoundaries.userToReasoning - layout.trace.flowGaps.exactTurnBoundaries.expected) <= 0.75, `${viewport.name}: user to reasoning spacing does not match the shared turn boundary`);
      assert.ok(Math.abs(layout.trace.flowGaps.exactTurnBoundaries.finalToUser - layout.trace.flowGaps.exactTurnBoundaries.expected) <= 0.75, `${viewport.name}: final answer to user spacing does not match the shared turn boundary`);
      if (!layout.trace.flowGaps.finalBoundary) {
        assert.ok(layout.trace.flowGaps.groupToNextElement >= 4 && layout.trace.flowGaps.groupToNextElement <= 8, `${viewport.name}: reasoning to assistant element spacing is not tight`);
        assert.ok(layout.trace.flowGaps.groupToNextVisible >= 4 && layout.trace.flowGaps.groupToNextVisible <= 8, `${viewport.name}: reasoning to visible assistant text spacing is not tight`);
      }
    }
  }
  if (viewport.kind.startsWith('trace-')) {
    assert.ok((layout.trace?.runningGroups ?? 0) <= 1, `${viewport.name}: more than the current reasoning group is animated`);
    assert.ok((layout.trace?.runningFlows ?? 0) <= 1, `${viewport.name}: more than the current thinking detail is animated`);
    assert.equal(layout.trace?.unexplainedLiveDots, 0, `${viewport.name}: unexplained green live dots remain in reasoning`);
  }
  if (viewport.kind === 'trace-collapsed') {
    assert.equal(layout.trace?.messageIdentityCount, 1, `${viewport.name}: the final answer does not own the turn's single provider mark`);
    assert.equal(layout.trace?.disclosureExpanded, 'false', `${viewport.name}: reasoning is not collapsed at rest`);
    assert.equal(layout.trace?.outerGroups, 1, `${viewport.name}: one uninterrupted reasoning/tool span rendered more than one outer control`);
    assert.equal(layout.trace?.chevrons?.outer, '0', `${viewport.name}: outer reasoning chevron is visible at rest`);
    assert.equal(layout.trace?.activitiesVisible, false, `${viewport.name}: tool rows leak out of collapsed reasoning`);
    assert.equal(layout.trace?.activityRows, 0, `${viewport.name}: collapsed reasoning exposes activity rows`);
    assert.equal(layout.trace?.snippetCount, 0, `${viewport.name}: raw activity snippet is visible at rest`);
    assert.ok(layout.sidebar?.newTask && layout.sidebar.dashboard && layout.sidebar.taskText, `${viewport.name}: sidebar controls or task text are missing`);
    assert.ok(layout.sidebar.newTask.height >= 32 && layout.sidebar.newTask.height <= 42, `${viewport.name}: New task is not compact`);
    assert.ok(Math.abs(layout.sidebar.newTask.height - layout.sidebar.dashboard.height) <= 1, `${viewport.name}: New task and Dashboard heights do not match`);
    assert.ok(Math.abs(layout.sidebar.newTask.width - layout.sidebar.dashboard.width) <= 1, `${viewport.name}: New task and Dashboard widths do not match`);
    assert.ok(Math.abs(layout.sidebar.newTask.labelCenterDelta) <= 0.75, `${viewport.name}: New task text is not centred independently of its icon`);
    assert.ok(Math.abs(layout.sidebar.dashboard.labelCenterDelta) <= 0.75, `${viewport.name}: Dashboard text is not centred independently of its icon`);
    assert.ok(layout.sidebar.footerDivider, `${viewport.name}: Settings divider geometry is missing`);
    assert.ok(Math.abs(layout.sidebar.footerDivider.leftDelta) <= 0.5, `${viewport.name}: Settings divider stops before the left wall`);
    assert.ok(Math.abs(layout.sidebar.footerDivider.rightDelta) <= 1.5, `${viewport.name}: Settings divider stops before the right wall`);
    assert.equal(layout.sidebar.footerDivider.borderTopWidth, '1px', `${viewport.name}: Settings divider is missing`);
    assert.ok(Math.abs(layout.sidebar.taskText.titleX - layout.sidebar.taskText.previewX) <= 1, `${viewport.name}: task preview does not align with its title`);
    assert.ok(layout.sidebar.taskControls, `${viewport.name}: task filter or plus control is missing`);
    assert.equal(layout.sidebar.taskControls.filterBeforePlus, true, `${viewport.name}: task filter is not placed before the plus action`);
    assert.equal(layout.sidebar.taskControls.filterInsideSearch, false, `${viewport.name}: task filter is still embedded in the search field`);
    assert.ok(layout.sidebar.taskControls.gap >= 5 && layout.sidebar.taskControls.gap <= 8, `${viewport.name}: task filter and plus spacing is unbalanced`);
    assert.ok(Math.abs(layout.sidebar.taskControls.centerDelta) <= .5, `${viewport.name}: task filter and plus controls are not vertically aligned`);
    assert.ok(layout.sidebar.taskRows.length >= 3, `${viewport.name}: task-row geometry fixture is incomplete`);
    const rowHeights = layout.sidebar.taskRows.map((row) => row.rowHeight);
    const previewHeights = layout.sidebar.taskRows.map((row) => row.previewHeight);
    assert.ok(Math.max(...rowHeights) - Math.min(...rowHeights) <= 0.5, `${viewport.name}: normal task rows do not share one height`);
    assert.ok(Math.max(...previewHeights) - Math.min(...previewHeights) <= 0.5, `${viewport.name}: task preview lanes do not share one height`);
    assert.ok(layout.sidebar.taskRows.some((row) => row.overflowByGeometry), `${viewport.name}: task-row fixture has no overflowing preview`);
    assert.ok(layout.sidebar.taskRows.some((row) => !row.overflowByGeometry), `${viewport.name}: task-row fixture has no fitting preview`);
    const workingRows = layout.sidebar.taskRows.filter((row) => row.workingSpinner);
    assert.equal(workingRows.length, 1, `${viewport.name}: working task spinner fixture is missing or duplicated`);
    const workingSpinner = workingRows[0].workingSpinner;
    assert.ok(workingSpinner.width >= 11.5 && workingSpinner.width <= 12.5 && workingSpinner.height >= 11.5 && workingSpinner.height <= 12.5, `${viewport.name}: task spinner does not visibly fill the space beneath the provider mark`);
    assert.ok(Math.abs(workingSpinner.centerDeltaX) <= .5, `${viewport.name}: task spinner is not horizontally centred on the provider mark`);
    assert.ok(workingSpinner.gapAbove >= 4 && workingSpinner.gapAbove <= 9, `${viewport.name}: task spinner sits too close to or far from the provider mark`);
    assert.ok(Math.abs(workingSpinner.gapAbove - workingSpinner.gapBelow) <= 1.5, `${viewport.name}: task spinner does not have balanced space above and below`);
    for (const row of layout.sidebar.taskRows) {
      assert.equal(row.overflowAttribute, row.overflowByGeometry, `${viewport.name}: task preview overflow state disagrees with its geometry`);
      assert.equal(row.maskImage !== 'none', row.overflowByGeometry, `${viewport.name}: task preview fade is not limited to clipped text`);
      if (row.overflowByGeometry) assert.ok(Math.abs(row.overflowDuration - row.overflowDistance / 18) <= .02, `${viewport.name}: task preview reveal speed changes with prompt length`);
      assert.ok(Math.abs(row.titleX - row.previewX) <= 0.5, `${viewport.name}: task title and preview starts drift apart`);
      assert.ok(row.titleGap >= 5 && row.titleGap <= 7, `${viewport.name}: task icon-to-title gap is not the compact six-pixel target`);
      assert.ok(row.previewGap >= 5 && row.previewGap <= 7, `${viewport.name}: task icon-to-preview gap is not the compact six-pixel target`);
    }
  }
  if (viewport.kind === 'trace-compacting') {
    assert.equal(layout.trace?.compactionStatus?.text, 'Automatically compacting context…', `${viewport.name}: active automatic compaction wording is not accurate`);
    assert.equal(layout.trace?.compactionStatus?.role, 'status', `${viewport.name}: active compaction is not announced as status`);
    assert.equal(layout.trace?.compactionStatus?.color, 'rgb(133, 138, 133)', `${viewport.name}: active compaction status is not quiet gray`);
    assert.equal(layout.trace?.compactionStatus?.backgroundColor, 'rgba(0, 0, 0, 0)', `${viewport.name}: active compaction acquired a heavy surface`);
    assert.equal(layout.trace?.compactionStatus?.borderTopWidth, '0px', `${viewport.name}: active compaction acquired a bordered container`);
    assert.equal(layout.trace?.compactionStatus?.iconWidth, 16, `${viewport.name}: active compaction icon is not compact`);
    assert.equal(layout.trace?.compactionStatus?.textAnimation, reducedMotion ? 'none' : 'compaction-text-sheen', `${viewport.name}: active compaction text motion does not match the motion preference`);
    assert.equal(layout.trace?.compactionStatus?.iconAnimation, reducedMotion ? 'none' : 'compaction-icon-sheen', `${viewport.name}: active compaction icon motion does not match the motion preference`);
  }
  if (viewport.kind === 'trace-compacted') {
    assert.equal(layout.trace?.compactionStatus?.text, 'Session compacted', `${viewport.name}: completed compaction wording is not preserved`);
    assert.equal(layout.trace?.compactionStatus?.expanded, 'false', `${viewport.name}: completed compaction is exposed by default`);
    assert.equal(layout.trace?.compactionStatus?.detailVisible, false, `${viewport.name}: completed compaction detail is visible at rest`);
    assert.equal(layout.trace?.compactionStatus?.textAnimation, 'none', `${viewport.name}: completed compaction is still animated`);
    assert.equal(layout.trace?.compactionStatus?.iconAnimation, 'none', `${viewport.name}: completed compaction icon is still animated`);
    assert.equal(layout.trace?.compactionStatus?.backgroundColor, 'rgba(0, 0, 0, 0)', `${viewport.name}: completed compaction acquired a heavy surface`);
  }
  if (viewport.kind === 'trace-compacted-expanded') {
    assert.equal(layout.trace?.compactionStatus?.expanded, 'true', `${viewport.name}: completed compaction did not expand`);
    assert.equal(layout.trace?.compactionStatus?.detailVisible, true, `${viewport.name}: expanded compaction has no readable detail`);
    assert.equal(layout.trace?.compactionStatus?.text, 'Session compacted', `${viewport.name}: expanded compaction lost its event label`);
  }
  if (viewport.kind === 'trace-expanded') {
    assert.equal(layout.trace?.disclosureExpanded, 'true', `${viewport.name}: reasoning did not expand`);
    assert.equal(layout.trace?.segmentsVisible, true, `${viewport.name}: expanded reasoning is missing its ordered summaries`);
    assert.ok((layout.trace?.segmentRows ?? 0) >= 1, `${viewport.name}: expanded reasoning has no concise summary rows`);
    assert.deepEqual(layout.trace?.segmentKinds, ['thinking', 'activity', 'activity'], `${viewport.name}: reasoning and sub-agent summaries are not in chronological fixture order`);
    assert.ok(layout.trace?.segmentText.some((text) => text.includes('Spawned sub-agent')), `${viewport.name}: spawned sub-agent is not named in the transcript`);
    assert.equal(layout.trace?.controlsVisible, true, `${viewport.name}: expanded reasoning is missing its local display controls`);
    assert.equal(layout.trace?.chevrons?.outer, '0', `${viewport.name}: expanded outer reasoning chevron is visible without interaction`);
    assert.equal(layout.trace?.chevrons?.inner, '0', `${viewport.name}: collapsed inner chevron is visible at rest`);
    assert.equal(layout.trace?.chevrons?.interactionRules.length, 2, `${viewport.name}: hover/focus chevron reveal rules are missing`);
    assert.equal(layout.trace?.activitiesVisible, false, `${viewport.name}: tool calls opened before their summary was selected`);
    assert.equal(layout.trace?.activityRows, 0, `${viewport.name}: raw tool-call rows opened before their summary was selected`);
    assert.equal(layout.trace?.snippetCount, 0, `${viewport.name}: tool details opened before an activity was selected`);
  }
  if (viewport.kind === 'trace-thinking-expanded') {
    assert.equal(layout.trace?.disclosureExpanded, 'true', `${viewport.name}: parent reasoning closed while thinking was open`);
    assert.ok((layout.trace?.thinkingFlows ?? 0) >= 1, `${viewport.name}: expanded thinking text is missing`);
    assert.ok(layout.trace?.reasoningFlow, `${viewport.name}: expanded thinking bounds are missing`);
    assert.ok(Number.parseFloat(layout.trace.reasoningFlow.maxHeight) <= 360, `${viewport.name}: verbose thinking is not height-bounded`);
    assert.match(layout.trace.reasoningFlow.overflowY, /auto|scroll/, `${viewport.name}: verbose thinking cannot scroll internally`);
    assert.equal(layout.trace.reasoningFlow.scrollHeight, layout.trace.reasoningFlow.clientHeight, `${viewport.name}: short thinking fixture gained unnecessary internal scrolling`);
    assert.equal(layout.trace.reasoningFlow.textAnimation, reducedMotion ? 'none' : 'reasoning-flow-shimmer', `${viewport.name}: live reasoning text motion does not match the motion preference`);
    assert.equal(layout.trace.reasoningFlow.iconAnimation, reducedMotion ? 'none' : 'reasoning-flow', `${viewport.name}: live reasoning motion does not match the motion preference`);
    assert.equal(layout.trace?.snippetCount, 0, `${viewport.name}: live activity detail opened without reader intent`);
    assert.equal(layout.trace?.snippetCount, 0, `${viewport.name}: Expand thinking opened a tool snippet`);
  }
  if (viewport.kind === 'trace-snippet') {
    assert.equal(layout.trace?.disclosureExpanded, 'true', `${viewport.name}: parent reasoning closed while tool details were open`);
    assert.equal(layout.trace?.activitiesVisible, true, `${viewport.name}: activity list disappeared while details were open`);
    assert.equal(layout.trace?.snippetCount, 1, `${viewport.name}: exactly one selected tool snippet should be visible`);
    assert.ok(layout.trace?.snippet, `${viewport.name}: selected tool snippet metrics are missing`);
    assert.ok(layout.trace.snippet.bounds.width <= 760.5, `${viewport.name}: tool snippet is too wide`);
    assert.ok(layout.trace.snippet.bounds.height <= 412, `${viewport.name}: tool snippet exceeds its bounded detail surface`);
    assert.ok(layout.trace.snippet.preClientHeight <= 330.5, `${viewport.name}: tool snippet is too tall`);
    assert.ok(layout.trace.snippet.preScrollHeight > layout.trace.snippet.preClientHeight, `${viewport.name}: long tool content is not contained by scrolling`);
    assert.match(layout.trace.snippet.overflowY, /auto|scroll/, `${viewport.name}: tool snippet does not scroll vertically`);
    assert.ok(Number.parseFloat(layout.trace.snippet.fontSize) >= 11, `${viewport.name}: tool snippet text is too small`);
    assert.ok(layout.trace.snippet.bounds.x >= 0 && layout.trace.snippet.bounds.right <= layout.viewport.width + 1, `${viewport.name}: tool snippet escapes horizontally`);
    assert.ok(layout.trace.snippet.conversationBounds && layout.trace.snippet.bounds.y >= layout.trace.snippet.conversationBounds.top - 1 && layout.trace.snippet.bounds.bottom <= layout.trace.snippet.conversationBounds.bottom + 1, `${viewport.name}: tool snippet is clipped by the conversation viewport (${JSON.stringify({ bounds: layout.trace.snippet.bounds, conversationBounds: layout.trace.snippet.conversationBounds })})`);
  }
  assert.ok(layout.buttons >= 4, `${viewport.name}: expected desktop actions are missing`);
  assert.equal(layout.emptyButtons, 0, `${viewport.name}: unlabeled button found`);
  assert.ok(layout.document.width <= layout.viewport.width + 2, `${viewport.name}: horizontal document overflow`);
  assert.deepEqual(layout.overflow, [], `${viewport.name}: content escapes the viewport`);
  const clippedControls = viewport.kind === 'settings-global-agents' || viewport.kind === 'settings-dictation'
    ? layout.clippedControls.filter((control) => control.className !== 'workflow-entry-trigger')
    : layout.clippedControls;
  assert.deepEqual(clippedControls, [], `${viewport.name}: visible control is clipped`);
  assert.deepEqual(layout.tinyReadableText, [], `${viewport.name}: visible text is below 8px`);
  assert.notEqual(layout.background, 'rgba(0, 0, 0, 0)', `${viewport.name}: transparent page background`);
  if (reducedMotion) assert.equal(layout.reducedMotion?.mediaMatches, true, `${viewport.name}: reduced-motion media emulation is unavailable`);
  process.stdout.write(`${viewport.name} ${JSON.stringify(layout)}\n`);
  return window;
}

// Each capture owns and destroys its BrowserWindow. Keep Electron alive between
// those windows so the next deterministic viewport can load on Windows/Linux.
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  let activeWindow = null;
  let exitCode = 0;
  try {
    await mkdir(outputDirectory, { recursive: true });
    for (const viewport of viewports) {
      activeWindow = await capture(viewport);
      if (!activeWindow.isDestroyed() && activeWindow.webContents.debugger.isAttached()) activeWindow.webContents.debugger.detach();
      if (!activeWindow.isDestroyed()) activeWindow.destroy();
      activeWindow = null;
    }
  } catch (error) {
    exitCode = 1;
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  } finally {
    if (activeWindow && !activeWindow.isDestroyed() && activeWindow.webContents.debugger.isAttached()) activeWindow.webContents.debugger.detach();
    if (activeWindow && !activeWindow.isDestroyed()) activeWindow.destroy();
    process.exitCode = exitCode;
    app.quit();
  }
});
