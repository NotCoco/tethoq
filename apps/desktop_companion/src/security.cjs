'use strict';

const SECURE_WEB_PREFERENCES = Object.freeze({
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  spellcheck: false,
});

const ALLOWED_PREVIEW_STATES = new Set(['first-run', 'connected']);

function normalizePreviewState(value) {
  return ALLOWED_PREVIEW_STATES.has(value) ? value : 'first-run';
}

module.exports = {
  SECURE_WEB_PREFERENCES,
  normalizePreviewState,
};
