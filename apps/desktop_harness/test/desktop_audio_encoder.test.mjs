import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

/**
 * lamejs 1.2.1 was written for plain script tags. Several of its modules use
 * MPEGMode and friends as globals without requiring them, so under any bundler
 * encoding threw "MPEGMode is not defined" the moment a recording stopped, and
 * MP3 dictation could never produce a clip.
 */
test("lamejs still depends on globals its own modules never require", async () => {
  const unrequired = [];
  for (const name of ["Encoder", "Lame", "PsyModel"]) {
    const source = await readFile(join(appRoot, "node_modules", "lamejs", "src", "js", `${name}.js`), "utf8");
    if (/\bMPEGMode\b/.test(source) && !/require\(['"]\.\/MPEGMode/.test(source)) unrequired.push(name);
  }
  assert.ok(unrequired.length > 0, "lamejs no longer needs the global shim; the workaround can be removed");
});

test("publishing the classes as globals makes real MP3 encoding work", () => {
  for (const name of ["MPEGMode", "Lame", "BitStream"]) {
    globalThis[name] ??= require(`lamejs/src/js/${name}.js`);
  }
  const { Mp3Encoder } = require("lamejs");

  const sampleRate = 44100;
  const samples = new Int16Array(sampleRate);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.round(Math.sin((index / sampleRate) * 440 * 2 * Math.PI) * 12000);
  }
  const encoder = new Mp3Encoder(1, sampleRate, 128);
  const frames = [encoder.encodeBuffer(samples), encoder.flush()].filter((chunk) => chunk.length > 0);
  const total = frames.reduce((sum, chunk) => sum + chunk.length, 0);

  assert.ok(total > 1_000, `expected real MP3 output, got ${total} bytes`);
  // Every MPEG audio frame begins with eleven set sync bits.
  assert.equal(frames[0][0] & 0xff, 0xff);
  assert.equal(frames[0][1] & 0xe0, 0xe0);
});

test("the recorder publishes the globals lamejs needs before encoding", async () => {
  const source = await readFile(join(appRoot, "src", "renderer", "src", "audio_dictation.tsx"), "utf8");
  assert.match(source, /import MPEGMode from "lamejs\/src\/js\/MPEGMode\.js"/);
  assert.match(source, /const lameGlobals[^=]*= \{ MPEGMode, Lame, BitStream \}/);
  assert.match(source, /globalThis as Record<string, unknown>\)\[name\] = value/);
});
