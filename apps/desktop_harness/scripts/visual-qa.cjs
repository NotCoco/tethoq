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
  { name: 'composer-handoff-980x680', width: 980, height: 680, kind: 'composer-handoff', selector: '.handoff-chat-picker' },
  { name: 'composer-delegation-980x680', width: 980, height: 680, kind: 'composer-delegation', selector: '.delegation-chat-picker' },
  { name: 'composer-vision-eyes-980x680', width: 980, height: 680, kind: 'composer-vision', selector: '.vision-eyes-picker' },
  { name: 'context-compaction-1100x760', width: 1100, height: 760, kind: 'context-compaction', selector: '.context-usage-popover' },
  { name: 'trace-collapsed-sidebar-1100x760', width: 1100, height: 760, kind: 'trace-collapsed', selector: '.reasoning-disclosure[aria-expanded="false"]' },
  { name: 'trace-expanded-1100x760', width: 1100, height: 760, kind: 'trace-expanded', selector: '.reasoning-activities' },
  { name: 'trace-snippet-1100x760', width: 1100, height: 760, kind: 'trace-snippet', selector: '.activity-snippet' },
  { name: 'wallet-dropdown-1100x760', width: 1100, height: 760, kind: 'wallet', selector: '.wallet-popover' },
  { name: 'wallet-direct-advanced-1100x760', width: 1100, height: 760, kind: 'wallet-direct-advanced', selector: '.wallet-advanced' },
  { name: 'dashboard-1440x900', width: 1440, height: 900, kind: 'dashboard', selector: '.dashboard-page' },
  { name: 'settings-connectors-1440x900', width: 1440, height: 900, kind: 'settings', selector: '.connector-card[data-connector-id="tethoq-example"]' },
  { name: 'browser-private-profile-1440x900', width: 1440, height: 900, kind: 'browser', selector: '.browser-page .browser-privacy-note' },
  { name: 'browser-downloads-1440x900', width: 1440, height: 900, kind: 'browser-downloads', selector: '.browser-download-panel .browser-download-progress' },
  { name: 'browser-downloads-minimum-980x680', width: 980, height: 680, kind: 'browser-downloads', selector: '.browser-download-panel .browser-download-progress' },
  { name: 'browser-downloads-minimum-supported-760x480', width: 760, height: 480, kind: 'browser-downloads', selector: '.browser-download-panel .browser-download-progress' },
  { name: 'workflows-1440x900', width: 1440, height: 900, kind: 'workflows', selector: '#workflow-settings' },
  { name: 'new-task-1100x760', width: 1100, height: 760, kind: 'new-task-draft', selector: '.workspace .composer-wrap' },
  { name: 'new-task-minimum-760x480', width: 760, height: 480, kind: 'new-task-draft', selector: '.workspace .composer-wrap' },
  { name: 'approval-1100x760', width: 1100, height: 760, kind: 'approval', selector: '.workspace .approval-card' },
];
if (process.argv.includes('--context-only')) {
  const contextViewport = viewports.find((viewport) => viewport.kind === 'context-compaction');
  viewports.splice(0, viewports.length, contextViewport);
} else if (process.argv.includes('--trace-only')) {
  const traceViewports = viewports.filter((viewport) => viewport.kind.startsWith('trace-'));
  viewports.splice(0, viewports.length, ...traceViewports);
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
  window.webContents.on('console-message', (event) => {
    diagnostics.push(`console[${event.level ?? 'unknown'}] ${event.message ?? ''} (${event.sourceId ?? ''}:${event.lineNumber ?? 0})`);
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    diagnostics.push(`render-process-gone ${JSON.stringify(details)}`);
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await window.loadFile(rendererPath);
  await waitForRenderer(window, diagnostics);
  if (viewport.kind === 'minimum-workspace') {
    await window.webContents.executeJavaScript(`document.querySelector('.session-row')?.click()`, true);
  } else if (viewport.kind === 'composer-model') {
    await window.webContents.executeJavaScript(`document.querySelector('.model-picker-trigger')?.click()`, true);
  } else if (viewport.kind === 'composer-model-browser') {
    await window.webContents.executeJavaScript(`document.querySelector('.model-picker-trigger')?.click()`, true);
    await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="Open full model browser"]')?.click()`, true);
  } else if (viewport.kind === 'composer-actions') {
    await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="More message actions"]')?.click()`, true);
  } else if (viewport.kind === 'composer-handoff') {
    await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="More message actions"]')?.click()`, true);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('.composer-actions-menu [role="menuitem"]')].find((button) => button.textContent?.includes('Context Handoff'))?.click()`, true);
  } else if (viewport.kind === 'composer-delegation') {
    await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="More message actions"]')?.click()`, true);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('.composer-actions-menu [role="menuitem"]')].find((button) => button.textContent?.includes('Delegate task'))?.click()`, true);
  } else if (viewport.kind === 'composer-vision') {
    await window.webContents.executeJavaScript(`document.querySelectorAll('.session-row')[1]?.click()`, true);
    await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="More message actions"]')?.click()`, true);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('.composer-actions-menu [role="menuitem"]')].find((button) => button.textContent?.includes('Attach workflow'))?.click()`, true);
  } else if (viewport.kind === 'dashboard') {
    await window.webContents.executeJavaScript(`document.querySelector('.primary-nav button')?.click()`, true);
  } else if (viewport.kind === 'settings') {
    await window.webContents.executeJavaScript(`document.querySelector('.sidebar-settings')?.click()`, true);
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        const section = document.querySelector('.connector-section');
        if (section) { section.scrollIntoView({ block: 'center' }); return requestAnimationFrame(() => resolve()); }
        if (Date.now() - started > 5000) return reject(new Error('Connector settings did not render'));
        requestAnimationFrame(check);
      };
      check();
    })`, true);
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
  } else if (viewport.kind === 'workflows') {
    await window.webContents.executeJavaScript(`document.querySelector('button[aria-label="More message actions"]')?.click()`, true);
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('.composer-actions-menu [role="menuitem"]')].find((button) => button.textContent?.includes('Manage workflows'))?.click()`, true);
  } else if (viewport.kind === 'context-compaction') {
    await window.webContents.executeJavaScript(`document.querySelector('.context-usage-trigger')?.click()`, true);
    await window.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('.context-threshold-meter input[type="range"]');
      if (!input) return;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, input.min);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`, true);
  } else if (viewport.kind === 'trace-expanded' || viewport.kind === 'trace-snippet') {
    await window.webContents.executeJavaScript(`document.querySelector('.reasoning-disclosure[aria-expanded="false"]')?.click()`, true);
    if (viewport.kind === 'trace-snippet') {
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
            snippet.closest('.activity-snippet')?.scrollIntoView({ block: 'center' });
            return requestAnimationFrame(() => requestAnimationFrame(resolve));
          }
          if (Date.now() - started > 5000) return reject(new Error('Expanded trace snippet did not render'));
          requestAnimationFrame(check);
        };
        check();
      })`, true);
    }
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
  window.webContents.invalidate();
  await new Promise((resolve) => setTimeout(resolve, 300));
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
      connectorCards: document.querySelectorAll('.connector-card').length,
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
        noteVisual: (() => {
          const note = document.querySelector('.context-threshold-note');
          const rect = note?.getBoundingClientRect();
          const style = note ? getComputedStyle(note) : null;
          return rect && style ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height, color: style.color, fontSize: style.fontSize, display: style.display, visibility: style.visibility, opacity: style.opacity } : null;
        })(),
        modalCount: document.querySelectorAll('.modal').length,
      } : null,
      trace: ${JSON.stringify(viewport.kind.startsWith('trace-'))} ? (() => {
        const disclosure = document.querySelector('.reasoning-disclosure');
        const activities = document.querySelector('.reasoning-activities');
        const rows = [...document.querySelectorAll('.reasoning-activities .activity-row')];
        const snippet = document.querySelector('.activity-snippet');
        const snippetPre = snippet?.querySelector('pre');
        const snippetRect = snippet?.getBoundingClientRect();
        const preRect = snippetPre?.getBoundingClientRect();
        const conversationRect = document.querySelector('.conversation-scroll')?.getBoundingClientRect();
        return {
          disclosureExpanded: disclosure?.getAttribute('aria-expanded') ?? null,
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
        const session = document.querySelector('.session-row');
        const title = session?.querySelector('.session-row-title');
        const preview = session?.querySelector('p');
        const newTaskRect = newTask?.getBoundingClientRect();
        const dashboardRect = dashboard?.getBoundingClientRect();
        const titleRect = title?.getBoundingClientRect();
        const previewRect = preview?.getBoundingClientRect();
        return {
          newTask: newTaskRect ? { x: newTaskRect.x, width: newTaskRect.width, height: newTaskRect.height } : null,
          dashboard: dashboardRect ? { x: dashboardRect.x, width: dashboardRect.width, height: dashboardRect.height } : null,
          taskText: titleRect && previewRect ? { titleX: titleRect.x, previewX: previewRect.x } : null,
        };
      })() : null,
    };
  })()`, true);

  const image = await window.webContents.capturePage();
  await writeFile(path.join(outputDirectory, `${viewport.name}.png`), image.toPNG());
  await writeFile(path.join(outputDirectory, `${viewport.name}.json`), `${JSON.stringify(layout, null, 2)}\n`);

  assert.ok(layout.rootChildren > 0, `${viewport.name}: empty renderer root`);
  assert.ok(layout.rootTextLength > 80, `${viewport.name}: renderer content did not load`);
  assert.equal(layout.appReady, true, `${viewport.name}: desktop shell did not finish loading`);
  assert.equal(layout.loading, false, `${viewport.name}: loading state remained visible`);
  assert.equal(layout.expectedStateReady, true, `${viewport.name}: expected ${viewport.selector} state is missing`);
  const thinExpectedState = viewport.selector.includes('progress');
  assert.ok(layout.expectedStateBounds?.width > 40 && layout.expectedStateBounds?.height > (thinExpectedState ? 1 : 20), `${viewport.name}: expected ${viewport.selector} state has unusable bounds`);
  if (viewport.kind === 'settings') assert.ok(layout.connectorCards >= 1, `${viewport.name}: external connector details are missing`);
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
  if (viewport.kind.startsWith('wallet')) {
    assert.ok(layout.selectedStateBounds, `${viewport.name}: wallet overlay is missing`);
    assert.ok(layout.selectedStateBounds.x >= 0 && layout.selectedStateBounds.y >= 0 && layout.selectedStateBounds.x + layout.selectedStateBounds.width <= layout.viewport.width + 1 && layout.selectedStateBounds.bottom <= layout.viewport.height + 1, `${viewport.name}: wallet overlay is clipped`);
  }
  if (viewport.kind === 'context-compaction') {
    assert.ok(layout.selectedStateBounds, `${viewport.name}: context settings are missing`);
    assert.ok(layout.selectedStateBounds.x >= 0 && layout.selectedStateBounds.y >= 0 && layout.selectedStateBounds.x + layout.selectedStateBounds.width <= layout.viewport.width + 1 && layout.selectedStateBounds.bottom <= layout.viewport.height + 1, `${viewport.name}: context settings are clipped`);
    assert.equal(layout.contextCompaction?.title, 'Set automatic compaction', `${viewport.name}: context title is unclear`);
    assert.equal(layout.contextCompaction?.note, 'Applying now may compact while this turn is still running.', `${viewport.name}: active-turn threshold guidance is not concise and inline`);
    assert.equal(layout.contextCompaction?.modalCount, 0, `${viewport.name}: context Apply still opens a confirmation modal`);
    assert.ok(layout.contextCompaction?.noteVisual?.height > 12 && layout.contextCompaction.noteVisual.opacity !== '0' && layout.contextCompaction.noteVisual.visibility === 'visible', `${viewport.name}: active-turn note is not visibly readable`);
  }
  if (viewport.kind === 'trace-collapsed') {
    assert.equal(layout.trace?.disclosureExpanded, 'false', `${viewport.name}: reasoning is not collapsed at rest`);
    assert.equal(layout.trace?.activitiesVisible, false, `${viewport.name}: tool rows leak out of collapsed reasoning`);
    assert.equal(layout.trace?.activityRows, 0, `${viewport.name}: collapsed reasoning exposes activity rows`);
    assert.equal(layout.trace?.snippetCount, 0, `${viewport.name}: raw activity snippet is visible at rest`);
    assert.ok(layout.sidebar?.newTask && layout.sidebar.dashboard && layout.sidebar.taskText, `${viewport.name}: sidebar controls or task text are missing`);
    assert.ok(layout.sidebar.newTask.height >= 32 && layout.sidebar.newTask.height <= 42, `${viewport.name}: New task is not compact`);
    assert.ok(Math.abs(layout.sidebar.newTask.height - layout.sidebar.dashboard.height) <= 1, `${viewport.name}: New task and Dashboard heights do not match`);
    assert.ok(Math.abs(layout.sidebar.newTask.width - layout.sidebar.dashboard.width) <= 1, `${viewport.name}: New task and Dashboard widths do not match`);
    assert.ok(Math.abs(layout.sidebar.taskText.titleX - layout.sidebar.taskText.previewX) <= 1, `${viewport.name}: task preview does not align with its title`);
  }
  if (viewport.kind === 'trace-expanded') {
    assert.equal(layout.trace?.disclosureExpanded, 'true', `${viewport.name}: reasoning did not expand`);
    assert.equal(layout.trace?.activitiesVisible, true, `${viewport.name}: expanded reasoning is missing its activity list`);
    assert.ok((layout.trace?.activityRows ?? 0) >= 1, `${viewport.name}: expanded reasoning has no concise activity rows`);
    assert.equal(layout.trace?.snippetCount, 0, `${viewport.name}: tool details opened before an activity was selected`);
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
    assert.ok(layout.trace.snippet.conversationBounds && layout.trace.snippet.bounds.y >= layout.trace.snippet.conversationBounds.top - 1 && layout.trace.snippet.bounds.bottom <= layout.trace.snippet.conversationBounds.bottom + 1, `${viewport.name}: tool snippet is clipped by the conversation viewport`);
  }
  assert.ok(layout.buttons >= 4, `${viewport.name}: expected desktop actions are missing`);
  assert.equal(layout.emptyButtons, 0, `${viewport.name}: unlabeled button found`);
  assert.ok(layout.document.width <= layout.viewport.width + 2, `${viewport.name}: horizontal document overflow`);
  assert.deepEqual(layout.overflow, [], `${viewport.name}: content escapes the viewport`);
  assert.deepEqual(layout.clippedControls, [], `${viewport.name}: visible control is clipped`);
  assert.deepEqual(layout.tinyReadableText, [], `${viewport.name}: visible text is below 8px`);
  assert.notEqual(layout.background, 'rgba(0, 0, 0, 0)', `${viewport.name}: transparent page background`);
  if (reducedMotion) assert.equal(layout.reducedMotion?.mediaMatches, true, `${viewport.name}: reduced-motion media emulation is unavailable`);
  process.stdout.write(`${viewport.name} ${JSON.stringify(layout)}\n`);
  return window;
}

app.whenReady().then(async () => {
  const windows = [];
  let exitCode = 0;
  try {
    await mkdir(outputDirectory, { recursive: true });
    for (const viewport of viewports) windows.push(await capture(viewport));
  } catch (error) {
    exitCode = 1;
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  } finally {
    for (const window of windows) {
      if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
      if (!window.isDestroyed()) window.destroy();
    }
    process.exitCode = exitCode;
    app.quit();
  }
});
