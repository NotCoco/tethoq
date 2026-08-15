'use strict';

const WINDOW_MODES = Object.freeze({
  summary: Object.freeze({ width: 432, height: 226 }),
  pairing: Object.freeze({ width: 432, height: 518 }),
});

function normalizeWindowMode(value) {
  return Object.hasOwn(WINDOW_MODES, value) ? value : 'summary';
}

function fitWindowBounds(workArea, mode, margin = 16) {
  const preferred = WINDOW_MODES[normalizeWindowMode(mode)];
  const availableWidth = Math.max(340, workArea.width - (margin * 2));
  const availableHeight = Math.max(194, workArea.height - (margin * 2));
  const width = Math.min(preferred.width, availableWidth);
  const height = Math.min(preferred.height, availableHeight);
  return {
    x: Math.round(workArea.x + workArea.width - width - margin),
    y: Math.round(workArea.y + workArea.height - height - margin),
    width: Math.round(width),
    height: Math.round(height),
  };
}

module.exports = {
  WINDOW_MODES,
  fitWindowBounds,
  normalizeWindowMode,
};
