import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

test("the production recorder encodes captured PCM into MP3 and releases its input", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tethoq-audio-encoder-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = join(directory, "audio.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("../src/renderer/src/audio_dictation.tsx", import.meta.url))],
    outfile, bundle: true, format: "esm", platform: "node", jsx: "automatic",
  });
  // Import the app's shim as well as its recorder. Recreating the shim here
  // would accidentally repair the code this regression is supposed to check.
  const { Mp3DictationRecorder } = await import(pathToFileURL(outfile).href);
  let processor;
  const released = [];
  class AudioContext {
    state = "running";
    destination = {};
    createMediaStreamSource() { return { connect() {} }; }
    createScriptProcessor() {
      processor = { connect() {}, disconnect() { released.push("processor"); } };
      return processor;
    }
    async close() { this.state = "closed"; released.push("context"); }
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
  Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: AudioContext });
  t.after(() => previous ? Object.defineProperty(globalThis, "AudioContext", previous) : delete globalThis.AudioContext);
  const recorder = new Mp3DictationRecorder(() => {});
  t.after(() => recorder.dispose());
  await recorder.start({ getTracks: () => [{ stop() { released.push("track"); } }] });
  const samples = Float32Array.from({ length: 44100 }, (_, i) => Math.sin(i / 44100 * 440 * 2 * Math.PI) * 0.4);
  processor.onaudioprocess({ inputBuffer: { getChannelData: () => samples } });
  const clip = await recorder.stop();
  const bytes = Buffer.from(clip.dataBase64, "base64");
  assert.equal(clip.mimeType, "audio/mpeg");
  assert.equal(clip.origin, "dictation");
  assert.equal(clip.durationSeconds, 1);
  assert.equal(clip.byteLength, bytes.length);
  assert.ok(bytes.length > 1000, "the recorder must return encoded audio, not an empty header");
  assert.equal(bytes[0], 0xff);
  assert.equal(bytes[1] & 0xe0, 0xe0, "MP3 output begins with an MPEG frame sync");
  assert.deepEqual(released, ["processor", "track", "context"]);
  assert.equal(processor.onaudioprocess, null);
});
