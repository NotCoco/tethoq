'use strict';

const summary = document.querySelector('#summary');
const pairingPanel = document.querySelector('#pairing-panel');
const statusDot = document.querySelector('#status-dot');
const statusLabel = document.querySelector('#status-label');
const bridgeTitle = document.querySelector('#bridge-title');
const bridgeDetail = document.querySelector('#bridge-detail');
const pairActionLabel = document.querySelector('#pair-action-label');
const toast = document.querySelector('#toast');

let currentStatus = { state: 'idle' };
let pairingTimer;
let toastTimer;
let pairingUiTimeout;
let pairingPanelOpen = false;
const pairingUiTimeoutMs = 45_000;

function clearPairingTimer() {
  window.clearInterval(pairingTimer);
  pairingTimer = undefined;
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = window.setTimeout(() => { toast.hidden = true; }, 3200);
}

function setSummaryStatus(status) {
  currentStatus = status;
  statusDot.className = '';
  if (status.state === 'paired') {
    statusLabel.textContent = 'Phone connected';
    bridgeTitle.textContent = 'Tethoq is ready';
    bridgeDetail.textContent = 'The Bridge is running quietly. Closing this panel keeps your phone connection available.';
    pairActionLabel.textContent = 'Pair another';
    return;
  }
  if (status.state === 'starting' || status.state === 'ready') {
    statusDot.className = 'busy';
    statusLabel.textContent = status.state === 'ready' ? 'Waiting for phone' : 'Preparing pairing';
    bridgeTitle.textContent = 'Pairing is active';
    bridgeDetail.textContent = 'The secure one-time code stays available while the Bridge runs in your tray.';
    pairActionLabel.textContent = status.state === 'ready' ? 'Show QR code' : 'View pairing';
    return;
  }
  if (status.state === 'error') {
    statusDot.className = 'error';
    statusLabel.textContent = 'Needs attention';
    bridgeTitle.textContent = 'Bridge needs a retry';
    bridgeDetail.textContent = 'The previous pairing attempt stopped. Your local tools and credentials were not exposed.';
    pairActionLabel.textContent = 'Try again';
    return;
  }
  if (status.state === 'booting' || status.state === 'restarting') {
    statusDot.className = 'busy';
    statusLabel.textContent = status.state === 'restarting' ? 'Bridge reconnecting' : 'Bridge starting';
    bridgeTitle.textContent = status.state === 'restarting' ? 'Restoring the connection' : 'Starting Tethoq Bridge';
    bridgeDetail.textContent = 'The local connector is getting ready. It will continue quietly in your tray.';
    pairActionLabel.textContent = 'Please wait';
    return;
  }
  statusLabel.textContent = 'Bridge ready';
  bridgeTitle.textContent = 'Connect Tethoq to this PC';
  bridgeDetail.textContent = 'Runs quietly in your tray. Your coding tools and credentials stay on this computer.';
  pairActionLabel.textContent = 'Pair a phone';
}

async function showSummary() {
  pairingPanelOpen = false;
  clearPairingTimer();
  pairingPanel.hidden = true;
  summary.hidden = false;
  await window.tethoq.setWindowMode('summary');
  setSummaryStatus(currentStatus);
}

async function showPairing() {
  pairingPanelOpen = true;
  summary.hidden = true;
  pairingPanel.hidden = false;
  await window.tethoq.setWindowMode('pairing');
  if (currentStatus.state === 'ready' && currentStatus.qrDataUrl) {
    renderPairingStatus(currentStatus);
    return;
  }
  if (currentStatus.state === 'starting') {
    renderPairingStatus(currentStatus);
    return;
  }
  await startPairing();
}

function renderPairingStatus(result) {
  const status = document.querySelector('#pairing-status');
  const detail = document.querySelector('#pairing-detail');
  const spinner = document.querySelector('#pairing-spinner');
  const loading = document.querySelector('#pairing-loading');
  const ready = document.querySelector('#pairing-ready');
  const qr = document.querySelector('#pairing-qr');
  const expiry = document.querySelector('#pairing-expiry');
  const retry = document.querySelector('#retry-pairing');

  currentStatus = result;
  setSummaryStatus(result);
  clearPairingTimer();

  if (result.state === 'paired') {
    void window.tethoq.completePreviewSetup();
    void showSummary();
    showToast('Your phone is connected.');
    return;
  }

  const hasReadyQr = result.state === 'ready'
    && typeof result.qrDataUrl === 'string'
    && result.qrDataUrl.startsWith('data:image/svg+xml;base64,');
  loading.hidden = hasReadyQr;
  ready.hidden = !hasReadyQr;
  retry.hidden = result.state !== 'error' && !(result.state === 'ready' && !hasReadyQr);
  spinner.hidden = result.state !== 'starting';

  if (hasReadyQr) {
    qr.src = result.qrDataUrl;
    const updateExpiry = () => {
      const seconds = Math.max(0, Math.ceil((Date.parse(result.expiresAt) - Date.now()) / 1000));
      expiry.textContent = seconds > 0
        ? `Expires in ${Math.ceil(seconds / 60)} min.`
        : 'This code expired.';
      if (seconds === 0) {
        clearPairingTimer();
        qr.removeAttribute('src');
        ready.hidden = true;
        loading.hidden = false;
        spinner.hidden = true;
        status.textContent = 'This pairing code expired';
        detail.textContent = 'Generate a new code and try again.';
        retry.hidden = false;
        currentStatus = { state: 'error', message: detail.textContent };
        setSummaryStatus(currentStatus);
      }
    };
    updateExpiry();
    pairingTimer = window.setInterval(updateExpiry, 1000);
    return;
  }

  qr.removeAttribute('src');
  if (result.state === 'error') {
    status.textContent = 'Could not prepare pairing';
    detail.textContent = result.message || 'Generate a new code and try again.';
  } else {
    status.textContent = 'Preparing a secure code…';
    detail.textContent = 'Nothing connects until you scan it.';
  }
}

async function startPairing() {
  renderPairingStatus({ state: 'starting' });
  window.clearTimeout(pairingUiTimeout);
  try {
    const result = await Promise.race([
      window.tethoq.startPairing(),
      new Promise((resolve) => {
        pairingUiTimeout = window.setTimeout(() => resolve({
          state: 'error',
          message: 'The secure connection is taking too long. Generate a new code and try again.',
          timedOut: true,
        }), pairingUiTimeoutMs);
      }),
    ]);
    if (!pairingPanelOpen) {
      currentStatus = result;
      setSummaryStatus(result);
      return;
    }
    if (result.timedOut) {
      try { await window.tethoq.abortPairingStart(); } catch { /* The visible timeout remains authoritative. */ }
    }
    renderPairingStatus(result);
  } catch {
    renderPairingStatus({
      state: 'error',
      message: 'Tethoq could not start pairing. Generate a new code and try again.',
    });
  } finally {
    window.clearTimeout(pairingUiTimeout);
  }
}

window.tethoq.onPairingProgress((message) => {
  if (!pairingPanelOpen || typeof message !== 'string') return;
  if (!document.querySelector('#pairing-spinner').hidden) {
    document.querySelector('#pairing-status').textContent = message;
  }
});

window.tethoq.onPairingState((state) => {
  if (!state || typeof state.state !== 'string') return;
  currentStatus = state;
  if (!pairingPanelOpen) setSummaryStatus(state);
  else renderPairingStatus(state);
});

document.querySelector('#show-pairing').addEventListener('click', () => { void showPairing(); });
document.querySelector('#pairing-back').addEventListener('click', () => { void showSummary(); });
document.querySelector('#retry-pairing').addEventListener('click', () => { void startPairing(); });
document.querySelector('#window-minimize').addEventListener('click', () => { void window.tethoq.minimizeWindow(); });
document.querySelector('#window-close').addEventListener('click', () => { void window.tethoq.hideWindow(); });
document.querySelector('#bridge-mark').addEventListener('error', (event) => {
  event.currentTarget.src = 'assets/tethoq-icon.png';
}, { once: true });

document.addEventListener('visibilitychange', () => {
  document.body.classList.toggle('page-hidden', document.hidden);
  if (document.hidden) clearPairingTimer();
  else if (!pairingPanel.hidden && currentStatus.state === 'ready') renderPairingStatus(currentStatus);
});

window.addEventListener('pagehide', () => {
  pairingPanelOpen = false;
  clearPairingTimer();
  window.clearTimeout(pairingUiTimeout);
});

async function initialize() {
  const [state, metadata, pairingStatus] = await Promise.all([
    window.tethoq.getPreviewState(),
    window.tethoq.getAppMeta(),
    window.tethoq.getPairingStatus(),
  ]);
  document.querySelector('#version-label').textContent = `v${metadata.version}`;
  const initial = pairingStatus.state === 'idle' && state === 'connected'
    ? { state: 'paired' }
    : pairingStatus;
  setSummaryStatus(initial);
  await showSummary();
}

void initialize();
