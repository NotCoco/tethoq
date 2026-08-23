import assert from "node:assert/strict";
import test from "node:test";
import {
  attachmentOriginOf,
  composeEarsDestinationText,
  defaultEarsSettings,
  earsCancelledMessage,
  earsCleanedInstruction,
  earsConfigurationError,
  earsInstruction,
  earsUserPrompt,
  earsVerbatimInstruction,
  eligibleEarsClips,
  isDictationAudioAttachment,
  isEarsCancelledError,
  lowestReasoningEffort,
  normalizeEarsSettings,
  planEarsSend,
  applyEarsTranscripts,
  providerDeliversNativeAudio,
  reasoningLabelForNote,
  routeAcceptsEarsAudio,
} from "./ears.js";

const dictation = { id: "d1", mimeType: "audio/mpeg", origin: "dictation" as const };
const picker = { id: "p1", mimeType: "audio/mpeg", origin: "file-picker" as const };
const dropped = { id: "p2", mimeType: "audio/mpeg", origin: "drag-drop" as const };
const clipboard = { id: "p3", mimeType: "audio/mpeg", origin: "clipboard" as const };

test("only explicit dictation origin is eligible for EARS", () => {
  assert.equal(isDictationAudioAttachment(dictation), true);
  assert.equal(isDictationAudioAttachment(picker), false);
  assert.deepEqual(eligibleEarsClips([picker, picker, picker]), []);
  assert.deepEqual(eligibleEarsClips([picker, dictation, dropped]).map((item) => item.id), ["d1"]);
  assert.equal(attachmentOriginOf({}), "file-picker");
  assert.equal(attachmentOriginOf({ origin: "dictation" }), "dictation");
});

test("multiple dictation clips keep composer order", () => {
  const clips = [
    { id: "first", mimeType: "audio/mpeg", origin: "dictation" as const },
    picker,
    { id: "second", mimeType: "audio/mpeg", origin: "dictation" as const },
  ];
  assert.deepEqual(eligibleEarsClips(clips).map((item) => item.id), ["first", "second"]);
});

test("typed text stays ahead of transcribed clips", () => {
  assert.equal(composeEarsDestinationText("Fix the tests", ["and ship it"]), "Fix the tests\n\nand ship it");
  assert.equal(composeEarsDestinationText("", ["one", "two"]), "one\n\ntwo");
  assert.equal(composeEarsDestinationText("only text", ["", "  "]), "only text");
});

test("verbatim and cleaned use distinct high-priority instructions", () => {
  assert.notEqual(earsVerbatimInstruction, earsCleanedInstruction);
  assert.match(earsInstruction("verbatim"), /Transcribe as faithfully as possible/);
  assert.match(earsInstruction("cleaned"), /polished written version/);
  assert.doesNotMatch(earsInstruction("verbatim"), /polished written version/);
  for (const instruction of [earsInstruction("verbatim"), earsInstruction("cleaned")]) {
    assert.match(instruction, /new, independent transcription job/);
    assert.match(instruction, /unrelated users or conversations/);
    assert.match(instruction, /Ignore all earlier helper-session context/);
    assert.match(instruction, /Output only the requested transcript/);
    assert.match(instruction, /answer to the spoken request/);
  }
});

test("each EARS user turn repeats isolation and transcript-only guidance", () => {
  const first = earsUserPrompt(1);
  const second = earsUserPrompt(2);
  for (const prompt of [first, second]) {
    assert.match(prompt, /New independent transcription job/);
    assert.match(prompt, /different Tethoq task/);
    assert.match(prompt, /return only its transcript/);
    assert.match(prompt, /no label, acknowledgement, commentary, Markdown, or answer/);
  }
  assert.doesNotMatch(first, /recording 1/);
  assert.match(second, /recording 2/);
  assert.match(second, /do not use any other recording/);
});

test("EARS routes require advertised audio input on a native-audio provider", () => {
  assert.equal(routeAcceptsEarsAudio({ providerId: "direct", inputModalities: ["text", "image", "audio"] }), true);
  assert.equal(routeAcceptsEarsAudio({ providerId: "codex", inputModalities: ["text", "image", "audio"] }), true);
  assert.equal(routeAcceptsEarsAudio({ providerId: "direct", inputModalities: ["text", "image"] }), false);
  assert.equal(routeAcceptsEarsAudio({ providerId: "grok", inputModalities: ["text", "image", "audio"] }), false);
  assert.equal(routeAcceptsEarsAudio({ providerId: "direct", inputModalities: ["text"] }), false);
});

test("lowest supported reasoning is deterministic and omits invented values", () => {
  assert.equal(lowestReasoningEffort(["High", "Low", "Ultra"]), "Low");
  assert.equal(lowestReasoningEffort(["medium", "light", "auto"]), "light");
  assert.equal(lowestReasoningEffort(["Default", "Auto"]), undefined);
  assert.equal(lowestReasoningEffort([]), undefined);
  assert.equal(reasoningLabelForNote("low"), "Low");
  assert.equal(reasoningLabelForNote("low", { providerId: "codex", modelId: "gpt-5.6-sol" }), "Light");
  assert.equal(reasoningLabelForNote("low", { providerId: "grok", modelId: "grok-4.6" }), "Low");
});

test("enabled EARS without a usable model is rejected before send", () => {
  const routes = [{
    providerId: "direct",
    modelId: "openai::gpt-5.6-sol",
    displayName: "GPT-5.6 Sol",
    inputModalities: ["text", "image", "audio"] as const,
    efforts: ["Low", "High"],
  }];
  assert.equal(earsConfigurationError({ ...defaultEarsSettings, enabled: true }, routes, [dictation]), "Choose an EARS model before sending dictation.");
  assert.match(earsConfigurationError({
    enabled: true,
    providerId: "direct",
    modelId: "missing",
    mode: "cleaned",
  }, routes, [dictation]) ?? "", /no longer available/);
  assert.equal(earsConfigurationError({
    enabled: true,
    providerId: "direct",
    modelId: "openai::gpt-5.6-sol",
    mode: "cleaned",
  }, routes, [dictation]), undefined);
  assert.equal(earsConfigurationError({ ...defaultEarsSettings, enabled: true }, routes, [picker, clipboard]), undefined);
});

test("disabled EARS sends dictation to an audio destination and rejects a text-only one", () => {
  const routes = [{
    providerId: "direct",
    modelId: "openai::gpt-5.6-sol",
    displayName: "GPT-5.6 Sol",
    inputModalities: ["text", "image", "audio"] as const,
    efforts: ["Low"],
  }];
  const settings = { ...defaultEarsSettings, enabled: false };
  assert.deepEqual(planEarsSend({
    attachments: [dictation, picker],
    settings,
    routes,
    destinationAcceptsAudio: true,
  }), { action: "send", keepIds: ["d1", "p1"] });
  assert.equal(planEarsSend({
    attachments: [dictation],
    settings,
    routes,
    destinationAcceptsAudio: false,
  }).action, "reject");
});

test("EARS keeps non-dictation attachments and does not re-append transcripts on retry", () => {
  const routes = [{
    providerId: "direct",
    modelId: "openai::gpt-5.6-sol",
    displayName: "GPT-5.6 Sol",
    inputModalities: ["text", "image", "audio"] as const,
    efforts: ["Low"],
  }];
  const settings = { enabled: true, providerId: "direct", modelId: "openai::gpt-5.6-sol", mode: "cleaned" as const };
  const image = { id: "img", mimeType: "image/png", origin: "file-picker" as const };
  const plan = planEarsSend({
    attachments: [dictation, image, picker],
    settings,
    routes,
    destinationAcceptsAudio: false,
  });
  assert.deepEqual(plan, { action: "ears", clipIds: ["d1"], keepIds: ["img", "p1"] });
  const first = applyEarsTranscripts("typed", [], ["spoken once"]);
  assert.equal(applyEarsTranscripts("typed", [], ["spoken once"]), first);
});

test("cancelled EARS is a distinct abort, not a transcription failure", () => {
  assert.equal(isEarsCancelledError(new Error(earsCancelledMessage)), true);
  assert.equal(isEarsCancelledError(new Error("EARS did not hear any speech.")), false);
});

test("normalizeEarsSettings drops junk and defaults to cleaned", () => {
  assert.deepEqual(normalizeEarsSettings({ enabled: "yes", mode: "ask", modelId: "" }), defaultEarsSettings);
  assert.deepEqual(normalizeEarsSettings({
    enabled: true,
    providerId: "  direct  ",
    modelId: "openai::gpt-5.6-sol",
    mode: "verbatim",
  }), {
    enabled: true,
    providerId: "direct",
    modelId: "openai::gpt-5.6-sol",
    mode: "verbatim",
  });
});

test("only routes that can carry audio to a model are offered for direct audio", () => {
  // OpenCode forwards a file part with its real mime type, so it qualifies.
  assert.equal(providerDeliversNativeAudio("opencode"), true);
  assert.equal(providerDeliversNativeAudio("direct"), true);
  assert.equal(providerDeliversNativeAudio("codex"), true);
  // Grok rejects every non-image attachment, and its chat models cannot hear audio.
  assert.equal(providerDeliversNativeAudio("grok"), false);
  assert.equal(providerDeliversNativeAudio("pi"), false);

  // The model must also actually accept audio, not merely sit behind a route.
  assert.equal(routeAcceptsEarsAudio({ providerId: "direct", inputModalities: ["text", "image", "audio"] }), true);
  assert.equal(routeAcceptsEarsAudio({ providerId: "direct", inputModalities: ["text", "image"] }), false);
  assert.equal(routeAcceptsEarsAudio({ providerId: "grok", inputModalities: ["text", "image", "audio"] }), false);
});
