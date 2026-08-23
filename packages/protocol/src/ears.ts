import { reasoningDisplayLabel, type ReasoningLabelContext } from "./reasoning.js";

export const earsModes = ["verbatim", "cleaned"] as const;
export type EarsMode = (typeof earsModes)[number];

export const attachmentOrigins = ["file-picker", "drag-drop", "clipboard", "dictation"] as const;
export type AttachmentOrigin = (typeof attachmentOrigins)[number];

export const earsAudioMimeTypes = ["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/wave"] as const;
export type EarsAudioMimeType = (typeof earsAudioMimeTypes)[number];

export const defaultEarsSettings: EarsSettings = Object.freeze({
  enabled: false,
  providerId: null,
  modelId: null,
  mode: "cleaned",
});

export interface EarsSettings {
  readonly enabled: boolean;
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly mode: EarsMode;
}

export interface EarsAudioRoute {
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly inputModalities: readonly ("text" | "image" | "audio")[];
  readonly efforts: readonly string[];
}

export interface EarsAttachment {
  readonly id: string;
  readonly mimeType: string;
  readonly origin: AttachmentOrigin;
}

export const earsVerbatimInstruction = [
  "You are acting only as EARS, an audio transcription layer for another AI agent.",
  "",
  "Every attached recording is a new, independent transcription job. This hidden helper is shared across Tethoq tasks, so earlier messages may belong to unrelated users or conversations. Ignore all earlier helper-session context and never infer conversational continuity from it.",
  "",
  "Listen directly to the supplied audio and return only the text spoken by the user.",
  "",
  "Transcribe as faithfully as possible. Preserve the user's wording, repetitions, false starts, incomplete sentences, slang, profanity, emphasis, uncertainty, and conversational style when they are audible.",
  "",
  "Use punctuation and paragraph breaks only to make the speech readable. Output only the requested transcript: no label, acknowledgement, commentary, explanation, summary, answer to the spoken request, quotation marks, or Markdown.",
  "",
  "When a word is genuinely unclear, make the most contextually plausible transcription without inventing additional meaning.",
].join("\n");

export const earsCleanedInstruction = [
  "You are acting only as EARS, an audio-to-prompt preprocessing layer for another AI agent.",
  "",
  "Every attached recording is a new, independent transcription job. This hidden helper is shared across Tethoq tasks, so earlier messages may belong to unrelated users or conversations. Ignore all earlier helper-session context and never infer conversational continuity from it.",
  "",
  "Listen directly to the supplied audio. Return only a polished written version of what the user wants to communicate.",
  "",
  "Remove filler words, accidental repetition, abandoned sentence fragments, and speech-only disfluencies. Correct obvious grammar and punctuation issues. Organise the request so it is easy for the destination agent to follow.",
  "",
  "Preserve every substantive instruction, constraint, example, caveat, correction, uncertainty, preference, emotional emphasis, technical term, proper noun, and intended tone. Do not shorten away meaningful detail. Do not make the request more polite, generic, formal, confident, or restrictive than the speaker intended.",
  "",
  "Resolve obvious spoken self-corrections in favour of the user's final intended wording. Output only the requested transcript: no label, acknowledgement, commentary, answer to the spoken request, suggestions, inferred requirements, mention of audio processing, quotation marks, or Markdown.",
  "",
  "When part of the audio is genuinely uncertain, preserve that uncertainty rather than fabricating certainty.",
].join("\n");

const reasoningRank = new Map<string, number>([
  ["none", 0],
  ["off", 0],
  ["disable", 0],
  ["disabled", 0],
  ["minimal", 1],
  ["min", 1],
  ["lowest", 1],
  ["low", 2],
  ["light", 2],
  ["medium", 3],
  ["med", 3],
  ["high", 4],
  ["xhigh", 5],
  ["x-high", 5],
  ["ultra", 6],
  ["max", 7],
  ["maximum", 7],
]);

/**
 * Routes that can hand a recording to a model as audio. OpenCode belongs here:
 * it forwards a file part with its real mime type, so it can host the only
 * audio-capable model a user has configured. Leaving it out meant OpenCode could
 * be a direct-audio destination while never being usable as a transcription route.
 */
const providersThatDeliverNativeAudio = new Set(["direct", "codex", "opencode"]);

export function isAttachmentOrigin(value: unknown): value is AttachmentOrigin {
  return typeof value === "string" && (attachmentOrigins as readonly string[]).includes(value);
}

export function isEarsMode(value: unknown): value is EarsMode {
  return value === "verbatim" || value === "cleaned";
}

export function isEarsAudioMimeType(value: string): boolean {
  const mime = value.trim().toLowerCase();
  return (earsAudioMimeTypes as readonly string[]).includes(mime);
}

/** Missing origin is never treated as dictation. */
export function attachmentOriginOf(value: { readonly origin?: unknown }): AttachmentOrigin {
  return isAttachmentOrigin(value.origin) ? value.origin : "file-picker";
}

export function isDictationAudioAttachment(attachment: EarsAttachment): boolean {
  return attachment.origin === "dictation" && isEarsAudioMimeType(attachment.mimeType);
}

export function eligibleEarsClips(attachments: readonly EarsAttachment[]): readonly EarsAttachment[] {
  return attachments.filter(isDictationAudioAttachment);
}

export function providerDeliversNativeAudio(providerId: string): boolean {
  return providersThatDeliverNativeAudio.has(providerId);
}

export function routeAcceptsEarsAudio(route: {
  readonly providerId: string;
  readonly inputModalities?: readonly string[];
}): boolean {
  return providerDeliversNativeAudio(route.providerId)
    && (route.inputModalities ?? []).includes("audio");
}

export function earsInstruction(mode: EarsMode): string {
  return mode === "verbatim" ? earsVerbatimInstruction : earsCleanedInstruction;
}

export function lowestReasoningEffort(efforts: readonly string[]): string | undefined {
  const concrete = efforts
    .map((effort) => effort.trim())
    .filter((effort) => effort.length > 0 && !["auto", "default", "cli default", "session default"].includes(effort.toLowerCase()));
  if (concrete.length === 0) return undefined;
  return [...concrete].sort((left, right) => reasoningRankOf(left) - reasoningRankOf(right) || left.localeCompare(right))[0];
}

export function reasoningLabelForNote(effort: string | undefined, context: ReasoningLabelContext = {}): string | undefined {
  if (effort === undefined) return undefined;
  const label = reasoningDisplayLabel(effort, context);
  return label.length > 0 ? label : undefined;
}

export function normalizeEarsSettings(value: unknown): EarsSettings {
  const source = typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const providerId = optionalId(source.providerId, 160);
  const modelId = optionalId(source.modelId, 320);
  return {
    enabled: source.enabled === true,
    providerId,
    modelId,
    mode: isEarsMode(source.mode) ? source.mode : defaultEarsSettings.mode,
  };
}

export function earsModelKey(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`;
}

export function parseEarsModelKey(value: string | null | undefined): { readonly providerId: string; readonly modelId: string } | undefined {
  if (typeof value !== "string") return undefined;
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  const providerId = value.slice(0, separator).trim();
  const modelId = value.slice(separator + 1).trim();
  return providerId && modelId ? { providerId, modelId } : undefined;
}

export function resolveEarsRoute(
  settings: EarsSettings,
  routes: readonly EarsAudioRoute[],
): EarsAudioRoute | undefined {
  if (settings.providerId === null || settings.modelId === null) return undefined;
  return routes.find((route) => route.providerId === settings.providerId && route.modelId === settings.modelId);
}

export function earsConfigurationError(
  settings: EarsSettings,
  routes: readonly EarsAudioRoute[],
  clips: readonly EarsAttachment[],
): string | undefined {
  if (eligibleEarsClips(clips).length === 0) return undefined;
  if (!settings.enabled) return undefined;
  if (settings.providerId === null || settings.modelId === null) {
    return "Choose an EARS model before sending dictation.";
  }
  const route = resolveEarsRoute(settings, routes);
  if (route === undefined || !routeAcceptsEarsAudio(route)) {
    return "The configured EARS model is no longer available for audio. Choose another model.";
  }
  return undefined;
}

export function composeEarsDestinationText(typed: string, transcripts: readonly string[]): string {
  const spoken = transcripts.map((text) => text.trim()).filter(Boolean).join("\n\n");
  const written = typed.trim();
  if (!written) return spoken;
  if (!spoken) return written;
  return `${written}\n\n${spoken}`;
}

export function earsUserPrompt(clipCount: number): string {
  const position = clipCount <= 1 ? "" : ` It is recording ${clipCount} in the destination message, but do not use any other recording or earlier helper exchange as context.`;
  return `New independent transcription job. Ignore every earlier exchange in this shared helper session; it may belong to a different Tethoq task. Transcribe only the attached recording and return only its transcript, with no label, acknowledgement, commentary, Markdown, or answer to the spoken request.${position}`;
}

export const earsCancelledMessage = "EARS transcription was cancelled.";

export function isEarsCancelledError(error: unknown): boolean {
  return error instanceof Error && error.message === earsCancelledMessage;
}

export type EarsSendPlan =
  | { readonly action: "send"; readonly keepIds: readonly string[] }
  | { readonly action: "ears"; readonly clipIds: readonly string[]; readonly keepIds: readonly string[] }
  | { readonly action: "configure"; readonly error: string }
  | { readonly action: "reject"; readonly error: string };

export function planEarsSend(input: {
  readonly attachments: readonly EarsAttachment[];
  readonly settings: EarsSettings;
  readonly routes: readonly EarsAudioRoute[];
  readonly destinationAcceptsAudio: boolean;
}): EarsSendPlan {
  const clips = eligibleEarsClips(input.attachments);
  const keepIds = input.attachments.filter((attachment) => !isDictationAudioAttachment(attachment)).map((attachment) => attachment.id);
  if (clips.length === 0) return { action: "send", keepIds: input.attachments.map((attachment) => attachment.id) };
  if (!input.settings.enabled) {
    if (input.destinationAcceptsAudio) return { action: "send", keepIds: input.attachments.map((attachment) => attachment.id) };
    return { action: "reject", error: "This model does not accept direct audio. Enable EARS or choose an audio-capable model." };
  }
  const configurationError = earsConfigurationError(input.settings, input.routes, clips);
  if (configurationError !== undefined) return { action: "configure", error: configurationError };
  return { action: "ears", clipIds: clips.map((clip) => clip.id), keepIds };
}

export function applyEarsTranscripts(
  typed: string,
  previousTranscripts: readonly string[],
  nextTranscripts: readonly string[],
): string {
  return composeEarsDestinationText(typed, [...previousTranscripts, ...nextTranscripts]);
}

function reasoningRankOf(effort: string): number {
  return reasoningRank.get(effort.trim().toLowerCase()) ?? 50;
}

function optionalId(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(normalized) ? normalized : null;
}
