/**
 * Drives the real microphone path end to end using Chromium's synthetic audio
 * device, so the one link that cannot be exercised headlessly — getUserMedia
 * through the MP3 encoder — is actually verified.
 *
 * The bundle is produced by an ordinary Vite application build, the same shape
 * electron-vite produces for the renderer. Library-mode builds resolve lamejs's
 * UMD globals differently and fail on them, which would be testing something the
 * user never runs.
 */
const { app, BrowserWindow, session } = require("electron");
const { mkdir, writeFile, rm } = require("node:fs/promises");
const { join } = require("node:path");

// A synthetic capture device: Chromium generates a tone instead of a real mic.
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");

const appRoot = join(__dirname, "..");
const sourceDirectory = join(appRoot, ".mic-probe-src");
const outDirectory = join(appRoot, ".mic-probe");
const recordSeconds = 2;

async function main() {
  await mkdir(sourceDirectory, { recursive: true });
  await writeFile(join(sourceDirectory, "index.html"),
    `<!doctype html><meta charset="utf-8"><body><script type="module" src="./probe.js"></script></body>`, "utf8");
  await writeFile(join(sourceDirectory, "probe.js"), `
window.addEventListener("error", (event) => console.log("PAGE ERROR: " + event.message));
window.addEventListener("unhandledrejection", (event) => console.log("PAGE REJECTION: " + event.reason));
console.log("probe module executing");
import { Mp3DictationRecorder, liveTraceLevels } from "../src/renderer/src/audio_dictation";
console.log("recorder imported: " + typeof Mp3DictationRecorder);
window.__run = async (seconds) => {
  const levels = [];
  const recorder = new Mp3DictationRecorder((level) => { levels.push(level); liveTraceLevels.push(level); });
  await recorder.start();
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  const clip = await recorder.stop();
  const binary = atob(clip.dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  let decodedSeconds = null;
  let decodeError = null;
  try {
    const context = new AudioContext();
    const buffer = await context.decodeAudioData(bytes.buffer.slice(0));
    decodedSeconds = buffer.duration;
    await context.close();
  } catch (error) { decodeError = String((error && error.message) || error); }
  return {
    name: clip.name, mimeType: clip.mimeType, origin: clip.origin,
    byteLength: clip.byteLength, durationSeconds: clip.durationSeconds,
    firstBytes: [...bytes.slice(0, 3)],
    liveLevelSamples: levels.length,
    maxLevel: levels.length ? Math.max(...levels) : 0,
    decodedSeconds, decodeError,
  };
};
`, "utf8");

  const { build } = await import("vite");
  const react = (await import("@vitejs/plugin-react")).default;
  await build({
    root: sourceDirectory,
    logLevel: "silent",
    // Loaded over file://, so asset URLs must be relative rather than root-absolute.
    base: "./",
    plugins: [react()],
    build: { outDir: outDirectory, emptyOutDir: true },
  });

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === "media"));
  const window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } });
  const rendererLogs = [];
  window.webContents.on("console-message", (event) => {
    const text = typeof event === "object" && event !== null && "message" in event ? String(event.message) : "";
    if (text && !/Security Warning|unsafe-eval|electronjs\.org|once the app is packaged|unnecessary security risks|This warning will not/.test(text)) {
      rendererLogs.push(text);
    }
  });
  await window.loadFile(join(outDirectory, "index.html"));
  await new Promise((resolve) => setTimeout(resolve, 600));

  const result = await window.webContents.executeJavaScript(`window.__run(${recordSeconds})`)
    .catch((error) => ({ failure: String((error && error.message) || error) }));

  const checks = result.failure ? [["recording completed without throwing", false]] : [
    ["mime type is MP3", result.mimeType === "audio/mpeg"],
    ["marked as dictation", result.origin === "dictation"],
    ["named as a dictation clip", /^dictation-.*\.mp3$/.test(result.name)],
    ["produced audio bytes", result.byteLength > 4000],
    ["measured length matches the recording", Math.abs(result.durationSeconds - recordSeconds) < 0.5],
    ["live trace received levels", result.liveLevelSamples >= 10],
    ["captured a non-silent signal", result.maxLevel > 0.01],
    ["bytes decode as real audio", result.decodedSeconds !== null],
    ["decoded length matches too", result.decodedSeconds !== null && Math.abs(result.decodedSeconds - recordSeconds) < 0.6],
  ];

  console.log(JSON.stringify(result, null, 2));
  if (rendererLogs.length) console.log(`\nrenderer console:\n  ${rendererLogs.join("\n  ")}`);
  console.log("");
  let failed = 0;
  for (const [label, ok] of checks) {
    if (!ok) failed += 1;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  await rm(sourceDirectory, { recursive: true, force: true });
  await rm(outDirectory, { recursive: true, force: true });
  app.exit(failed === 0 ? 0 : 1);
}

app.whenReady().then(main).catch(async (error) => {
  console.error(`mic probe failed: ${(error && error.stack) || error}`);
  await rm(sourceDirectory, { recursive: true, force: true }).catch(() => undefined);
  await rm(outDirectory, { recursive: true, force: true }).catch(() => undefined);
  app.exit(1);
});
