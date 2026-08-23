'use strict';

/**
 * User-visible desktop-chat coverage contract for the zero-token Electron QA.
 *
 * A feature is covered only when its named renderer journey passed. Keeping
 * this inventory separate from the scenario runner prevents a newly added UI
 * surface from being mistaken for tested merely because the app still boots.
 */
const FEATURE_CONTRACT = Object.freeze([
  ['runtime.connected', 'boot-and-state-signals'],
  ['tasks.secondary-fixture-visible', 'boot-and-state-signals'],
  ['subagents.proven-child-hidden-from-rail', 'boot-and-state-signals'],
  ['subagents.provider-parented-user-task-visible', 'boot-and-state-signals'],
  ['subagents.child-reachable-from-parent', 'boot-and-state-signals'],
  ['subagents.dropup-not-clipped-or-doubled', 'boot-and-state-signals'],
  ['subagents.working-child-spinner', 'boot-and-state-signals'],
  ['subagents.open-child-back-to-parent', 'boot-and-state-signals'],
  ['transcript.copy-controls-clean', 'boot-and-state-signals'],

  ['context.draft-live-percentage', 'context-threshold-lifecycle'],
  ['context.escape-discards-draft', 'context-threshold-lifecycle'],
  ['context.outside-click-discards-draft', 'context-threshold-lifecycle'],
  ['context.apply-once', 'context-threshold-lifecycle'],
  ['context.persist-on-reopen', 'context-threshold-lifecycle'],
  ['context.success-is-silent', 'context-threshold-lifecycle'],

  ['commands.catalogue-keyboard', 'command-contracts'],
  ['eyes.capability-filter', 'command-contracts'],
  ['eyes.provider-model-payload', 'command-contracts'],
  ['ears.capability-filter', 'command-contracts'],
  ['ears.settings-persist', 'ears-transcription-send'],
  ['ears.record-transcribe-send', 'ears-transcription-send'],
  ['ears.source-audio-not-forwarded', 'ears-transcription-send'],
  ['mesh.mixed-provider-model-effort-payload', 'command-contracts'],
  ['simplify.hidden-metadata-payload', 'command-contracts'],

  ['stream.reasoning-live-single-clickable', 'master-stream-identity'],
  ['stream.reasoning-shimmer', 'master-stream-identity'],
  ['stream.tool-command-details', 'master-stream-identity'],
  ['stream.optimistic-user-reconciles-once', 'master-stream-identity'],
  ['stream.history-insertion-no-duplicates', 'master-stream-identity'],
  ['history.terminal-before-final-recovers-after-reload', 'terminal-history-race'],
  ['history.terminal-race-no-duplicate-or-stale-shimmer', 'terminal-history-race'],
  ['annotation.create-edit-remove-send', 'response-annotation-journey'],
  ['annotation.metadata-hidden-from-transcript', 'response-annotation-journey'],
  ['annotation.provider-echo-reconciles-once', 'response-annotation-journey'],
  ['annotation.reopen-detail-once', 'response-annotation-journey'],
  ['compaction.single-collapsed-disclosure', 'compaction-once'],
  ['compaction.detail-on-demand-once', 'compaction-once'],
  ['compaction.copy-control-does-not-overlap', 'compaction-once'],
  ['failure.visible-error-row', 'error'],
  ['approval.pause-resolve-resume', 'approval'],

  ['audio.stop-then-send', 'native-audio-sending'],
  ['audio.send-while-recording', 'native-audio-sending'],
  ['audio.audio-only-real-turn', 'native-audio-sending'],
  ['audio.playable-persistent-user-row', 'native-audio-sending'],
  ['audio.no-queue-flash-or-success-toast', 'native-audio-sending'],
  ['audio.no-stale-answer-replay', 'native-audio-sending'],
  ['audio.gpt-5.6-sol-requires-ears', 'ears-transcription-send'],

  ['scroll.reader-owned-during-stream', 'queue-steer-and-viewport-stability'],
  ['scroll.reasoning-expansion-preserves-anchor', 'queue-steer-and-viewport-stability'],
  ['scroll.task-switch-restores-session-anchor', 'queue-steer-and-viewport-stability'],
  ['queue.queued-row-never-fake-transcript', 'queue-steer-and-viewport-stability'],
  ['queue.steer-becomes-one-user-row', 'queue-steer-and-viewport-stability'],
  ['queue.edit-preserves-identity-and-order', 'queue-management-journeys'],
  ['queue.remove-preserves-sibling-order', 'queue-management-journeys'],
  ['queue.failed-delivery-restores-original-index', 'queue-management-journeys'],
  ['queue.successful-actions-are-silent', 'queue-management-journeys'],
  ['queue.move-consumes-only-selected-item', 'queue-management-journeys'],
  ['queue.move-preserves-content-model-effort', 'queue-management-journeys'],
  ['queue.side-chat-consumes-only-selected-item', 'queue-management-journeys'],
  ['queue.side-chat-opens-and-reopens', 'queue-management-journeys'],
  ['history.image-audio-file-filechange-render', 'queue-steer-and-viewport-stability'],
  ['history.older-page-loads', 'queue-steer-and-viewport-stability'],

  ['responsive.compact-workspace-bounds', 'overlays-and-responsive'],
  ['responsive.queue-popover-not-clipped', 'overlays-and-responsive'],
  ['responsive.model-picker-not-clipped', 'overlays-and-responsive'],
  ['responsive.model-picker-painted-above-header', 'overlays-and-responsive'],
  ['responsive.model-picker-focuses-search', 'overlays-and-responsive'],
  ['responsive.actions-popover-not-clipped', 'overlays-and-responsive'],
  ['draft.task-local-restore', 'draft-restore-and-materialize'],
  ['draft.materialize-create-payload', 'draft-restore-and-materialize'],
  ['draft.materialize-once-no-duplicate', 'draft-restore-and-materialize'],
  ['draft.clear-after-materialize', 'draft-restore-and-materialize'],
  ['settings.close-action-persist', 'settings-round-trip'],
  ['settings.alert-level-persist', 'settings-round-trip'],
  ['settings.startup-persist', 'settings-round-trip'],
  ['settings.reasoning-display-persist', 'settings-round-trip'],
  ['settings.experimental-toggle-persist', 'settings-round-trip'],
  ['settings.foreign-subagent-toggle-persist', 'settings-round-trip'],
  ['settings.success-is-silent', 'settings-round-trip'],
  ['microphone.custom-device-exact-constraint', 'microphone-selection-fallback'],
  ['microphone.missing-device-falls-back-to-default', 'microphone-selection-fallback'],
  ['microphone.preference-clears-after-fallback', 'microphone-selection-fallback'],
  ['tasks.search-filters-visible-rows', 'task-search-and-filters'],
  ['tasks.clear-and-escape-reset-search', 'task-search-and-filters'],
  ['tasks.combined-provider-status-available-filter', 'task-search-and-filters'],
  ['tasks.no-match-state', 'task-search-and-filters'],
  ['archive.selected-row-leaves-default-list', 'archive-selected-task'],
  ['archive.selected-conversation-remains-open', 'archive-selected-task'],
  ['archive.show-archived-restores-row', 'archive-selected-task'],
  ['archive.unselected-task-round-trip', 'archive-unselected-and-draft'],
  ['archive.draft-round-trip', 'archive-unselected-and-draft'],
  ['archive.restore-reenters-default-list', 'archive-unselected-and-draft'],
].map(([id, scenario]) => Object.freeze({ id, scenario })));

function evaluateFeatureCoverage(results, failures = []) {
  const failedScenarios = new Set(failures.map((failure) => failure?.name).filter((name) => typeof name === 'string'));
  const coveredFeatureIds = [];
  const missingFeatureIds = [];
  const evidence = {};
  for (const feature of FEATURE_CONTRACT) {
    const result = results[feature.scenario];
    const featureEvidence = result?.featureEvidence;
    const explicitEvidence = featureEvidence
      && typeof featureEvidence === 'object'
      && !Array.isArray(featureEvidence)
      ? featureEvidence[feature.id]
      : undefined;
    // A scenario's successful return is not enough to prove every feature it
    // names. Require the scenario to publish a per-feature evidence record,
    // with an explicit pass and a non-empty observation captured after the
    // journey's assertions ran. This keeps a future scenario from silently
    // claiming an entire group merely because it did not throw.
    const hasExplicitEvidence = explicitEvidence !== null
      && typeof explicitEvidence === 'object'
      && explicitEvidence.passed === true
      && explicitEvidence.observed !== undefined
      && explicitEvidence.observed !== null;
    const passed = result?.passed === true && hasExplicitEvidence && !failedScenarios.has(feature.scenario);
    evidence[feature.id] = {
      scenario: feature.scenario,
      passed,
      explicit: hasExplicitEvidence,
      ...(hasExplicitEvidence ? { observed: explicitEvidence.observed } : {}),
    };
    (passed ? coveredFeatureIds : missingFeatureIds).push(feature.id);
  }
  return {
    requiredFeatureCount: FEATURE_CONTRACT.length,
    coveredFeatureIds,
    missingFeatureIds,
    evidence,
  };
}

module.exports = { FEATURE_CONTRACT, evaluateFeatureCoverage };
