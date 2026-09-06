import type { SelectedAudio } from "./audio_dictation";

export interface ParsedResponseAnnotation {
  readonly id: string;
  readonly text: string;
  readonly annotation: string;
  /** Zero-based position among the message's audio parts; never shown as prose. */
  readonly audioAttachmentIndex?: number;
}

export interface ResponseAnnotation extends ParsedResponseAnnotation {
  readonly audio?: SelectedAudio;
}

export interface ParsedResponseAnnotations {
  readonly body: string;
  readonly annotations: readonly ParsedResponseAnnotation[];
}

const responseHeader = "# Response annotations:";
const requestHeader = "## My request:";
const annotationsOpen = "<response-annotations>";
const annotationsClose = "</response-annotations>";
const maximumAnnotations = 24;
const maximumAnnotationCharacters = 24_000;

function annotationId(index: number, text: string, annotation: string): string {
  let hash = 2166136261;
  const value = `${text}\u0000${annotation}`;
  for (let offset = 0; offset < value.length; offset += 1) {
    hash ^= value.charCodeAt(offset);
    hash = Math.imul(hash, 16777619);
  }
  return `annotation-${index + 1}-${(hash >>> 0).toString(36)}`;
}

function annotationArray(value: unknown): readonly ParsedResponseAnnotation[] {
  if (!Array.isArray(value)) return [];
  const annotations: ParsedResponseAnnotation[] = [];
  for (const candidate of value.slice(0, maximumAnnotations)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const item = candidate as Record<string, unknown>;
    const text = typeof item.text === "string" ? item.text.trim().slice(0, maximumAnnotationCharacters) : "";
    const annotation = typeof item.annotation === "string" ? item.annotation.trim().slice(0, maximumAnnotationCharacters) : "";
    // Codex can persist a selection-only annotation when the user highlights
    // response text without adding a comment. The selection is still valid UI
    // data; rejecting it would expose the entire transport envelope as prose.
    if (!text) continue;
    const audioAttachmentIndex = typeof item.audioAttachmentIndex === "number" && Number.isInteger(item.audioAttachmentIndex) && item.audioAttachmentIndex >= 0
      ? item.audioAttachmentIndex
      : undefined;
    annotations.push({ id: annotationId(annotations.length, text, annotation), text, annotation, ...(audioAttachmentIndex !== undefined ? { audioAttachmentIndex } : {}) });
  }
  return annotations;
}

/**
 * Codex stores response annotations inside the user text it sends to a model.
 * Parse both the current tagged envelope and the older bare-JSON form so the
 * transcript can render product UI instead of exposing that transport protocol.
 */
export function parseResponseAnnotations(value: string): ParsedResponseAnnotations | null {
  const trimmed = value.trimStart();
  if (!trimmed.startsWith(responseHeader)) return null;
  const requestIndex = trimmed.indexOf(requestHeader);
  if (requestIndex < 0) return null;
  const metadata = trimmed.slice(responseHeader.length, requestIndex);
  const taggedStart = metadata.indexOf(annotationsOpen);
  const taggedEnd = metadata.lastIndexOf(annotationsClose);
  const json = taggedStart >= 0 && taggedEnd > taggedStart
    ? metadata.slice(taggedStart + annotationsOpen.length, taggedEnd).trim()
    : (() => {
        const start = metadata.indexOf("[");
        const end = metadata.lastIndexOf("]");
        return start >= 0 && end > start ? metadata.slice(start, end + 1).trim() : "";
      })();
  if (!json) return null;
  try {
    const annotations = annotationArray(JSON.parse(json));
    if (!annotations.length) return null;
    return { body: trimmed.slice(requestIndex + requestHeader.length).trim(), annotations };
  } catch {
    return null;
  }
}

export function visibleResponseAnnotationBody(value: string): string {
  return parseResponseAnnotations(value)?.body ?? value;
}

export function serializeResponseAnnotations(body: string, annotations: readonly ResponseAnnotation[], audioAttachmentOffset = 0): string {
  let audioIndex = Math.max(0, Math.floor(audioAttachmentOffset));
  const payload = annotations.map(({ text, annotation, audio }) => {
    const audioAttachmentIndex = audio ? audioIndex++ : undefined;
    return {
      text: text.trim(),
      annotation: annotation.trim() || (audio ? `Voice annotation attached as ${audio.name}.` : "Voice annotation attached."),
      ...(audioAttachmentIndex !== undefined ? { audioAttachmentIndex } : {}),
    };
  });
  if (!payload.length) return body;
  return `${responseHeader}\nEach item contains text selected from an earlier model response and a user comment. Treat items as Annotation 1, Annotation 2, and so on in array order. Address every comment.\n${annotationsOpen}\n${JSON.stringify(payload)}\n${annotationsClose}\n\n${requestHeader}\n${body}`;
}

/** Keeps annotation recordings inside their numbered detail instead of duplicating them as message-level audio. */
export function associateResponseAnnotationAudio<T>(annotations: readonly ParsedResponseAnnotation[], audio: readonly T[]): {
  readonly annotations: ReadonlyArray<ParsedResponseAnnotation & { readonly audio?: T }>;
  readonly remainingAudio: readonly T[];
} {
  const claimed = new Set<number>();
  const associated = annotations.map((annotation) => {
    const index = annotation.audioAttachmentIndex;
    if (index === undefined || index >= audio.length || claimed.has(index)) return annotation;
    claimed.add(index);
    return { ...annotation, audio: audio[index]! };
  });
  return { annotations: associated, remainingAudio: audio.filter((_, index) => !claimed.has(index)) };
}

export function responseAnnotationCopyText(body: string, annotations: readonly ParsedResponseAnnotation[]): string {
  const annotationText = annotations.map((item, index) => `Annotation ${index + 1}\nSelected: ${item.text}\nComment: ${item.annotation || "Voice annotation"}`).join("\n\n");
  return [annotationText, body.trim()].filter(Boolean).join("\n\n");
}
