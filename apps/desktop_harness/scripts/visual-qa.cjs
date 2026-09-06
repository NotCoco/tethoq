'use strict';

const assert = require('node:assert/strict');
const { mkdir, readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow, nativeImage, protocol, session } = require('electron');

const appRoot = path.resolve(__dirname, '..');
const rendererPath = path.join(appRoot, 'out', 'renderer', 'index.html');
const outputArgument = process.argv.slice(2).find((argument) => !argument.startsWith('--'));
const outputDirectory = path.resolve(outputArgument ?? path.join(appRoot, 'qa-artifacts'));
const localModelImagePath = path.join(outputDirectory, 'local-model-image-fixture.png');
const capturedLayouts = new Map();
protocol.registerSchemesAsPrivileged([{ scheme: 'tethoq-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
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
  { name: 'dictation-recording-1100x760', width: 1100, height: 760, kind: 'dictation-recording', selector: '.dictation-audio-strip' },
  { name: 'dictation-recording-760x480', width: 760, height: 480, kind: 'dictation-recording', selector: '.dictation-audio-strip' },
  { name: 'composer-queue-strip-1100x760', width: 1100, height: 760, kind: 'queue-strip', selector: '.queued-message-menu .composer-popover' },
  { name: 'composer-queue-strip-760x480', width: 760, height: 480, kind: 'queue-strip', selector: '.queued-message-menu .composer-popover' },
  { name: 'queue-new-task-1100x760', width: 1100, height: 760, kind: 'queue-new-task', selector: '.queue-new-task-picker' },
  { name: 'composer-stream-follow-1100x760', width: 1100, height: 760, kind: 'composer-stream-follow', selector: '.conversation-tail-spacer' },
  { name: 'composer-stream-follow-760x480', width: 760, height: 480, kind: 'composer-stream-follow', selector: '.conversation-tail-spacer' },
  { name: 'side-chat-1100x760', width: 1100, height: 760, kind: 'side-chat', selector: '.side-chat-panel' },
  { name: 'side-chat-rail-1100x760', width: 1100, height: 760, kind: 'side-chat-rail', selector: '.session-row-group.has-side-chats' },
  { name: 'composer-handoff-980x680', width: 980, height: 680, kind: 'composer-handoff', selector: '.handoff-chat-picker' },
  { name: 'composer-delegation-980x680', width: 980, height: 680, kind: 'composer-delegation', selector: '.delegation-chat-picker' },
  { name: 'composer-vision-eyes-980x680', width: 980, height: 680, kind: 'composer-vision', selector: '.vision-eyes-picker' },
  { name: 'context-compaction-1100x760', width: 1100, height: 760, kind: 'context-compaction', selector: '.context-usage-popover' },
  { name: 'task-details-1100x760', width: 1100, height: 760, kind: 'task-details', selector: '.task-details-popover' },
  { name: 'project-heading-controls-1100x760', width: 1100, height: 760, kind: 'project-heading-controls', selector: '.session-project-heading' },
  { name: 'project-heading-controls-800x560', width: 800, height: 560, kind: 'project-heading-controls', selector: '.session-project-heading' },
  { name: 'subagents-hover-1100x760', width: 1100, height: 760, kind: 'subagents-hover', qaSubagentCount: 1, selector: '.app-tooltip-overlay' },
  { name: 'subagents-hover-1100x760-two-digit', width: 1100, height: 760, kind: 'subagents-hover', qaSubagentCount: 12, selector: '.app-tooltip-overlay' },
  { name: 'subagents-hover-1100x760-three-digit', width: 1100, height: 760, kind: 'subagents-hover', qaSubagentCount: 130, selector: '.app-tooltip-overlay' },
  { name: 'subagents-hover-800x560', width: 800, height: 560, kind: 'subagents-hover', qaSubagentCount: 1, selector: '.app-tooltip-overlay' },
  { name: 'subagents-hover-800x560-two-digit', width: 800, height: 560, kind: 'subagents-hover', qaSubagentCount: 12, selector: '.app-tooltip-overlay' },
  { name: 'subagents-hover-800x560-three-digit', width: 800, height: 560, kind: 'subagents-hover', qaSubagentCount: 130, selector: '.app-tooltip-overlay' },
  { name: 'subagents-hover-project-1100x760', width: 1100, height: 760, kind: 'subagents-hover-project', qaSubagentCount: 2, selector: '.app-tooltip-overlay' },
  { name: 'subagents-hover-project-1100x760-one-digit', width: 1100, height: 760, kind: 'subagents-hover-project', qaSubagentCount: 1, selector: '.app-tooltip-overlay' },
  { name: 'subagents-hover-project-1100x760-two-digit', width: 1100, height: 760, kind: 'subagents-hover-project', qaSubagentCount: 12, selector: '.app-tooltip-overlay' },
  { name: 'subagents-hover-project-1100x760-three-digit', width: 1100, height: 760, kind: 'subagents-hover-project', qaSubagentCount: 130, selector: '.app-tooltip-overlay' },
  { name: 'subagents-hover-project-1100x760-capped', width: 1100, height: 760, kind: 'subagents-hover-project', qaSubagentCount: 1_000, selector: '.app-tooltip-overlay' },
  { name: 'subagents-hover-project-800x560', width: 800, height: 560, kind: 'subagents-hover-project', qaSubagentCount: 2, selector: '.app-tooltip-overlay' },
  { name: 'subagents-hover-project-800x560-one-digit', width: 800, height: 560, kind: 'subagents-hover-project', qaSubagentCount: 1, selector: '.app-tooltip-overlay' },
  { name: 'subagents-hover-project-800x560-two-digit', width: 800, height: 560, kind: 'subagents-hover-project', qaSubagentCount: 12, selector: '.app-tooltip-overlay' },
  { name: 'subagents-hover-project-800x560-three-digit', width: 800, height: 560, kind: 'subagents-hover-project', qaSubagentCount: 130, selector: '.app-tooltip-overlay' },
  { name: 'subagents-hover-project-800x560-capped', width: 800, height: 560, kind: 'subagents-hover-project', qaSubagentCount: 1_000, selector: '.app-tooltip-overlay' },
  { name: 'subagents-1100x760', width: 1100, height: 760, kind: 'subagents', selector: '.session-subagents-popover' },
  { name: 'subagents-800x560', width: 800, height: 560, kind: 'subagents', selector: '.session-subagents-popover' },
  { name: 'local-open-menu-1100x760', width: 1100, height: 760, kind: 'local-open', selector: '.workspace-local-open-menu' },
  { name: 'slash-command-palette-1100x760', width: 1100, height: 760, kind: 'slash-command', selector: '.slash-command-palette' },
  { name: 'mesh-quick-chooser-1100x760', width: 1100, height: 760, kind: 'mesh-quick', selector: '.mesh-panel' },
  { name: 'mesh-quick-chooser-760x480', width: 760, height: 480, kind: 'mesh-quick', selector: '.mesh-panel' },
  { name: 'mesh-model-reasoning-1100x760', width: 1100, height: 760, kind: 'mesh-details', selector: '.mesh-model-picker' },
  { name: 'mesh-model-reasoning-760x480', width: 760, height: 480, kind: 'mesh-details', selector: '.mesh-model-picker' },
  { name: 'mesh-widget-outlines-codex-parent-1100x760', width: 1100, height: 760, kind: 'mesh-widgets', meshSessionId: 'desktop-harness', meshProviders: ['OpenCode', 'Grok Build'], selector: '.composer-inline-mesh' },
  { name: 'mesh-repeated-grok-1100x760', width: 1100, height: 760, kind: 'mesh-widgets', meshSessionId: 'checkout', meshProviders: ['Grok Build', 'Grok Build'], selector: '.composer-inline-mesh' },
  { name: 'mesh-widget-multiline-760x480', width: 760, height: 480, kind: 'mesh-widgets', meshSessionId: 'desktop-harness', meshProviders: ['OpenCode'], selector: '.composer-input-flow' },
  { name: 'mesh-codex-badge-760x480', width: 760, height: 480, kind: 'mesh-widgets', meshSessionId: 'checkout', meshProviders: ['Codex'], selector: '.composer-input-flow' },
  { name: 'simplify-settings-1100x760', width: 1100, height: 760, kind: 'simplify-settings', selector: '.simplify-settings' },
  { name: 'trace-collapsed-sidebar-1100x760', width: 1100, height: 760, kind: 'trace-collapsed', selector: '.reasoning-disclosure[aria-expanded="false"]' },
  { name: 'task-rail-recency-1100x760', width: 1100, height: 760, kind: 'task-rail', selector: '.session-list-scroll' },
  { name: 'task-rail-recency-800x560', width: 800, height: 560, kind: 'task-rail', selector: '.session-list-scroll' },
  { name: 'sidebar-resized-1100x760', width: 1100, height: 760, kind: 'sidebar-resized', selector: '.navigation-resize-handle' },
  { name: 'trace-compacting-1100x760', width: 1100, height: 760, kind: 'trace-compacting', selector: '.timeline-compaction-active' },
  { name: 'trace-compacted-1100x760', width: 1100, height: 760, kind: 'trace-compacted', selector: '.timeline-compaction-toggle[aria-expanded="false"]' },
  { name: 'trace-compacted-expanded-1100x760', width: 1100, height: 760, kind: 'trace-compacted-expanded', selector: '.timeline-compaction-toggle' },
  { name: 'trace-expanded-1100x760', width: 1100, height: 760, kind: 'trace-expanded', selector: '.reasoning-segments' },
  { name: 'trace-activity-row-1100x760', width: 1100, height: 760, kind: 'trace-activity-row', selector: '.activity-row:has(.activity-target)' },
  { name: 'trace-thinking-expanded-1100x760', width: 1100, height: 760, kind: 'trace-thinking-expanded', selector: '.reasoning-thinking-segment .reasoning-flow' },
  { name: 'trace-thinking-expanded-760x480', width: 760, height: 480, kind: 'trace-thinking-expanded', selector: '.reasoning-thinking-segment .reasoning-flow' },
  { name: 'trace-snippet-1100x760', width: 1100, height: 760, kind: 'trace-snippet', selector: '.activity-snippet' },
  { name: 'final-message-meta-1100x760', width: 1100, height: 760, kind: 'final-message-meta', selector: '.message-footer' },
  { name: 'user-message-meta-1100x760', width: 1100, height: 760, kind: 'user-message-meta', selector: '.message-user .message-footer' },
  { name: 'thinking-message-meta-1100x760', width: 1100, height: 760, kind: 'thinking-message-meta', selector: '.reasoning-thinking-segment .timeline-item-meta' },
  { name: 'message-error-1100x760', width: 1100, height: 760, kind: 'message-error', selector: '.timeline-error-notice' },
  { name: 'user-attachment-1100x760', width: 1100, height: 760, kind: 'user-attachment', selector: '.message-user .message-images-before' },
  { name: 'user-image-only-1100x760', width: 1100, height: 760, kind: 'user-image-only', selector: '.message-user .message-images-only' },
  { name: 'user-image-only-760x480', width: 760, height: 480, kind: 'user-image-only', selector: '.message-user .message-images-only' },
  { name: 'model-local-image-1100x760', width: 1100, height: 760, kind: 'local-model-image', selector: '.message-assistant .rich-text-image img' },
  { name: 'dictation-audio-source-980x680', width: 980, height: 680, kind: 'dictation-audio-source', selector: '.dictation-source-menu .composer-popover' },
  { name: 'dictation-saved-key-980x680', width: 980, height: 680, kind: 'dictation-saved-key', selector: '.dictation-manage-source' },
  { name: 'audio-message-1100x760', width: 1100, height: 760, kind: 'audio-message', selector: '.message-audio-before' },
  { name: 'workflow-message-1100x760', width: 1100, height: 760, kind: 'workflow-message', selector: '.message-workflow-panel' },
  { name: 'wallet-tooltip-1100x760', width: 1100, height: 760, kind: 'wallet-tooltip', selector: '.wallet-trigger' },
  { name: 'wallet-dropdown-1100x760', width: 1100, height: 760, kind: 'wallet', selector: '.wallet-popover' },
  { name: 'wallet-direct-advanced-1100x760', width: 1100, height: 760, kind: 'wallet-direct-advanced', selector: '.wallet-advanced' },
  { name: 'dashboard-1440x900', width: 1440, height: 900, kind: 'dashboard', selector: '.dashboard-page' },
  { name: 'dashboard-1100x760', width: 1100, height: 760, kind: 'dashboard', selector: '.dashboard-page' },
  { name: 'dashboard-800x560', width: 800, height: 560, kind: 'dashboard', selector: '.dashboard-page' },
  { name: 'settings-defaults-1440x900', width: 1440, height: 900, kind: 'settings-defaults', selector: '.agent-defaults' },
  { name: 'settings-defaults-900x700', width: 900, height: 700, kind: 'settings-defaults', selector: '.agent-defaults' },
  { name: 'settings-defaults-760x600', width: 760, height: 600, kind: 'settings-defaults', selector: '.agent-defaults' },
  { name: 'settings-global-agents-1440x900', width: 1440, height: 900, kind: 'settings-global-agents', selector: '.global-agents-settings' },
  { name: 'settings-agents-1440x900', width: 1440, height: 900, kind: 'settings-agents', selector: '.provider-settings' },
  { name: 'settings-dictation-1100x760', width: 1100, height: 760, kind: 'settings-dictation', selector: '.dictation-settings-editor' },
  { name: 'settings-runtime-1440x900', width: 1440, height: 900, kind: 'settings-runtime', selector: '.settings-compact-grid' },
  { name: 'settings-connectors-1440x900', width: 1440, height: 900, kind: 'settings', selector: '.connector-card[data-connector-id="tethoq-example"]' },
  { name: 'settings-connectors-900x700', width: 900, height: 700, kind: 'settings', selector: '.connector-card[data-connector-id="tethoq-example"]' },
  { name: 'settings-connectors-760x600', width: 760, height: 600, kind: 'settings', selector: '.connector-card[data-connector-id="tethoq-example"]' },
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
} else if (process.argv.includes('--project-heading-controls-only')) {
  const projectHeadingViewports = viewports.filter((viewport) => viewport.kind === 'project-heading-controls');
  viewports.splice(0, viewports.length, ...projectHeadingViewports);
} else if (process.argv.includes('--subagent-popover-only')) {
  const subagentPopoverViewports = viewports.filter((viewport) => viewport.kind === 'subagents');
  viewports.splice(0, viewports.length, ...subagentPopoverViewports);
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
} else if (process.argv.includes('--trace-activity-only')) {
  const traceActivityViewport = viewports.find((viewport) => viewport.kind === 'trace-activity-row');
  viewports.splice(0, viewports.length, traceActivityViewport);
} else if (process.argv.includes('--sidebar-only')) {
  const sidebarViewport = viewports.find((viewport) => viewport.kind === 'trace-collapsed');
  viewports.splice(0, viewports.length, sidebarViewport);
} else if (process.argv.includes('--task-rail-only')) {
  const taskRailViewports = viewports.filter((viewport) => viewport.kind === 'task-rail');
  viewports.splice(0, viewports.length, ...taskRailViewports);
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
} else if (process.argv.includes('--side-chat-rail-only')) {
  const sideChatRailViewport = viewports.find((viewport) => viewport.kind === 'side-chat-rail');
  viewports.splice(0, viewports.length, sideChatRailViewport);
} else if (process.argv.includes('--local-open-only')) {
  const localOpenViewport = viewports.find((viewport) => viewport.kind === 'local-open');
  viewports.splice(0, viewports.length, localOpenViewport);
} else if (process.argv.includes('--slash-command-only')) {
  const slashCommandViewport = viewports.find((viewport) => viewport.kind === 'slash-command');
  viewports.splice(0, viewports.length, slashCommandViewport);
} else if (process.argv.includes('--mesh-only')) {
  const meshViewports = viewports.filter((viewport) => viewport.kind === 'mesh-quick' || viewport.kind === 'mesh-details' || viewport.kind === 'mesh-widgets');
  viewports.splice(0, viewports.length, ...meshViewports);
} else if (process.argv.includes('--mesh-widgets-only')) {
  const meshWidgetViewports = viewports.filter((viewport) => viewport.kind === 'mesh-widgets');
  viewports.splice(0, viewports.length, ...meshWidgetViewports);
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
  const settingsViewports = viewports.filter((viewport) => viewport.kind === 'settings-defaults' || viewport.kind === 'settings-agents' || viewport.kind === 'settings-runtime' || viewport.kind === 'settings');
  viewports.splice(0, viewports.length, ...settingsViewports);
} else if (process.argv.includes('--workflows-only')) {
  const workflowsViewports = viewports.filter((viewport) => viewport.kind === 'workflows' || viewport.kind === 'workflow-screenshot-preview');
  viewports.splice(0, viewports.length, ...workflowsViewports);
} else if (process.argv.includes('--workflow-message-only')) {
  const workflowMessageViewport = viewports.find((viewport) => viewport.kind === 'workflow-message');
  viewports.splice(0, viewports.length, workflowMessageViewport);
} else if (process.argv.includes('--composer-delegation-only')) {
  const delegationViewport = viewports.find((viewport) => viewport.kind === 'composer-delegation');
  viewports.splice(0, viewports.length, delegationViewport);
} else if (process.argv.includes('--composer-actions-only')) {
  const composerActionsViewport = viewports.find((viewport) => viewport.kind === 'composer-actions');
  viewports.splice(0, viewports.length, composerActionsViewport);
} else if (process.argv.includes('--composer-model-only')) {
  const modelViewport = viewports.find((viewport) => viewport.kind === 'composer-model');
  viewports.splice(0, viewports.length, modelViewport);
} else if (process.argv.includes('--dictation-recording-only')) {
  const recordingViewports = viewports.filter((viewport) => viewport.kind === 'dictation-recording');
  viewports.splice(0, viewports.length, ...recordingViewports);
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
} else if (process.argv.includes('--user-image-only-only')) {
  const imageOnlyViewports = viewports.filter((viewport) => viewport.kind === 'user-image-only');
  viewports.splice(0, viewports.length, ...imageOnlyViewports);
} else if (process.argv.includes('--local-model-image-only')) {
  const localModelImageViewport = viewports.find((viewport) => viewport.kind === 'local-model-image');
  viewports.splice(0, viewports.length, localModelImageViewport);
} else if (process.argv.includes('--dictation-audio-only')) {
  const audioViewports = viewports.filter((viewport) => viewport.kind === 'dictation-audio-source' || viewport.kind === 'audio-message');
  viewports.splice(0, viewports.length, ...audioViewports);
} else if (process.argv.includes('--dictation-saved-key-only')) {
  const savedKeyViewport = viewports.find((viewport) => viewport.kind === 'dictation-saved-key');
  viewports.splice(0, viewports.length, savedKeyViewport);
} else if (process.argv.includes('--wallet-tooltip-only')) {
  const walletTooltipViewport = viewports.find((viewport) => viewport.kind === 'wallet-tooltip');
  viewports.splice(0, viewports.length, walletTooltipViewport);
} else if (process.argv.includes('--browser-only')) {
  const browserViewport = viewports.find((viewport) => viewport.kind === 'browser');
  viewports.splice(0, viewports.length, browserViewport);
} else if (process.argv.includes('--dashboard-only')) {
  const dashboardViewports = viewports.filter((viewport) => viewport.kind === 'dashboard');
  viewports.splice(0, viewports.length, ...dashboardViewports);
} else if (process.argv.includes('--compact-workspace-only')) {
  const compactViewports = viewports.filter((viewport) => viewport.name === 'compact-1100x760' || viewport.name === 'minimum-supported-760x480');
  viewports.splice(0, viewports.length, ...compactViewports);
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
  let subagentDividerOverlap = null;
  window.webContents.on('console-message', (event) => {
    diagnostics.push(`console[${event.level ?? 'unknown'}] ${event.message ?? ''} (${event.sourceId ?? ''}:${event.lineNumber ?? 0})`);
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    diagnostics.push(`render-process-gone ${JSON.stringify(details)}`);
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const query = {
    ...(viewport.kind === 'local-model-image' ? { localImage: localModelImagePath } : {}),
    ...(Number.isSafeInteger(viewport.qaSubagentCount) ? { qaSubagentCount: String(viewport.qaSubagentCount) } : {}),
  };
  await window.loadFile(rendererPath, {
    hash: viewport.kind,
    ...(Object.keys(query).length ? { query } : {}),
  });
  await waitForRenderer(window, diagnostics);
  if (viewport.kind === 'browser') {
    await window.webContents.executeJavaScript(`localStorage.removeItem('tethoq.browser-privacy-notice-dismissed.v1')`, true);
  }
  if (viewport.kind !== 'dashboard' && viewport.kind !== 'new-task-draft') {
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        const row = document.querySelector(${JSON.stringify(`[data-session-id="${viewport.meshSessionId ?? 'desktop-harness'}"] > .session-row`)});
        if (row) {
          row.click();
          const waitForWorkspace = () => {
            if (document.querySelector('.workspace')) return requestAnimationFrame(() => requestAnimationFrame(resolve));
            if (Date.now() - started > 5000) return reject(new Error('Fixture task did not open Workspace'));
            requestAnimationFrame(waitForWorkspace);
          };
          return requestAnimationFrame(waitForWorkspace);
        }
        if (Date.now() - started > 5000) return reject(new Error('Fixture task list did not hydrate'));
        requestAnimationFrame(check);
      };
      check();
    })`, true);
  }
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
  } else if (viewport.kind === 'user-image-only') {
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        const gallery = document.querySelector('.message-images-only[data-image-layout="1"]');
        const thumbnail = gallery?.querySelector('button');
        if (gallery && thumbnail) {
          gallery.scrollIntoView({ block: 'center' });
          thumbnail.click();
          return requestAnimationFrame(() => requestAnimationFrame(() => {
            window.__tethoqImageOnlyLightboxOpened = Boolean(document.querySelector('.image-lightbox'));
            document.querySelector('.image-lightbox > button')?.click();
            document.querySelector('.message-images-only[data-image-layout="many"]')?.scrollIntoView({ block: 'center' });
            requestAnimationFrame(resolve);
          }));
        }
        if (Date.now() - started > 5000) return reject(new Error('Image-only gallery did not render'));
        requestAnimationFrame(check);
      };
      check();
    })`, true);
  } else if (viewport.kind === 'local-model-image') {
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        const thumbnail = document.querySelector('.message-assistant .rich-text-image');
        const image = thumbnail?.querySelector('img');
        if (thumbnail instanceof HTMLButtonElement && image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0) {
          thumbnail.scrollIntoView({ block: 'center' });
          thumbnail.click();
          return requestAnimationFrame(() => requestAnimationFrame(() => {
            window.__tethoqLocalModelImage = {
              lightboxOpened: Boolean(document.querySelector('.image-lightbox img')),
              source: image.getAttribute('src') ?? '',
              naturalWidth: image.naturalWidth,
              naturalHeight: image.naturalHeight,
            };
            document.querySelector('.image-lightbox > button')?.click();
            thumbnail.scrollIntoView({ block: 'center' });
            requestAnimationFrame(resolve);
          }));
        }
        if (Date.now() - started > 5000) return reject(new Error('Local model image did not render as a loaded widget'));
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
  } else if (viewport.kind === 'side-chat-rail') {
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const frame = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      const waitFor = async (predicate, message) => {
        const started = Date.now();
        while (!predicate()) {
          if (Date.now() - started > 5000) throw new Error(message);
          await frame();
        }
      };
      const openNewSideChat = async () => {
        const trigger = document.querySelector('button[aria-label="More message actions"]');
        if (!(trigger instanceof HTMLButtonElement)) throw new Error('Message actions trigger is missing');
        trigger.click();
        await waitFor(() => Boolean(document.querySelector('.composer-actions-menu [role="menuitem"]')), 'Message actions did not open');
        const action = [...document.querySelectorAll('.composer-actions-menu [role="menuitem"]')].find((button) => button.textContent?.includes('Open side chat'));
        if (!(action instanceof HTMLButtonElement)) throw new Error('Open side chat action is missing');
        action.click();
        await waitFor(() => Boolean(document.querySelector('.side-chat-panel')), 'Side chat did not open');
        document.querySelector('button[aria-label="Close side chat"]')?.click();
        await waitFor(() => !document.querySelector('.side-chat-panel'), 'Side chat did not close');
        await new Promise((done) => setTimeout(done, 4));
      };
      (async () => {
        await openNewSideChat();
        await openNewSideChat();
        const filter = document.querySelector('button.sidebar-task-filter');
        if (!(filter instanceof HTMLButtonElement)) throw new Error('Task filter trigger is missing');
        filter.click();
        await waitFor(() => Boolean(document.querySelector('[role="dialog"][aria-label="Task filters"]')), 'Task filters did not open');
        const show = [...document.querySelectorAll('[role="dialog"][aria-label="Task filters"] [role="checkbox"]')].find((button) => button.textContent?.includes('Show side chats'));
        if (!(show instanceof HTMLButtonElement)) throw new Error('Show side chats control is missing');
        if (show.getAttribute('aria-checked') !== 'true') show.click();
        await waitFor(() => document.querySelectorAll('.session-side-chats > button').length >= 2, 'Two side-chat children did not render');
        filter.click();
        await waitFor(() => !document.querySelector('[role="dialog"][aria-label="Task filters"]'), 'Task filters did not close');
        const projectMode = document.querySelector('button[aria-label="Arrange tasks by project"]');
        if (projectMode instanceof HTMLButtonElement) projectMode.click();
        await waitFor(() => document.querySelectorAll('.session-side-chats > button').length >= 2, 'Side-chat children did not survive project mode');
        const projectShell = document.querySelector('.session-row-shell:has(.session-subagents.compact):has(.session-project-working-indicator)');
        if (!(projectShell instanceof HTMLElement)) throw new Error('Working project task with sub-agents is missing');
        const projectTrigger = projectShell.querySelector('.session-subagents-trigger');
        const projectSummary = projectTrigger?.querySelector('.session-subagents-summary');
        const projectIcon = projectTrigger?.querySelector('.session-subagents-icon');
        const projectCount = projectTrigger?.querySelector('.session-subagents-count');
        const projectRow = projectShell.querySelector('.session-row.compact');
        const projectTitleLive = projectRow?.querySelector('.session-project-row-title');
        const projectSpinnerLive = projectRow?.querySelector('.session-project-working-indicator');
        const projectScroller = projectShell.closest('.session-list-scroll');
        if (!(projectTrigger instanceof HTMLElement) || !(projectSummary instanceof HTMLElement) || !(projectIcon instanceof SVGElement) || !(projectCount instanceof HTMLElement)
          || !(projectRow instanceof HTMLElement) || !(projectTitleLive instanceof HTMLElement)
          || !(projectSpinnerLive instanceof HTMLElement) || !(projectScroller instanceof HTMLElement)) throw new Error('Project sub-agent geometry fixture is incomplete');
        const plainBounds = (element) => {
          const bounds = element.getBoundingClientRect();
          return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, width: bounds.width, height: bounds.height, centerX: bounds.left + bounds.width / 2, centerY: bounds.top + bounds.height / 2 };
        };
        const countGlyphBounds = () => {
          const range = document.createRange();
          range.selectNodeContents(projectCount);
          const bounds = range.getBoundingClientRect();
          return { left: bounds.left, right: bounds.right, width: bounds.width, centerY: bounds.top + bounds.height / 2 };
        };
        const projectControlReading = () => ({
          count: projectCount.textContent?.trim() ?? '',
          trigger: plainBounds(projectTrigger),
          summary: plainBounds(projectSummary),
          icon: plainBounds(projectIcon),
          countGlyph: countGlyphBounds(),
          chevrons: projectTrigger.querySelectorAll('.session-subagents-chevron').length,
        });
        const projectControl = projectControlReading();
        window.__tethoqProjectSubagentGeometry = {
          clip: plainBounds(projectScroller),
          row: plainBounds(projectRow),
          title: plainBounds(projectTitleLive),
          spinner: plainBounds(projectSpinnerLive),
          current: projectControl,
        };
        const projectClone = projectShell.cloneNode(true);
        if (!(projectClone instanceof HTMLElement)) throw new Error('Project title fixture could not be cloned');
        projectClone.style.cssText = 'position:fixed;left:-10000px;top:0;width:' + projectShell.getBoundingClientRect().width + 'px;margin:0;visibility:hidden;';
        document.body.append(projectClone);
        const projectTitle = projectClone.querySelector('.session-project-row-title');
        const projectSpinner = projectClone.querySelector('.session-project-working-indicator');
        if (!(projectTitle instanceof HTMLElement) || !(projectSpinner instanceof HTMLElement)) throw new Error('Project title fixture is incomplete');
        const workingTitleWidth = projectTitle.getBoundingClientRect().width;
        projectSpinner.remove();
        const idleTitleWidth = projectTitle.getBoundingClientRect().width;
        window.__tethoqProjectTitleLane = { workingTitleWidth, idleTitleWidth, releasedWidth: idleTitleWidth - workingTitleWidth };
        projectClone.remove();
        document.querySelector('.session-side-chats > button')?.click();
        await waitFor(() => Boolean(document.querySelector('.session-side-chats > button.active')), 'Active side-chat child did not render');
        const disclosure = document.querySelector('.session-side-chat-toggle');
        if (!(disclosure instanceof HTMLButtonElement)) throw new Error('Side-chat collapse control is missing');
        const regionId = disclosure.getAttribute('aria-controls') || '';
        const region = document.getElementById(regionId);
        if (!(region instanceof HTMLElement)) throw new Error('Side-chat collapse control does not own a region');
        disclosure.focus();
        await frame();
        const focused = document.activeElement === disclosure;
        disclosure.click();
        await waitFor(() => disclosure.getAttribute('aria-expanded') === 'false' && region.hidden, 'Side-chat rows did not collapse');
        const collapsedRail = disclosure.closest('.session-side-chat-rail');
        const collapsedBounds = collapsedRail?.getBoundingClientRect();
        window.__tethoqSideChatRailDisclosure = {
          focused,
          collapsed: Boolean(collapsedRail?.classList.contains('collapsed')),
          collapsedHeight: collapsedBounds?.height ?? 0,
          regionHidden: region.hidden,
          activePanelSurvived: Boolean(document.querySelector('.side-chat-panel')),
        };
        disclosure.click();
        await waitFor(() => disclosure.getAttribute('aria-expanded') === 'true' && !region.hidden, 'Side-chat rows did not reopen');
        await waitFor(() => Boolean(document.querySelector('.session-side-chats > button.active')), 'Reopening the rail lost its active child');
        disclosure.blur();
        await frame();
        resolve();
      })().catch(reject);
    })`, true);
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const disclosure = document.querySelector('.session-side-chat-toggle');
      if (!(disclosure instanceof HTMLButtonElement)) return reject(new Error('Side-chat collapse control disappeared before capture'));
      disclosure.click();
      requestAnimationFrame(() => requestAnimationFrame(() => disclosure.getAttribute('aria-expanded') === 'false' ? resolve() : reject(new Error('Side-chat rail did not collapse for capture'))));
    })`, true);
    const collapsedImage = await window.webContents.capturePage();
    await writeFile(path.join(outputDirectory, `${viewport.name}-collapsed.png`), collapsedImage.toPNG());
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const disclosure = document.querySelector('.session-side-chat-toggle');
      if (!(disclosure instanceof HTMLButtonElement)) return reject(new Error('Collapsed side-chat control disappeared'));
      disclosure.click();
      requestAnimationFrame(() => requestAnimationFrame(() => disclosure.getAttribute('aria-expanded') === 'true' ? resolve() : reject(new Error('Side-chat rail did not reopen after capture'))));
    })`, true);
  } else if (viewport.kind === 'dictation-audio-source' || viewport.kind === 'dictation-saved-key' || viewport.kind === 'audio-message' || viewport.kind === 'dictation-recording') {
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
    if (viewport.kind === 'dictation-audio-source' || viewport.kind === 'dictation-saved-key') {
      await window.webContents.executeJavaScript(`document.querySelector('.dictation-source-menu > button')?.click()`, true);
    }
    if (viewport.kind === 'dictation-saved-key') {
      await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const started = Date.now();
        const choose = () => {
          const row = [...document.querySelectorAll('.dictation-sources-scroll > button')].find((button) => button.textContent?.includes('OpenAI speech-to-text') && button.textContent?.includes('API key saved'));
          if (row) {
            row.click();
            return requestAnimationFrame(() => requestAnimationFrame(() => {
              document.querySelector('.dictation-source-menu > button')?.click();
              requestAnimationFrame(() => requestAnimationFrame(resolve));
            }));
          }
          if (Date.now() - started > 5000) return reject(new Error('Saved OpenAI dictation source did not render'));
          requestAnimationFrame(choose);
        };
        choose();
      })`, true);
    }
    if (viewport.kind === 'dictation-recording') {
      await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        (async () => {
          const frame = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
          const waitFor = (predicate, message) => new Promise((done, fail) => {
            const started = Date.now();
            const check = () => {
              const result = predicate();
              if (result) return done(result);
              if (Date.now() - started > 5000) return fail(new Error(message));
              requestAnimationFrame(check);
            };
            check();
          });

          document.querySelector('.dictation-source-menu > button')?.click();
          const source = await waitFor(
            () => [...document.querySelectorAll('.dictation-sources-scroll > button')].find((button) => button.textContent?.includes('OpenAI speech-to-text') && button.textContent?.includes('API key saved')),
            'Recording fixture could not select its ready transcription source',
          );
          source.click();
          await frame();

          document.querySelector('button[aria-label="Add attachment"]')?.click();
          const attach = await waitFor(
            () => [...document.querySelectorAll('.composer-attachment-menu [role="menuitem"]')].find((button) => button.textContent?.includes('Attach image')),
            'Recording fixture attachment action did not render',
          );
          attach.click();
          await waitFor(() => document.querySelectorAll('.attachment-chips > span').length === 4, 'Recording fixture did not render four attachments');

          const textarea = document.querySelector('#composer-message');
          if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('Recording fixture textarea is missing');
          const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
          if (!setValue) throw new Error('Recording fixture cannot set textarea value');
          setValue.call(textarea, Array.from({ length: 24 }, (_, index) => 'Dense recording line ' + String(index + 1).padStart(2, '0') + ' keeps the draft, attachments, and actions inside the composer.').join('\\n'));
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          await frame();

          const fakeTrack = { stop() {} };
          const fakeStream = { getTracks: () => [fakeTrack] };
          const mediaDevices = navigator.mediaDevices ?? {};
          Object.defineProperty(mediaDevices, 'getUserMedia', { configurable: true, value: async () => fakeStream });
          if (!navigator.mediaDevices) Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: mediaDevices });
          class FakeMediaRecorder {
            static isTypeSupported() { return true; }
            constructor(stream, options = {}) { this.stream = stream; this.mimeType = options.mimeType || 'audio/webm'; this.state = 'inactive'; this.ondataavailable = null; this.onerror = null; this.onstop = null; }
            start() { this.state = 'recording'; }
            stop() { this.state = 'inactive'; this.onstop?.(); }
          }
          Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: FakeMediaRecorder });

          const dictate = document.querySelector('.workspace .dictation-main');
          if (!(dictate instanceof HTMLButtonElement)) throw new Error('Recording fixture dictate control is missing');
          dictate.click();
          await waitFor(() => document.querySelector('.dictation-audio-strip') && document.querySelector('.dictation-main[aria-label="Stop dictation"]'), 'Recording fixture did not enter the live state');
          await frame();
          resolve();
        })().catch(reject);
      })`, true);
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
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        if (document.querySelector('.desktop-app')?.getAttribute('data-runtime-state') === 'ready') return requestAnimationFrame(() => requestAnimationFrame(resolve));
        if (Date.now() - started > 5000) return reject(new Error('Dashboard fixture did not finish hydrating'));
        requestAnimationFrame(check);
      };
      check();
    })`, true);
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
        const setup = document.querySelector('.agent-default-setup-action');
        setup?.click();
        await waitFor(() => Boolean(document.querySelector('.wallet-direct-settings')));
        const wallet = document.querySelector('.wallet-popover');
        window.__tethoqDirectSetupCheck = {
          opened: Boolean(wallet),
          directForm: Boolean(document.querySelector('.wallet-direct-settings')),
          text: wallet?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        };
        document.querySelector('.wallet-trigger')?.click();
        await waitFor(() => !document.querySelector('.wallet-popover'));
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
      const expandedMeter = document.querySelector('.context-expanded-track');
      const applied = [...document.querySelectorAll('.context-usage-stats > div')].find((row) => row.querySelector('dt')?.textContent?.trim() === 'Compacts at');
      return {
        sliderValue: input ? Number(input.value) : null,
        thresholdText: document.querySelector('.context-usage-heading b')?.textContent?.trim() ?? null,
        percentText: document.querySelector('.context-usage-percent')?.textContent?.trim() ?? null,
        ariaNow: meter?.getAttribute('aria-valuenow') ?? null,
        meterLabel: meter?.getAttribute('aria-label') ?? null,
        expandedAriaNow: expandedMeter?.getAttribute('aria-valuenow') ?? null,
        expandedFill: expandedMeter?.querySelector('i')?.style.width ?? null,
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
  } else if (viewport.kind === 'project-heading-controls') {
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const started = Date.now();
      document.querySelector('button[aria-label="Arrange tasks by project"]')?.click();
      const check = () => {
        if (document.querySelector('.session-project-heading .session-project-new-task')) return requestAnimationFrame(() => requestAnimationFrame(resolve));
        if (Date.now() - started > 5000) return reject(new Error('Project heading controls did not render'));
        requestAnimationFrame(check);
      };
      check();
    })`, true);
    await window.webContents.executeJavaScript(`(() => {
      const disclosure = document.querySelector('.session-project-header > svg:last-child');
      window.__tethoqProjectDisclosureIdleOpacity = disclosure ? getComputedStyle(disclosure).opacity : null;
    })()`, true);
    const point = await window.webContents.executeJavaScript(`(() => { const rect = document.querySelector('.session-project-new-task')?.getBoundingClientRect(); return rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } : null; })()`, true);
    if (!point) throw new Error('Project heading plus target is missing');
    window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
    await new Promise((resolve) => setTimeout(resolve, 80));
    window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x - 40, y: point.y });
    window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
    await new Promise((resolve) => setTimeout(resolve, 180));
  } else if (viewport.kind === 'subagents-hover' || viewport.kind === 'subagents-hover-project') {
    const subagentTriggerSelector = viewport.kind === 'subagents-hover-project'
      ? '.session-subagents.compact .session-subagents-trigger'
      : '.session-subagents-trigger';
    if (viewport.kind === 'subagents-hover-project') {
      await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const started = Date.now();
        document.querySelector('button[aria-label="Arrange tasks by project"]')?.click();
        const check = () => {
          if (document.querySelector(${JSON.stringify(subagentTriggerSelector)})) return requestAnimationFrame(() => requestAnimationFrame(() => {
            const rows = [...document.querySelectorAll('.session-project-items .session-row.compact')];
            const shells = [...document.querySelectorAll('.session-project-items .session-row-shell')];
            const groups = [...document.querySelectorAll('.session-project-items > .session-row-group')];
            const groupBounds = groups.map((group) => group.getBoundingClientRect());
            const allShellBounds = shells.map((shell) => shell.getBoundingClientRect());
            const interGroupGaps = [...document.querySelectorAll('.session-project-items')].flatMap((items) => {
              const siblings = [...items.querySelectorAll(':scope > .session-row-group')].map((group) => group.getBoundingClientRect());
              return siblings.slice(1).map((bounds, index) => bounds.top - siblings[index].bottom);
            });
            const titleTextLefts = shells.map((shell) => {
              const title = shell.querySelector('.session-project-row-title strong');
              if (!title) return null;
              const range = document.createRange();
              range.selectNodeContents(title);
              return range.getBoundingClientRect().left;
            }).filter((left) => Number.isFinite(left));
            const ordinaryTitle = document.querySelector('.session-project-items .session-row-shell:not(:has(.session-subagents.compact)) .session-project-row-title strong');
            const ordinaryItems = ordinaryTitle?.closest('.session-project-items');
            const ordinaryRange = document.createRange();
            if (ordinaryTitle) ordinaryRange.selectNodeContents(ordinaryTitle);
            const ordinaryTextBounds = ordinaryTitle ? ordinaryRange.getBoundingClientRect() : null;
            const ordinaryShell = ordinaryTitle?.closest('.session-row-shell');
            const ordinaryRow = ordinaryShell?.querySelector('.session-row.compact');
            const ordinaryShellBeforeBounds = ordinaryShell?.getBoundingClientRect();
            const ordinaryRowBeforeBounds = ordinaryRow?.getBoundingClientRect();
            const ordinaryLeftGutterHit = ordinaryShellBeforeBounds && ordinaryRow
              ? document.elementFromPoint(ordinaryShellBeforeBounds.left + 8, ordinaryShellBeforeBounds.top + ordinaryShellBeforeBounds.height / 2)?.closest('.session-row.compact') === ordinaryRow
              : false;
            const ordinaryWasSelected = ordinaryRow?.classList.contains('selected') ?? false;
            ordinaryRow?.classList.add('selected');
            const ordinarySelectedShellBounds = ordinaryShell?.getBoundingClientRect();
            const ordinarySelectedRowBounds = ordinaryRow?.getBoundingClientRect();
            const ordinarySelectedShellBackground = ordinaryShell ? getComputedStyle(ordinaryShell).backgroundColor : null;
            const ordinarySelectedRowBackground = ordinaryRow ? getComputedStyle(ordinaryRow).backgroundColor : null;
            ordinaryRow?.classList.toggle('selected', ordinaryWasSelected);
            const probe = document.createElement('button');
            probe.type = 'button';
            probe.className = 'session-project-show-more';
            probe.textContent = 'Show more';
            ordinaryItems?.append(probe);
            const probeRange = document.createRange();
            probeRange.selectNodeContents(probe);
            const probeTextBounds = probe.getBoundingClientRect().width > 0 ? probeRange.getBoundingClientRect() : null;
            const selectedShell = document.querySelector('.session-row-shell:has(.session-subagents.compact):has(.session-row.compact.selected)');
            const selectedRow = selectedShell?.querySelector('.session-row.compact.selected');
            const selectedShellBounds = selectedShell?.getBoundingClientRect();
            const selectedRowBounds = selectedRow?.getBoundingClientRect();
            const spinnerBounds = selectedShell?.querySelector('.session-project-working-indicator')?.getBoundingClientRect();
            window.__tethoqProjectListGeometry = {
              rowHeights: rows.map((row) => row.getBoundingClientRect().height),
              shellHeights: shells.map((shell) => shell.getBoundingClientRect().height),
              groupLayouts: groups.map((group, index) => ({
                display: getComputedStyle(group).display,
                left: groupBounds[index].left,
                right: groupBounds[index].right,
                top: groupBounds[index].top,
                bottom: groupBounds[index].bottom,
                width: groupBounds[index].width,
                height: groupBounds[index].height,
              })),
              interGroupGaps,
              shellLayouts: allShellBounds.map((bounds) => ({ left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, width: bounds.width, height: bounds.height })),
              titleTextLefts,
              ordinaryTitleLeft: ordinaryTextBounds?.left ?? null,
              showMoreTextLeft: probeTextBounds?.left ?? null,
              ordinaryLeftGutterHit,
              ordinaryShellBeforeSelection: ordinaryShellBeforeBounds ? {
                left: ordinaryShellBeforeBounds.left,
                right: ordinaryShellBeforeBounds.right,
                width: ordinaryShellBeforeBounds.width,
                height: ordinaryShellBeforeBounds.height,
              } : null,
              ordinarySelectedShell: ordinarySelectedShellBounds ? {
                left: ordinarySelectedShellBounds.left,
                right: ordinarySelectedShellBounds.right,
                width: ordinarySelectedShellBounds.width,
                height: ordinarySelectedShellBounds.height,
                background: ordinarySelectedShellBackground,
              } : null,
              ordinaryRowBeforeSelection: ordinaryRowBeforeBounds ? {
                left: ordinaryRowBeforeBounds.left,
                right: ordinaryRowBeforeBounds.right,
                width: ordinaryRowBeforeBounds.width,
                height: ordinaryRowBeforeBounds.height,
              } : null,
              ordinarySelectedRow: ordinarySelectedRowBounds ? {
                left: ordinarySelectedRowBounds.left,
                right: ordinarySelectedRowBounds.right,
                width: ordinarySelectedRowBounds.width,
                height: ordinarySelectedRowBounds.height,
                background: ordinarySelectedRowBackground,
              } : null,
              selectedShell: selectedShellBounds ? {
                left: selectedShellBounds.left,
                right: selectedShellBounds.right,
                top: selectedShellBounds.top,
                bottom: selectedShellBounds.bottom,
                width: selectedShellBounds.width,
                height: selectedShellBounds.height,
                background: getComputedStyle(selectedShell).backgroundColor,
                borderRadius: getComputedStyle(selectedShell).borderRadius,
              } : null,
              selectedRow: selectedRowBounds ? {
                left: selectedRowBounds.left,
                right: selectedRowBounds.right,
                top: selectedRowBounds.top,
                bottom: selectedRowBounds.bottom,
                width: selectedRowBounds.width,
                height: selectedRowBounds.height,
                background: getComputedStyle(selectedRow).backgroundColor,
              } : null,
              spinner: spinnerBounds ? {
                left: spinnerBounds.left,
                right: spinnerBounds.right,
                top: spinnerBounds.top,
                bottom: spinnerBounds.bottom,
                width: spinnerBounds.width,
                height: spinnerBounds.height,
              } : null,
            };
            probe.remove();
            resolve();
          }));
          if (Date.now() - started > 5000) return reject(new Error('Compact project sub-agent hover target did not render'));
          requestAnimationFrame(check);
        };
        check();
      })`, true);
    }
    await window.webContents.executeJavaScript(`(() => {
      const trigger = document.querySelector(${JSON.stringify(subagentTriggerSelector)});
      const compact = trigger?.closest('.session-subagents')?.classList.contains('compact') ?? false;
      const provider = trigger?.querySelector('.provider-logo');
      const summary = trigger?.querySelector('.session-subagents-summary');
      const icon = trigger?.querySelector('.session-subagents-icon');
      const count = trigger?.querySelector('.session-subagents-count');
      const chevron = trigger?.querySelector('.session-subagents-chevron');
      if (!trigger || !summary || !icon || !count || (!compact && !chevron)) return;
      const read = () => {
        const triggerBounds = trigger.getBoundingClientRect();
        const triggerStyle = getComputedStyle(trigger);
        const providerBounds = provider?.getBoundingClientRect();
        const summaryBounds = summary?.getBoundingClientRect();
        const iconBounds = icon?.getBoundingClientRect();
        const countBounds = count.getBoundingClientRect();
        const chevronBounds = chevron?.getBoundingClientRect();
        const chevronStyle = chevron ? getComputedStyle(chevron) : null;
        const providerGlyph = provider?.querySelector('.provider-monogram');
        const chevronPathBounds = chevron?.querySelector('path')?.getBoundingClientRect();
        const providerGlyphRange = document.createRange();
        if (providerGlyph) providerGlyphRange.selectNodeContents(providerGlyph);
        const providerGlyphBounds = providerGlyph ? providerGlyphRange.getBoundingClientRect() : null;
        const countRange = document.createRange();
        countRange.selectNodeContents(count);
        const countGlyphBounds = countRange.getBoundingClientRect();
        const shell = trigger.closest('.session-row-shell');
        const shellBounds = shell?.getBoundingClientRect();
        const shellStyle = shell ? getComputedStyle(shell) : null;
        const row = shell?.querySelector('.session-row');
        const rowBounds = row?.getBoundingClientRect();
        const rowStyle = row ? getComputedStyle(row) : null;
        const title = shell?.querySelector('.session-project-row-title, .session-row-title');
        const titleBounds = title?.getBoundingClientRect();
        const titleGlyph = title?.querySelector('strong');
        const titleGlyphRange = document.createRange();
        if (titleGlyph) titleGlyphRange.selectNodeContents(titleGlyph);
        const titleGlyphBounds = titleGlyph ? titleGlyphRange.getBoundingClientRect() : null;
        const titleLeadGlyphRange = document.createRange();
        const titleGlyphText = titleGlyph?.firstChild;
        if (titleGlyphText?.nodeType === Node.TEXT_NODE && titleGlyphText.textContent?.length) {
          titleLeadGlyphRange.setStart(titleGlyphText, 0);
          titleLeadGlyphRange.setEnd(titleGlyphText, 1);
        }
        const titleLeadGlyphBounds = titleGlyphText?.nodeType === Node.TEXT_NODE && titleGlyphText.textContent?.length
          ? titleLeadGlyphRange.getBoundingClientRect()
          : null;
        const spinnerBounds = shell?.querySelector('.session-project-working-indicator, .session-row-working-indicator')?.getBoundingClientRect();
        const clipBounds = trigger.closest('.session-list-scroll')?.getBoundingClientRect();
        return {
          count: count.textContent?.trim() ?? '',
          triggerLeft: triggerBounds.left,
          triggerRight: triggerBounds.right,
          triggerTop: triggerBounds.top,
          triggerBottom: triggerBounds.bottom,
          triggerWidth: triggerBounds.width,
          triggerHeight: triggerBounds.height,
          triggerCenterY: triggerBounds.top + triggerBounds.height / 2,
          compact,
          genericIconPresent: Boolean(icon),
          providerLeft: providerBounds?.left ?? null,
          providerRight: providerBounds?.right ?? null,
          providerTop: providerBounds?.top ?? null,
          providerBottom: providerBounds?.bottom ?? null,
          providerWidth: providerBounds?.width ?? 0,
          providerCenterX: providerBounds ? providerBounds.left + providerBounds.width / 2 : null,
          providerCenterY: providerBounds ? providerBounds.top + providerBounds.height / 2 : null,
          providerFontSize: providerGlyph ? Number.parseFloat(getComputedStyle(providerGlyph).fontSize) : 0,
          providerGlyphLeft: providerGlyphBounds?.left ?? 0,
          providerGlyphRight: providerGlyphBounds?.right ?? 0,
          providerGlyphTop: providerGlyphBounds?.top ?? 0,
          providerGlyphBottom: providerGlyphBounds?.bottom ?? 0,
          providerGlyphCenterY: providerGlyphBounds ? providerGlyphBounds.top + providerGlyphBounds.height / 2 : null,
          summaryLeft: summaryBounds?.left ?? null,
          summaryRight: summaryBounds?.right ?? null,
          summaryTop: summaryBounds?.top ?? null,
          summaryBottom: summaryBounds?.bottom ?? null,
          summaryWidth: summaryBounds?.width ?? 0,
          summaryCenterX: summaryBounds ? summaryBounds.left + summaryBounds.width / 2 : null,
          summaryCenterY: summaryBounds ? summaryBounds.top + summaryBounds.height / 2 : null,
          iconLeft: iconBounds?.left ?? null,
          iconRight: iconBounds?.right ?? null,
          iconTop: iconBounds?.top ?? null,
          iconBottom: iconBounds?.bottom ?? null,
          iconWidth: iconBounds?.width ?? 0,
          iconHeight: iconBounds?.height ?? 0,
          iconCenterX: iconBounds ? iconBounds.left + iconBounds.width / 2 : null,
          iconCenterY: iconBounds ? iconBounds.top + iconBounds.height / 2 : null,
          countLeft: countBounds.left,
          countRight: countBounds.right,
          countTop: countBounds.top,
          countBottom: countBounds.bottom,
          countCenterY: countBounds.top + countBounds.height / 2,
          countFontSize: Number.parseFloat(getComputedStyle(count).fontSize),
          countFontWeight: Number.parseFloat(getComputedStyle(count).fontWeight),
          countCapped: count.getAttribute('data-count-capped') === 'true',
          chevronPresent: Boolean(chevron),
          chevronCenterX: chevronBounds ? chevronBounds.left + chevronBounds.width / 2 : null,
          chevronLeft: chevronBounds?.left ?? null,
          chevronRight: chevronBounds?.right ?? null,
          chevronTop: chevronBounds?.top ?? null,
          chevronBottom: chevronBounds?.bottom ?? null,
          chevronWidth: chevronBounds?.width ?? 0,
          chevronHeight: chevronBounds?.height ?? 0,
          chevronOpacity: chevronStyle?.opacity ?? null,
          chevronStrokeWidth: chevronStyle ? Number.parseFloat(chevronStyle.strokeWidth) : 0,
          chevronTranslate: chevronStyle?.translate ?? null,
          triggerBackground: triggerStyle.backgroundColor,
          focusVisible: trigger.matches(':focus-visible'),
          chevronPathLeft: chevronPathBounds?.left ?? 0,
          chevronPathRight: chevronPathBounds?.right ?? 0,
          chevronPathTop: chevronPathBounds?.top ?? 0,
          chevronPathBottom: chevronPathBounds?.bottom ?? 0,
          countGlyphLeft: countGlyphBounds.left,
          countGlyphRight: countGlyphBounds.right,
          countGlyphTop: countGlyphBounds.top,
          countGlyphBottom: countGlyphBounds.bottom,
          countGlyphCenterY: countGlyphBounds.top + countGlyphBounds.height / 2,
          clipLeft: clipBounds?.left ?? null,
          clipRight: clipBounds?.right ?? null,
          rowTop: rowBounds?.top ?? null,
          rowBottom: rowBounds?.bottom ?? null,
          rowHeight: rowBounds?.height ?? null,
          rowLeft: rowBounds?.left ?? null,
          rowRight: rowBounds?.right ?? null,
          rowBackground: rowStyle?.backgroundColor ?? null,
          shellTop: shellBounds?.top ?? null,
          shellBottom: shellBounds?.bottom ?? null,
          shellHeight: shellBounds?.height ?? null,
          shellBackground: shellStyle?.backgroundColor ?? null,
          shellBorderRadius: shellStyle?.borderRadius ?? null,
          titleTop: titleBounds?.top ?? null,
          titleBottom: titleBounds?.bottom ?? null,
          titleCenterY: titleBounds ? titleBounds.top + titleBounds.height / 2 : null,
          titleLeft: titleBounds?.left ?? null,
          titleGlyphTop: titleGlyphBounds?.top ?? null,
          titleGlyphBottom: titleGlyphBounds?.bottom ?? null,
          titleGlyphCenterY: titleGlyphBounds ? titleGlyphBounds.top + titleGlyphBounds.height / 2 : null,
          titleLeadGlyphLeft: titleLeadGlyphBounds?.left ?? null,
          titleLeadGlyphRight: titleLeadGlyphBounds?.right ?? null,
          titleLeadGlyphTop: titleLeadGlyphBounds?.top ?? null,
          titleLeadGlyphBottom: titleLeadGlyphBounds?.bottom ?? null,
          titleClearance: titleBounds ? titleBounds.left - triggerBounds.right : null,
          spinnerLeft: spinnerBounds?.left ?? null,
          spinnerTop: spinnerBounds?.top ?? null,
          spinnerBottom: spinnerBounds?.bottom ?? null,
          spinnerCenterY: spinnerBounds ? spinnerBounds.top + spinnerBounds.height / 2 : null,
          spinnerRight: spinnerBounds?.right ?? null,
        };
      };
      window.__tethoqReadSubagentCountGeometry = read;
      window.__tethoqSubagentCountGeometry = { current: read() };
    })()`, true);
    if (viewport.kind === 'subagents-hover-project') {
      await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const reveal = document.querySelector('.session-row-shell:has(.session-subagents.compact) .session-project-row-title');
        const content = reveal?.querySelector(':scope > span');
        if (!(reveal instanceof HTMLElement) || !(content instanceof HTMLElement)) return reject(new Error('Compact project title fade fixture is missing'));
        const originalWidth = reveal.style.width;
        reveal.style.width = Math.max(1, content.scrollWidth - 1) + 'px';
        const started = Date.now();
        const check = () => {
          const distance = content.scrollWidth - reveal.clientWidth;
          if (distance === 1 && reveal.getAttribute('data-overflow') === 'true') {
            const style = getComputedStyle(reveal);
            window.__tethoqOnePixelTitleFade = { distance, attribute: reveal.getAttribute('data-overflow'), maskImage: style.maskImage || style.webkitMaskImage };
            if (originalWidth) reveal.style.width = originalWidth;
            else reveal.style.removeProperty('width');
            return requestAnimationFrame(() => requestAnimationFrame(resolve));
          }
          if (Date.now() - started > 3000) return reject(new Error('One-pixel project-title overflow did not activate its fade'));
          requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      })`, true);
    }
    const point = await window.webContents.executeJavaScript(`(() => { const rect = document.querySelector(${JSON.stringify(subagentTriggerSelector)})?.getBoundingClientRect(); return rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } : null; })()`, true);
    if (!point) throw new Error('Sub-agent hover target is missing');
    window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
    await new Promise((resolve) => setTimeout(resolve, 650));
    await window.webContents.executeJavaScript(`(() => {
      const read = window.__tethoqReadSubagentCountGeometry;
      if (typeof read === 'function') window.__tethoqSubagentCountGeometry.hover = read();
    })()`, true);
  } else if (viewport.kind === 'subagents') {
    const point = await window.webContents.executeJavaScript(`(() => { const rect = document.querySelector('.session-subagents-trigger')?.getBoundingClientRect(); return rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } : null; })()`, true);
    if (!point) throw new Error('Sub-agent disclosure target is missing');
    window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
    window.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    const readChildState = async () => await window.webContents.executeJavaScript(`(() => {
      const row = document.querySelector('.session-subagents-popover > button');
      const label = row?.querySelector('.session-subagent-state')?.textContent ?? '';
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
        const label = row?.querySelector('.session-subagent-state')?.textContent ?? '';
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
    subagentDividerOverlap = await window.webContents.executeJavaScript(`(() => {
      const appRoot = document.querySelector('.desktop-app');
      const handle = document.querySelector('.navigation-resize-handle');
      const panel = document.querySelector('.session-subagents-popover');
      if (!(appRoot instanceof HTMLElement) || !(handle instanceof HTMLElement) || !(panel instanceof HTMLElement)) return null;
      appRoot.classList.add('sidebar-resizing');
      // The correctly layered panel intercepts pointer hover at the overlap. Force
      // the same painted divider state so this fixture can isolate the z-order.
      const activeDividerStyle = document.createElement('style');
      activeDividerStyle.textContent = '.navigation-resize-handle::after { background: #686863 !important; }';
      document.head.append(activeDividerStyle);
      const handleBounds = handle.getBoundingClientRect();
      const panelBounds = panel.getBoundingClientRect();
      const lineX = handleBounds.left + 4.5;
      const overlapTop = Math.max(handleBounds.top, panelBounds.top);
      const overlapBottom = Math.min(handleBounds.bottom, panelBounds.bottom);
      const sampleY = overlapTop + Math.min(3, Math.max(1, (overlapBottom - overlapTop) / 2));
      const outsideY = Math.max(handleBounds.top + 2, panelBounds.top - 4);
      const hit = document.elementFromPoint(lineX, sampleY);
      return {
        panelParentIsBody: panel.parentElement === document.body,
        panelZIndex: Number.parseInt(getComputedStyle(panel).zIndex, 10),
        handleZIndex: Number.parseInt(getComputedStyle(handle).zIndex, 10),
        activeLineColor: getComputedStyle(handle, '::after').backgroundColor,
        lineX,
        sampleY,
        outsideY,
        overlaps: lineX >= panelBounds.left && lineX <= panelBounds.right && overlapBottom > overlapTop,
        hitInsidePanel: hit === panel || panel.contains(hit),
        hitClass: hit instanceof HTMLElement ? hit.className : '',
      };
    })()`, true);
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
  } else if (viewport.kind === 'mesh-quick' || viewport.kind === 'mesh-details') {
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const textarea = document.querySelector('.workspace textarea[aria-label="Message"]');
      if (!textarea) return reject(new Error('Mesh visual fixture has no composer'));
      textarea.focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, 'Compare this /mesh carefully');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      const started = Date.now();
      const check = () => {
        if (document.querySelector('.mesh-panel')) return requestAnimationFrame(() => requestAnimationFrame(resolve));
        if (Date.now() - started > 5000) return reject(new Error('Mesh quick chooser did not render'));
        requestAnimationFrame(check);
      };
      check();
    })`, true);
    if (viewport.kind === 'mesh-details') {
      await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const rows = [...document.querySelectorAll('.mesh-panel .mesh-add-row')];
        const row = rows.find((candidate) => candidate.querySelector('strong')?.textContent?.includes('Tethoq Example Connector'))
          ?? rows.find((candidate) => !candidate.querySelector('small')?.textContent?.includes('No reasoning control'));
        const details = row?.querySelector('.mesh-add-details');
        if (!(details instanceof HTMLButtonElement)) return reject(new Error('Mesh visual fixture has no detail disclosure'));
        details.click();
        const started = Date.now();
        const check = () => {
          const picker = document.querySelector('.mesh-model-picker');
          const reasoning = picker?.querySelector('.mesh-model-picker-reasoning');
          if (picker && reasoning && !picker.querySelector('.mesh-catalogue-status')) return requestAnimationFrame(() => requestAnimationFrame(resolve));
          if (Date.now() - started > 5000) return reject(new Error('Mesh model and reasoning picker did not settle: ' + (picker?.textContent?.trim() ?? 'picker missing')));
          requestAnimationFrame(check);
        };
        check();
      })`, true);
    }
  } else if (viewport.kind === 'mesh-widgets') {
    await window.webContents.executeJavaScript(`(async () => {
      let textarea = document.querySelector('#composer-message');
      const setValue = function(value) { if (this.isContentEditable) this.value = value; else Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(this, value); };
      if (!textarea) throw new Error('Mesh widget fixture has no composer');
      const waitFor = (predicate, label) => new Promise((resolve, reject) => {
        const started = Date.now();
        const check = () => {
          if (predicate()) return requestAnimationFrame(resolve);
          if (Date.now() - started > 5000) return reject(new Error(label));
          requestAnimationFrame(check);
        };
        check();
      });
      const providers = ${JSON.stringify(viewport.meshProviders ?? [])};
      for (let index = 0; index < providers.length; index += 1) {
        setValue.call(textarea, textarea.value + ' /mesh');
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        await waitFor(() => document.querySelector('.mesh-panel'), 'Mesh widget fixture did not open the chooser');
        const row = [...document.querySelectorAll('.mesh-panel .mesh-add-row')].find((candidate) => candidate.querySelector('strong')?.textContent?.trim() === providers[index]);
        const select = row?.querySelector('.mesh-add-select');
        if (!(select instanceof HTMLButtonElement)) throw new Error('Mesh widget fixture is missing ' + providers[index]);
        select.click();
        await waitFor(() => document.querySelectorAll('.composer-mesh-widget').length === index + 1, 'Mesh widget fixture did not commit ' + providers[index]);
        textarea = document.querySelector('#composer-message');
      }
      const markers = textarea.value.match(/[\\uE000-\\uF8FF]/gu) ?? [];
      setValue.call(textarea, 'Compare ' + markers.join(' and ') + ' carefully');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    })()`, true);
    // Type directly beside every badge with no separating space, reproducing
    // the overlap report. Measure the painted text and bubble independently.
    for (let targetIndex = 0; targetIndex < viewport.meshProviders.length; targetIndex += 1) {
      await window.webContents.executeJavaScript(`(() => {
        const input = document.querySelector('#composer-message');
        const token = [...document.querySelectorAll('.composer-mesh-widget')][${targetIndex}].dataset.meshToken;
        const index = input.value.indexOf(token) + 1;
        input.focus(); input.setSelectionRange(index, index);
      })()`);
      await window.webContents.insertText('m');
      await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const adjacent = await window.webContents.executeJavaScript(`(() => {
        const badge = [...document.querySelectorAll('.composer-mesh-widget')][${targetIndex}];
        const body = badge.querySelector('.composer-mesh-widget-body');
        const next = badge.nextSibling;
        if (next?.nodeType !== Node.TEXT_NODE || !next.textContent.startsWith('m')) throw new Error('Typing after a badge did not create adjacent editable text');
        const range = document.createRange(); range.setStart(next, 0); range.setEnd(next, 1);
        const typed = range.getBoundingClientRect();
        range.selectNodeContents(badge.querySelector('.composer-mesh-widget-model'));
        const label = range.getBoundingClientRect();
        const bounds = body.getBoundingClientRect();
        return { textLeft: typed.left, bubbleRight: bounds.right, baselineDelta: Math.abs(typed.bottom - label.bottom), color: getComputedStyle(body).color, border: getComputedStyle(body).borderColor, radius: getComputedStyle(body).borderRadius, label: body.textContent, title: body.title };
      })()`);
      assert.ok(adjacent.textLeft >= adjacent.bubbleRight - .5, 'Immediately typed text must start beyond the complete Mesh bubble');
      assert.ok(adjacent.baselineDelta <= 1, 'The Mesh label must share the regular text baseline');
      assert.equal(adjacent.color, 'rgb(215, 218, 215)', 'Provider colour must not tint the badge text');
      assert.equal(adjacent.radius, '999px', 'Mesh label lost its rounded outline');
      assert.equal(adjacent.label, adjacent.title, 'The badge must display its model and reasoning');
    }
    await window.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('#composer-message'); input.setSelectionRange(input.value.length, input.value.length);
    })()`);
    // Use native key events: dispatching a DOM keydown alone never performs
    // the textarea's default newline insertion and missed this regression.
    for (const line of ['Second line stays below the target', 'Third line stays below the target']) {
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: ['shift'] });
      window.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers: ['shift'] });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', modifiers: ['shift'] });
      await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(resolve))');
      await window.webContents.insertText(line);
      await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(resolve))');
    }
    const meshLayout = await window.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const input = document.querySelector('#composer-message');
      const flow = document.querySelector('.composer-input-flow').getBoundingClientRect();
      const targets = document.querySelector('.composer-inline-mesh').getBoundingClientRect();
      const text = input.getBoundingClientRect();
      resolve({
        lines: input.value.split('\\n').length,
        targetOffset: targets.top - flow.top,
        textOffset: text.top - flow.top,
        inputWidth: text.width, flowWidth: flow.width,
        textHeight: text.height,
        targetCount: document.querySelectorAll('.composer-mesh-widget').length,
      });
    })))`, true);
    assert.equal(meshLayout.lines, 3, 'Shift+Enter must insert a newline without sending');
    assert.equal(meshLayout.targetCount, viewport.meshProviders.length, 'Newlines must retain every Mesh target');
    assert.ok(meshLayout.textHeight > 42, 'The native multiline input must grow');
    assert.ok(Math.abs(meshLayout.inputWidth - meshLayout.flowWidth) < 1, 'Mesh must not narrow or shift the text input');
    const referenceLine = () => window.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('#composer-message');
      return document.querySelector('.composer-mesh-widget').getBoundingClientRect().top - input.getBoundingClientRect().top + input.scrollTop;
    })()`);
    const originalLine = await referenceLine();
    await window.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('#composer-message');
      input.focus(); input.setSelectionRange(0, 0);
    })()`);
    await window.webContents.insertText('Extra context before the reference. '.repeat(8));
    await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    assert.ok(await referenceLine() > originalLine + 20, 'A Mesh logo must wrap with newly inserted preceding text');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: ['control'] });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: ['control'] });
    await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    // Exercise real native deletion and Undo through the decorated textarea.
    await window.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('#composer-message');
      const index = input.value.search(/[\uE000-\uF8FF]/u);
      input.focus(); input.setSelectionRange(index + 1, index + 1);
    })()`, true);
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
    await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    assert.equal(await window.webContents.executeJavaScript('document.querySelectorAll(".composer-mesh-widget").length'), viewport.meshProviders.length - 1, 'Backspace must delete only its adjacent reference');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: ['control'] });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: ['control'] });
    await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    assert.equal(await window.webContents.executeJavaScript('document.querySelectorAll(".composer-mesh-widget").length'), viewport.meshProviders.length, 'Undo must restore the deleted reference');
    await writeFile(path.join(outputDirectory, viewport.name + '-multiline.json'), JSON.stringify(meshLayout, null, 2));
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
  } else if (viewport.kind === 'trace-expanded' || viewport.kind === 'trace-activity-row' || viewport.kind === 'trace-thinking-expanded' || viewport.kind === 'trace-snippet' || viewport.kind === 'thinking-message-meta') {
    if (viewport.width <= 780) {
      await window.webContents.executeJavaScript(`document.querySelector('.session-row')?.click()`, true);
      await window.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`, true);
    }
    await window.webContents.executeJavaScript(`document.querySelector('.reasoning-disclosure[aria-expanded="false"]')?.click()`, true);
    if (viewport.kind === 'trace-activity-row') {
      await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const started = Date.now();
        const check = () => {
          const target = [...document.querySelectorAll('.activity-row .activity-target')]
            .find((entry) => entry.textContent?.trim() === 'Provider integration');
          if (target) {
            target.closest('.activity-row')?.scrollIntoView({ block: 'center' });
            return requestAnimationFrame(() => requestAnimationFrame(resolve));
          }
          const nextDisclosure = document.querySelector('.reasoning-disclosure[aria-expanded="false"]');
          if (nextDisclosure instanceof HTMLButtonElement) nextDisclosure.click();
          if (Date.now() - started > 5000) return reject(new Error('Sub-agent activity target did not render'));
          requestAnimationFrame(check);
        };
        check();
      })`, true);
    } else if (viewport.kind === 'trace-thinking-expanded') {
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
  if (viewport.kind === 'subagents-hover-project') {
    const ordinaryPoint = await window.webContents.executeJavaScript(`(() => {
      const row = document.querySelector('.session-project-items .session-row-shell:not(:has(.session-subagents.compact)) > .session-row.compact');
      const bounds = row?.getBoundingClientRect();
      return bounds ? { x: Math.round(bounds.left + bounds.width * .75), y: Math.round(bounds.top + bounds.height / 2) } : null;
    })()`, true);
    if (!ordinaryPoint) throw new Error('Ordinary compact project hover target did not render');
    window.webContents.sendInputEvent({ type: 'mouseMove', x: ordinaryPoint.x, y: ordinaryPoint.y });
    await new Promise((resolve) => setTimeout(resolve, 120));
    await window.webContents.executeJavaScript(`(() => {
      const row = document.querySelector('.session-project-items .session-row-shell:not(:has(.session-subagents.compact)) > .session-row.compact');
      const shell = row?.closest('.session-row-shell');
      if (!row || !shell || !window.__tethoqProjectListGeometry) return;
      window.__tethoqProjectListGeometry.ordinaryHover = {
        shellBackground: getComputedStyle(shell).backgroundColor,
        rowBackground: getComputedStyle(row).backgroundColor,
      };
    })()`, true);
    const subagentPoint = await window.webContents.executeJavaScript(`(() => {
      const bounds = document.querySelector('.session-subagents.compact .session-subagents-trigger')?.getBoundingClientRect();
      return bounds ? { x: Math.round(bounds.left + bounds.width / 2), y: Math.round(bounds.top + bounds.height / 2) } : null;
    })()`, true);
    if (!subagentPoint) throw new Error('Compact sub-agent hover target disappeared');
    window.webContents.sendInputEvent({ type: 'mouseMove', x: subagentPoint.x, y: subagentPoint.y });
    await new Promise((resolve) => setTimeout(resolve, 650));
    await window.webContents.executeJavaScript(`(() => {
      const read = window.__tethoqReadSubagentCountGeometry;
      if (typeof read === 'function') window.__tethoqSubagentCountGeometry.hover = read();
    })()`, true);
  }
  if (viewport.kind === 'task-rail') {
    const point = await window.webContents.executeJavaScript(`(() => {
      const preview = document.querySelector('.session-row-preview[data-overflow="true"]');
      const row = preview?.closest('.session-row');
      const bounds = row?.getBoundingClientRect();
      return bounds ? { x: Math.round(bounds.left + bounds.width / 2), y: Math.round(bounds.top + bounds.height / 2) } : null;
    })()`, true);
    if (!point) throw new Error('Overflowing task-preview hover target is missing');
    window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
    await new Promise((resolve) => setTimeout(resolve, 900));
  }
  if (viewport.kind === 'wallet-tooltip') {
    const point = await window.webContents.executeJavaScript(`(() => { const rect = document.querySelector('.wallet-trigger')?.getBoundingClientRect(); return rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } : null; })()`, true);
    if (!point) throw new Error('Wallet tooltip hover target is missing');
    window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
    await new Promise((resolve) => setTimeout(resolve, 650));
  }
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
  } else if (viewport.kind === 'dictation-recording') {
    const point = await window.webContents.executeJavaScript(`(() => { const rect = document.querySelector('.dictation-main[aria-label="Stop dictation"]')?.getBoundingClientRect(); return rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } : null; })()`, true);
    if (!point) throw new Error('Recording Stop hover target is missing');
    window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
    await new Promise((resolve) => setTimeout(resolve, 180));
  } else if (viewport.kind === 'dictation-hover') {
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const textarea = document.querySelector('#composer-message');
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (!(textarea instanceof HTMLTextAreaElement) || !setValue) return reject(new Error('Send alignment fixture textarea is missing'));
      setValue.call(textarea, 'Send alignment QA');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    })`, true);
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
      const scrollContainer = element.closest('.session-list-scroll, .conversation-scroll, .settings-page, .dashboard-page, .browser-download-list, .workflow-settings-list, .modal, .composer-popover, .chat-picker, .model-picker-scroll, .model-library-scroll, .wallet-popover, .mesh-add, .mesh-model-picker-scroll');
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
      dashboardDefault: ${JSON.stringify(viewport.kind === 'dashboard')} ? (() => {
        const dashboard = document.querySelector('.dashboard-page');
        const heading = dashboard?.querySelector('.page-heading');
        const headingBounds = heading?.getBoundingClientRect();
        const newTaskButton = heading?.querySelector('button');
        const newTaskLabel = newTaskButton?.querySelector('span');
        const newTaskIcon = newTaskButton?.querySelector('svg');
        const newTaskRawBounds = newTaskButton?.getBoundingClientRect();
        const newTaskLabelBounds = newTaskLabel?.getBoundingClientRect();
        const newTaskIconBounds = newTaskIcon?.getBoundingClientRect();
        const newTaskBounds = newTaskRawBounds && newTaskRawBounds.width > 0 && newTaskRawBounds.height > 0 ? newTaskRawBounds : null;
        const persistentNewTaskBounds = document.querySelector('.new-task-row .new-task-button')?.getBoundingClientRect();
        const gridBounds = dashboard?.querySelector('.dashboard-grid')?.getBoundingClientRect();
        const sectionTitle = dashboard?.querySelector('.recent-section .section-title');
        const sectionTitleBounds = sectionTitle?.getBoundingClientRect();
        const recentTableBounds = dashboard?.querySelector('.recent-table')?.getBoundingClientRect();
        const attentionCount = dashboard?.querySelector('.attention-card .attention-heading > b');
        const attentionCountStyle = attentionCount ? getComputedStyle(attentionCount) : null;
        const clearIcon = dashboard?.querySelector('.attention-card .empty-icon');
        const clearIconStyle = clearIcon ? getComputedStyle(clearIcon) : null;
        const clearShield = clearIcon?.querySelector('svg');
        const clearShieldBounds = clearShield?.getBoundingClientRect();
        const activeButton = dashboard?.querySelector('.active-task-card > button');
        const activeFooter = activeButton?.querySelector('.active-task-footer');
        const activeProject = activeFooter?.querySelector('span:first-child');
        const activeFolder = activeProject?.querySelector('svg');
        const activeFolderBounds = activeFolder?.getBoundingClientRect();
        const activeTime = activeFooter?.querySelector('span:nth-child(2)');
        const firstRecentRow = dashboard?.querySelector('.recent-table > button');
        const recentIdentity = firstRecentRow?.querySelector('span:first-child');
        const recentLogo = recentIdentity?.querySelector('.provider-logo');
        const recentLogoBounds = recentLogo?.getBoundingClientRect();
        const recentTitleElement = recentIdentity?.querySelector('strong');
        return {
          dashboard: Boolean(dashboard),
          workspace: Boolean(document.querySelector('.workspace')),
          chooseTaskText: /Choose a task/u.test(root?.textContent ?? ''),
          dashboardTitle: heading?.querySelector('h1')?.textContent?.trim() ?? '',
          recentTitle: sectionTitle?.querySelector('h2')?.textContent?.trim() ?? '',
          decorativeCopy: [...(dashboard?.querySelectorAll('.page-heading p, .section-title p') ?? [])].map((item) => item.textContent?.trim() ?? ''),
          headingBounds: headingBounds ? { left: headingBounds.left, right: headingBounds.right, top: headingBounds.top, bottom: headingBounds.bottom } : null,
          newTaskBounds: newTaskBounds ? { left: newTaskBounds.left, right: newTaskBounds.right, top: newTaskBounds.top, bottom: newTaskBounds.bottom } : null,
          persistentNewTaskBounds: persistentNewTaskBounds ? { width: persistentNewTaskBounds.width, height: persistentNewTaskBounds.height } : null,
          newTaskGeometry: newTaskBounds && newTaskLabelBounds && newTaskIconBounds ? {
            width: newTaskBounds.width,
            height: newTaskBounds.height,
            labelCenterDeltaX: (newTaskLabelBounds.left + newTaskLabelBounds.width / 2) - (newTaskBounds.left + newTaskBounds.width / 2),
            labelCenterDeltaY: (newTaskLabelBounds.top + newTaskLabelBounds.height / 2) - (newTaskBounds.top + newTaskBounds.height / 2),
            iconCenterDeltaY: (newTaskIconBounds.top + newTaskIconBounds.height / 2) - (newTaskBounds.top + newTaskBounds.height / 2),
            iconToLabelGap: newTaskLabelBounds.left - newTaskIconBounds.right,
            iconWidth: newTaskIconBounds.width,
            iconHeight: newTaskIconBounds.height,
            labelHeight: newTaskLabelBounds.height,
            labelFontSize: Number.parseFloat(getComputedStyle(newTaskLabel).fontSize),
            labelFontWeight: Number.parseFloat(getComputedStyle(newTaskLabel).fontWeight),
            labelLineHeight: Number.parseFloat(getComputedStyle(newTaskLabel).lineHeight),
          } : null,
          gridBounds: gridBounds ? { left: gridBounds.left, right: gridBounds.right, top: gridBounds.top, bottom: gridBounds.bottom } : null,
          sectionTitleBounds: sectionTitleBounds ? { left: sectionTitleBounds.left, right: sectionTitleBounds.right, top: sectionTitleBounds.top, bottom: sectionTitleBounds.bottom } : null,
          recentTableBounds: recentTableBounds ? { left: recentTableBounds.left, right: recentTableBounds.right, top: recentTableBounds.top, bottom: recentTableBounds.bottom } : null,
          attentionCount: attentionCount && attentionCountStyle ? { text: attentionCount.textContent?.trim() ?? '', fontSize: Number.parseFloat(attentionCountStyle.fontSize), borderTopWidth: attentionCountStyle.borderTopWidth, borderRadius: attentionCountStyle.borderRadius, background: attentionCountStyle.backgroundColor } : null,
          clearState: clearIcon && clearIconStyle && clearShieldBounds ? { borderTopWidth: clearIconStyle.borderTopWidth, borderRadius: clearIconStyle.borderRadius, background: clearIconStyle.backgroundColor, shieldWidth: clearShieldBounds.width, shieldHeight: clearShieldBounds.height } : null,
          activeTask: activeFooter && activeProject && activeFolderBounds && activeTime ? { clickablePanel: activeButton instanceof HTMLButtonElement, footerDirectChevronCount: activeFooter.querySelectorAll(':scope > svg').length, projectFontSize: Number.parseFloat(getComputedStyle(activeProject).fontSize), timeFontSize: Number.parseFloat(getComputedStyle(activeTime).fontSize), projectColor: getComputedStyle(activeProject).color, timeColor: getComputedStyle(activeTime).color, folderWidth: activeFolderBounds.width, folderHeight: activeFolderBounds.height } : null,
          recentTask: recentLogoBounds && recentTitleElement ? { logoWidth: recentLogoBounds.width, logoHeight: recentLogoBounds.height, titleFontSize: Number.parseFloat(getComputedStyle(recentTitleElement).fontSize) } : null,
        };
      })() : null,
      slashCommandPalette: ${JSON.stringify(viewport.kind === 'slash-command')} ? (() => {
        const palette = document.querySelector('.slash-command-palette');
        const textarea = document.querySelector('.workspace textarea[aria-label="Message"]');
        const bounds = palette?.getBoundingClientRect();
        const rows = [...(palette?.querySelectorAll('[role="option"]') ?? [])];
        const rowBounds = rows.map((row) => row.getBoundingClientRect());
        const descriptionSizes = rows.map((row) => Number.parseFloat(getComputedStyle(row.querySelector('small')).fontSize));
        const hintSizes = rows.map((row) => Number.parseFloat(getComputedStyle(row.querySelector('kbd')).fontSize));
        return palette && textarea ? {
          query: textarea.value,
          commands: rows.map((item) => item.textContent?.trim() ?? ''),
          selected: palette.querySelector('[aria-selected="true"]')?.textContent?.trim() ?? null,
          width: bounds?.width ?? 0,
          clientHeight: palette.clientHeight,
          scrollHeight: palette.scrollHeight,
          rowHeights: rowBounds.map((rect) => rect.height),
          completeRows: bounds ? rowBounds.filter((rect) => rect.top >= bounds.top - .5 && rect.bottom <= bounds.bottom + .5).length : 0,
          descriptionSizes,
          hintSizes,
          iconPath: rows[0]?.querySelector('svg path')?.getAttribute('d') ?? '',
        } : null;
      })() : null,
      meshQuickChooser: ${JSON.stringify(viewport.kind === 'mesh-quick')} ? (() => {
        const panel = document.querySelector('.mesh-panel');
        const textarea = document.querySelector('.workspace textarea[aria-label="Message"]');
        const bounds = panel?.getBoundingClientRect();
        const rows = [...(panel?.querySelectorAll('.mesh-add-row') ?? [])];
        return panel && textarea && bounds ? {
          query: textarea.value,
          bounds: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height },
          viewport: { width: innerWidth, height: innerHeight },
          rowCount: rows.length,
          selectedRows: panel.querySelectorAll('.mesh-add-row.selected[aria-selected="true"]').length,
          rowHeights: rows.map((row) => row.getBoundingClientRect().height),
          rowColumns: rows.map((row) => {
            const main = row.querySelector('.mesh-add-select');
            const details = row.querySelector('.mesh-add-details');
            const mainBounds = main?.getBoundingClientRect();
            const detailsBounds = details?.getBoundingClientRect();
            return {
              mainWidth: mainBounds?.width ?? 0,
              detailsWidth: detailsBounds?.width ?? 0,
              buttonCount: row.querySelectorAll(':scope > button').length,
            };
          }),
          providerLabels: rows.map((row) => row.querySelector('strong')?.textContent?.trim() ?? ''),
          resolvedChoices: rows.map((row) => row.querySelector('small')?.textContent?.trim() ?? ''),
          resolvedChoiceFontSizes: rows.map((row) => Number.parseFloat(getComputedStyle(row.querySelector('small')).fontSize)),
          horizontalOverflow: panel.scrollWidth > panel.clientWidth + 1,
        } : null;
      })() : null,
      meshDetails: ${JSON.stringify(viewport.kind === 'mesh-details')} ? (() => {
        const picker = document.querySelector('.mesh-model-picker');
        const scroll = picker?.querySelector('.mesh-model-picker-scroll');
        const reasoning = picker?.querySelector('.mesh-model-picker-reasoning');
        const footer = picker?.querySelector(':scope > footer');
        const bounds = picker?.getBoundingClientRect();
        const scrollBounds = scroll?.getBoundingClientRect();
        const reasoningBounds = reasoning?.getBoundingClientRect();
        const footerBounds = footer?.getBoundingClientRect();
        const modelButtons = [...(scroll?.querySelectorAll('section > button[role="radio"]') ?? [])];
        const effortButtons = [...(reasoning?.querySelectorAll('button[role="radio"]') ?? [])];
        const inside = (outer, inner) => outer && inner && inner.left >= outer.left - .5 && inner.right <= outer.right + .5 && inner.top >= outer.top - .5 && inner.bottom <= outer.bottom + .5;
        return picker && scroll && reasoning && footer && bounds && scrollBounds && reasoningBounds && footerBounds ? {
          bounds: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height },
          viewport: { width: innerWidth, height: innerHeight },
          scrollBounds: { top: scrollBounds.top, bottom: scrollBounds.bottom, height: scrollBounds.height },
          reasoningBounds: { top: reasoningBounds.top, bottom: reasoningBounds.bottom, height: reasoningBounds.height },
          footerBounds: { top: footerBounds.top, bottom: footerBounds.bottom },
          reasoningInsideScroll: reasoning.closest('.mesh-model-picker-scroll') !== null,
          modelCount: modelButtons.length,
          completeModels: modelButtons.filter((button) => inside(scrollBounds, button.getBoundingClientRect())).length,
          effortLabels: effortButtons.map((button) => button.textContent?.trim() ?? ''),
          selectedEfforts: effortButtons.filter((button) => button.getAttribute('aria-checked') === 'true').length,
          effortsFullyVisible: effortButtons.every((button) => inside(reasoningBounds, button.getBoundingClientRect())),
          horizontalOverflow: picker.scrollWidth > picker.clientWidth + 1,
        } : null;
      })() : null,
      meshWidgets: ${JSON.stringify(viewport.kind === 'mesh-widgets')} ? (() => {
        const host = document.querySelector('.composer-inline-mesh');
        const textarea = document.querySelector('#composer-message');
        const widgets = [...(host?.querySelectorAll('.composer-mesh-widget') ?? [])];
        const bounds = host?.getBoundingClientRect();
        return host && textarea && bounds ? {
          query: textarea.value.replace(/[\\uE000-\\uF8FF]/gu, "[mesh]"),
          bounds: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height },
          viewport: { width: innerWidth, height: innerHeight },
          widgets: widgets.map((widget) => {
            const body = widget.querySelector('.composer-mesh-widget-body');
            const bodyBounds = body?.getBoundingClientRect();
            return {
              providerId: widget.getAttribute('data-provider-id'),
              borderColor: body ? getComputedStyle(body).borderColor : null,
              visible: bodyBounds ? bodyBounds.left >= 0 && bodyBounds.right <= innerWidth && bodyBounds.top >= 0 && bodyBounds.bottom <= innerHeight : false,
            };
          }),
          horizontalOverflow: host.scrollWidth > host.clientWidth + 1,
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
        const sendIcon = document.querySelector('.workspace .send-button .send-arrow-icon')?.getBoundingClientRect();
        const center = (rect) => rect ? rect.top + rect.height / 2 : null;
        const horizontalCenter = (rect) => rect ? rect.left + rect.width / 2 : null;
        return modelLabel && modelValue && modelLogo && effortLabel && effortValue && microphone && dictationArrow && send ? {
          modelValueDelta: center(modelValue) - center(modelLabel),
          modelLogoDelta: center(modelLogo) - center(modelLabel),
          effortValueDelta: center(effortValue) - center(effortLabel),
          labelDelta: center(effortLabel) - center(modelLabel),
          microphoneSendDelta: center(microphone) - center(send),
          arrowMicrophoneDelta: horizontalCenter(dictationArrow) - horizontalCenter(microphone),
          sendIconDelta: sendIcon ? horizontalCenter(sendIcon) - horizontalCenter(send) : null,
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
          modalOpen: Boolean(document.querySelector('[aria-modal="true"]')),
          upperHitIsMain: upperHit?.classList.contains('dictation-main') ?? false,
          lowerHitIsSource: lowerHit?.parentElement?.classList.contains('dictation-source-menu') ?? false,
        } : null;
      })(),
      dictationRecording: ${JSON.stringify(viewport.kind === 'dictation-recording')} ? (() => {
        const box = document.querySelector('.composer-box');
        const strip = document.querySelector('.dictation-audio-strip');
        const attachments = document.querySelector('.attachment-chips');
        const entry = document.querySelector('.composer-entry-row');
        const textarea = document.querySelector('#composer-message');
        const actions = document.querySelector('.composer-primary-actions');
        const more = document.querySelector('.composer-actions-menu > button');
        const stop = document.querySelector('.dictation-main[aria-label="Stop dictation"]');
        const send = document.querySelector('.send-button');
        const elapsed = document.querySelector('.dictation-audio-elapsed');
        if (!box || !strip || !attachments || !entry || !(textarea instanceof HTMLTextAreaElement) || !actions || !more || !stop || !send || !elapsed) return null;
        const boxBounds = box.getBoundingClientRect();
        const plain = (element) => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
        };
        const measured = {
          strip: plain(strip),
          attachments: plain(attachments),
          entry: plain(entry),
          textarea: plain(textarea),
          actions: plain(actions),
          more: plain(more),
          stop: plain(stop),
          send: plain(send),
        };
        const contained = Object.fromEntries(Object.entries(measured).map(([name, bounds]) => [name,
          bounds.left >= boxBounds.left - .75 && bounds.right <= boxBounds.right + .75 && bounds.top >= boxBounds.top - .75 && bounds.bottom <= boxBounds.bottom + .75,
        ]));
        const stripBounds = strip.getBoundingClientRect();
        const stopBounds = stop.getBoundingClientRect();
        const elapsedBounds = elapsed.getBoundingClientRect();
        const stopStyle = getComputedStyle(stop);
        const connectorStyle = getComputedStyle(strip, '::after');
        const lowerHit = document.elementFromPoint(stopBounds.left + stopBounds.width / 2, stopBounds.bottom - 7)?.closest('button');
        return {
          box: { ...plain(box), clientHeight: box.clientHeight, scrollHeight: box.scrollHeight },
          measured,
          contained,
          attachmentCount: attachments.querySelectorAll(':scope > span').length,
          upperStopCount: document.querySelectorAll('.dictation-audio-stop').length,
          dedicatedStopCount: document.querySelectorAll('.dictation-main[aria-label="Stop dictation"]').length,
          sourceMenuCount: document.querySelectorAll('.dictation-source-menu').length,
          stripButtonCount: strip.querySelectorAll('button').length,
          textareaClientHeight: textarea.clientHeight,
          textareaScrollHeight: textarea.scrollHeight,
          textareaOverflowY: getComputedStyle(textarea).overflowY,
          timerRightGap: stripBounds.right - elapsedBounds.right,
          lowerHitIsStop: lowerHit === stop,
          sendLabel: send.getAttribute('aria-label'),
          stopBackground: stopStyle.backgroundColor,
          stopColor: stopStyle.color,
          stopBoxShadow: stopStyle.boxShadow,
          connector: {
            content: connectorStyle.content,
            background: connectorStyle.backgroundColor,
            clipPath: connectorStyle.clipPath,
          },
        };
      })() : null,
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
        const trigger = document.querySelector('.model-picker-trigger');
        const scroll = panel?.querySelector('.model-picker-scroll');
        const panelBounds = panel?.getBoundingClientRect();
        const triggerBounds = trigger?.getBoundingClientRect();
        const scrollBounds = scroll?.getBoundingClientRect();
        const scrollStyle = scroll ? getComputedStyle(scroll) : null;
        const bottomInset = scrollStyle ? Number.parseFloat(scrollStyle.paddingBottom) : 0;
        const contentBottom = scrollBounds ? scrollBounds.bottom - bottomInset : 0;
        const rows = [...(panel?.querySelectorAll('.model-catalog-results section > button') ?? [])];
        const visibleRows = rows.filter((row) => {
          const rect = row.getBoundingClientRect();
          return scrollBounds && rect.bottom > scrollBounds.top + .5 && rect.top < contentBottom - .5;
        });
        const partialRows = visibleRows.filter((row) => {
          const rect = row.getBoundingClientRect();
          return scrollBounds && (rect.top < scrollBounds.top - .5 || rect.bottom > contentBottom + .5);
        });
        const sections = [...(panel?.querySelectorAll('.model-catalog-results > section') ?? [])];
        const recent = sections.find((section) => section.querySelector('h4')?.textContent?.trim() === 'Recent');
        const canonical = sections.filter((section) => section !== recent);
        const rowMarks = rows.map((row) => {
          const mark = row.querySelector('.provider-logo');
          const monogram = mark?.querySelector('.provider-monogram');
          const bounds = mark?.getBoundingClientRect();
          return bounds && monogram ? { width: bounds.width, height: bounds.height, fontSize: Number.parseFloat(getComputedStyle(monogram).fontSize) } : null;
        }).filter(Boolean);
        const headings = [...(panel?.querySelectorAll('h4') ?? [])].map((heading) => heading.querySelector(':scope > span:last-child')?.textContent?.trim() ?? heading.textContent?.trim() ?? '');
        const badges = [...(panel?.querySelectorAll('.model-row-meta') ?? [])].map((meta) => meta.textContent?.trim() ?? '');
        return panel ? {
          headings,
          badges,
          text: panel.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          rightEdgeDelta: panelBounds && triggerBounds ? panelBounds.right - triggerBounds.right : null,
          triggerGap: panelBounds && triggerBounds ? triggerBounds.top - panelBounds.bottom : null,
          completeRowViewport: scroll?.getAttribute('data-complete-row-viewport') === 'true',
          visibleRows: visibleRows.length,
          partialRows: partialRows.length,
          bottomInset,
          rowMarks,
          recentSelected: recent?.querySelectorAll('button[aria-current="true"], button.selected').length ?? 0,
          recentChecks: recent?.querySelectorAll('.model-row-meta svg').length ?? 0,
          canonicalSelected: canonical.reduce((count, section) => count + section.querySelectorAll('button[aria-current="true"]').length, 0),
          canonicalChecks: canonical.reduce((count, section) => count + section.querySelectorAll('.model-row-meta svg').length, 0),
        } : null;
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
      dictationSavedKey: ${JSON.stringify(viewport.kind === 'dictation-saved-key')} ? (() => {
        const popover = document.querySelector('.dictation-source-menu .composer-popover');
        const row = popover?.querySelector('.dictation-manage-source');
        const label = row?.querySelector(':scope > span');
        const strong = label?.querySelector('strong');
        const small = label?.querySelector('small');
        const arrow = row?.querySelector(':scope > svg');
        const selectedLabel = popover?.querySelector('.dictation-sources-scroll > button[aria-checked="true"] > .provider-logo + span');
        const popoverBounds = popover?.getBoundingClientRect();
        const rowBounds = row?.getBoundingClientRect();
        const labelBounds = label?.getBoundingClientRect();
        const selectedLabelBounds = selectedLabel?.getBoundingClientRect();
        const arrowBounds = arrow?.getBoundingClientRect();
        return popoverBounds && rowBounds && labelBounds && selectedLabelBounds && arrowBounds && strong && small ? {
          text: row.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
          rowWidth: rowBounds.width,
          popoverInnerWidth: popover.clientWidth,
          labelWidth: labelBounds.width,
          labelLeftDelta: labelBounds.left - selectedLabelBounds.left,
          arrowRightGap: rowBounds.right - arrowBounds.right,
          rowBottomGap: popoverBounds.bottom - rowBounds.bottom,
          strongLines: strong.scrollHeight / (Number.parseFloat(getComputedStyle(strong).lineHeight) || strong.scrollHeight),
          smallLines: small.scrollHeight / (Number.parseFloat(getComputedStyle(small).lineHeight) || small.scrollHeight),
          rowScrollWidth: row.scrollWidth,
          rowClientWidth: row.clientWidth,
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
          compactImageOnlyLayout: gallery.classList.contains('message-images-user'),
          galleryBottom: galleryBounds.bottom,
          bodyTop: bodyBounds.top,
          lightboxOpened: window.__tethoqAttachmentLightboxOpened === true,
        } : null;
      })() : null,
      userImageOnly: ${JSON.stringify(viewport.kind === 'user-image-only')} ? (() => {
        const measure = (selector) => {
          const gallery = document.querySelector(selector);
          const message = gallery?.closest('.message-user');
          const content = gallery?.closest('.message-content');
          if (!gallery || !message || !content) return null;
          const galleryBounds = gallery.getBoundingClientRect();
          const messageBounds = message.getBoundingClientRect();
          const contentBounds = content.getBoundingClientRect();
          const style = getComputedStyle(gallery);
          const tiles = [...gallery.children].map((tile) => {
            const bounds = tile.getBoundingClientRect();
            return { left: bounds.left, right: bounds.right, top: bounds.top, width: bounds.width, height: bounds.height };
          });
          return {
            gallery: { left: galleryBounds.left, right: galleryBounds.right, width: galleryBounds.width, height: galleryBounds.height },
            messageRight: messageBounds.right,
            contentRight: contentBounds.right,
            background: style.backgroundColor,
            borderWidth: style.borderWidth,
            unavailable: gallery.querySelectorAll('.message-image-unavailable').length,
            tiles,
          };
        };
        return {
          single: measure('.message-images-only[data-image-layout="1"]'),
          many: measure('.message-images-only[data-image-layout="many"]'),
          lightboxOpened: window.__tethoqImageOnlyLightboxOpened === true,
        };
      })() : null,
      localModelImage: ${JSON.stringify(viewport.kind === 'local-model-image')} ? (() => {
        const widget = document.querySelector('.message-assistant .rich-text-image');
        const image = widget?.querySelector('img');
        return widget && image ? {
          widgets: document.querySelectorAll('.message-assistant .rich-text-image').length,
          unavailable: document.querySelectorAll('.message-assistant .rich-image-unavailable').length,
          alt: image.getAttribute('alt') ?? '',
          proof: window.__tethoqLocalModelImage ?? null,
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
      agentDefaults: ${JSON.stringify(viewport.kind === 'settings-defaults')} ? (() => {
        const section = document.querySelector('.agent-defaults');
        const list = section?.querySelector('.agent-default-list');
        const close = document.querySelector('.settings-close-button');
        const heading = section?.querySelector('header h2');
        const closeBounds = close?.getBoundingClientRect();
        const headingBounds = heading?.getBoundingClientRect();
        const rows = [...(list?.querySelectorAll(':scope > article') ?? [])];
        const rowReadings = rows.map((row) => {
          const logo = row.querySelector('.provider-logo');
          const logoBounds = logo?.getBoundingClientRect();
          const controls = row.querySelector('.agent-default-controls');
          const controlsBounds = controls?.getBoundingClientRect();
          const settings = [...row.querySelectorAll('.agent-default-model-row')].map((setting) => {
            const label = setting.querySelector('.agent-default-label');
            const field = setting.querySelector('.agent-default-field');
            const chevron = setting.querySelector('.agent-model-trigger > svg, .agent-default-select > svg');
            const labelBounds = label?.getBoundingClientRect();
            const fieldBounds = field?.getBoundingClientRect();
            const chevronBounds = chevron?.getBoundingClientRect();
            return {
              label: label?.textContent?.trim() ?? '',
              labelLeft: labelBounds?.left ?? null,
              fieldLeft: fieldBounds?.left ?? null,
              chevronRight: chevronBounds?.right ?? null,
              chevronWidth: chevronBounds?.width ?? null,
            };
          });
          return {
            name: row.querySelector('.agent-default-identity strong')?.textContent?.trim() ?? '',
            logoWidth: logoBounds?.width ?? null,
            logoHeight: logoBounds?.height ?? null,
            controlsWidth: controlsBounds?.width ?? null,
            settings,
          };
        });
        const direct = rows.find((row) => row.querySelector('.agent-default-identity strong')?.textContent?.trim() === 'Direct API');
        const directDot = direct?.querySelector('.connection-dot');
        const directAction = direct?.querySelector('.agent-default-setup-action');
        return {
          rows: rows.length,
          selects: section?.querySelectorAll('.agent-default-controls select').length ?? 0,
          text: section?.textContent?.trim() ?? '',
          closeHeadingCenterDelta: closeBounds && headingBounds ? (closeBounds.top + closeBounds.height / 2) - (headingBounds.top + headingBounds.height / 2) : null,
          rowReadings,
          direct: direct && directDot ? {
            dotClass: directDot.className,
            dotColor: getComputedStyle(directDot).backgroundColor,
            action: directAction?.textContent?.trim() ?? '',
            modelLabel: direct.querySelector('.agent-default-label')?.textContent?.trim() ?? '',
            requiredText: direct.querySelector('.agent-default-required')?.textContent?.trim() ?? '',
          } : null,
        };
      })() : null,
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
      directSetup: window.__tethoqDirectSetupCheck ?? null,
      connectorSettings: ${JSON.stringify(viewport.kind === 'settings')} ? (() => {
        const list = document.querySelector('.settings-simplified .connector-list');
        const cards = [...(list?.querySelectorAll(':scope > .connector-card') ?? [])];
        const listStyle = list ? getComputedStyle(list) : null;
        return list && listStyle ? {
          cardCount: cards.length,
          listBorderWidth: listStyle.borderWidth,
          listBorderRadius: listStyle.borderRadius,
          listOverflow: listStyle.overflow,
          cards: cards.map((card) => {
            const style = getComputedStyle(card);
            return {
              borderWidth: style.borderWidth,
              borderRadius: style.borderRadius,
              borderTopWidth: style.borderTopWidth,
              disclosure: card.querySelector('.connector-disclosure')?.textContent?.trim() ?? '',
            };
          }),
        } : null;
      })() : null,
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
        const rows = [...document.querySelectorAll('.queued-message-row')].map((row) => {
          const rowBounds = row.getBoundingClientRect();
          const text = row.querySelector('.queued-message-content > strong');
          const textBounds = text?.getBoundingClientRect();
          const textRange = document.createRange();
          if (text) textRange.selectNodeContents(text);
          const glyphBounds = text ? textRange.getBoundingClientRect() : null;
          return textBounds && glyphBounds ? {
            hasAttachments: Boolean(row.querySelector('.queued-attachment-widgets')),
            rowHeight: rowBounds.height,
            rowScrollHeight: row.scrollHeight,
            lineBoxCenterDelta: rowBounds.top + rowBounds.height / 2 - (textBounds.top + textBounds.height / 2),
            glyphCenterDelta: rowBounds.top + rowBounds.height / 2 - (glyphBounds.top + glyphBounds.height / 2),
            textBottomGap: rowBounds.bottom - textBounds.bottom,
          } : null;
        });
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
          rows,
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
      sideChat: ${JSON.stringify(viewport.kind === 'side-chat')} ? (() => {
        const panel = document.querySelector('.side-chat-panel');
        const composer = panel?.querySelector('.side-chat-composer');
        const transcript = panel?.querySelector('.side-chat-transcript');
        const panelBounds = panel?.getBoundingClientRect();
        const composerBounds = composer?.getBoundingClientRect();
        return panel && composer && transcript && panelBounds && composerBounds ? {
          panelBottom: panelBounds.bottom,
          composerBottom: composerBounds.bottom,
          bottomGap: panelBounds.bottom - composerBounds.bottom,
          attachmentCount: panel.querySelectorAll('.side-chat-attachments').length,
          headerGridRow: getComputedStyle(panel.querySelector('header')).gridRowStart,
          transcriptGridRow: getComputedStyle(transcript).gridRowStart,
          composerGridRow: getComputedStyle(composer).gridRowStart,
        } : null;
      })() : null,
      sideChatRail: ${JSON.stringify(viewport.kind === 'side-chat-rail')} ? (() => {
        const group = document.querySelector('.session-row-group.has-side-chats');
        const parent = group?.querySelector(':scope > .session-row-shell > .session-row');
        const rail = group?.querySelector(':scope > .session-side-chat-rail');
        const toggle = rail?.querySelector(':scope > .session-side-chat-toggle');
        const stack = rail?.querySelector(':scope > .session-side-chats');
        const children = [...(stack?.querySelectorAll(':scope > button') ?? [])];
        const parentBounds = parent?.getBoundingClientRect();
        const railBounds = rail?.getBoundingClientRect();
        const toggleBounds = toggle?.getBoundingClientRect();
        const stackBounds = stack?.getBoundingClientRect();
        const childBounds = children.map((child) => child.getBoundingClientRect());
        const active = children.find((child) => child.classList.contains('active'));
        const inactive = children.find((child) => !child.classList.contains('active'));
        return group && parent && rail && toggle && stack && parentBounds && railBounds && toggleBounds && stackBounds ? {
          childCount: children.length,
          joinGap: stackBounds.top - parentBounds.bottom,
          shoulderJoinGap: stackBounds.left - toggleBounds.right,
          shoulderTopGap: toggleBounds.top - stackBounds.top,
          shoulderWidth: toggleBounds.width,
          shoulderAriaExpanded: toggle.getAttribute('aria-expanded'),
          shoulderRadius: getComputedStyle(toggle).borderRadius,
          siblingGaps: childBounds.slice(1).map((bounds, index) => bounds.top - childBounds[index].bottom),
          parentBottomRightRadius: getComputedStyle(parent).borderBottomRightRadius,
          stackBorderRadius: getComputedStyle(stack).borderRadius,
          stackBackground: getComputedStyle(stack).backgroundColor,
          childRadii: children.map((child) => getComputedStyle(child).borderRadius),
          activeBackground: active ? getComputedStyle(active).backgroundColor : null,
          inactiveBackground: inactive ? getComputedStyle(inactive).backgroundColor : null,
          disclosureCheck: window.__tethoqSideChatRailDisclosure ?? null,
          titleLane: window.__tethoqProjectTitleLane ?? null,
          projectSubagent: window.__tethoqProjectSubagentGeometry ?? null,
        } : null;
      })() : null,
      downloadPopover: (() => { const rect = document.querySelector('.browser-download-popover')?.getBoundingClientRect(); return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height, rightGap: innerWidth - rect.right } : null; })(),
      downloadButton: (() => { const button = document.querySelector('.browser-downloads'); return button ? { expanded: button.getAttribute('aria-expanded'), hasPopup: button.getAttribute('aria-haspopup'), badge: button.querySelector('span')?.textContent?.trim() ?? null } : null; })(),
      downloadDialog: (() => { const dialog = document.querySelector('.browser-download-popover'); return dialog ? { role: dialog.getAttribute('role'), label: dialog.getAttribute('aria-label') } : null; })(),
      downloadViewportBefore: window.__tethoqDownloadViewportBefore ?? null,
      downloadViewportAfter: (() => { const rect = document.querySelector('.browser-viewport')?.getBoundingClientRect(); return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null; })(),
      walletTooltip: ${JSON.stringify(viewport.kind === 'wallet-tooltip')} ? (() => {
        const trigger = document.querySelector('.wallet-trigger');
        const titlebar = document.querySelector('.titlebar');
        const workspaceHeader = document.querySelector('.workspace-header');
        const style = trigger ? getComputedStyle(trigger, '::after') : null;
        return trigger && titlebar && workspaceHeader && style ? {
          content: style.content,
          opacity: style.opacity,
          color: style.color,
          background: style.backgroundColor,
          titlebarZIndex: Number(getComputedStyle(titlebar).zIndex),
          workspaceHeaderZIndex: Number(getComputedStyle(workspaceHeader).zIndex),
        } : null;
      })() : null,
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
      projectHeadingControls: ${JSON.stringify(viewport.kind === 'project-heading-controls')} ? (() => {
        const heading = document.querySelector('.session-project-heading');
        const collapse = heading?.querySelector('.session-project-header');
        const plus = heading?.querySelector('.session-project-new-task');
        const glyph = plus?.querySelector('svg');
        const disclosure = collapse?.querySelector(':scope > svg:last-child');
        const headingBounds = heading?.getBoundingClientRect();
        const collapseBounds = collapse?.getBoundingClientRect();
        const plusBounds = plus?.getBoundingClientRect();
        const glyphBounds = glyph?.getBoundingClientRect();
        const disclosureBounds = disclosure?.getBoundingClientRect();
        const projectRowBounds = document.querySelector('.session-project-items .session-row.compact')?.getBoundingClientRect();
        const projectScroller = heading?.closest('.session-list-scroll');
        const projectScrollerBounds = projectScroller?.getBoundingClientRect();
        const projectCreate = document.querySelector('.sidebar-task-header > button[aria-label="New project"]');
        const projectCreateIcon = projectCreate?.querySelector('.folder-plus-icon');
        const projectCreateIconBounds = projectCreateIcon?.getBoundingClientRect();
        return headingBounds && collapseBounds && plusBounds && glyphBounds ? {
          heading: { left: headingBounds.left, right: headingBounds.right, width: headingBounds.width, height: headingBounds.height },
          collapse: { left: collapseBounds.left, right: collapseBounds.right, width: collapseBounds.width, height: collapseBounds.height, centerY: collapseBounds.top + collapseBounds.height / 2 },
          plus: { left: plusBounds.left, right: plusBounds.right, width: plusBounds.width, height: plusBounds.height, centerY: plusBounds.top + plusBounds.height / 2, opacity: getComputedStyle(plus).opacity, pointerEvents: getComputedStyle(plus).pointerEvents },
          disclosure: disclosureBounds ? { left: disclosureBounds.left, right: disclosureBounds.right, width: disclosureBounds.width, rightGap: collapseBounds.right - disclosureBounds.right, opacity: getComputedStyle(disclosure).opacity, idleOpacity: window.__tethoqProjectDisclosureIdleOpacity ?? null } : null,
          projectRowRight: projectRowBounds?.right ?? null,
          projectScrollerRight: projectScrollerBounds?.right ?? null,
          projectContentRight: projectScrollerBounds && projectScroller ? projectScrollerBounds.left + projectScroller.clientWidth : null,
          glyphCenterDeltaX: (glyphBounds.left + glyphBounds.width / 2) - (plusBounds.left + plusBounds.width / 2),
          glyphCenterDeltaY: (glyphBounds.top + glyphBounds.height / 2) - (plusBounds.top + plusBounds.height / 2),
          projectCreate: projectCreateIcon && projectCreateIconBounds ? { width: projectCreateIconBounds.width, height: projectCreateIconBounds.height, pathCount: projectCreateIcon.querySelectorAll('path').length } : null,
        } : null;
      })() : null,
      subagents: ${JSON.stringify(viewport.kind === 'subagents')} ? (() => {
        const trigger = document.querySelector('.session-subagents-trigger');
        const triggerBounds = trigger?.getBoundingClientRect();
        const triggerChevron = trigger?.querySelector('.session-subagents-chevron');
        const triggerChevronBounds = triggerChevron?.getBoundingClientRect();
        const triggerSummary = trigger?.querySelector('.session-subagents-summary');
        const triggerSummaryBounds = triggerSummary?.getBoundingClientRect();
        const panel = document.querySelector('.session-subagents-popover');
        const panelBounds = panel?.getBoundingClientRect();
        const rows = [...(panel?.querySelectorAll(':scope > button') ?? [])];
        return panel ? {
          triggerLabel: trigger?.getAttribute('aria-label') ?? '',
          expanded: trigger?.getAttribute('aria-expanded') ?? '',
          triggerState: triggerBounds && triggerChevron && triggerChevronBounds && triggerSummaryBounds ? {
            width: triggerBounds.width,
            height: triggerBounds.height,
            summaryCenterX: triggerSummaryBounds.left + triggerSummaryBounds.width / 2,
            expectedSummaryCenterX: triggerBounds.left + 19,
            chevronCenterX: triggerChevronBounds.left + triggerChevronBounds.width / 2,
            chevronCenterY: triggerChevronBounds.top + triggerChevronBounds.height / 2,
            chevronWidth: triggerChevronBounds.width,
            chevronHeight: triggerChevronBounds.height,
            chevronOpacity: getComputedStyle(triggerChevron).opacity,
            chevronStrokeWidth: Number.parseFloat(getComputedStyle(triggerChevron).strokeWidth),
          } : null,
          childRows: rows.length,
          text: panel.textContent?.trim() ?? '',
          background: getComputedStyle(panel).backgroundColor,
          topLevelTitles: [...document.querySelectorAll('.session-row-title')].map((title) => title.textContent?.trim() ?? ''),
          geometry: {
            width: panelBounds?.width ?? 0,
            height: panelBounds?.height ?? 0,
            clientHeight: panel.clientHeight,
            scrollHeight: panel.scrollHeight,
            overflowY: getComputedStyle(panel).overflowY,
            rowHeights: rows.map((row) => row.getBoundingClientRect().height),
            metadataFontSizes: rows.map((row) => Number.parseFloat(getComputedStyle(row.querySelector('small')).fontSize)),
            markSizes: rows.map((row) => row.querySelector('.provider-logo')?.getBoundingClientRect().width ?? 0),
            providerIds: rows.map((row) => row.querySelector('.provider-logo')?.getAttribute('data-provider-id') ?? ''),
            genericIconCounts: rows.map((row) => row.querySelectorAll('.session-subagents-icon').length),
            metadata: rows.map((row) => {
              const model = row.querySelector('.session-subagent-model')?.textContent?.trim() ?? '';
              const separator = row.querySelector('.session-subagent-separator')?.textContent?.trim() ?? '';
              const reasoning = row.querySelector('.session-subagent-reasoning');
              return {
                text: [model, separator, reasoning?.textContent?.trim() ?? ''].filter(Boolean).join(' '),
                reasoningVisible: Boolean(reasoning && visible(reasoning)),
              };
            }),
            states: rows.map((row) => {
              const state = row.querySelector('.session-subagent-state');
              return { text: state?.textContent?.trim() ?? '', clientWidth: state?.clientWidth ?? 0, scrollWidth: state?.scrollWidth ?? 0 };
            }),
          },
        } : null;
      })() : null,
      subagentTooltip: ${JSON.stringify(viewport.kind === 'subagents-hover' || viewport.kind === 'subagents-hover-project')} ? (() => {
        const trigger = document.querySelector(${JSON.stringify(viewport.kind === 'subagents-hover-project' ? '.session-subagents.compact .session-subagents-trigger' : '.session-subagents-trigger')});
        const tooltips = [...document.querySelectorAll('.app-tooltip-overlay')];
        const visibleTooltips = tooltips.filter((tooltip) => visible(tooltip));
        const tooltip = visibleTooltips[0];
        const bounds = tooltip?.getBoundingClientRect();
        const triggerBounds = trigger?.getBoundingClientRect();
        return {
          visibleCount: visibleTooltips.length,
          text: tooltip?.textContent?.trim() ?? '',
          bounds: bounds ? { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height } : null,
          triggerBounds: triggerBounds ? { left: triggerBounds.left, right: triggerBounds.right } : null,
          parentIsBody: tooltip?.parentElement === document.body,
          sharedOverlay: tooltip?.classList.contains('app-tooltip-overlay') ?? false,
          placement: tooltip?.getAttribute('data-placement') ?? null,
          triggerTooltipText: trigger?.getAttribute('data-tooltip') ?? null,
          describedByTooltip: Boolean(tooltip?.id && trigger?.getAttribute('aria-describedby')?.split(' ').includes(tooltip.id)),
          legacyTooltipCount: document.querySelectorAll('.session-subagents-tooltip').length,
          nestedTooltipSources: trigger?.querySelectorAll('[data-tooltip]').length ?? -1,
          triggerHasTooltipSource: trigger?.hasAttribute('data-tooltip') ?? false,
          triggerPseudoContent: trigger ? getComputedStyle(trigger, '::after').content : null,
        };
      })() : null,
      subagentCountGeometry: ${JSON.stringify(viewport.kind === 'subagents-hover' || viewport.kind === 'subagents-hover-project')} ? window.__tethoqSubagentCountGeometry ?? null : null,
      projectListGeometry: ${JSON.stringify(viewport.kind === 'subagents-hover-project')} ? window.__tethoqProjectListGeometry ?? null : null,
      onePixelTitleFade: ${JSON.stringify(viewport.kind === 'subagents-hover-project')} ? window.__tethoqOnePixelTitleFade ?? null : null,
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
        const activityText = (() => {
          const row = [...document.querySelectorAll('.activity-row')].find((entry) => visible(entry) && entry.querySelector('.activity-target')?.textContent?.trim() === 'Provider integration');
          const primary = row?.querySelector('strong');
          const target = row?.querySelector('.activity-target');
          if (!row || !primary || !target) return null;
          const textBounds = (element) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            const bounds = range.getBoundingClientRect();
            return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, width: bounds.width, height: bounds.height };
          };
          const rowBounds = row.getBoundingClientRect();
          return {
            primaryText: primary.textContent?.trim() ?? '',
            targetText: target.textContent?.trim() ?? '',
            targetTranslate: getComputedStyle(target).translate,
            rowBounds: { left: rowBounds.left, right: rowBounds.right, top: rowBounds.top, bottom: rowBounds.bottom },
            primaryBounds: textBounds(primary),
            targetBounds: textBounds(target),
          };
        })();
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
          activityText,
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
      sidebar: ${JSON.stringify(viewport.kind === 'trace-collapsed' || viewport.kind === 'task-rail')} ? (() => {
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
        const newTaskIconRect = newTask?.querySelector('svg')?.getBoundingClientRect();
        const dashboardLabelRect = dashboardLabel?.getBoundingClientRect();
        const dashboardIconRect = dashboard?.querySelector('svg')?.getBoundingClientRect();
        const titleRect = title?.getBoundingClientRect();
        const previewRect = preview?.getBoundingClientRect();
        const taskSearch = document.querySelector('.sidebar-task-search');
        const taskFilter = document.querySelector('.sidebar-task-filter');
        const taskPlus = document.querySelector('.sidebar-task-header > button');
        const taskFilterRect = taskFilter?.getBoundingClientRect();
        const taskPlusRect = taskPlus?.getBoundingClientRect();
        const taskRows = [...document.querySelectorAll('.session-row')].map((row) => {
          const rangeBounds = (element, firstGlyphOnly = false) => {
            if (!element) return null;
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            let textNode = walker.nextNode();
            while (textNode && !(textNode.textContent ?? '').trim()) textNode = walker.nextNode();
            if (!textNode) return null;
            const range = document.createRange();
            if (firstGlyphOnly) {
              const text = textNode.textContent ?? '';
              const offset = text.length - text.trimStart().length;
              range.setStart(textNode, offset);
              range.setEnd(textNode, Math.min(offset + 1, textNode.length));
            } else range.selectNodeContents(element);
            const bounds = range.getBoundingClientRect();
            return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, width: bounds.width, height: bounds.height };
          };
          const logo = row.querySelector('.provider-logo');
          const rowTitle = row.querySelector('.session-row-title');
          const rowPreview = row.querySelector('.session-row-preview');
          const rowTrailing = row.querySelector('.session-row-trailing');
          const rowTime = rowTrailing?.querySelector('time');
          const rowSubagents = row.closest('.session-row-shell')?.querySelector(':scope > .session-subagents:not(.compact) .session-subagents-trigger');
          const subagentSummary = rowSubagents?.querySelector('.session-subagents-summary');
          const subagentIcon = rowSubagents?.querySelector('.session-subagents-icon');
          const subagentCount = rowSubagents?.querySelector('.session-subagents-count');
          const subagentChevron = rowSubagents?.querySelector('.session-subagents-chevron');
          const workingSpinner = row.querySelector('.session-row-working-spinner');
          const workingIndicator = row.querySelector('.session-row-working-indicator');
          const titleGlyph = rowTitle?.querySelector('strong');
          const logoGlyph = logo?.querySelector('.provider-monogram');
          const previewContent = rowPreview?.querySelector(':scope > span');
          const rowBounds = row.getBoundingClientRect();
          const logoBounds = logo?.getBoundingClientRect();
          const titleBounds = rowTitle?.getBoundingClientRect();
          const previewBounds = rowPreview?.getBoundingClientRect();
          const trailingBounds = rowTrailing?.getBoundingClientRect();
          const timeBounds = rowTime?.getBoundingClientRect();
          const timeInkRange = rowTime?.firstChild ? document.createRange() : null;
          if (timeInkRange && rowTime) timeInkRange.selectNodeContents(rowTime);
          const timeInkBounds = timeInkRange?.getBoundingClientRect();
          const fourCharacterTime = rowTime?.cloneNode(true);
          let fourCharacterTimeWidth = null;
          if (fourCharacterTime instanceof HTMLElement && rowTrailing) {
            fourCharacterTime.textContent = '999d';
            fourCharacterTime.style.position = 'fixed';
            fourCharacterTime.style.visibility = 'hidden';
            fourCharacterTime.style.width = 'max-content';
            rowTrailing.append(fourCharacterTime);
            const fourCharacterRange = document.createRange();
            fourCharacterRange.selectNodeContents(fourCharacterTime);
            fourCharacterTimeWidth = fourCharacterRange.getBoundingClientRect().width;
            fourCharacterTime.remove();
          }
          const subagentBounds = rowSubagents?.getBoundingClientRect();
          const subagentSummaryBounds = subagentSummary?.getBoundingClientRect();
          const subagentIconBounds = subagentIcon?.getBoundingClientRect();
          const subagentCountBounds = subagentCount?.getBoundingClientRect();
          const subagentChevronBounds = subagentChevron?.getBoundingClientRect();
          const subagentChevronPathBounds = subagentChevron?.querySelector('path')?.getBoundingClientRect();
          const spinnerBounds = workingSpinner?.getBoundingClientRect();
          const indicatorBounds = workingIndicator?.getBoundingClientRect();
          const titleGlyphBounds = titleGlyph?.getBoundingClientRect();
          const overflowByGeometry = Boolean(rowPreview && previewContent && previewContent.scrollHeight - rowPreview.clientHeight > 0);
          const overflowDistance = rowPreview && previewContent ? Math.max(0, previewContent.scrollHeight - rowPreview.clientHeight) : 0;
          return logoBounds && titleBounds && previewBounds ? {
            rowHeight: rowBounds.height,
            rowLeft: rowBounds.left,
            rowTop: rowBounds.top,
            rowBottom: rowBounds.bottom,
            rowRight: rowBounds.right,
            previewHeight: previewBounds.height,
            logoTopGap: logoBounds.top - rowBounds.top,
            logoBottomGap: rowBounds.bottom - logoBounds.bottom,
            hasSubagents: Boolean(row.closest('.session-row-shell')?.querySelector(':scope > .session-subagents')),
            trailingWidth: trailingBounds?.width ?? null,
            titleTimeGap: timeBounds ? timeBounds.left - titleBounds.right : null,
            timeWidth: timeBounds?.width ?? null,
            titleTimeInkGap: timeInkBounds ? timeInkBounds.left - titleBounds.right : null,
            timeInkWidth: timeInkBounds?.width ?? null,
            fourCharacterTimeWidth,
            fourCharacterTimeGap: timeBounds && fourCharacterTimeWidth !== null ? timeBounds.right - fourCharacterTimeWidth - titleBounds.right : null,
            cornerAlignment: timeBounds ? {
              timeTopGap: timeBounds.top - rowBounds.top,
              timeRightGap: rowBounds.right - timeBounds.right,
            } : null,
            subagentCorner: subagentBounds && subagentSummaryBounds && subagentIconBounds && subagentCountBounds && subagentChevronBounds ? {
              trigger: { left: subagentBounds.left, right: subagentBounds.right, top: subagentBounds.top, bottom: subagentBounds.bottom, width: subagentBounds.width, height: subagentBounds.height },
              summary: { left: subagentSummaryBounds.left, right: subagentSummaryBounds.right, top: subagentSummaryBounds.top, bottom: subagentSummaryBounds.bottom, width: subagentSummaryBounds.width },
              icon: { left: subagentIconBounds.left, right: subagentIconBounds.right, top: subagentIconBounds.top, bottom: subagentIconBounds.bottom, width: subagentIconBounds.width, height: subagentIconBounds.height },
              count: { left: subagentCountBounds.left, right: subagentCountBounds.right, top: subagentCountBounds.top, bottom: subagentCountBounds.bottom },
              chevron: { left: subagentChevronBounds.left, right: subagentChevronBounds.right, top: subagentChevronBounds.top, bottom: subagentChevronBounds.bottom, width: subagentChevronBounds.width, height: subagentChevronBounds.height, opacity: getComputedStyle(subagentChevron).opacity, strokeWidth: Number.parseFloat(getComputedStyle(subagentChevron).strokeWidth) },
              leftGap: subagentBounds.left - rowBounds.left,
              bottomGap: rowBounds.bottom - subagentBounds.bottom,
              previewGap: previewBounds.left - subagentBounds.right,
              summaryCenterDeltaX: (subagentSummaryBounds.left + subagentSummaryBounds.width / 2) - (subagentBounds.left + 19),
              iconCountCenterDeltaY: (subagentIconBounds.top + subagentIconBounds.height / 2) - (subagentCountBounds.top + subagentCountBounds.height / 2),
              summaryToChevronPaintGap: subagentChevronPathBounds ? subagentChevronPathBounds.top - subagentSummaryBounds.bottom : null,
              chevronCenterDeltaX: (subagentChevronBounds.left + subagentChevronBounds.width / 2) - (subagentBounds.left + 18),
              chevronBelowSummary: (subagentChevronBounds.top + subagentChevronBounds.height / 2) - (subagentSummaryBounds.top + subagentSummaryBounds.height / 2),
            } : null,
            paintBounds: {
              row: { top: rowBounds.top, bottom: rowBounds.bottom },
              logo: rangeBounds(logoGlyph),
              title: rangeBounds(titleGlyph, true),
              time: rangeBounds(rowTime, true),
              subagentIcon: subagentIconBounds ? { left: subagentIconBounds.left, right: subagentIconBounds.right, top: subagentIconBounds.top, bottom: subagentIconBounds.bottom } : null,
              subagentCount: rangeBounds(subagentCount),
            },
            titleX: titleBounds.x,
            previewX: previewBounds.x,
            titleGap: titleBounds.left - logoBounds.right,
            previewGap: previewBounds.left - logoBounds.right,
            overflowByGeometry,
            overflowAttribute: rowPreview?.getAttribute('data-overflow') === 'true',
            hovered: row.matches(':hover'),
            maskImage: getComputedStyle(rowPreview).maskImage,
            previewTransform: previewContent ? getComputedStyle(previewContent).transform : 'none',
            overflowDistance,
            overflowDuration: Number.parseFloat(rowPreview?.style.getPropertyValue('--overflow-duration') || '0'),
            workingSpinner: spinnerBounds && indicatorBounds ? {
              width: workingSpinner.offsetWidth,
              height: workingSpinner.offsetHeight,
              centerDeltaY: (indicatorBounds.top + indicatorBounds.height / 2) - (rowBounds.top + rowBounds.height / 2),
              rightGap: rowBounds.right - indicatorBounds.right,
              bottomGap: rowBounds.bottom - indicatorBounds.bottom,
            } : null,
          } : null;
        }).filter(Boolean);
        return {
          newTask: newTaskRect && newTaskLabelRect ? {
            x: newTaskRect.x,
            width: newTaskRect.width,
            height: newTaskRect.height,
            label: newTaskLabel?.textContent?.trim() ?? '',
            labelCenterDelta: (newTaskLabelRect.x + newTaskLabelRect.width / 2) - (newTaskRect.x + newTaskRect.width / 2),
            iconToLabelGap: newTaskIconRect ? newTaskLabelRect.left - newTaskIconRect.right : null,
            iconCenterX: newTaskIconRect ? newTaskIconRect.left + newTaskIconRect.width / 2 : null,
            iconCenterDeltaY: newTaskIconRect ? (newTaskIconRect.top + newTaskIconRect.height / 2) - (newTaskRect.top + newTaskRect.height / 2) : null,
            labelCenterDeltaY: (newTaskLabelRect.top + newTaskLabelRect.height / 2) - (newTaskRect.top + newTaskRect.height / 2),
            labelHeight: newTaskLabelRect.height,
            labelFontSize: Number.parseFloat(getComputedStyle(newTaskLabel).fontSize),
            labelLineHeight: Number.parseFloat(getComputedStyle(newTaskLabel).lineHeight),
          } : null,
          dashboard: dashboardRect && dashboardLabelRect ? {
            x: dashboardRect.x,
            width: dashboardRect.width,
            height: dashboardRect.height,
            labelCenterDelta: (dashboardLabelRect.x + dashboardLabelRect.width / 2) - (dashboardRect.x + dashboardRect.width / 2),
            iconToLabelGap: dashboardIconRect ? dashboardLabelRect.left - dashboardIconRect.right : null,
            iconCenterX: dashboardIconRect ? dashboardIconRect.left + dashboardIconRect.width / 2 : null,
            iconCenterDeltaY: dashboardIconRect ? (dashboardIconRect.top + dashboardIconRect.height / 2) - (dashboardRect.top + dashboardRect.height / 2) : null,
            labelCenterDeltaY: (dashboardLabelRect.top + dashboardLabelRect.height / 2) - (dashboardRect.top + dashboardRect.height / 2),
            labelHeight: dashboardLabelRect.height,
            labelFontSize: Number.parseFloat(getComputedStyle(dashboardLabel).fontSize),
            labelLineHeight: Number.parseFloat(getComputedStyle(dashboardLabel).lineHeight),
          } : null,
          footerDivider: navigationRect && footerRect ? { leftDelta: footerRect.left - navigationRect.left, rightDelta: navigationRect.right - footerRect.right, borderTopWidth: getComputedStyle(footer).borderTopWidth } : null,
          taskText: titleRect && previewRect ? { titleX: titleRect.x, previewX: previewRect.x } : null,
          taskControls: taskFilterRect && taskPlusRect ? { filterBeforePlus: taskFilterRect.right <= taskPlusRect.left, gap: taskPlusRect.left - taskFilterRect.right, centerDelta: (taskFilterRect.top + taskFilterRect.height / 2) - (taskPlusRect.top + taskPlusRect.height / 2), filterInsideSearch: Boolean(taskSearch?.contains(taskFilter)) } : null,
          taskRows,
        };
      })() : null,
    };
  })()`, true);
  if (subagentTransition) layout.subagentTransition = subagentTransition;
  if (subagentDividerOverlap) layout.subagentDividerOverlap = subagentDividerOverlap;
  if (layout.composerTail) layout.composerTail.coverPixels = composerCoverPixels;

  const image = await window.webContents.capturePage();
  const scanPaintedInk = (textBounds, rowBounds, backgroundChannel = 0, verticalBleed = 3) => {
    if (!textBounds || !rowBounds || ![textBounds.left, textBounds.right, textBounds.top, textBounds.bottom, rowBounds.top, rowBounds.bottom].every(Number.isFinite)) return null;
    const imageSize = image.getSize();
    const x = Math.max(0, Math.floor(textBounds.left));
    const y = Math.max(0, Math.floor(rowBounds.top), Math.floor(textBounds.top) - verticalBleed);
    const right = Math.min(imageSize.width, Math.ceil(textBounds.right));
    const bottom = Math.min(imageSize.height, Math.ceil(rowBounds.bottom), Math.ceil(textBounds.bottom) + verticalBleed);
    const width = Math.max(1, right - x);
    const height = Math.max(1, bottom - y);
    const crop = image.crop({ x, y, width, height });
    const pixels = crop.toBitmap();
    let top = Infinity;
    let paintedBottom = -Infinity;
    let paintedPixels = 0;
    let paintedWeight = 0;
    let weightedRow = 0;
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        const offset = (row * width + column) * 4;
        const lightestChannel = Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
        if (pixels[offset + 3] > 0 && lightestChannel >= 48) {
          const weight = Math.max(1, lightestChannel - backgroundChannel);
          top = Math.min(top, row);
          paintedBottom = Math.max(paintedBottom, row);
          paintedPixels += 1;
          paintedWeight += weight;
          weightedRow += row * weight;
        }
      }
    }
    return paintedPixels ? { top: y + top, bottom: y + paintedBottom, height: paintedBottom - top + 1, paintedPixels, weightedCenterY: y + weightedRow / paintedWeight } : null;
  };
  if (viewport.kind === 'trace-activity-row' && layout.trace?.activityText) {
    layout.trace.activityText.ink = {
      primary: scanPaintedInk(layout.trace.activityText.primaryBounds, layout.trace.activityText.rowBounds),
      target: scanPaintedInk(layout.trace.activityText.targetBounds, layout.trace.activityText.rowBounds),
    };
  }
  if (viewport.kind === 'task-rail' && layout.sidebar?.taskRows) {
    for (const row of layout.sidebar.taskRows) {
      row.paintedInk = {
        logo: scanPaintedInk(row.paintBounds?.logo, row.paintBounds?.row),
        title: scanPaintedInk(row.paintBounds?.title, row.paintBounds?.row),
        time: scanPaintedInk(row.paintBounds?.time, row.paintBounds?.row),
        subagentIcon: scanPaintedInk(row.paintBounds?.subagentIcon, row.paintBounds?.row),
        subagentCount: scanPaintedInk(row.paintBounds?.subagentCount, row.paintBounds?.row),
      };
    }
  }
  if ((viewport.kind === 'subagents-hover-project' || viewport.kind === 'subagents-hover') && layout.subagentCountGeometry?.current) {
    const current = layout.subagentCountGeometry.current;
    const channelMatch = current.rowBackground?.match(/\d+(?:\.\d+)?/gu)?.slice(0, 3).map(Number) ?? [];
    const backgroundChannel = channelMatch.length ? Math.max(...channelMatch) : 0;
    const rowBounds = { top: current.rowTop, bottom: current.rowBottom };
    const verticalBleed = viewport.kind === 'subagents-hover' ? 0 : 3;
    current.paintedInk = {
      icon: scanPaintedInk({ left: current.iconLeft, right: current.iconRight, top: current.iconTop, bottom: current.iconBottom }, rowBounds, backgroundChannel, verticalBleed),
      count: scanPaintedInk({ left: current.countLeft, right: current.countRight, top: current.countTop, bottom: current.countBottom }, rowBounds, backgroundChannel, verticalBleed),
      titleLead: scanPaintedInk({ left: current.titleLeadGlyphLeft, right: current.titleLeadGlyphRight, top: current.titleLeadGlyphTop, bottom: current.titleLeadGlyphBottom }, rowBounds, backgroundChannel),
      spinner: scanPaintedInk({ left: current.spinnerLeft, right: current.spinnerRight, top: current.spinnerTop, bottom: current.spinnerBottom }, rowBounds, backgroundChannel),
    };
  }
  if (viewport.kind === 'subagents' && layout.subagentDividerOverlap) {
    const samplePixel = (x, y) => [...image.crop({ x: Math.floor(x), y: Math.floor(y), width: 1, height: 1 }).toBitmap().subarray(0, 4)];
    const { lineX, sampleY, outsideY } = layout.subagentDividerOverlap;
    layout.subagentDividerOverlap.pixels = {
      outsideLine: samplePixel(lineX, outsideY),
      outsideBeside: samplePixel(lineX + 2, outsideY),
      insideLine: samplePixel(lineX, sampleY),
      insideBeside: samplePixel(lineX + 2, sampleY),
    };

    const pointFor = async (selector) => await window.webContents.executeJavaScript(`(() => {
      const bounds = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
      return bounds ? { x: Math.round(bounds.left + bounds.width / 2), y: Math.round(bounds.top + bounds.height / 2) } : null;
    })()`, true);
    const clickAt = (point) => {
      if (!point) throw new Error('Sub-agent interaction target is missing');
      window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
      window.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      window.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    };
    const waitFor = async (predicate, message) => {
      const started = Date.now();
      while (Date.now() - started <= 4_000) {
        const result = await window.webContents.executeJavaScript(predicate, true);
        if (result) return result;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      throw new Error(message);
    };
    const parentTitle = await window.webContents.executeJavaScript(`document.querySelector('.workspace-title h1')?.textContent?.trim() ?? ''`, true);
    clickAt(await pointFor('.session-subagents-popover > button'));
    const childTitle = await waitFor(`(() => {
      const title = document.querySelector('.workspace-title h1')?.textContent?.trim() ?? '';
      return !document.querySelector('.session-subagents-popover') && title && title !== ${JSON.stringify(parentTitle)} ? title : '';
    })()`, 'Portaled child row did not open its task');

    clickAt(await pointFor('[data-session-id="desktop-harness"] > .session-row'));
    await waitFor(`document.querySelector('.workspace-title h1')?.textContent?.trim() === ${JSON.stringify(parentTitle)}`, 'Parent task did not reopen');
    clickAt(await pointFor('.session-subagents-trigger'));
    await waitFor(`Boolean(document.querySelector('.session-subagents-popover'))`, 'Sub-agent panel did not reopen for outside-click QA');
    clickAt(await pointFor('.workspace-title'));
    const outsideDismissed = await waitFor(`!document.querySelector('.session-subagents-popover')`, 'Outside click did not dismiss the portaled sub-agent panel');

    clickAt(await pointFor('.session-subagents-trigger'));
    await waitFor(`Boolean(document.querySelector('.session-subagents-popover'))`, 'Sub-agent panel did not reopen for Escape QA');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    const escapeDismissed = await waitFor(`!document.querySelector('.session-subagents-popover')`, 'Escape did not dismiss the portaled sub-agent panel');
    const focusRestored = await waitFor(`document.activeElement?.classList.contains('session-subagents-trigger')`, 'Escape did not restore focus to the sub-agent trigger');
    layout.subagentInteractions = { childOpened: Boolean(childTitle), outsideDismissed: Boolean(outsideDismissed), escapeDismissed: Boolean(escapeDismissed), focusRestored: Boolean(focusRestored) };
  }
  await writeFile(path.join(outputDirectory, `${viewport.name}.png`), image.toPNG());
  await writeFile(path.join(outputDirectory, `${viewport.name}.json`), `${JSON.stringify(layout, null, 2)}\n`);
  capturedLayouts.set(viewport.name, { viewport, layout });

  assert.ok(layout.rootChildren > 0, `${viewport.name}: empty renderer root`);
  assert.ok(layout.rootTextLength > 80, `${viewport.name}: renderer content did not load`);
  assert.equal(layout.appReady, true, `${viewport.name}: desktop shell did not finish loading`);
  assert.equal(layout.loading, false, `${viewport.name}: loading state remained visible`);
  assert.equal(layout.expectedStateReady, true, `${viewport.name}: expected ${viewport.selector} state is missing`);
  const thinExpectedState = viewport.selector.includes('progress') || viewport.kind === 'dictation-hover' || viewport.kind === 'sidebar-resized' || viewport.kind === 'wallet-tooltip';
  const expectedStateMinimumWidth = viewport.kind === 'sidebar-resized' ? 8 : thinExpectedState ? 20 : 40;
  assert.ok(layout.expectedStateBounds?.width >= expectedStateMinimumWidth && layout.expectedStateBounds?.height > (thinExpectedState ? 1 : 20), `${viewport.name}: expected ${viewport.selector} state has unusable bounds`);
  if (viewport.kind === 'dashboard') {
    assert.equal(layout.dashboardDefault?.dashboard, true, `${viewport.name}: startup did not remain on the real Dashboard`);
    assert.equal(layout.dashboardDefault?.workspace, false, `${viewport.name}: a task workspace replaced the Dashboard`);
    assert.equal(layout.dashboardDefault?.chooseTaskText, false, `${viewport.name}: obsolete choose-task copy returned`);
    assert.equal(layout.dashboardDefault?.dashboardTitle, 'Dashboard', `${viewport.name}: primary Dashboard title is missing`);
    assert.equal(layout.dashboardDefault?.recentTitle, 'Recent tasks', `${viewport.name}: Recent tasks title is missing`);
    assert.deepEqual(layout.dashboardDefault?.decorativeCopy, [], `${viewport.name}: removed dashboard framing copy returned`);
    const dashboardGeometry = layout.dashboardDefault;
    assert.ok(dashboardGeometry?.headingBounds && dashboardGeometry.gridBounds && dashboardGeometry.sectionTitleBounds && dashboardGeometry.recentTableBounds, `${viewport.name}: dashboard geometry is incomplete`);
    assert.ok(dashboardGeometry.headingBounds.left >= 0 && dashboardGeometry.headingBounds.right <= layout.viewport.width + 1, `${viewport.name}: dashboard header escapes the viewport`);
    const dashboardHeaderButtonHidden = layout.viewport.width <= 900 && layout.viewport.width > 780;
    if (dashboardHeaderButtonHidden) {
      assert.equal(dashboardGeometry.newTaskBounds, null, `${viewport.name}: duplicate New task button returned beside the visible sidebar action`);
    } else {
      assert.ok(dashboardGeometry.newTaskBounds, `${viewport.name}: New task is missing when the sidebar action is unavailable`);
      assert.ok(dashboardGeometry.newTaskBounds.left >= dashboardGeometry.headingBounds.left && dashboardGeometry.newTaskBounds.right <= dashboardGeometry.headingBounds.right, `${viewport.name}: New task escaped the dashboard header`);
      const newTaskGeometry = dashboardGeometry.newTaskGeometry;
      assert.ok(newTaskGeometry, `${viewport.name}: New task alignment geometry is missing`);
      assert.ok(dashboardGeometry.persistentNewTaskBounds, `${viewport.name}: preferred top-left New task geometry is missing`);
      assert.ok(Math.abs(newTaskGeometry.width - dashboardGeometry.persistentNewTaskBounds.width) <= .75, `${viewport.name}: Dashboard New task does not match the preferred top-left width`);
      assert.ok(Math.abs(newTaskGeometry.height - dashboardGeometry.persistentNewTaskBounds.height) <= .75, `${viewport.name}: Dashboard New task does not match the preferred top-left height`);
      assert.ok(Math.abs(newTaskGeometry.labelCenterDeltaX) <= .75 && Math.abs(newTaskGeometry.labelCenterDeltaY) <= .75, `${viewport.name}: New task label is not independently centred`);
      assert.ok(Math.abs(newTaskGeometry.iconCenterDeltaY) <= .75, `${viewport.name}: New task plus is not vertically centred`);
      assert.ok(newTaskGeometry.iconToLabelGap >= 7 && newTaskGeometry.iconToLabelGap <= 9, `${viewport.name}: New task plus does not keep the top-left eight-pixel label gap`);
      assert.ok(newTaskGeometry.iconWidth >= 16.5 && newTaskGeometry.iconHeight >= 16.5, `${viewport.name}: New task plus is smaller than the top-left icon`);
      assert.equal(newTaskGeometry.labelFontSize, 13, `${viewport.name}: New task label does not match the top-left size`);
      assert.ok(newTaskGeometry.labelFontWeight >= 700, `${viewport.name}: New task label does not match the top-left weight`);
    }
    assert.ok(dashboardGeometry.headingBounds.bottom < dashboardGeometry.gridBounds.top, `${viewport.name}: dashboard cards overlap the compacted header`);
    assert.ok(dashboardGeometry.sectionTitleBounds.bottom < dashboardGeometry.recentTableBounds.top, `${viewport.name}: Recent tasks title overlaps the table`);
    assert.equal(dashboardGeometry.attentionCount?.text, '0', `${viewport.name}: attention count fixture is missing`);
    assert.ok((dashboardGeometry.attentionCount?.fontSize ?? 0) >= 12, `${viewport.name}: attention count remains too small`);
    assert.equal(dashboardGeometry.attentionCount?.borderTopWidth, '0px', `${viewport.name}: attention count remains boxed`);
    assert.equal(dashboardGeometry.attentionCount?.borderRadius, '0px', `${viewport.name}: attention count remains circled`);
    assert.equal(dashboardGeometry.attentionCount?.background, 'rgba(0, 0, 0, 0)', `${viewport.name}: attention count acquired a decorative fill`);
    assert.equal(dashboardGeometry.clearState?.borderTopWidth, '0px', `${viewport.name}: clear-state shield remains boxed`);
    assert.equal(dashboardGeometry.clearState?.borderRadius, '0px', `${viewport.name}: clear-state shield wrapper remains rounded`);
    assert.equal(dashboardGeometry.clearState?.background, 'rgba(0, 0, 0, 0)', `${viewport.name}: clear-state shield wrapper retained a decorative fill`);
    assert.ok((dashboardGeometry.clearState?.shieldWidth ?? 0) >= 29.5 && (dashboardGeometry.clearState?.shieldHeight ?? 0) >= 29.5, `${viewport.name}: clear-state shield remains too small`);
    assert.equal(dashboardGeometry.activeTask?.clickablePanel, true, `${viewport.name}: active task card lost its full-panel button`);
    assert.equal(dashboardGeometry.activeTask?.footerDirectChevronCount, 0, `${viewport.name}: active task card retained a fake edge chevron`);
    assert.ok((dashboardGeometry.activeTask?.projectFontSize ?? 0) >= 11.5 && (dashboardGeometry.activeTask?.timeFontSize ?? 0) >= 11.5, `${viewport.name}: active project or updated time remains too small`);
    assert.ok((dashboardGeometry.activeTask?.folderWidth ?? 0) >= 15.5 && (dashboardGeometry.activeTask?.folderHeight ?? 0) >= 15.5, `${viewport.name}: active project folder icon remains too small`);
    assert.ok((dashboardGeometry.recentTask?.logoWidth ?? 0) >= 27.5 && (dashboardGeometry.recentTask?.logoHeight ?? 0) >= 27.5, `${viewport.name}: recent task provider mark remains too small`);
    assert.ok((dashboardGeometry.recentTask?.titleFontSize ?? 0) >= 12.5, `${viewport.name}: recent task title remains too small`);
  }
  if (viewport.kind === 'slash-command') {
    assert.equal(layout.slashCommandPalette?.query, '/', `${viewport.name}: opening the palette changed the draft`);
    assert.deepEqual(layout.slashCommandPalette?.commands, [
      '/simplifyShorten the previous or upcoming answerEnter',
      '/meshSend this turn to other coding tools togetherEnter',
      "/goalSet or manage this task's goalEnter",
      '/earsConfigure dictation preprocessingEnter',
      '/eyesChoose the model that reads imagesEnter',
    ], `${viewport.name}: palette does not show the supported command catalogue`);
    assert.equal(layout.slashCommandPalette?.selected, layout.slashCommandPalette?.commands[0], `${viewport.name}: top command is not selected by default`);
    assert.ok((layout.slashCommandPalette?.width ?? Infinity) <= 520.5, `${viewport.name}: command palette remains wider than its useful content`);
    assert.equal(layout.slashCommandPalette?.completeRows, 5, `${viewport.name}: five complete command rows are not visible`);
    assert.ok((layout.slashCommandPalette?.scrollHeight ?? Infinity) <= (layout.slashCommandPalette?.clientHeight ?? 0) + 1, `${viewport.name}: five commands introduce premature scrolling`);
    assert.ok(layout.slashCommandPalette?.rowHeights?.every((height) => Math.abs(height - 43) <= .5), `${viewport.name}: command rows do not keep whole-row geometry`);
    assert.ok(layout.slashCommandPalette?.descriptionSizes?.every((size) => size >= 12.5), `${viewport.name}: command descriptions remain miniature`);
    assert.ok(layout.slashCommandPalette?.hintSizes?.every((size) => size >= 12.5), `${viewport.name}: Enter hints remain miniature`);
    assert.equal(layout.slashCommandPalette?.iconPath, 'm15.5 4.5-7 15', `${viewport.name}: slash commands still use a platform Command glyph`);
  }
  if (viewport.kind === 'mesh-quick') {
    const mesh = layout.meshQuickChooser;
    assert.ok(mesh, `${viewport.name}: Mesh quick chooser did not open`);
    assert.equal(mesh?.query, 'Compare this /mesh carefully', `${viewport.name}: opening Mesh changed surrounding draft text`);
    assert.ok((mesh?.rowCount ?? 0) >= 2, `${viewport.name}: Mesh quick chooser has no useful target list`);
    assert.equal(mesh?.selectedRows, 1, `${viewport.name}: Mesh quick chooser does not have exactly one keyboard highlight`);
    assert.ok(mesh?.rowHeights?.every((height) => height >= 43.5), `${viewport.name}: Mesh quick rows lost their comfortable selection height`);
    assert.ok(mesh?.rowColumns?.every((row) => row.buttonCount === 2 && row.mainWidth > row.detailsWidth && Math.abs(row.detailsWidth - 34) <= .5), `${viewport.name}: Mesh quick and detail targets are not cleanly split`);
    assert.ok(mesh?.providerLabels?.every(Boolean), `${viewport.name}: Mesh quick chooser contains an unnamed harness`);
    assert.ok(mesh?.resolvedChoices?.every((label) => label.includes(' · ')), `${viewport.name}: Mesh quick chooser hides model or reasoning`);
    assert.ok(mesh?.resolvedChoices?.every((label) => !label.includes('Harness reasoning')), `${viewport.name}: Mesh quick chooser invents an ambiguous reasoning value`);
    assert.ok(mesh?.resolvedChoiceFontSizes?.every((size) => size >= 11), `${viewport.name}: Mesh model and reasoning labels are too small`);
    assert.ok((mesh?.bounds.width ?? Infinity) <= 440.5, `${viewport.name}: Mesh quick chooser is wider than its useful content`);
    assert.equal(mesh?.horizontalOverflow, false, `${viewport.name}: Mesh quick chooser overflows horizontally`);
    assert.ok((mesh?.bounds.left ?? -1) >= 0 && (mesh?.bounds.right ?? Infinity) <= (mesh?.viewport.width ?? 0), `${viewport.name}: Mesh quick chooser escapes the horizontal viewport`);
    assert.ok((mesh?.bounds.top ?? -1) >= 0 && (mesh?.bounds.bottom ?? Infinity) <= (mesh?.viewport.height ?? 0), `${viewport.name}: Mesh quick chooser escapes the vertical viewport`);
  }
  if (viewport.kind === 'mesh-details') {
    const mesh = layout.meshDetails;
    assert.ok(mesh, `${viewport.name}: Mesh model and reasoning picker did not open`);
    assert.equal(mesh?.reasoningInsideScroll, false, `${viewport.name}: Mesh reasoning is still inside the scrolling model list`);
    assert.ok((mesh?.modelCount ?? 0) >= 1 && (mesh?.completeModels ?? 0) >= 1, `${viewport.name}: Mesh model list has no complete visible model row`);
    assert.ok((mesh?.effortLabels?.length ?? 0) >= 1 && mesh?.effortLabels?.every(Boolean), `${viewport.name}: Mesh reasoning has no visible concrete choices`);
    assert.equal(mesh?.selectedEfforts, 1, `${viewport.name}: Mesh reasoning does not expose exactly one current choice`);
    assert.equal(mesh?.effortsFullyVisible, true, `${viewport.name}: A Mesh reasoning choice is clipped`);
    assert.ok((mesh?.scrollBounds.bottom ?? Infinity) <= (mesh?.reasoningBounds.top ?? -Infinity) + .5, `${viewport.name}: Scrolling models overlap the fixed reasoning section`);
    assert.ok((mesh?.reasoningBounds.bottom ?? Infinity) <= (mesh?.footerBounds.top ?? -Infinity) + .5, `${viewport.name}: Reasoning overlaps the picker actions`);
    assert.equal(mesh?.horizontalOverflow, false, `${viewport.name}: Mesh model and reasoning picker overflows horizontally`);
    assert.ok((mesh?.bounds.left ?? -1) >= 0 && (mesh?.bounds.right ?? Infinity) <= (mesh?.viewport.width ?? 0), `${viewport.name}: Mesh model picker escapes the horizontal viewport`);
    assert.ok((mesh?.bounds.top ?? -1) >= 0 && (mesh?.bounds.bottom ?? Infinity) <= (mesh?.viewport.height ?? 0), `${viewport.name}: Mesh model picker escapes the vertical viewport`);
  }
  if (viewport.kind === 'mesh-widgets') {
    const mesh = layout.meshWidgets;
    const expectedColors = { opencode: 'rgb(128, 199, 161)', codex: 'rgb(240, 241, 238)', grok: 'rgb(137, 140, 135)' };
    const providerIds = { OpenCode: 'opencode', Codex: 'codex', 'Grok Build': 'grok' };
    const expectedProviderIds = (viewport.meshProviders ?? []).map((name) => providerIds[name]);
    assert.ok(mesh, `${viewport.name}: committed Mesh widgets did not render`);
    assert.equal(mesh?.query, 'Compare ' + viewport.meshProviders.map(() => '[mesh]m').join(' and ') + ' carefully\nSecond line stays below the target\nThird line stays below the target', `${viewport.name}: committed Mesh widgets changed the instruction`);
    assert.deepEqual(mesh?.widgets?.map((widget) => widget.providerId), expectedProviderIds, `${viewport.name}: committed Mesh widget provider order changed`);
    assert.ok(mesh?.widgets?.every((widget) => widget.visible), `${viewport.name}: a committed Mesh widget is clipped`);
    assert.ok(mesh?.widgets?.every((widget) => widget.borderColor === expectedColors[widget.providerId]), `${viewport.name}: provider colour must remain on the bubble outline`);
  }
  if (viewport.kind === 'settings') {
    assert.ok(layout.connectorCards >= 1, `${viewport.name}: external connector details are missing`);
    assert.equal(layout.connectorSettings?.cardCount, 2, `${viewport.name}: connector group fixture is incomplete`);
    assert.equal(layout.connectorSettings?.listBorderWidth, '1px', `${viewport.name}: connectors have no shared outer boundary`);
    assert.equal(layout.connectorSettings?.listBorderRadius, '8px', `${viewport.name}: connector group corners changed`);
    assert.equal(layout.connectorSettings?.listOverflow, 'hidden', `${viewport.name}: connector dividers can escape the outer corners`);
    assert.ok(layout.connectorSettings?.cards?.every((card) => card.borderRadius === '0px'), `${viewport.name}: individual connectors still look like separate rounded tiles`);
    assert.equal(layout.connectorSettings?.cards?.[0]?.borderWidth, '0px', `${viewport.name}: first connector retained its own outer border`);
    assert.equal(layout.connectorSettings?.cards?.[1]?.borderTopWidth, '1px', `${viewport.name}: connector rows have no shared-list divider`);
    assert.ok(layout.connectorSettings?.cards?.every((card) => card.disclosure === 'Details'), `${viewport.name}: connector disclosure is still an unlabeled chevron`);
  }
  if (viewport.kind === 'settings-defaults') {
    assert.ok(layout.agentDefaults?.rows >= 1, `${viewport.name}: agent defaults are missing`);
    assert.ok(layout.agentDefaults?.selects >= 2, `${viewport.name}: concrete model and reasoning controls are missing`);
    assert.doesNotMatch(layout.agentDefaults?.text ?? '', /\bAuto\b/u, `${viewport.name}: ambiguous Auto reasoning is visible`);
    assert.doesNotMatch(layout.agentDefaults?.text ?? '', /Managed by agent/u, `${viewport.name}: unavailable reasoning is presented as a fake setting`);
    assert.match(layout.agentDefaults?.text ?? '', /Direct API[\s\S]*API key required[\s\S]*Model[\s\S]*API key required[\s\S]*Set up/u, `${viewport.name}: missing Direct API credentials have no truthful setting row and remedy`);
    assert.match(layout.agentDefaults?.text ?? '', /OpenCode[\s\S]*Model[\s\S]*Big Pickle[\s\S]*OpenCode/u, `${viewport.name}: the selected OpenCode route is not explicit`);
    assert.match(layout.agentDefaults?.direct?.dotClass ?? '', /\baction-required\b/u, `${viewport.name}: Direct API without a verified key still claims a healthy connection`);
    assert.equal(layout.agentDefaults?.direct?.dotColor, 'rgb(188, 147, 82)', `${viewport.name}: Direct API action-required status is not amber`);
    assert.equal(layout.agentDefaults?.direct?.modelLabel, 'Model', `${viewport.name}: Direct API setup state abandoned the normal Model grid`);
    assert.equal(layout.agentDefaults?.direct?.requiredText, 'API key required', `${viewport.name}: Direct API setup state is ambiguous`);
    assert.equal(layout.agentDefaults?.direct?.action, 'Set up', `${viewport.name}: Direct API setup action is missing or vague`);
    assert.equal(layout.directSetup?.opened, true, `${viewport.name}: Direct API Set up did not open the existing wallet surface`);
    assert.equal(layout.directSetup?.directForm, true, `${viewport.name}: Direct API Set up opened no real credential form`);
    assert.match(layout.directSetup?.text ?? '', /Direct API configuration[\s\S]*API key/u, `${viewport.name}: Direct API Set up opened the wrong wallet view`);
    assert.ok(layout.agentDefaults?.rowReadings?.every((row) => (row.logoWidth ?? 0) >= 33.5 && (row.logoHeight ?? 0) >= 33.5), `${viewport.name}: provider marks remain too small in the agent list`);
    if (viewport.width > 900) assert.ok(layout.agentDefaults?.rowReadings?.every((row) => (row.controlsWidth ?? Infinity) <= 360.5), `${viewport.name}: agent setting controls still stretch past their useful width`);
    for (const row of layout.agentDefaults?.rowReadings ?? []) {
      if (row.settings.length < 2) continue;
      const fieldLefts = row.settings.map((setting) => setting.fieldLeft).filter(Number.isFinite);
      assert.ok(Math.max(...fieldLefts) - Math.min(...fieldLefts) <= .5, `${viewport.name}: ${row.name} Model and Reasoning values no longer share one x-coordinate`);
      const chevrons = row.settings.filter((setting) => Number.isFinite(setting.chevronRight));
      assert.ok(chevrons.every((setting) => Math.abs(setting.chevronWidth - 13) <= .5), `${viewport.name}: ${row.name} chevron width changed`);
      assert.ok(Math.max(...chevrons.map((setting) => setting.chevronRight)) - Math.min(...chevrons.map((setting) => setting.chevronRight)) <= .5, `${viewport.name}: ${row.name} Model and Reasoning chevrons no longer align`);
    }
    if (viewport.width > 900) assert.ok(Math.abs(layout.agentDefaults?.closeHeadingCenterDelta ?? Infinity) <= 7, `${viewport.name}: Settings close control is detached from the Agents heading`);
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
    assert.match(layout.providerSettingsText ?? '', /Direct API[\s\S]*API key required[\s\S]*Set up/u, `${viewport.name}: Direct API action-required state is unclear`);
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
    if (layout.composerAlignment.sendIconDelta !== null) assert.ok(Math.abs(layout.composerAlignment.sendIconDelta - 2) <= .25, `${viewport.name}: Send arrow is not shifted two pixels right of geometric centre`);
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
    if (!layout.dictationShape.modalOpen) {
      assert.equal(layout.dictationShape.upperHitIsMain, true, `${viewport.name}: upper microphone hit region does not start dictation`);
      assert.equal(layout.dictationShape.lowerHitIsSource, true, `${viewport.name}: lower crescent hit region does not open sources`);
    }
    if (viewport.kind === 'dictation-hover') assert.equal(layout.dictationShape.fill.background, 'rgb(58, 58, 55)', `${viewport.name}: dictation selector hover fill is not visible`);
  }
  if (viewport.kind === 'dictation-recording') {
    const recording = layout.dictationRecording;
    assert.ok(recording, `${viewport.name}: active recording geometry is missing`);
    assert.equal(recording.upperStopCount, 0, `${viewport.name}: the waveform retained a redundant upper Stop control`);
    assert.equal(recording.dedicatedStopCount, 1, `${viewport.name}: recording does not expose exactly one dedicated lower Stop control`);
    assert.equal(recording.sourceMenuCount, 0, `${viewport.name}: the dictation-source crescent still intercepts the lower Stop control`);
    assert.equal(recording.stripButtonCount, 0, `${viewport.name}: the live strip retained button-sized timer-side space`);
    assert.equal(recording.attachmentCount, 4, `${viewport.name}: dense attachment fixture is incomplete`);
    assert.ok(recording.textareaScrollHeight > recording.textareaClientHeight + 1, `${viewport.name}: long recording text does not scroll internally`);
    assert.equal(recording.textareaOverflowY, 'auto', `${viewport.name}: long recording text escapes instead of using its own scrollbar`);
    assert.ok(Object.values(recording.contained).every(Boolean), `${viewport.name}: recording content or ellipsis/Stop/Send controls escape the composer: ${JSON.stringify(recording.contained)}`);
    assert.ok(recording.timerRightGap >= 9 && recording.timerRightGap <= 11, `${viewport.name}: removing the upper Stop did not reclaim the timer-side space`);
    assert.equal(recording.lowerHitIsStop, true, `${viewport.name}: the lower part of the red control does not stop recording`);
    assert.match(recording.sendLabel ?? '', /Stop dictation and send/u, `${viewport.name}: recording lost the separate combined Send action`);
    assert.equal(recording.stopBackground, 'rgb(90, 50, 48)', `${viewport.name}: hovering Stop does not deepen the red fill`);
    assert.equal(recording.stopColor, 'rgb(255, 212, 207)', `${viewport.name}: hovering Stop does not retain a coherent red-tinted foreground`);
    assert.match(recording.stopBoxShadow, /rgba\(242, 118, 108, 0\.14\).*0px 0px 0px 4px/u, `${viewport.name}: hovering Stop does not strengthen the surrounding red halo`);
    assert.equal(recording.connector.content, 'none', `${viewport.name}: the recording strip still paints a connector cone into Stop`);
    assert.equal(recording.connector.background, 'rgba(0, 0, 0, 0)', `${viewport.name}: the removed connector still leaves a painted background`);
    assert.equal(recording.connector.clipPath, 'none', `${viewport.name}: the removed connector still retains tapered geometry`);
  }
  if (viewport.kind === 'composer-model') {
    assert.ok(layout.modelCatalog, `${viewport.name}: model picker did not open`);
    assert.doesNotMatch(layout.modelCatalog?.text ?? '', /\bDefault\b/u, `${viewport.name}: Default is still stamped on model rows`);
    assert.ok((layout.modelCatalog?.headings ?? []).some((heading) => heading === 'OpenAI Codex' || heading.includes('Codex')), `${viewport.name}: OpenAI Codex group is missing`);
    assert.ok((layout.modelCatalog?.headings ?? []).includes('OpenCode'), `${viewport.name}: OpenCode-native routes are not identified`);
    assert.ok((layout.modelCatalog?.headings ?? []).includes('OpenCode Go via OpenCode'), `${viewport.name}: OpenCode Go routes are not grouped under their reported upstream`);
    assert.ok((layout.modelCatalog?.headings ?? []).includes('DeepSeek via OpenCode'), `${viewport.name}: DeepSeek routes are not grouped under their reported upstream`);
    assert.ok(Math.abs(layout.modelCatalog?.rightEdgeDelta ?? Infinity) <= .5, `${viewport.name}: model panel no longer shares the trigger's right edge`);
    assert.ok(Math.abs((layout.modelCatalog?.triggerGap ?? Infinity) - 8) <= .5, `${viewport.name}: model panel no longer keeps its 8px trigger gap`);
    assert.equal(layout.modelCatalog?.completeRowViewport, true, `${viewport.name}: compact model list is not using whole-row viewport measurement`);
    assert.ok((layout.modelCatalog?.visibleRows ?? 0) >= 1, `${viewport.name}: model list has no visible rows`);
    assert.equal(layout.modelCatalog?.partialRows, 0, `${viewport.name}: a model row is clipped at the scroll viewport edge`);
    assert.ok((layout.modelCatalog?.bottomInset ?? 0) >= 6.5, `${viewport.name}: model list lost its bottom inset`);
    assert.ok(layout.modelCatalog?.rowMarks?.every((mark) => Math.abs(mark.width - 18) <= .5 && Math.abs(mark.height - 18) <= .5 && mark.fontSize >= 11), `${viewport.name}: model-row provider marks are not fixed, readable 18px identities`);
    assert.equal(layout.modelCatalog?.recentSelected, 0, `${viewport.name}: Recent duplicates canonical selection fill`);
    assert.equal(layout.modelCatalog?.recentChecks, 0, `${viewport.name}: Recent duplicates the canonical selection check`);
    assert.equal(layout.modelCatalog?.canonicalSelected, 1, `${viewport.name}: canonical model selection is missing or duplicated`);
    assert.equal(layout.modelCatalog?.canonicalChecks, 1, `${viewport.name}: canonical model check is missing or duplicated`);
  }
  if (viewport.kind === 'dictation-audio-source') {
    assert.equal(layout.dictationAudioSource?.mp3Label, 'MP3', `${viewport.name}: MP3 is not listed under the dictate crescent`);
    assert.equal(layout.dictationAudioSource?.checked, 'true', `${viewport.name}: MP3 is not the selected dictation source`);
  }
  if (viewport.kind === 'dictation-saved-key') {
    assert.match(layout.dictationSavedKey?.text ?? '', /Manage API key.*Replace or remove the saved key/u, `${viewport.name}: saved-key action copy is unclear`);
    assert.ok((layout.dictationSavedKey?.labelWidth ?? 0) >= 200, `${viewport.name}: saved-key label collapsed into the provider-logo column`);
    assert.ok(Math.abs(layout.dictationSavedKey?.labelLeftDelta ?? 999) <= 1, `${viewport.name}: saved-key label is not aligned with provider labels`);
    assert.ok((layout.dictationSavedKey?.strongLines ?? 99) <= 1.1, `${viewport.name}: saved-key action title wrapped vertically`);
    assert.ok((layout.dictationSavedKey?.smallLines ?? 99) <= 1.1, `${viewport.name}: saved-key action guidance wrapped vertically`);
    assert.ok((layout.dictationSavedKey?.arrowRightGap ?? 0) >= 8, `${viewport.name}: saved-key chevron is not held in a stable trailing slot`);
    assert.ok((layout.dictationSavedKey?.rowBottomGap ?? -1) >= 0, `${viewport.name}: saved-key row is clipped by the popover`);
    assert.ok((layout.dictationSavedKey?.rowScrollWidth ?? 1) <= (layout.dictationSavedKey?.rowClientWidth ?? 0) + 1, `${viewport.name}: saved-key row overflows horizontally`);
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
    assert.equal(layout.userAttachment.compactImageOnlyLayout, false, `${viewport.name}: a mixed text-and-image message was incorrectly shrunk into the image-only layout`);
    assert.ok(layout.userAttachment.galleryBottom <= layout.userAttachment.bodyTop + .5, `${viewport.name}: image thumbnail is not above the user request`);
    assert.equal(layout.userAttachment.lightboxOpened, true, `${viewport.name}: clicking the image did not open the large preview`);
    assert.doesNotMatch(layout.userAttachment.messageText, /Files mentioned by the user|My request|Distinguish instructions|<image\b/iu, `${viewport.name}: attachment transport metadata leaked into the message`);
  }
  if (viewport.kind === 'user-image-only') {
    assert.ok(layout.userImageOnly?.single, `${viewport.name}: single image-only bubble is missing`);
    assert.ok(layout.userImageOnly?.many, `${viewport.name}: multi-image bubble is missing`);
    assert.equal(layout.userImageOnly.single.tiles.length, 1, `${viewport.name}: single image count changed`);
    assert.equal(layout.userImageOnly.many.tiles.length, 5, `${viewport.name}: multi-image count changed`);
    assert.equal(layout.userImageOnly.many.unavailable, 1, `${viewport.name}: unavailable image fixture did not remain in the gallery`);
    assert.ok(layout.userImageOnly.single.gallery.width <= 126, `${viewport.name}: lone image bubble is not compact`);
    assert.ok(layout.userImageOnly.many.gallery.width <= 237, `${viewport.name}: multi-image bubble exceeds its compact footprint`);
    assert.ok(Math.abs(layout.userImageOnly.single.gallery.right - layout.userImageOnly.single.contentRight) <= 1, `${viewport.name}: lone image bubble is not right aligned`);
    assert.ok(Math.abs(layout.userImageOnly.many.gallery.right - layout.userImageOnly.many.contentRight) <= 1, `${viewport.name}: multi-image bubble is not right aligned`);
    assert.equal(layout.userImageOnly.single.background, 'rgb(43, 43, 41)', `${viewport.name}: image-only message has no user bubble surface`);
    assert.equal(layout.userImageOnly.single.borderWidth, '1px', `${viewport.name}: image-only message bubble boundary is missing`);
    assert.deepEqual([...new Set(layout.userImageOnly.many.tiles.map((tile) => Math.round(tile.top)))].length, 2, `${viewport.name}: five images should wrap into two compact rows`);
    assert.ok(layout.userImageOnly.many.tiles.every((tile) => tile.width >= 48 && tile.height >= 48), `${viewport.name}: a multi-image target became too small`);
    assert.ok(layout.userImageOnly.many.tiles.every((tile) => Math.round(tile.height) === 48), `${viewport.name}: unavailable image hydration changed gallery geometry`);
    assert.equal(layout.userImageOnly.lightboxOpened, true, `${viewport.name}: image-only thumbnail did not open the lightbox`);
  }
  if (viewport.kind === 'local-model-image') {
    assert.ok(layout.localModelImage, `${viewport.name}: model-created local image widget is missing`);
    assert.equal(layout.localModelImage.widgets, 1, `${viewport.name}: model-created local image did not render exactly once`);
    assert.equal(layout.localModelImage.unavailable, 0, `${viewport.name}: loaded local image fell back to alt text`);
    assert.equal(layout.localModelImage.alt, 'Model-created UI preview', `${viewport.name}: local image lost its accessible label`);
    assert.ok((layout.localModelImage.proof?.naturalWidth ?? 0) > 0, `${viewport.name}: local image has no decoded pixels`);
    assert.match(layout.localModelImage.proof?.source ?? '', /^tethoq-media:\/\/local\//u, `${viewport.name}: local image bypassed the safe media scheme`);
    assert.equal(layout.localModelImage.proof?.lightboxOpened, true, `${viewport.name}: local image widget did not open the lightbox`);
  }
  if (viewport.kind === 'queue-strip' || viewport.kind === 'queue-new-task' || viewport.kind === 'side-chat') {
    assert.ok(layout.selectedStateBounds, `${viewport.name}: compact ${viewport.kind} surface is missing`);
    assert.ok(layout.selectedStateBounds.x >= 0 && layout.selectedStateBounds.y >= 0 && layout.selectedStateBounds.x + layout.selectedStateBounds.width <= layout.viewport.width + 1 && layout.selectedStateBounds.bottom <= layout.viewport.height + 1, `${viewport.name}: compact ${viewport.kind} surface is clipped`);
  }
  if (viewport.kind === 'side-chat') {
    assert.ok(layout.sideChat, `${viewport.name}: side-chat geometry is missing`);
    assert.ok(Math.abs(layout.sideChat.bottomGap) <= .5, `${viewport.name}: composer leaves an empty strip below it`);
    assert.equal(layout.sideChat.headerGridRow, '1', `${viewport.name}: header is not pinned to row 1`);
    assert.equal(layout.sideChat.transcriptGridRow, '2', `${viewport.name}: transcript is not pinned to row 2`);
    assert.equal(layout.sideChat.composerGridRow, '4', `${viewport.name}: composer is not pinned to the final row`);
  }
  if (viewport.kind === 'side-chat-rail') {
    assert.ok(layout.sideChatRail, `${viewport.name}: joined side-chat rail is missing`);
    assert.ok(layout.sideChatRail.childCount >= 2, `${viewport.name}: multi-child side-chat stack is missing`);
    assert.ok(Math.abs(layout.sideChatRail.joinGap) <= .5, `${viewport.name}: side-chat stack is detached from its parent`);
    assert.ok(Math.abs(layout.sideChatRail.shoulderJoinGap) <= .5, `${viewport.name}: outward collapse tab is detached from the side-chat stack`);
    assert.ok(Math.abs(layout.sideChatRail.shoulderTopGap) <= .5, `${viewport.name}: outward collapse tab does not share the stack's upper join`);
    assert.equal(layout.sideChatRail.shoulderWidth, 24, `${viewport.name}: outward collapse tab is not a compact control`);
    assert.equal(layout.sideChatRail.shoulderAriaExpanded, 'true', `${viewport.name}: reopened side-chat tab does not announce the visible stack`);
    assert.equal(layout.sideChatRail.shoulderRadius, '0px 0px 0px 7px', `${viewport.name}: side-chat tab folds inward instead of outward`);
    assert.ok(layout.sideChatRail.siblingGaps.every((gap) => Math.abs(gap) <= .5), `${viewport.name}: side-chat siblings retain a visible gap`);
    assert.equal(layout.sideChatRail.parentBottomRightRadius, '0px', `${viewport.name}: parent corner does not fit the child stack`);
    assert.equal(layout.sideChatRail.stackBorderRadius, '0px 0px 7px 7px', `${viewport.name}: child stack retains an inward upper corner`);
    assert.ok(layout.sideChatRail.childRadii.every((radius) => radius === '0px'), `${viewport.name}: child rows still look like separate rounded cards`);
    assert.equal(layout.sideChatRail.activeBackground, layout.sideChatRail.inactiveBackground, `${viewport.name}: active child has an unexplained full-row shade`);
    assert.equal(layout.sideChatRail.disclosureCheck?.focused, true, `${viewport.name}: side-chat disclosure cannot receive keyboard focus`);
    assert.equal(layout.sideChatRail.disclosureCheck?.collapsed, true, `${viewport.name}: side-chat disclosure did not enter its compact state`);
    assert.equal(layout.sideChatRail.disclosureCheck?.regionHidden, true, `${viewport.name}: collapsed side-chat rows remained visible`);
    assert.equal(layout.sideChatRail.disclosureCheck?.collapsedHeight, 20, `${viewport.name}: collapsed side-chat tab reserves excess task-list space`);
    assert.equal(layout.sideChatRail.disclosureCheck?.activePanelSurvived, true, `${viewport.name}: collapsing the task-list rail closed the active side chat`);
    assert.ok(layout.sideChatRail.titleLane, `${viewport.name}: project title lane geometry is missing`);
    assert.ok(layout.sideChatRail.titleLane.idleTitleWidth > layout.sideChatRail.titleLane.workingTitleWidth, `${viewport.name}: idle project title still reserves spinner space`);
    assert.ok(Math.abs(layout.sideChatRail.titleLane.releasedWidth - 22) <= .5, `${viewport.name}: spinner does not reserve exactly its 16px track and 6px gap`);
    const projectSubagent = layout.sideChatRail.projectSubagent;
    assert.ok(projectSubagent, `${viewport.name}: compact project sub-agent geometry is missing`);
    const projectControl = projectSubagent.current;
    assert.ok(projectControl, `${viewport.name}: live compact sub-agent control reading is missing`);
    assert.ok(projectControl.trigger.left >= projectSubagent.clip.left - .5, `${viewport.name}: compact sub-agent control escapes the visible left gutter`);
    assert.ok(projectControl.icon.left >= projectSubagent.clip.left - .5, `${viewport.name}: compact generic sub-agent mark is clipped on the left`);
    assert.ok(projectControl.trigger.right <= projectSubagent.title.left + .5, `${viewport.name}: compact sub-agent control overlaps the task title`);
    assert.ok(projectSubagent.title.left - projectControl.trigger.right >= 3.5 && projectSubagent.title.left - projectControl.trigger.right <= 4.5, `${viewport.name}: compact control leaves excess space before the task title`);
    assert.ok(Math.abs(projectControl.trigger.width - 38) <= .5, `${viewport.name}: compact control no longer uses its fixed 38px geometry`);
    assert.equal(projectControl.chevrons, 0, `${viewport.name}: compact project control still paints a disclosure chevron`);
    assert.ok(Math.abs(projectControl.summary.centerY - projectSubagent.title.centerY) <= 1.5, `${viewport.name}: compact icon and count do not share the task-title line`);
    assert.ok(projectSubagent.row.right - projectSubagent.spinner.right >= 7 && projectSubagent.row.right - projectSubagent.spinner.right <= 8.5, `${viewport.name}: compact working spinner is not fixed at the row's rightmost padded edge`);
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
    const attachedQueueRow = layout.queueStrip.rows?.find((row) => row?.hasAttachments);
    const textOnlyQueueRow = layout.queueStrip.rows?.find((row) => row && !row.hasAttachments);
    assert.ok(attachedQueueRow && textOnlyQueueRow, `${viewport.name}: queued optical-alignment fixtures are incomplete`);
    assert.ok(Math.abs(textOnlyQueueRow.glyphCenterDelta) <= .75, `${viewport.name}: queued text does not sit at the row's optical centre`);
    assert.ok(Math.abs(textOnlyQueueRow.lineBoxCenterDelta) <= .75, `${viewport.name}: queued text line box is vertically off-centre`);
    const expectedAttachedQueueRowHeight = viewport.width <= 780 ? 105 : 72;
    assert.ok(Math.abs(attachedQueueRow.rowHeight - expectedAttachedQueueRowHeight) <= .5 && Math.abs(textOnlyQueueRow.rowHeight - 39) <= .5, `${viewport.name}: queued text correction changed row geometry`);
    assert.ok(attachedQueueRow.textBottomGap >= 3.5, `${viewport.name}: queued text correction crowds the attachment row edge`);
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
  if (viewport.kind === 'wallet-tooltip') {
    assert.ok(layout.walletTooltip, `${viewport.name}: wallet tooltip state is missing`);
    assert.equal(layout.walletTooltip.opacity, '1', `${viewport.name}: wallet tooltip did not finish its reveal`);
    assert.match(layout.walletTooltip.content, /wallet|account|subscription|billing/iu, `${viewport.name}: wallet tooltip lost its label`);
    assert.ok(layout.walletTooltip.titlebarZIndex > layout.walletTooltip.workspaceHeaderZIndex, `${viewport.name}: workspace still paints over the wallet tooltip`);
    assert.equal(layout.walletTooltip.color, 'rgb(217, 220, 217)', `${viewport.name}: wallet tooltip text contrast regressed`);
    assert.equal(layout.walletTooltip.background, 'rgba(23, 23, 22, 0.98)', `${viewport.name}: wallet tooltip surface is not opaque enough`);
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
      expandedAriaNow: '33',
      expandedFill: '33.4375%',
      appliedText: '96.0k',
      noteText: null,
    }, `${viewport.name}: the initial context usage and compaction threshold are not independently represented`);
    assert.equal(layout.contextCompaction?.interaction?.draft?.sliderValue, 8_000, `${viewport.name}: physical threshold drag did not reach the supported minimum`);
    assert.equal(layout.contextCompaction?.interaction?.draft?.percentText, '100%', `${viewport.name}: the compact percentage did not preview the draft threshold`);
    assert.equal(layout.contextCompaction?.interaction?.draft?.expandedFill, '33.4375%', `${viewport.name}: dragging the compaction threshold moved the context fill`);
    assert.equal(layout.contextCompaction?.interaction?.draft?.appliedText, '96.0k', `${viewport.name}: dragging falsely changed the applied threshold before Apply`);
    assert.equal(layout.contextCompaction?.interaction?.draft?.noteText, 'Applying now may compact while this turn is still running.', `${viewport.name}: active-turn threshold guidance is not concise and inline`);
    assert.deepEqual(layout.contextCompaction?.interaction?.reopened, layout.contextCompaction?.interaction?.initial, `${viewport.name}: closing without Apply did not discard the draft threshold`);
    assert.equal(layout.contextCompaction?.interaction?.applied?.sliderValue, 8_000, `${viewport.name}: Apply did not retain the chosen threshold`);
    assert.equal(layout.contextCompaction?.interaction?.applied?.percentText, '100%', `${viewport.name}: the applied percentage did not stay relative to the compaction limit`);
    assert.equal(layout.contextCompaction?.interaction?.applied?.expandedFill, '33.4375%', `${viewport.name}: applying the compaction threshold moved the context fill`);
    assert.equal(layout.contextCompaction?.interaction?.applied?.appliedText, '8.0k', `${viewport.name}: Usage did not show the bridge-confirmed applied threshold`);
  }
  if (viewport.kind === 'task-details') {
    assert.ok(layout.selectedStateBounds, `${viewport.name}: task details are missing`);
    assert.ok(layout.selectedStateBounds.x >= 0 && layout.selectedStateBounds.y >= 0 && layout.selectedStateBounds.x + layout.selectedStateBounds.width <= layout.viewport.width + 1 && layout.selectedStateBounds.bottom <= layout.viewport.height + 1, `${viewport.name}: task details are clipped`);
    assert.equal(layout.taskDetails?.childRows, 1, `${viewport.name}: spawned sub-agent row is missing`);
    assert.match(layout.taskDetails?.text ?? '', /Sub-agents[\s\S]*Layout review[\s\S]*Location/u, `${viewport.name}: task details hierarchy is unclear`);
    assert.equal(layout.taskDetails?.background, 'rgb(24, 24, 23)', `${viewport.name}: task details panel is not opaque`);
  }
  if (viewport.kind === 'project-heading-controls') {
    const controls = layout.projectHeadingControls;
    assert.ok(controls, `${viewport.name}: project heading control geometry is missing`);
    assert.ok(Math.abs(controls.plus.height - controls.collapse.height) <= .5, `${viewport.name}: project plus is shorter than the adjacent collapse control`);
    assert.ok(Math.abs(controls.plus.width - controls.plus.height) <= .5, `${viewport.name}: project plus hit target is not square`);
    assert.ok(Math.abs(controls.plus.centerY - controls.collapse.centerY) <= .5, `${viewport.name}: project plus and collapse control are vertically misaligned`);
    assert.ok(Math.abs(controls.plus.left - controls.collapse.right - 2) <= .5, `${viewport.name}: project plus no longer keeps the two-pixel control gap`);
    assert.ok(Math.abs(controls.plus.right - controls.heading.right) <= .5, `${viewport.name}: project plus does not end at the folder heading edge`);
    assert.ok(Math.abs(controls.plus.right - controls.projectRowRight) <= .5, `${viewport.name}: project plus does not align with the session-row clickbox edge`);
    assert.ok(Math.abs(controls.plus.right - controls.projectContentRight) <= .5, `${viewport.name}: project plus does not end before the scrollbar gutter`);
    assert.ok((controls.disclosure?.rightGap ?? 0) >= 6 && (controls.disclosure?.rightGap ?? Infinity) <= 8, `${viewport.name}: folder disclosure did not move with the folder clickbox edge`);
    assert.equal(controls.disclosure?.idleOpacity, '0', `${viewport.name}: folder disclosure is permanently visible without pointer or keyboard intent`);
    assert.equal(controls.disclosure?.opacity, '1', `${viewport.name}: hovering the folder heading does not reveal its disclosure orientation`);
    assert.ok(Math.abs(controls.glyphCenterDeltaX) <= .5 && Math.abs(controls.glyphCenterDeltaY) <= .5, `${viewport.name}: plus glyph is not centred in its hit target`);
    assert.equal(controls.plus.opacity, '1', `${viewport.name}: hovered project plus did not become visible`);
    assert.equal(controls.plus.pointerEvents, 'auto', `${viewport.name}: visible project plus does not expose its full hit target`);
    assert.ok((controls.projectCreate?.width ?? 0) >= 18.5 && (controls.projectCreate?.height ?? 0) >= 18.5, `${viewport.name}: choose-or-create project icon remains too small`);
    assert.equal(controls.projectCreate?.pathCount, 2, `${viewport.name}: choose-or-create project icon does not visibly combine folder and plus marks`);
  }
  if (viewport.kind === 'subagents') {
    assert.ok(layout.selectedStateBounds, `${viewport.name}: sub-agent disclosure is missing`);
    assert.ok(layout.selectedStateBounds.x >= 0 && layout.selectedStateBounds.y >= 0 && layout.selectedStateBounds.x + layout.selectedStateBounds.width <= layout.viewport.width + 1 && layout.selectedStateBounds.bottom <= layout.viewport.height + 1, `${viewport.name}: sub-agent disclosure is clipped`);
    assert.equal(layout.subagents?.triggerLabel, '2 sub-agents', `${viewport.name}: parent row does not expose the child count`);
    assert.equal(layout.subagents?.expanded, 'true', `${viewport.name}: sub-agent disclosure did not open`);
    assert.ok(Math.abs((layout.subagents?.triggerState?.width ?? 0) - 38) <= .5 && Math.abs((layout.subagents?.triggerState?.height ?? 0) - 25) <= .5, `${viewport.name}: open rich trigger is not fixed at 38x25`);
    assert.ok(Math.abs((layout.subagents?.triggerState?.summaryCenterX ?? 0) - (layout.subagents?.triggerState?.expectedSummaryCenterX ?? Infinity)) <= .5, `${viewport.name}: opening the panel moved the centred summary`);
    assert.ok(Math.abs((layout.subagents?.triggerState?.chevronWidth ?? 0) - 8) <= .5 && Math.abs((layout.subagents?.triggerState?.chevronHeight ?? 0) - 8) <= .5, `${viewport.name}: open disclosure chevron changed size`);
    assert.equal(layout.subagents?.triggerState?.chevronOpacity, '1', `${viewport.name}: open trigger did not fully reveal its disclosure chevron`);
    assert.ok(Math.abs((layout.subagents?.triggerState?.chevronStrokeWidth ?? 0) - 2.4) <= .1, `${viewport.name}: open disclosure chevron lost its readable stroke`);
    assert.equal(layout.subagents?.childRows, 2, `${viewport.name}: sub-agent disclosure did not render every child`);
    assert.match(layout.subagents?.text ?? '', /Layout review[\s\S]*Provider research/u, `${viewport.name}: child task names are missing or out of order`);
    assert.equal(layout.subagents?.background, 'rgb(24, 24, 23)', `${viewport.name}: sub-agent disclosure is not opaque`);
    assert.ok(Math.abs((layout.subagents?.geometry?.width ?? 0) - 300) <= .5, `${viewport.name}: sub-agent disclosure is not modestly widened to 300px`);
    assert.ok((layout.subagents?.geometry?.height ?? 0) >= 111.5 && (layout.subagents?.geometry?.height ?? Infinity) <= 112.5, `${viewport.name}: two child rows do not use their natural 112px height`);
    assert.equal(layout.subagents?.geometry?.scrollHeight, layout.subagents?.geometry?.clientHeight, `${viewport.name}: two child rows receive a premature scrollbar`);
    assert.equal(layout.subagents?.geometry?.overflowY, 'auto', `${viewport.name}: long child lists cannot scroll after the meaningful maximum`);
    assert.ok(layout.subagents?.geometry?.rowHeights.every((height) => Math.abs(height - 50) <= .5), `${viewport.name}: child rows do not preserve complete 50px increments`);
    assert.ok(layout.subagents?.geometry?.metadataFontSizes.every((size) => size >= 12.5), `${viewport.name}: child model metadata remains undersized`);
    assert.ok(layout.subagents?.geometry?.markSizes.every((size) => size >= 27.5), `${viewport.name}: child provider marks remain undersized`);
    assert.deepEqual(layout.subagents?.geometry?.providerIds, ['codex', 'opencode'], `${viewport.name}: child rows lost their actual harness identities`);
    assert.deepEqual(layout.subagents?.geometry?.genericIconCounts, [0, 0], `${viewport.name}: the generic parent icon repeats inside child rows`);
    assert.deepEqual(layout.subagents?.geometry?.metadata?.map((entry) => entry.text), ['gpt-5.6-sol · High', 'deepseek/deepseek-v4-pro · Max'], `${viewport.name}: child model and reasoning metadata is incomplete`);
    assert.ok(layout.subagents?.geometry?.metadata?.every((entry) => entry.reasoningVisible), `${viewport.name}: a child reasoning level is not visibly rendered`);
    assert.ok(layout.subagents?.geometry?.states.every((state) => state.scrollWidth <= state.clientWidth + .5), `${viewport.name}: child state text is truncated`);
    assert.equal(layout.subagents?.topLevelTitles.includes('Review the desktop layout'), false, `${viewport.name}: a child leaked into the top-level task list`);
    assert.equal(layout.subagents?.topLevelTitles.includes('Research the provider boundary'), false, `${viewport.name}: a child leaked into the top-level task list`);
    assert.match(layout.subagentTransition?.idle?.label ?? '', /Idle/u, `${viewport.name}: initial child state did not render`);
    assert.equal(layout.subagentTransition?.idle?.spinnerCount, 0, `${viewport.name}: idle child displayed a working spinner`);
    assert.match(layout.subagentTransition?.working?.label ?? '', /Working/u, `${viewport.name}: child did not update live to working`);
    assert.equal(layout.subagentTransition?.working?.spinnerCount, 1, `${viewport.name}: working child is missing its spinner`);
    assert.notEqual(layout.subagentTransition?.working?.spinnerAnimation, 'none', `${viewport.name}: working child spinner is not animated`);
    assert.match(layout.subagentTransition?.completed?.label ?? '', /Completed/u, `${viewport.name}: child did not update live to completed`);
    assert.equal(layout.subagentTransition?.completed?.spinnerCount, 0, `${viewport.name}: completed child kept a stale spinner`);
    assert.equal(layout.subagentDividerOverlap?.panelParentIsBody, true, `${viewport.name}: sub-agent panel is still trapped inside the task-row stacking context`);
    assert.ok((layout.subagentDividerOverlap?.panelZIndex ?? 0) > (layout.subagentDividerOverlap?.handleZIndex ?? Infinity), `${viewport.name}: sub-agent panel does not outrank the resize divider`);
    assert.equal(layout.subagentDividerOverlap?.overlaps, true, `${viewport.name}: divider fixture does not cross the sub-agent panel`);
    assert.equal(layout.subagentDividerOverlap?.hitInsidePanel, true, `${viewport.name}: active divider paints or receives input above the open sub-agent panel`);
    assert.notDeepEqual(layout.subagentDividerOverlap?.pixels?.outsideLine, layout.subagentDividerOverlap?.pixels?.outsideBeside, `${viewport.name}: the forced active divider is not visibly painted outside the panel`);
    assert.deepEqual(layout.subagentDividerOverlap?.pixels?.insideLine, layout.subagentDividerOverlap?.pixels?.insideBeside, `${viewport.name}: active divider remains visible through the panel`);
    assert.deepEqual(layout.subagentInteractions, { childOpened: true, outsideDismissed: true, escapeDismissed: true, focusRestored: true }, `${viewport.name}: portaled sub-agent panel interactions regressed`);
  }
  if (viewport.kind === 'subagents-hover' || viewport.kind === 'subagents-hover-project') {
    const expectedExactCount = Number.isSafeInteger(viewport.qaSubagentCount) ? viewport.qaSubagentCount : 2;
    const expectedPaintedCount = viewport.kind === 'subagents-hover-project' && expectedExactCount >= 1_000 ? '1k+' : String(expectedExactCount);
    const expectedTooltip = `${expectedExactCount} sub-agent${expectedExactCount === 1 ? '' : 's'}`;
    assert.ok(layout.selectedStateBounds, `${viewport.name}: sub-agent hover tooltip is missing`);
    assert.equal(layout.subagentTooltip?.visibleCount, 1, `${viewport.name}: sub-agent hover produced overlapping tooltip layers`);
    assert.equal(layout.subagentTooltip?.text, expectedTooltip, `${viewport.name}: sub-agent hover label did not come from the React-rendered exact count`);
    assert.equal(layout.subagentTooltip?.parentIsBody, true, `${viewport.name}: sub-agent tooltip is still trapped inside the task rail`);
    assert.equal(layout.subagentTooltip?.sharedOverlay, true, `${viewport.name}: sub-agent hover bypassed the shared app tooltip layer`);
    assert.ok(['above', 'below', 'left', 'right'].includes(layout.subagentTooltip?.placement), `${viewport.name}: shared sub-agent tooltip has no resolved placement`);
    assert.equal(layout.subagentTooltip?.triggerTooltipText, expectedTooltip, `${viewport.name}: trigger does not expose the exact count to the shared tooltip layer`);
    assert.equal(layout.subagentTooltip?.describedByTooltip, true, `${viewport.name}: shared tooltip is not connected to its trigger for assistive technology`);
    assert.equal(layout.subagentTooltip?.legacyTooltipCount, 0, `${viewport.name}: legacy sub-agent tooltip markup still rendered`);
    assert.equal(layout.subagentTooltip?.nestedTooltipSources, 0, `${viewport.name}: provider logo still creates a second tooltip`);
    assert.equal(layout.subagentTooltip?.triggerHasTooltipSource, true, `${viewport.name}: trigger is not registered with the shared tooltip layer`);
    assert.ok(layout.subagentTooltip?.triggerPseudoContent === 'none' || layout.subagentTooltip?.triggerPseudoContent === 'normal', `${viewport.name}: an underlying trigger pseudo-tooltip is still painted`);
    assert.ok(layout.subagentTooltip?.bounds && layout.subagentTooltip.bounds.left >= 8 && layout.subagentTooltip.bounds.top >= 8 && layout.subagentTooltip.bounds.right <= layout.viewport.width - 8 + 1 && layout.subagentTooltip.bounds.bottom <= layout.viewport.height - 8 + 1, `${viewport.name}: sub-agent hover tooltip is clipped by the viewport`);
    if (viewport.kind === 'subagents-hover-project') assert.ok(layout.subagentTooltip?.triggerBounds?.left < 50, `${viewport.name}: project tooltip fixture did not exercise the left-gutter trigger`);
    const current = layout.subagentCountGeometry?.current;
    assert.equal(current?.count, expectedPaintedCount, `${viewport.name}: the requested React-rendered count was not painted`);
    if (viewport.kind === 'subagents-hover-project') {
      assert.equal(current?.countCapped, expectedExactCount >= 1_000, `${viewport.name}: compact capped-count state disagrees with the exact count`);
      assert.ok(Math.abs((current?.triggerWidth ?? 0) - 38) <= .5 && Math.abs((current?.triggerHeight ?? 0) - 22) <= .5, `${viewport.name}: compact trigger is not fixed at 38x22`);
      assert.equal(current?.genericIconPresent, true, `${viewport.name}: compact trigger is missing the generic two-person icon`);
      assert.equal(current?.providerWidth, 0, `${viewport.name}: compact trigger still renders a child-provider monogram`);
      assert.ok(Math.abs((current?.iconWidth ?? 0) - 13) <= .5 && Math.abs((current?.iconHeight ?? 0) - 13) <= .5, `${viewport.name}: compact generic icon changed size`);
      assert.ok(Math.abs((current?.countFontSize ?? 0) - (expectedExactCount >= 1_000 ? 11 : 12)) <= .1 && (current?.countFontWeight ?? 0) >= 650, `${viewport.name}: compact sub-agent count is not readable`);
      assert.ok(Math.abs((current?.summaryCenterX ?? 0) - ((current?.triggerLeft ?? 0) + 19)) <= .5, `${viewport.name}: compact icon-and-count summary is not dynamically centred`);
      assert.ok((current?.summaryLeft ?? -Infinity) >= (current?.triggerLeft ?? Infinity) - .5 && (current?.summaryRight ?? Infinity) <= (current?.triggerRight ?? -Infinity) + .5, `${viewport.name}: compact summary escapes its fixed button`);
      assert.ok(Math.abs(((current?.iconCenterY ?? 0) - (current?.countCenterY ?? 0)) - 1) <= .5, `${viewport.name}: compact icon box lost its one-pixel painted-ink correction`);
      assert.ok(Math.abs((current?.summaryCenterY ?? 0) - (current?.titleGlyphCenterY ?? Infinity)) <= .75, `${viewport.name}: compact icon and count do not share the task-title glyph baseline`);
      assert.ok(current?.paintedInk?.icon && current?.paintedInk?.count && current?.paintedInk?.titleLead && current?.paintedInk?.spinner, `${viewport.name}: compact icon, count, title, or spinner painted bounds are missing`);
      assert.ok(Math.abs(current.paintedInk.icon.weightedCenterY - current.paintedInk.count.weightedCenterY) <= .75, `${viewport.name}: compact icon ink is optically above or below the count`);
      assert.ok(Math.abs(current.paintedInk.icon.weightedCenterY - current.paintedInk.titleLead.weightedCenterY) <= .75, `${viewport.name}: compact icon ink is optically above or below the title`);
      assert.ok(Math.abs(((current.paintedInk.spinner.top + current.paintedInk.spinner.bottom) / 2) - current.paintedInk.titleLead.weightedCenterY) <= .5, `${viewport.name}: compact spinner ring is optically above or below the title`);
      if (expectedExactCount < 1_000) {
        assert.equal(current.paintedInk.count.top, current.paintedInk.titleLead.top, `${viewport.name}: compact count paints above or below the title cap`);
        assert.equal(current.paintedInk.count.bottom, current.paintedInk.titleLead.bottom, `${viewport.name}: compact count and title cap do not share a painted height`);
      }
      assert.equal(current?.chevronPresent, false, `${viewport.name}: compact project control still paints a disclosure chevron`);
      assert.ok(Math.abs((current?.rowHeight ?? 0) - 31) <= .5 && Math.abs((current?.shellHeight ?? 0) - 31) <= .5, `${viewport.name}: compact task or shell inherited the 74px recency-card cadence`);
      assert.ok((current?.triggerRight ?? Infinity) <= (current?.titleLeft ?? -Infinity) + .5, `${viewport.name}: compact control overlaps the task title`);
      assert.ok((current?.titleLeft ?? 0) - (current?.triggerRight ?? 0) >= 3.5 && (current?.titleLeft ?? 0) - (current?.triggerRight ?? 0) <= 4.5, `${viewport.name}: compact control leaves excess space before the title`);
      assert.ok((current?.rowRight ?? Infinity) - (current?.spinnerRight ?? -Infinity) >= 6 && (current?.rowRight ?? Infinity) - (current?.spinnerRight ?? -Infinity) <= 8, `${viewport.name}: working spinner moved away from the padded right edge`);
      assert.ok(layout.projectListGeometry?.rowHeights?.length > 1 && layout.projectListGeometry.rowHeights.every((height) => Math.abs(height - 31) <= .5), `${viewport.name}: project tasks do not share a 31px one-line cadence`);
      assert.ok(layout.projectListGeometry?.shellHeights?.length > 1 && layout.projectListGeometry.shellHeights.every((height) => Math.abs(height - 31) <= .5), `${viewport.name}: project task shells contain hidden vertical slack`);
      assert.ok(layout.projectListGeometry?.groupLayouts?.length > 1 && layout.projectListGeometry.groupLayouts.every((group) => group.display === 'block'), `${viewport.name}: an adjacent task group became a nested layout container`);
      assert.ok(Math.max(...layout.projectListGeometry.groupLayouts.map((group) => group.left)) - Math.min(...layout.projectListGeometry.groupLayouts.map((group) => group.left)) <= .5, `${viewport.name}: adjacent task groups no longer share one left edge`);
      assert.ok(Math.max(...layout.projectListGeometry.groupLayouts.map((group) => group.width)) - Math.min(...layout.projectListGeometry.groupLayouts.map((group) => group.width)) <= .5, `${viewport.name}: adjacent task groups no longer share one width`);
      assert.ok(layout.projectListGeometry?.interGroupGaps?.every((gap) => Math.abs(gap) <= .5), `${viewport.name}: project tasks contain unexpected vertical gaps`);
      assert.ok(Math.max(...layout.projectListGeometry.shellLayouts.map((shell) => shell.left)) - Math.min(...layout.projectListGeometry.shellLayouts.map((shell) => shell.left)) <= .5
        && Math.max(...layout.projectListGeometry.shellLayouts.map((shell) => shell.right)) - Math.min(...layout.projectListGeometry.shellLayouts.map((shell) => shell.right)) <= .5,
      `${viewport.name}: project task shells do not share full-row bounds`);
      assert.ok((layout.projectListGeometry?.titleTextLefts?.length ?? 0) > 1 && Math.max(...layout.projectListGeometry.titleTextLefts) - Math.min(...layout.projectListGeometry.titleTextLefts) <= .5, `${viewport.name}: project titles shift horizontally when a row gains or loses sub-agents`);
      assert.ok(Math.abs((layout.projectListGeometry?.ordinaryTitleLeft ?? 0) - (current?.titleLeft ?? Infinity)) <= .5, `${viewport.name}: ordinary and sub-agent task titles use different glyph lanes`);
      assert.ok(Math.abs((layout.projectListGeometry?.ordinaryTitleLeft ?? 0) - (layout.projectListGeometry?.showMoreTextLeft ?? Infinity)) <= .5, `${viewport.name}: Show more is not aligned to the ordinary task-title glyph lane`);
      assert.ok(Math.abs((layout.projectListGeometry?.selectedShell?.height ?? 0) - 31) <= .5 && Math.abs((layout.projectListGeometry?.selectedRow?.height ?? 0) - 31) <= .5, `${viewport.name}: selected sub-agent row breaks the one-line cadence`);
      assert.equal(layout.projectListGeometry?.selectedShell?.background, 'rgb(41, 41, 39)', `${viewport.name}: selected sub-agent control and title do not share one background`);
      assert.equal(layout.projectListGeometry?.selectedRow?.background, 'rgba(0, 0, 0, 0)', `${viewport.name}: selected inner row splits the unified shell background`);
      assert.equal(layout.projectListGeometry?.ordinarySelectedShell?.background, 'rgb(41, 41, 39)', `${viewport.name}: an ordinary selected task does not paint the full project shell`);
      assert.equal(layout.projectListGeometry?.ordinarySelectedRow?.background, 'rgba(0, 0, 0, 0)', `${viewport.name}: an ordinary selected task still paints the narrower inner button`);
      assert.ok(Math.abs((layout.projectListGeometry?.ordinarySelectedShell?.left ?? 0) - (layout.projectListGeometry?.selectedShell?.left ?? Infinity)) <= .5
        && Math.abs((layout.projectListGeometry?.ordinarySelectedShell?.right ?? 0) - (layout.projectListGeometry?.selectedShell?.right ?? Infinity)) <= .5,
      `${viewport.name}: selected highlight bounds change when a task gains sub-agents`);
      assert.ok(['left', 'right', 'width', 'height'].every((key) => Math.abs((layout.projectListGeometry?.ordinaryRowBeforeSelection?.[key] ?? 0) - (layout.projectListGeometry?.ordinarySelectedRow?.[key] ?? Infinity)) <= .5), `${viewport.name}: selected paint changed the ordinary task button clickbox`);
      assert.ok(['left', 'right', 'width', 'height'].every((key) => Math.abs((layout.projectListGeometry?.ordinaryShellBeforeSelection?.[key] ?? 0) - (layout.projectListGeometry?.ordinaryRowBeforeSelection?.[key] ?? Infinity)) <= .5), `${viewport.name}: an ordinary task button does not own its full visible shell`);
      assert.equal(layout.projectListGeometry?.ordinaryLeftGutterHit, true, `${viewport.name}: the left side of an ordinary project task is not clickable`);
      assert.equal(layout.projectListGeometry?.ordinaryHover?.shellBackground, 'rgb(25, 25, 24)', `${viewport.name}: ordinary project hover does not paint the full shell`);
      assert.equal(layout.projectListGeometry?.ordinaryHover?.rowBackground, 'rgba(0, 0, 0, 0)', `${viewport.name}: ordinary project hover still paints only the nested button`);
      assert.ok(Math.abs((layout.projectListGeometry?.spinner?.width ?? 0) - 12) <= .5 && Math.abs((layout.projectListGeometry?.spinner?.height ?? 0) - 12) <= .5, `${viewport.name}: rightmost working spinner changed size`);
      assert.ok((layout.projectListGeometry?.spinner?.top ?? -Infinity) >= (layout.projectListGeometry?.selectedRow?.top ?? Infinity)
        && (layout.projectListGeometry?.spinner?.bottom ?? Infinity) <= (layout.projectListGeometry?.selectedRow?.bottom ?? -Infinity), `${viewport.name}: optically corrected spinner escapes the 31px row`);
      assert.equal(layout.onePixelTitleFade?.distance, 1, `${viewport.name}: one-pixel title overflow fixture is not exact`);
      assert.equal(layout.onePixelTitleFade?.attribute, 'true', `${viewport.name}: one clipped title pixel did not activate overflow state`);
      assert.notEqual(layout.onePixelTitleFade?.maskImage, 'none', `${viewport.name}: one-pixel-clipped project title has no terminal fade`);
    } else {
      assert.ok(Math.abs((current?.triggerWidth ?? 0) - 38) <= .5 && Math.abs((current?.triggerHeight ?? 0) - 25) <= .5, `${viewport.name}: rich sub-agent trigger is not fixed at 38x25`);
      assert.equal(current?.genericIconPresent, true, `${viewport.name}: rich trigger is missing the generic two-person icon`);
      assert.equal(current?.providerWidth, 0, `${viewport.name}: rich trigger still renders a provider monogram`);
      assert.ok(Math.abs((current?.iconWidth ?? 0) - 13) <= .5 && Math.abs((current?.iconHeight ?? 0) - 13) <= .5, `${viewport.name}: generic sub-agent icon changed size`);
      assert.ok(Math.abs((current?.countFontSize ?? 0) - 11.5) <= .1 && (current?.countFontWeight ?? 0) >= 650, `${viewport.name}: rich sub-agent count did not move down one type step`);
      assert.ok(Math.abs((current?.summaryCenterX ?? 0) - ((current?.triggerLeft ?? 0) + 19)) <= .5, `${viewport.name}: icon-and-count summary moved from its fixed lane centre`);
      assert.ok((current?.summaryLeft ?? -Infinity) >= (current?.triggerLeft ?? Infinity) - .5 && (current?.summaryRight ?? Infinity) <= (current?.triggerRight ?? -Infinity) + .5, `${viewport.name}: icon-and-count summary escapes the fixed button`);
      assert.ok(Math.abs(((current?.iconBottom ?? 0) - (current?.countBottom ?? 0)) - 1) <= .25, `${viewport.name}: smaller count box lost its one-pixel optical lift`);
      assert.ok(Math.abs((current?.summaryCenterY ?? 0) - ((current?.triggerTop ?? 0) + 10.5)) <= .5, `${viewport.name}: three extra top pixels did not preserve the summary position`);
      assert.ok(Math.abs((current?.summaryTop ?? 0) - ((current?.triggerTop ?? 0) + 4)) <= .5, `${viewport.name}: rich trigger does not keep four pixels above its summary`);
      assert.ok(current?.paintedInk?.icon && current?.paintedInk?.count, `${viewport.name}: rich icon or count painted bounds are missing`);
      assert.equal(current.paintedInk.icon.bottom, current.paintedInk.count.bottom, `${viewport.name}: rich icon and count do not share a painted bottom`);
      assert.ok(current.paintedInk.count.top > current.paintedInk.icon.top, `${viewport.name}: the smaller rich count does not leave the icon visually taller`);
      assert.ok((current?.titleClearance ?? -Infinity) >= 4.5 && (current?.titleClearance ?? Infinity) <= 5.5, `${viewport.name}: rich trigger lost its five-pixel title-lane gap`);
      assert.ok(Math.abs((current?.chevronWidth ?? 0) - 8) <= .5 && Math.abs((current?.chevronHeight ?? 0) - 8) <= .5, `${viewport.name}: lower disclosure chevron is not 8x8`);
      assert.ok(Math.abs((current?.chevronCenterX ?? 0) - ((current?.triggerLeft ?? 0) + 18)) <= .5, `${viewport.name}: lower disclosure chevron lost its one-pixel left correction`);
      assert.ok((current?.chevronPathTop ?? -Infinity) - (current?.summaryBottom ?? Infinity) >= 1, `${viewport.name}: lower disclosure chevron paints into the summary row`);
      assert.equal(current?.chevronOpacity, '0.38', `${viewport.name}: idle disclosure chevron is not subtle but visible`);
      assert.ok(Math.abs((current?.chevronStrokeWidth ?? 0) - 2.4) <= .1, `${viewport.name}: lower disclosure chevron lost its readable stroke`);
      assert.ok((current?.chevronTranslate ?? '').includes('-1px'), `${viewport.name}: lower disclosure chevron lost its one-pixel translation`);
      assert.ok(Math.abs((current?.triggerLeft ?? 0) - (current?.rowLeft ?? 0)) <= .5 && Math.abs((current?.rowBottom ?? 0) - (current?.triggerBottom ?? 0) - 4) <= .5, `${viewport.name}: rich sub-agent control is not anchored four pixels above the lower-left corner`);
    }
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
  }
  if (viewport.kind === 'trace-collapsed' || viewport.kind === 'task-rail') {
    assert.ok(layout.sidebar?.newTask && layout.sidebar.dashboard && layout.sidebar.taskText, `${viewport.name}: sidebar controls or task text are missing`);
    assert.ok(layout.sidebar.newTask.height >= 32 && layout.sidebar.newTask.height <= 42, `${viewport.name}: New task is not compact`);
    assert.ok(Math.abs(layout.sidebar.newTask.height - layout.sidebar.dashboard.height) <= 1, `${viewport.name}: New task and Dashboard heights do not match`);
    assert.ok(Math.abs(layout.sidebar.newTask.width - layout.sidebar.dashboard.width) <= 1, `${viewport.name}: New task and Dashboard widths do not match`);
    assert.equal(layout.sidebar.newTask.label, 'New task', `${viewport.name}: New task label capitalization changed`);
    assert.ok(Math.abs(layout.sidebar.newTask.labelCenterDelta) <= 0.75, `${viewport.name}: New task text is not centred independently of its icon`);
    assert.ok((layout.sidebar.newTask.iconToLabelGap ?? 0) >= 7 && (layout.sidebar.newTask.iconToLabelGap ?? Infinity) <= 9, `${viewport.name}: plus is not optically eight pixels beside the independently centred label`);
    assert.ok(Math.abs(layout.sidebar.dashboard.labelCenterDelta) <= 0.75, `${viewport.name}: Dashboard text is not centred independently of its icon`);
    assert.ok((layout.sidebar.dashboard.iconToLabelGap ?? 0) >= 7 && (layout.sidebar.dashboard.iconToLabelGap ?? Infinity) <= 9, `${viewport.name}: Dashboard icon does not use the New task label gap`);
    assert.ok(Math.abs(layout.sidebar.newTask.iconCenterX - layout.sidebar.dashboard.iconCenterX) <= 3.5, `${viewport.name}: Dashboard icon is outside the New task icon column`);
    assert.ok(Math.abs(layout.sidebar.newTask.iconCenterDeltaY) <= .75 && Math.abs(layout.sidebar.dashboard.iconCenterDeltaY) <= .75, `${viewport.name}: persistent navigation icons are not vertically centred`);
    assert.ok(Math.abs(layout.sidebar.newTask.labelCenterDeltaY) <= .75 && Math.abs(layout.sidebar.dashboard.labelCenterDeltaY) <= .75, `${viewport.name}: persistent navigation labels are not vertically centred`);
    assert.equal(layout.sidebar.newTask.labelFontSize, 13, `${viewport.name}: New task label size changed`);
    assert.equal(layout.sidebar.dashboard.labelFontSize, 13, `${viewport.name}: Dashboard label does not share the New task line box`);
    assert.ok(Math.abs(layout.sidebar.newTask.labelHeight - layout.sidebar.dashboard.labelHeight) <= .5, `${viewport.name}: Dashboard and New task labels do not share a line box`);
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
    assert.ok(rowHeights.every((height) => Math.abs(height - 74) <= .5), `${viewport.name}: rich task rows are not all exactly 74px tall`);
    assert.ok(Math.max(...previewHeights) - Math.min(...previewHeights) <= 0.5, `${viewport.name}: task preview lanes do not share one height`);
    assert.ok(layout.sidebar.taskRows.every((row) => Math.abs((row.trailingWidth ?? 0) - 32) <= .5), `${viewport.name}: fixed four-character relative-time lane is no longer 32px`);
    assert.ok(layout.sidebar.taskRows.every((row) => (row.fourCharacterTimeGap ?? 0) >= 2 && (row.fourCharacterTimeGap ?? Infinity) <= 3.5), `${viewport.name}: recency title fade does not leave a tiny safe gap before a four-character age`);
    assert.ok(layout.sidebar.taskRows.every((row) => Math.abs(row.logoTopGap - 2) <= .5), `${viewport.name}: the recency provider mark box is not aligned with the title ink`);
    assert.ok(layout.sidebar.taskRows.every((row) => row.logoBottomGap >= 14), `${viewport.name}: the recency provider marks did not move into the requested upper lane`);
    const cornerRow = layout.sidebar.taskRows.find((row) => row.subagentCorner && row.workingSpinner);
    assert.ok(cornerRow, `${viewport.name}: rich corner-alignment fixture is missing`);
    assert.ok(cornerRow.paintedInk?.logo && cornerRow.paintedInk?.title && cornerRow.paintedInk?.time, `${viewport.name}: title-row painted bounds are missing`);
    assert.equal(cornerRow.paintedInk.logo.top, cornerRow.paintedInk.title.top, `${viewport.name}: primary provider ink does not align with the title top`);
    assert.equal(cornerRow.paintedInk.time.top, cornerRow.paintedInk.title.top, `${viewport.name}: relative-time ink does not align with the title top`);
    assert.ok(cornerRow.paintedInk?.subagentIcon && cornerRow.paintedInk?.subagentCount, `${viewport.name}: generic sub-agent icon or count is not visibly painted`);
    assert.equal(cornerRow.paintedInk.subagentIcon.bottom, cornerRow.paintedInk.subagentCount.bottom, `${viewport.name}: generic sub-agent icon and count do not share a painted height`);
    assert.ok(cornerRow.paintedInk.subagentCount.top > cornerRow.paintedInk.subagentIcon.top, `${viewport.name}: smaller sub-agent count does not leave the icon visually taller`);
    assert.ok(Math.abs(cornerRow.subagentCorner.trigger.width - 38) <= .5 && Math.abs(cornerRow.subagentCorner.trigger.height - 25) <= .5, `${viewport.name}: lower-left sub-agent button is not fixed at 38x25`);
    assert.ok(Math.abs(cornerRow.subagentCorner.leftGap) <= .5, `${viewport.name}: sub-agent button is not anchored under the primary provider`);
    assert.ok(Math.abs(cornerRow.subagentCorner.bottomGap - 4) <= .5, `${viewport.name}: sub-agent button is not raised four pixels above the row edge`);
    assert.ok(cornerRow.subagentCorner.previewGap >= 4.5, `${viewport.name}: lower-left control intrudes into the task text lane`);
    assert.ok(Math.abs(cornerRow.subagentCorner.summaryCenterDeltaX) <= .5, `${viewport.name}: generic icon and count moved from their fixed lane centre`);
    assert.ok(Math.abs(cornerRow.subagentCorner.iconCountCenterDeltaY - .25) <= .25, `${viewport.name}: generic icon and smaller count lost their one-pixel optical correction`);
    assert.ok(cornerRow.subagentCorner.summary.left >= cornerRow.subagentCorner.trigger.left - .5 && cornerRow.subagentCorner.summary.right <= cornerRow.subagentCorner.trigger.right + .5, `${viewport.name}: dynamic summary escapes the fixed button`);
    assert.ok((cornerRow.subagentCorner.summaryToChevronPaintGap ?? -Infinity) >= 1, `${viewport.name}: lower disclosure chevron paints into the generic summary`);
    assert.ok(Math.abs(cornerRow.subagentCorner.chevronCenterDeltaX) <= .5, `${viewport.name}: lower disclosure chevron lost its one-pixel left correction`);
    assert.ok(cornerRow.subagentCorner.chevronBelowSummary >= 7, `${viewport.name}: disclosure chevron is not visibly below the summary`);
    assert.ok(Math.abs(cornerRow.subagentCorner.chevron.width - 8) <= .5 && Math.abs(cornerRow.subagentCorner.chevron.height - 8) <= .5, `${viewport.name}: lower disclosure chevron is not 8x8`);
    assert.ok(Math.abs(cornerRow.subagentCorner.chevron.strokeWidth - 2.4) <= .1, `${viewport.name}: lower disclosure chevron lost its readable stroke`);
    assert.equal(cornerRow.subagentCorner.chevron.opacity, '0.38', `${viewport.name}: idle lower disclosure chevron is not subtly visible`);
    assert.ok(layout.sidebar.taskRows.some((row) => row.overflowByGeometry), `${viewport.name}: task-row fixture has no overflowing preview`);
    assert.ok(layout.sidebar.taskRows.some((row) => !row.overflowByGeometry), `${viewport.name}: task-row fixture has no fitting preview`);
    const hoveredOverflowRow = layout.sidebar.taskRows.find((row) => row.hovered && row.overflowByGeometry);
    assert.ok(hoveredOverflowRow, `${viewport.name}: overflowing task-preview hover state is missing`);
    assert.match(hoveredOverflowRow.maskImage, /rgba\(0, 0, 0, 0\) 0px, rgb\(0, 0, 0\) 3px, rgb\(0, 0, 0\) calc\(100% - 3px\), rgba\(0, 0, 0, 0\.72\) 100%/, `${viewport.name}: moving task preview does not use the three-pixel top fade`);
    assert.notEqual(hoveredOverflowRow.previewTransform, 'none', `${viewport.name}: hovered overflowing preview did not begin its vertical reveal`);
    const workingRows = layout.sidebar.taskRows.filter((row) => row.workingSpinner);
    assert.equal(workingRows.length, 1, `${viewport.name}: working task spinner fixture is missing or duplicated`);
    const workingSpinner = workingRows[0].workingSpinner;
    assert.ok(workingSpinner.width >= 11.5 && workingSpinner.width <= 12.5 && workingSpinner.height >= 11.5 && workingSpinner.height <= 12.5, `${viewport.name}: task spinner is no longer readable`);
    assert.ok(Math.abs(workingSpinner.rightGap - 6) <= .5, `${viewport.name}: working spinner is not fixed five pixels inside the row border`);
    assert.ok(Math.abs(workingSpinner.bottomGap - 6) <= .5, `${viewport.name}: working spinner is not in the balanced lower-right corner`);
    assert.ok(Math.abs(workingSpinner.rightGap - cornerRow.cornerAlignment.timeRightGap) <= .5, `${viewport.name}: time and spinner do not share the right-corner inset`);
    assert.ok(Math.abs(workingSpinner.rightGap - workingSpinner.bottomGap) <= .5, `${viewport.name}: working spinner corner insets are not balanced`);
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
  if (viewport.kind === 'trace-activity-row') {
    const activityText = layout.trace?.activityText;
    assert.ok(activityText, `${viewport.name}: shared activity target fixture is missing`);
    assert.equal(activityText.primaryText, 'Spawned sub-agent', `${viewport.name}: primary activity label changed`);
    assert.equal(activityText.targetText, 'Provider integration', `${viewport.name}: secondary activity fixture changed`);
    assert.equal(activityText.targetTranslate, '0px 1px', `${viewport.name}: shared activity target holder lost its local optical correction`);
    assert.ok(activityText.ink?.primary && activityText.ink?.target, `${viewport.name}: painted activity text bounds are missing`);
    assert.equal(activityText.ink.target.top, activityText.ink.primary.top, `${viewport.name}: secondary activity text paints above or below the primary label`);
    assert.equal(activityText.ink.target.bottom, activityText.ink.primary.bottom, `${viewport.name}: secondary activity text does not share the primary label's painted height`);
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
  const clippedControls = viewport.kind.startsWith('settings')
    ? layout.clippedControls.filter((control) => control.className !== 'workflow-entry-trigger')
    : layout.clippedControls;
  assert.deepEqual(clippedControls, [], `${viewport.name}: visible control is clipped`);
  assert.deepEqual(layout.tinyReadableText, [], `${viewport.name}: visible text is below 8px`);
  assert.notEqual(layout.background, 'rgba(0, 0, 0, 0)', `${viewport.name}: transparent page background`);
  if (reducedMotion) assert.equal(layout.reducedMotion?.mediaMatches, true, `${viewport.name}: reduced-motion media emulation is unavailable`);
  if (viewport.kind === 'browser') {
    const tabControls = await window.webContents.executeJavaScript(`(() => {
      const tab = document.querySelector('.browser-tabs [role="tab"]');
      const actions = tab?.querySelector('.browser-tab-actions');
      const mute = actions?.querySelector('[aria-label^="Mute "]');
      const close = actions?.querySelector('[aria-label^="Close "]');
      const add = document.querySelector('button[aria-label="New browser tab"]');
      return {
        tabPresent: Boolean(tab),
        actionsVisible: actions ? Number.parseFloat(getComputedStyle(actions).opacity) === 1 : false,
        muteRole: mute?.getAttribute('role') ?? null,
        muteTabIndex: mute?.getAttribute('tabindex') ?? null,
        closeRole: close?.getAttribute('role') ?? null,
        newTabIsButton: add instanceof HTMLButtonElement,
      };
    })()`, true);
    assert.deepEqual(tabControls, {
      tabPresent: true,
      actionsVisible: true,
      muteRole: 'button',
      muteTabIndex: '0',
      closeRole: 'button',
      newTabIsButton: true,
    }, `${viewport.name}: browser tab audio, close, or new-tab controls are not visibly usable`);

    const dismissal = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const button = document.querySelector('button[aria-label="Dismiss browser profile notice"]');
      if (!(button instanceof HTMLButtonElement)) return reject(new Error('Browser profile notice has no dismiss button'));
      const control = { type: button.type, ariaLabel: button.getAttribute('aria-label') };
      button.click();
      requestAnimationFrame(() => requestAnimationFrame(() => resolve({
        control,
        noticeVisible: Boolean(document.querySelector('.browser-privacy-note')),
        stored: localStorage.getItem('tethoq.browser-privacy-notice-dismissed.v1'),
      })));
    })`, true);
    assert.deepEqual(dismissal.control, { type: 'button', ariaLabel: 'Dismiss browser profile notice' }, `${viewport.name}: dismiss control is not an accessible button`);
    assert.equal(dismissal.noticeVisible, false, `${viewport.name}: dismissing the browser profile notice left it visible`);
    assert.equal(dismissal.stored, 'true', `${viewport.name}: browser profile notice dismissal was not persisted`);

    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const started = Date.now();
      const waitFor = (predicate, message, action) => {
        if (predicate()) { action?.(); return; }
        if (Date.now() - started > 5000) return reject(new Error(message));
        requestAnimationFrame(() => waitFor(predicate, message, action));
      };
      document.querySelector('button[aria-label="Return to task"]')?.click();
      waitFor(() => Boolean(document.querySelector('.workspace')), 'Returning from the browser did not restore the task', () => {
        document.querySelector('button[aria-label="More message actions"]')?.click();
        waitFor(() => Boolean(document.querySelector('.composer-actions-menu [role="menuitem"]')), 'Message actions did not reopen', () => {
          const action = [...document.querySelectorAll('.composer-actions-menu [role="menuitem"]')].find((button) => button.textContent?.includes('Open session browser'));
          if (!(action instanceof HTMLButtonElement)) return reject(new Error('Open session browser action disappeared'));
          action.click();
          waitFor(() => Boolean(document.querySelector('.browser-page')), 'Browser did not reopen', () => resolve());
        });
      });
    })`, true);
    assert.equal(await window.webContents.executeJavaScript(`Boolean(document.querySelector('.browser-privacy-note'))`, true), false, `${viewport.name}: browser profile notice returned after a real remount`);

    window.webContents.reload();
    await waitForRenderer(window, diagnostics);
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const started = Date.now();
      const waitFor = (predicate, message, action) => {
        if (predicate()) { action?.(); return; }
        if (Date.now() - started > 5000) return reject(new Error(message));
        requestAnimationFrame(() => waitFor(predicate, message, action));
      };
      waitFor(() => Boolean(document.querySelector('[data-session-id="desktop-harness"] > .session-row')), 'Fixture task did not return after reload', () => {
        document.querySelector('[data-session-id="desktop-harness"] > .session-row')?.click();
        waitFor(() => Boolean(document.querySelector('.workspace')), 'Fixture workspace did not return after reload', () => {
          document.querySelector('button[aria-label="More message actions"]')?.click();
          waitFor(() => Boolean(document.querySelector('.composer-actions-menu [role="menuitem"]')), 'Message actions did not return after reload', () => {
            const action = [...document.querySelectorAll('.composer-actions-menu [role="menuitem"]')].find((button) => button.textContent?.includes('Open session browser'));
            if (!(action instanceof HTMLButtonElement)) return reject(new Error('Open session browser action did not return after reload'));
            action.click();
            waitFor(() => Boolean(document.querySelector('.browser-page')), 'Browser did not return after reload', () => resolve());
          });
        });
      });
    })`, true);
    assert.equal(await window.webContents.executeJavaScript(`Boolean(document.querySelector('.browser-privacy-note'))`, true), false, `${viewport.name}: browser profile notice returned after renderer reload`);
    await window.webContents.executeJavaScript(`localStorage.removeItem('tethoq.browser-privacy-notice-dismissed.v1')`, true);
  }
  process.stdout.write(`${viewport.name} ${JSON.stringify(layout)}\n`);
  return window;
}

function assertCompactSubagentFixtureSet() {
  const fixtureCounts = [1, 12, 130, 1_000];
  const candidates = [...capturedLayouts.values()].filter(({ viewport }) => viewport.kind === 'subagents-hover-project' && fixtureCounts.includes(viewport.qaSubagentCount));
  if (!candidates.length) return;
  for (const width of [...new Set(candidates.map(({ viewport }) => viewport.width))]) {
    const fixtures = candidates.filter(({ viewport }) => viewport.width === width);
    assert.equal(fixtures.length, fixtureCounts.length, `${width}px compact sub-agent QA is missing a fresh React-rendered count fixture`);
    const byCount = new Map(fixtures.map(({ viewport, layout }) => [viewport.qaSubagentCount, layout]));
    const readings = fixtureCounts.map((count) => byCount.get(count)?.subagentCountGeometry?.current);
    assert.ok(readings.every(Boolean), `${width}px compact sub-agent QA is missing measured geometry`);
    const spread = (key) => {
      const values = readings.map((reading) => reading[key]);
      return Math.max(...values) - Math.min(...values);
    };
    for (const key of ['triggerLeft', 'triggerRight', 'summaryCenterX', 'titleLeft', 'spinnerRight']) {
      assert.ok(spread(key) <= .5, `${width}px compact ${key} anchor drifts as the exact count changes`);
    }
    assert.ok(readings.every((reading) => Math.abs(reading.triggerWidth - 38) <= .5 && Math.abs(reading.triggerHeight - 22) <= .5), `${width}px compact trigger is not fixed at 38x22`);
    assert.ok(readings.every((reading) => reading.genericIconPresent && reading.providerWidth === 0), `${width}px compact trigger did not fully replace provider monograms with the generic icon`);
    assert.ok(readings.every((reading) => Math.abs(reading.iconWidth - 13) <= .5 && Math.abs(reading.iconHeight - 13) <= .5), `${width}px compact generic icon changed readable size`);
    assert.ok(readings.every((reading) => Math.abs(reading.summaryCenterX - (reading.triggerLeft + 19)) <= .5), `${width}px compact summaries moved from their fixed lane centre`);
    assert.ok(readings[1].summaryWidth > readings[0].summaryWidth + 3, `${width}px compact two-digit summary did not expand naturally`);
    assert.ok(readings[2].summaryWidth > readings[1].summaryWidth + 3, `${width}px compact three-digit summary did not expand naturally`);
    assert.ok(readings.every((reading) => reading.summaryLeft >= reading.triggerLeft - .5 && reading.summaryRight <= reading.triggerRight + .5), `${width}px compact summary escapes the fixed trigger`);
    assert.ok(readings.every((reading) => Math.abs((reading.iconCenterY - reading.countCenterY) - 1) <= .5), `${width}px compact icon box lost its one-pixel painted-ink correction`);
    assert.ok(readings.every((reading) => Math.abs(reading.summaryCenterY - reading.titleGlyphCenterY) <= .75), `${width}px compact summaries do not share the task-title glyph baseline`);
    assert.ok(readings.every((reading) => reading.paintedInk?.icon && reading.paintedInk?.count && reading.paintedInk?.titleLead), `${width}px compact painted-ink readings are incomplete`);
    assert.ok(readings.every((reading) => Math.abs(reading.paintedInk.icon.weightedCenterY - reading.paintedInk.count.weightedCenterY) <= .75), `${width}px compact icon ink is optically above or below its count`);
    assert.ok(readings.every((reading) => Math.abs(reading.paintedInk.icon.weightedCenterY - reading.paintedInk.titleLead.weightedCenterY) <= .75), `${width}px compact icon ink is optically above or below the title`);
    assert.ok(readings.slice(0, 3).every((reading) => reading.paintedInk.count.top === reading.paintedInk.titleLead.top && reading.paintedInk.count.bottom === reading.paintedInk.titleLead.bottom), `${width}px one- through three-digit counts do not share the title cap's painted height`);
    assert.ok(readings.every((reading) => reading.titleClearance >= 3.5 && reading.titleClearance <= 4.5), `${width}px compact trigger lost its four-pixel title clearance`);
    assert.ok(readings.every((reading) => reading.chevronPresent === false), `${width}px compact project controls still paint disclosure chevrons`);
    assert.ok(readings.every((reading) => Math.abs(reading.rowHeight - 31) <= .5 && Math.abs(reading.shellHeight - 31) <= .5), `${width}px compact rows or shells are not one 31px line`);
    assert.ok(readings.slice(0, 3).every((reading) => Math.abs(reading.countFontSize - 12) <= .1 && reading.countFontWeight >= 650), `${width}px compact one- through three-digit counts changed readable size`);
    const capped = byCount.get(1_000);
    assert.equal(capped.subagentCountGeometry.current.count, '1k+', `${width}px compact four-digit count did not render its accessible cap`);
    assert.equal(capped.subagentCountGeometry.current.countCapped, true, `${width}px compact four-digit count did not receive capped styling`);
    assert.ok(Math.abs(capped.subagentCountGeometry.current.countFontSize - 11) <= .1, `${width}px compact 1k+ cap is no longer 11px`);
    for (const count of fixtureCounts) {
      const expected = `${count} sub-agent${count === 1 ? '' : 's'}`;
      assert.equal(byCount.get(count).subagentTooltip?.text, expected, `${width}px compact tooltip does not preserve the React-derived exact count`);
    }
  }
}

function assertRichSubagentFixtureSet() {
  const fixtureCounts = [1, 12, 130];
  const candidates = [...capturedLayouts.values()].filter(({ viewport }) => viewport.kind === 'subagents-hover' && fixtureCounts.includes(viewport.qaSubagentCount));
  if (!candidates.length) return;
  for (const width of [...new Set(candidates.map(({ viewport }) => viewport.width))]) {
    const fixtures = candidates.filter(({ viewport }) => viewport.width === width);
    assert.equal(fixtures.length, fixtureCounts.length, `${width}px rich sub-agent QA is missing a fresh React-rendered count fixture`);
    const byCount = new Map(fixtures.map(({ viewport, layout }) => [viewport.qaSubagentCount, layout]));
    const readings = fixtureCounts.map((count) => byCount.get(count)?.subagentCountGeometry?.current);
    assert.ok(readings.every(Boolean), `${width}px rich sub-agent QA is missing measured geometry`);
    const spread = (key) => {
      const values = readings.map((reading) => reading[key]);
      return Math.max(...values) - Math.min(...values);
    };
    for (const key of ['triggerLeft', 'triggerRight', 'summaryCenterX', 'chevronCenterX']) {
      assert.ok(spread(key) <= .5, `${width}px rich ${key} anchor drifts as the exact count changes`);
    }
    assert.ok(readings.every((reading) => Math.abs(reading.triggerWidth - 38) <= .5 && Math.abs(reading.triggerHeight - 25) <= .5), `${width}px rich trigger is not fixed at 38x25`);
    assert.ok(readings.every((reading) => reading.genericIconPresent && reading.providerWidth === 0), `${width}px rich trigger did not fully replace provider monograms with the generic icon`);
    assert.ok(readings.every((reading) => Math.abs(reading.iconWidth - 13) <= .5 && Math.abs(reading.iconHeight - 13) <= .5 && Math.abs(reading.countFontSize - 11.5) <= .1), `${width}px rich generic icon or count changed requested size`);
    assert.ok(readings.every((reading) => Math.abs(reading.summaryCenterX - (reading.triggerLeft + 19)) <= .5), `${width}px rich summaries moved from their fixed lane centre`);
    assert.ok(readings[1].summaryWidth > readings[0].summaryWidth + 4, `${width}px rich two-digit summary did not expand naturally`);
    assert.ok(readings[2].summaryWidth > readings[1].summaryWidth + 4, `${width}px rich three-digit summary did not expand naturally`);
    assert.ok(readings.every((reading) => reading.summaryLeft >= reading.triggerLeft - .5 && reading.summaryRight <= reading.triggerRight + .5), `${width}px rich summary escapes the fixed trigger`);
    assert.ok(readings.every((reading) => Math.abs((reading.iconBottom - reading.countBottom) - 1) <= .25), `${width}px rich smaller count boxes lost their one-pixel optical lift`);
    assert.ok(readings.every((reading) => Math.abs(reading.summaryCenterY - (reading.triggerTop + 10.5)) <= .5), `${width}px rich summaries lost the three-pixel top extension`);
    assert.ok(readings.every((reading) => reading.paintedInk?.icon && reading.paintedInk?.count), `${width}px rich painted-ink readings are incomplete`);
    assert.ok(readings.every((reading) => reading.paintedInk.icon.bottom === reading.paintedInk.count.bottom && reading.paintedInk.count.top > reading.paintedInk.icon.top), `${width}px rich count is not smaller while sharing the icon's painted bottom`);
    assert.ok(readings.every((reading) => reading.titleClearance >= 4.5 && reading.titleClearance <= 5.5), `${width}px rich trigger lost its five-pixel title-lane gap`);
    assert.ok(readings.every((reading) => Math.abs(reading.chevronWidth - 8) <= .5 && Math.abs(reading.chevronHeight - 8) <= .5), `${width}px rich disclosure is not 8x8`);
    assert.ok(readings.every((reading) => Math.abs(reading.chevronCenterX - (reading.triggerLeft + 18)) <= .5), `${width}px rich disclosure lost its one-pixel left correction`);
    assert.ok(readings.every((reading) => reading.chevronPathTop - reading.summaryBottom >= 1), `${width}px rich disclosure paints into the summary row`);
    assert.ok(readings.every((reading) => reading.chevronOpacity === '0.38' && Math.abs(reading.chevronStrokeWidth - 2.4) <= .1), `${width}px rich idle disclosure styling changed`);
    for (const count of fixtureCounts) {
      const expected = `${count} sub-agent${count === 1 ? '' : 's'}`;
      assert.equal(byCount.get(count).subagentTooltip?.text, expected, `${width}px rich tooltip does not preserve the React-derived exact count`);
    }
  }
}

// Each capture owns and destroys its BrowserWindow. Keep Electron alive between
// those windows so the next deterministic viewport can load on Windows/Linux.
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  let activeWindow = null;
  let exitCode = 0;
  try {
    await mkdir(outputDirectory, { recursive: true });
    if (viewports.some((viewport) => viewport.kind === 'local-model-image')) {
      const width = 480;
      const height = 260;
      const bitmap = Buffer.alloc(width * height * 4);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const offset = (y * width + x) * 4;
          const panel = x > 34 && x < width - 34 && y > 30 && y < height - 30;
          const rail = panel && x < 150;
          const accent = panel && y > 72 && y < 96 && x > 50 && x < width - 54;
          const red = accent ? 103 : rail ? 31 : panel ? 40 : 17 + Math.round((x / width) * 7);
          const green = accent ? 190 : rail ? 33 : panel ? 42 : 18 + Math.round((y / height) * 6);
          const blue = accent ? 143 : rail ? 31 : panel ? 39 : 19;
          bitmap[offset] = blue;
          bitmap[offset + 1] = green;
          bitmap[offset + 2] = red;
          bitmap[offset + 3] = 255;
        }
      }
      await writeFile(localModelImagePath, nativeImage.createFromBitmap(bitmap, { width, height, scaleFactor: 1 }).toPNG());
      session.defaultSession.protocol.handle('tethoq-media', async (request) => {
        if (request.method !== 'GET') return new Response(null, { status: 405 });
        try {
          const url = new URL(request.url);
          const requestedPath = decodeURIComponent(url.pathname.slice(1));
          if (url.hostname !== 'local' || path.resolve(requestedPath).toLocaleLowerCase() !== path.resolve(localModelImagePath).toLocaleLowerCase()) return new Response(null, { status: 404 });
          return new Response(await readFile(localModelImagePath), { headers: { 'Cache-Control': 'no-store', 'Content-Type': 'image/png' } });
        } catch {
          return new Response(null, { status: 404 });
        }
      });
    }
    for (const viewport of viewports) {
      activeWindow = await capture(viewport);
      if (!activeWindow.isDestroyed() && activeWindow.webContents.debugger.isAttached()) activeWindow.webContents.debugger.detach();
      if (!activeWindow.isDestroyed()) activeWindow.destroy();
      activeWindow = null;
    }
    assertCompactSubagentFixtureSet();
    assertRichSubagentFixtureSet();
  } catch (error) {
    exitCode = 1;
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  } finally {
    if (activeWindow && !activeWindow.isDestroyed() && activeWindow.webContents.debugger.isAttached()) activeWindow.webContents.debugger.detach();
    if (activeWindow && !activeWindow.isDestroyed()) activeWindow.destroy();
    app.exit(exitCode);
  }
});
