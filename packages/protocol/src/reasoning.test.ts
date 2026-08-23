import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizeReasoningEffort, extractAdvertisedReasoningEfforts, knownReasoningProfile, matchReasoningEffort, payloadLooksLikeReasoning, reasoningDisplayLabel, resolveModelReasoningProfile } from "./reasoning.js";

test("advertised reasoning efforts accept nested ACP and API spellings", () => {
  assert.deepEqual(extractAdvertisedReasoningEfforts({
    thought_levels: [{ value: "low" }, { value: "high" }, { value: "auto" }],
  }), ["low", "high"]);
  assert.deepEqual(extractAdvertisedReasoningEfforts({
    supportedReasoningEfforts: [{ reasoningEffort: "Low" }, { value: "High" }],
  }), ["Low", "High"]);
  assert.deepEqual(extractAdvertisedReasoningEfforts({
    id: "grok-4.6",
    name: "Grok 4.6",
  }), []);
  // OpenCode advertises reasoning levels as model variants; the variant names
  // are the selectable efforts and ambiguous keys are dropped.
  assert.deepEqual(extractAdvertisedReasoningEfforts({
    id: "deepseek-v4-pro",
    variants: { high: { reasoningEffort: "high" }, max: { reasoningEffort: "max" }, auto: {} },
  }), ["high", "max"]);
  // A stored default (options.reasoning_effort) must not collapse the choice:
  // the variants enumeration outranks a single current value.
  assert.deepEqual(extractAdvertisedReasoningEfforts({
    id: "deepseek-v4-pro-0813",
    variants: { low: {}, medium: {}, high: {}, max: {} },
    options: { reasoning_effort: "high" },
  }), ["low", "medium", "high", "max"]);
  assert.deepEqual(resolveModelReasoningProfile({
    providerId: "opencode",
    modelId: "deepseek/deepseek-v4-pro",
    displayName: "DeepSeek V4 Pro",
    advertised: { variants: { high: {}, max: {} } },
  }).efforts, ["high", "max"]);
});

test("Grok 4.6 documents selectable efforts including xhigh", () => {
  assert.deepEqual(knownReasoningProfile("grok", "grok-4.6", "Grok 4.6"), {
    efforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "high",
  });
  assert.deepEqual(resolveModelReasoningProfile({
    providerId: "grok",
    modelId: "grok-4.6",
    displayName: "Grok 4.6",
  }).efforts, ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(resolveModelReasoningProfile({
    providerId: "direct",
    modelId: "xai::grok-4.6",
    displayName: "Grok 4.6",
  }).defaultEffort, "high");
  assert.equal(knownReasoningProfile("grok", "grok-code", "Grok Code"), undefined);
});

test("Extra high spellings collapse onto the advertised Grok effort", () => {
  assert.equal(canonicalizeReasoningEffort("x-high"), "xhigh");
  assert.equal(canonicalizeReasoningEffort("extra high"), "xhigh");
  assert.equal(canonicalizeReasoningEffort("extra_high"), "xhigh");
  assert.equal(matchReasoningEffort("extra high", ["low", "medium", "high", "xhigh"]), "xhigh");
  assert.equal(matchReasoningEffort("xhigh", ["low", "medium", "high", "x-high"]), "x-high");
  assert.equal(matchReasoningEffort("Default", ["low", "high"]), undefined);
});

test("Grok shows Low for the documented low effort instead of Codex Light", () => {
  assert.equal(reasoningDisplayLabel("low"), "Low");
  assert.equal(reasoningDisplayLabel("low", { providerId: "grok", modelId: "grok-4.6", displayName: "Grok 4.6" }), "Low");
  assert.equal(reasoningDisplayLabel("xhigh", { providerId: "grok", modelId: "grok-4.6" }), "Extra high");
  assert.equal(reasoningDisplayLabel("low", { providerId: "codex", modelId: "gpt-5.6-sol", displayName: "GPT-5.6 Sol" }), "Light");
  assert.equal(reasoningDisplayLabel("Low", { providerId: "codex" }), "Light");
  assert.equal(reasoningDisplayLabel("default"), "");
});

test("advertised catalogue values win over the documented family fallback", () => {
  assert.deepEqual(resolveModelReasoningProfile({
    providerId: "grok",
    modelId: "grok-4.6",
    advertised: { thoughtLevels: ["medium", "high"] },
  }).efforts, ["medium", "high"]);
});

test("live thought payloads are reasoning even when partType is omitted", () => {
  assert.equal(payloadLooksLikeReasoning({
    content: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Inspecting" } },
  }), true);
  assert.equal(payloadLooksLikeReasoning({
    content: { sessionUpdate: "agent_message_chunk", content: { type: "thinking", thinking: "Tracing" } },
  }), true);
  assert.equal(payloadLooksLikeReasoning({ reasoning: "Considering options" }), true);
  assert.equal(payloadLooksLikeReasoning({
    content: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello" } },
  }), false);
});
