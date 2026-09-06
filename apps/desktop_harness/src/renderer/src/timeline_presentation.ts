import type { TimelineItem } from "./types";

const presentationTokenCache = new WeakMap<TimelineItem, string>();

function mixText(hash: number, value: string | number | boolean | undefined): number {
  const text = value === undefined ? "" : String(value);
  let next = hash;
  for (let index = 0; index < text.length; index += 1) {
    next ^= text.charCodeAt(index);
    next = Math.imul(next, 16777619);
  }
  next ^= 0xff;
  return Math.imul(next, 16777619);
}

/**
 * A cached description of every field that can change a mounted row's layout.
 * Preview payload bytes are deliberately excluded; readiness changes geometry,
 * while hashing multi-megabyte base64 strings would make typing and streaming slow.
 */
export function timelineItemPresentationToken(item: TimelineItem): string {
  const cached = presentationTokenCache.get(item);
  if (cached !== undefined) return cached;
  let hash = 2166136261;
  for (const value of [item.kind, item.phase, item.title, item.body, item.detail, item.state]) hash = mixText(hash, value);
  for (const image of item.images ?? []) {
    for (const value of [image.name, image.mimeType, image.dataUrl ? "ready" : "missing", image.loading === true]) hash = mixText(hash, value);
  }
  for (const audio of item.audio ?? []) {
    for (const value of [audio.name, audio.mimeType, audio.dataUrl ? "ready" : "missing", audio.durationSeconds, audio.dictation === true]) hash = mixText(hash, value);
  }
  for (const file of item.files ?? []) {
    hash = mixText(mixText(hash, file.name), file.mimeType);
  }
  for (const workflow of item.workflows ?? []) {
    for (const value of [workflow.id, workflow.name, workflow.eventCount, workflow.screenshotCount, ...(workflow.applications ?? [])]) hash = mixText(hash, value);
  }
  for (const annotation of item.annotations ?? []) {
    for (const value of [annotation.id, annotation.text, annotation.annotation, annotation.audioAttachmentIndex]) hash = mixText(hash, value);
    if (annotation.audio) {
      for (const value of [annotation.audio.name, annotation.audio.mimeType, annotation.audio.dataUrl ? "ready" : "missing", annotation.audio.durationSeconds]) hash = mixText(hash, value);
    }
  }
  if (item.origin?.kind === "cross_session") {
    for (const value of [item.origin.kind, item.origin.envelopeId, item.origin.sourceSessionId, item.origin.sourceTitle]) hash = mixText(hash, value);
  } else if (item.origin) {
    hash = mixText(mixText(hash, item.origin.kind), item.origin.sender);
  }
  const token = (hash >>> 0).toString(36);
  presentationTokenCache.set(item, token);
  return token;
}

export function timelinePresentationSignature(timeline: readonly TimelineItem[] | undefined): string {
  return timeline
    ? timeline.map((item) => `${item.presentationId ?? item.id}:${timelineItemPresentationToken(item)}`).join("|")
    : "none";
}
