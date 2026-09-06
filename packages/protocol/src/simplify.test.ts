import assert from "node:assert/strict";
import test from "node:test";

import {
  maximumSimplifyMaxWords,
  normalizeSimplifySettings,
  parseSimplifyCommand,
  simplifyDeveloperInstructions,
} from "./simplify.js";

test("simplify command distinguishes previous and upcoming answers", () => {
  assert.deepEqual(parseSimplifyCommand(" /simplify "), {
    active: true,
    target: "previous",
    content: "Simplify the previous answer.",
  });
  assert.deepEqual(parseSimplifyCommand("Please /simplify: explain the result"), {
    active: true,
    target: "upcoming",
    content: "Please explain the result",
  });
  assert.deepEqual(parseSimplifyCommand("/simplify, explain the result"), {
    active: true,
    target: "upcoming",
    content: "explain the result",
  });
  assert.equal(parseSimplifyCommand("/simplified is not a command").active, false);
  assert.equal(parseSimplifyCommand("/simplify-extra is not a command").active, false);
  assert.equal(parseSimplifyCommand("/simplify.exe is not a command").active, false);
  assert.equal(parseSimplifyCommand("/simplify,explain is not a command").active, false);
});

test("simplify settings are bounded and guidance stays concise", () => {
  assert.deepEqual(normalizeSimplifySettings({ maxWords: 0 }), { maxWords: 1 });
  assert.equal(normalizeSimplifySettings({ maxWords: 99_999 }).maxWords, maximumSimplifyMaxWords);
  const guidance = simplifyDeveloperInstructions(
    normalizeSimplifySettings({ maxWords: 200, guidance: "Keep the concrete example." }),
    "upcoming",
  );
  assert.match(guidance, /within 200 words/u);
  assert.match(guidance, /Keep the concrete example/u);
  assert.ok(guidance.split(/\s+/u).length < 200);
});
