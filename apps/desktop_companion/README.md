# Tethoq Bridge desktop companion

This folder contains the independent, tray-first Windows companion for Tethoq Bridge. It uses a compact frameless status panel, shows secure QR pairing only when requested, and keeps an established Bridge connection alive when the panel is closed. Explicitly choosing **Quit Tethoq Bridge** from the tray ends the Bridge process.

## Run locally

```powershell
npm install
npm run dev
```

Start silently in the tray without creating a renderer window:

```powershell
npm run dev -- --background
```

Run focused checks with `npm run verify`. Build a Windows NSIS installer with `npm run pack:win` after installing dependencies.

## Security boundary

The renderer runs with Node integration disabled, context isolation enabled, Chromium sandboxing enabled, denied permission requests, blocked navigation/new windows, a strict Content Security Policy, and explicitly allowlisted IPC methods. Bridge execution and URL validation stay in the main process; the renderer never receives the secret pairing-page URL. Hardware acceleration is disabled for the lightweight companion, hidden renderers are released after 30 seconds, and no pairing polling runs while the panel is hidden.

## Brand assets

- `src/assets/tethoq-bridge.png` — transparent connector mark for the panel/window.
- `src/assets/tethoq-bridge-tray.png` and `tethoq-bridge-tray@2x.png` — light-gray thin tray marks sized for Windows scaling.
- `src/assets/tethoq-bridge.ico` — multi-resolution Windows executable, installer, and shortcut icon.

The original `tethoq-icon.png` remains a legacy/full-Tethoq reference and is not the Bridge package icon.
