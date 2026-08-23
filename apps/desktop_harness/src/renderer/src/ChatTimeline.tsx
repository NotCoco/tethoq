import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertIcon, AnnotationIcon, BranchIcon, CheckIcon, ChevronDownIcon, CompactionIcon, CopyIcon, ScreenshotIcon, WorkflowIcon, XIcon } from "./icons";
import { copyText as copyToClipboard } from "./clipboard";
import { ProviderLogo, providerDisplayName } from "./components";
import { RichText } from "./RichText";
import { AudioPlaybackChip } from "./audio_dictation";
import type { Provider, ProviderId, ProviderStatus, TimelineItem, TimelineWorkflow } from "./types";
import { responseAnnotationCopyText } from "./response_annotations";

const routineActivityKinds = new Set<TimelineItem["kind"]>(["tool", "command", "file", "subagent"]);

function isRoutineActivity(item: TimelineItem): boolean {
  return routineActivityKinds.has(item.kind);
}

/**
 * Work that stands in for the pulse.
 *
 * Any named activity is already the visible record of current work. Rendering a
 * second pulse beside it creates two Reasoning rows for one span.
 */
function speaksForWork(item: TimelineItem): boolean {
  return item.kind === "reasoning" || isRoutineActivity(item);
}

/** Do not leave timestamp/copy-control shells for empty provider deltas. */
export function hasVisibleTimelineContent(item: TimelineItem): boolean {
  if (item.kind !== "user" && item.kind !== "assistant") return true;
  const body = item.body.trim();
  if (item.images?.length || item.audio?.length || item.workflows?.length || item.annotations?.length) return true;
  if (!body || /^<!--[\s\S]*-->$/u.test(body)) return false;
  const rawBlock = body.match(/^<([a-z][\w:-]*)\b[^>]*>[\s\S]*<\/\1>$/iu);
  return !rawBlock && !/^<[a-z][\w:-]*\b[^>]*\/?>$/iu.test(body);
}

type TimelineGroup =
  | { kind: "item"; item: TimelineItem; index: number }
  | { kind: "boundary"; item: TimelineItem; index: number; label: string }
  | { kind: "reasoning"; key: string; reasoning: TimelineItem; activities: TimelineItem[]; items: TimelineItem[]; index: number };

export type ReasoningSegment =
  | { kind: "thinking"; id: string; item: TimelineItem }
  | { kind: "compaction"; id: string; item: TimelineItem; label: string }
  | { kind: "activity"; id: string; items: TimelineItem[] };

const compactionNotice = /^(?:(?:context|conversation|session)\s+(?:was\s+|has\s+been\s+|automatically\s+)?compacted(?:\s+successfully)?|(?:automatic\s+|context\s+|session\s+)?compaction\s+(?:complete|completed))[.!]?$/iu;
const automaticCompactionNotice = /\b(?:automatically\s+compacted|automatic\s+compaction)\b/iu;
const compactionSummaryNotice = /^another language model started to solve this problem and produced a summary of its thinking process\./iu;
const compactionTitle = /^(?:(?:context|conversation|session)\s+)?compaction(?:\s+summary)?$/iu;
const systemTitle = /^(?:system|system message|system update|notice)$/iu;

function isCompactionItem(item: TimelineItem): boolean {
  if (item.kind === "user") return false;
  const title = cleanTitle(item.title ?? "");
  const body = item.body.trim();
  return compactionTitle.test(title)
    || compactionSummaryNotice.test(body)
    || [title, body, `${title} ${body}`.trim()].some((candidate) => candidate.length <= 140 && compactionNotice.test(candidate));
}

/** Normalize sparse provider notices into quiet transcript boundaries. */
export function timelineBoundaryLabel(item: TimelineItem): string | null {
  if (item.kind === "user") return null;
  const title = cleanTitle(item.title ?? "");
  const body = item.body.trim();
  if (isCompactionItem(item)) return "Session compacted";
  if (systemTitle.test(title) && body.length <= 240) return body || "System update";
  if (/^\s*\[(?:system|notice)\]\s*/iu.test(body) && body.length <= 240) {
    return body.replace(/^\s*\[(?:system|notice)\]\s*/iu, "").trim() || "System update";
  }
  return null;
}

/** Prefer provider detail when available; otherwise explain the event without exposing trace metadata. */
export function compactionDetailText(item: TimelineItem, _label: string): string {
  const detail = item.detail?.trim() ?? "";
  if (detail && !compactionNotice.test(detail)) return detail;
  const body = item.body.trim();
  if (body && !compactionNotice.test(body)) return body;
  const automatic = automaticCompactionNotice.test(`${item.title ?? ""} ${item.body}`);
  return automatic
    ? "Earlier conversation context was automatically summarized so this task could continue within the model's context window."
    : "Earlier conversation context was summarized so this task could continue within the model's context window.";
}

function compactionContentKey(item: TimelineItem, compactionLabel?: string): string {
  const raw = compactionLabel ? compactionDetailText(item, compactionLabel) : item.detail?.trim() || item.body;
  // Codex prefixes one stored copy with transport prose that the readable
  // reasoning copy omits. That prefix is not part of the summary itself.
  const comparable = compactionLabel ? raw.replace(compactionSummaryNotice, "").trim() || raw : raw;
  return plainPreviewText(formatReasoningText(comparable)).toLocaleLowerCase();
}

function compactionContentMatches(left: string, right: string): boolean {
  return left === right || (Math.min(left.length, right.length) >= 120 && (left.includes(right) || right.includes(left)));
}

/**
 * Keep the provider's two persisted copies of one compaction as one disclosure.
 *
 * Codex can store the summary once as readable reasoning and again as the
 * compaction event. During an active external turn those records do not always
 * enter the same Reasoning group, so group-local deduplication is too late: the
 * prose is painted once and the disclosure is painted again. Pair copies only
 * inside the same user turn, keep the later event at its chronological position,
 * and move the readable summary into that event's hidden detail.
 */
export function coalesceCompactionCopies(timeline: readonly TimelineItem[]): readonly TimelineItem[] {
  const removed = new Set<number>();
  const replacements = new Map<number, TimelineItem>();
  let start = 0;
  while (start < timeline.length) {
    let end = start + 1;
    while (end < timeline.length && timeline[end]?.kind !== "user") end += 1;
    const compactions = Array.from({ length: end - start }, (_, offset) => start + offset)
      .filter((index) => timelineBoundaryLabel(timeline[index]!) === "Session compacted");
    for (let ordinal = compactions.length - 1; ordinal >= 0; ordinal -= 1) {
      const compactionIndex = compactions[ordinal]!;
      if (removed.has(compactionIndex)) continue;
      const compaction = replacements.get(compactionIndex) ?? timeline[compactionIndex]!;
      const label = timelineBoundaryLabel(compaction);
      if (label !== "Session compacted") continue;
      const key = compactionContentKey(compaction, label);
      const matches: number[] = [];
      for (let index = start; index < end; index += 1) {
        if (index === compactionIndex || removed.has(index)) continue;
        const candidate = replacements.get(index) ?? timeline[index]!;
        if (candidate.kind === "user") continue;
        const candidateLabel = timelineBoundaryLabel(candidate);
        const candidateKey = compactionContentKey(candidate, candidateLabel === "Session compacted" ? candidateLabel : undefined);
        if (candidateKey && compactionContentMatches(candidateKey, key)) matches.push(index);
      }
      if (!matches.length) continue;
      const readable = matches
        .map((index) => replacements.get(index) ?? timeline[index]!)
        .map((item) => item.detail?.trim() || item.body)
        .sort((left, right) => right.length - left.length)[0];
      if (readable) replacements.set(compactionIndex, { ...compaction, detail: readable });
      for (const index of matches) removed.add(index);
    }
    start = end;
  }
  return timeline.flatMap((item, index) => removed.has(index) ? [] : [replacements.get(index) ?? item]);
}

function turnBounds(timeline: readonly TimelineItem[], index: number): readonly [number, number] {
  let start = index;
  while (start > 0 && timeline[start - 1]?.kind !== "user") start -= 1;
  let end = index + 1;
  while (end < timeline.length && timeline[end]?.kind !== "user") end += 1;
  return [start, end];
}

/** How an assistant row carries the provider mark. */
export type AssistantIdentityMode = "none" | "final" | "live";

/**
 * Every final answer in a turn carries the full identity mark: providers can
 * finish one output and then continue, and each completed answer deserves the
 * mark. The newest non-final output while work is live carries a faded,
 * breathing mark instead, so progress reads as progress without the mark
 * jumping between rows.
 */
export function assistantIdentityMode(timeline: readonly TimelineItem[], index: number, active: boolean): AssistantIdentityMode {
  const item = timeline[index];
  if (item?.kind !== "assistant" || !hasVisibleTimelineContent(item) || timelineBoundaryLabel(item)) return "none";
  let newestAssistant = -1;
  for (let cursor = timeline.length - 1; cursor >= 0; cursor -= 1) {
    const candidate = timeline[cursor]!;
    if (candidate.kind === "assistant" && hasVisibleTimelineContent(candidate) && !timelineBoundaryLabel(candidate)) {
      newestAssistant = cursor;
      break;
    }
  }
  const isNewest = index === newestAssistant;
  if (item.phase === "final_answer") return "final";
  if (item.phase === "commentary") return isNewest && (active || item.state === "running") ? "live" : "none";
  // No phase metadata: the turn's last assistant row is the answer once the
  // turn stops producing. Until then, the newest row shows the live mark.
  const [start, end] = turnBounds(timeline, index);
  let lastAssistant = -1;
  for (let cursor = start; cursor < end; cursor += 1) {
    const candidate = timeline[cursor]!;
    if (candidate.kind === "assistant" && hasVisibleTimelineContent(candidate) && !timelineBoundaryLabel(candidate)) lastAssistant = cursor;
  }
  if (index !== lastAssistant) return "none";
  return isNewest && (active || item.state === "running") ? "live" : "final";
}

/** Legacy boolean view: any visible identity treatment counts as shown. */
export function shouldShowAssistantIdentity(timeline: readonly TimelineItem[], index: number): boolean {
  return assistantIdentityMode(timeline, index, false) !== "none";
}

/** Copy the complete final answer once, even when a provider split it into several final chunks. */
export function finalAnswerCopyText(timeline: readonly TimelineItem[], index: number): string {
  const item = timeline[index];
  if (item?.kind !== "assistant") return "";
  const [start, end] = turnBounds(timeline, index);
  const assistantItems = timeline.slice(start, end).filter((candidate) =>
    candidate.kind === "assistant" && hasVisibleTimelineContent(candidate) && !timelineBoundaryLabel(candidate));
  const phaseAware = assistantItems.some((candidate) => candidate.phase !== undefined);
  const finalItems = phaseAware ? assistantItems.filter((candidate) => candidate.phase === "final_answer") : assistantItems;
  return (finalItems.length ? finalItems : [item]).map((candidate) => candidate.body.trim()).filter(Boolean).join("\n\n");
}

/** Preserve chronology while removing repeated outer Reasoning controls. */
export function reasoningSegments(items: readonly TimelineItem[], namespace = ""): ReasoningSegment[] {
  const segments: ReasoningSegment[] = [];
  let thinkingOrdinal = 0;
  const scope = namespace ? `${namespace}:` : "";
  const compactionByReadableItem = new Map<TimelineItem, { item: TimelineItem; label: string; contentKey: string }>();
  for (const compactionItem of items) {
    const label = timelineBoundaryLabel(compactionItem);
    if (label !== "Session compacted") continue;
    const contentKey = compactionContentKey(compactionItem, label);
    const readableItem = items.find((candidate) => timelineBoundaryLabel(candidate) !== "Session compacted"
      && compactionContentMatches(compactionContentKey(candidate), contentKey));
    if (readableItem) compactionByReadableItem.set(readableItem, { item: compactionItem, label, contentKey });
  }
  const seenCompactionContent = new Set<string>();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    const compactionLabel = timelineBoundaryLabel(item);
    if (compactionLabel === "Session compacted") {
      const contentKey = compactionContentKey(item, compactionLabel);
      // Some providers persist the same compaction summary twice: once as the
      // readable reasoning text and again as a system compaction record. Showing
      // the latter as a nested disclosure repeats the whole summary in a second
      // scrollable box. The matching readable row is converted into the one
      // formatted compaction disclosure, so this transport copy is skipped.
      if ([...compactionByReadableItem.values()].some((candidate) => candidate.item === item) || seenCompactionContent.has(contentKey)) continue;
      if (contentKey) seenCompactionContent.add(contentKey);
      segments.push({ kind: "compaction", id: `compaction:${scope}${item.messageId ?? item.id}:${thinkingOrdinal++}`, item, label: compactionLabel });
      continue;
    }
    const matchedCompaction = compactionByReadableItem.get(item);
    if (matchedCompaction) {
      const readableDetail = item.detail?.trim() || item.body;
      seenCompactionContent.add(matchedCompaction.contentKey);
      segments.push({
        kind: "compaction",
        id: `compaction:${scope}${matchedCompaction.item.messageId ?? matchedCompaction.item.id}:${thinkingOrdinal++}`,
        item: { ...matchedCompaction.item, detail: readableDetail },
        label: matchedCompaction.label,
      });
      continue;
    }
    if (item.kind === "reasoning" || item.kind === "assistant") {
      // The id must survive the live-to-history handover: live rows arrive under
      // the provider part id while history re-creates them from stored messages,
      // so a state keyed on the row id collapses the moment a reconcile lands.
      // Ordered within the group rather than keyed on the row id alone: several
      // thoughts in one provider message share a message id, and keying on that made
      // them one row as far as expansion state and React reconciliation were concerned.
      segments.push({ kind: "thinking", id: `thinking:${scope}${item.messageId ?? item.id}:${thinkingOrdinal++}`, item });
      continue;
    }
    if (!isRoutineActivity(item)) continue;
    // One row per activity, opening straight onto its detail. Summarising a run of
    // them behind a further row meant three things to open before any detail showed,
    // and the group above already stands for the whole span. A tool call id survives
    // the live-to-history handover; the message id does not identify a single row,
    // because every activity in one message shares it.
    segments.push({ kind: "activity", id: `activity:${scope}${item.detail ?? item.id}`, items: [item] });
  }
  // A live reasoning span can move from prose into a command/tool without ending
  // the span. withCurrentActivity intentionally keeps only the newest raw row
  // running, but the disclosure icon and its newest readable thought represent
  // that whole span. Project the shared live state onto that thought so the text
  // cannot become inert while its own icon continues to pulse. The segment id and
  // membership stay unchanged as adjacent activity arrives, avoiding a remount.
  if (items.some((item) => item.state === "running")) {
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      const segment = segments[index];
      if (segment?.kind !== "thinking") continue;
      if (segment.item.state !== "running") segments[index] = { ...segment, item: { ...segment.item, state: "running" } };
      break;
    }
  }
  return segments;
}

/**
 * Once a turn is terminal, only its final answer remains at conversation level.
 * Everything the harness narrated on the way there becomes part of Reasoning.
 * Providers with phases name the final answer directly; unphased harnesses use
 * the last visible assistant item in the settled turn.
 */
function foldedAssistantIndexes(timeline: readonly TimelineItem[], active: boolean): ReadonlySet<number> {
  const folded = new Set<number>();
  let start = 0;
  while (start < timeline.length) {
    let end = start + 1;
    while (end < timeline.length && timeline[end]?.kind !== "user") end += 1;
    const indexes = Array.from({ length: end - start }, (_, offset) => start + offset);
    if (!(active && end === timeline.length) && !indexes.some((index) => timeline[index]?.state === "running")) {
      const assistants = indexes.filter((index) => {
        const item = timeline[index];
        return item?.kind === "assistant" && hasVisibleTimelineContent(item) && (!timelineBoundaryLabel(item) || isCompactionItem(item));
      });
      const explicitFinals = assistants.filter((index) => timeline[index]?.phase === "final_answer");
      const finals = explicitFinals.length ? new Set(explicitFinals) : new Set(assistants.slice(-1));
      for (const index of assistants) if (!finals.has(index)) folded.add(index);
    }
    start = end;
  }
  return folded;
}

/** Keep every uninterrupted reasoning and execution span behind one quiet control. */
/**
 * Text a harness writes part-way through one answer, with more thinking still to
 * come in that same message. Treating it as a finished answer split a single turn
 * into a run of identical top-level Reasoning labels with fragments between them.
 * Only the last text of a message is the answer; the rest is narration and belongs
 * inside the working block. Harnesses that give each part its own message id are
 * unaffected, because nothing there shares one.
 */
function isInterimNarration(timeline: readonly TimelineItem[], index: number): boolean {
  const item = timeline[index];
  if (item?.kind !== "assistant" || item.messageId === undefined || item.phase === "final_answer") return false;
  return timeline.slice(index + 1).some((candidate) => candidate.messageId === item.messageId && candidate.kind === "reasoning");
}

/** Identity of the first concrete member, which cannot change when this span grows. */
function reasoningSpanBaseKey(item: TimelineItem): string {
  if (item.providerPartId) return `part:${item.providerPartId}`;
  if (item.detail && isRoutineActivity(item)) return `activity:${item.kind}:${item.detail}`;
  if (item.messageId) return `message:${item.messageId}`;
  if (item.kind === "file") {
    const fileIdentity = (item.title ?? item.body).trim();
    if (fileIdentity) return `file:${fileIdentity}`;
  }
  return `row:${item.id}`;
}

export function groupTimeline(timeline: readonly TimelineItem[], active = false): TimelineGroup[] {
  const groups: TimelineGroup[] = [];
  const reasoningKeyCounts = new Map<string, number>();
  const foldedAssistants = foldedAssistantIndexes(timeline, active);
  const belongsToReasoning = (item: TimelineItem, index: number): boolean =>
    item.kind === "reasoning" || isRoutineActivity(item) || foldedAssistants.has(index);
  for (let index = 0; index < timeline.length; index += 1) {
    const item = timeline[index]!;
    if (!hasVisibleTimelineContent(item)) continue;
    const boundaryLabel = timelineBoundaryLabel(item);
    if (boundaryLabel && !belongsToReasoning(item, index)) {
      groups.push({ kind: "boundary", item, index, label: boundaryLabel });
      continue;
    }
    if (!belongsToReasoning(item, index)) {
      groups.push({ kind: "item", item, index });
      continue;
    }
    const items: TimelineItem[] = [];
    let cursor = index;
    while (cursor < timeline.length) {
      const candidate = timeline[cursor]!;
      // An empty provider delta is not a visible interruption. Letting it split
      // an otherwise continuous span produced two sibling Reasoning controls,
      // even though no row existed between them for the reader.
      if (candidate.kind !== "user" && !hasVisibleTimelineContent(candidate)) {
        cursor += 1;
        continue;
      }
      if (timelineBoundaryLabel(candidate) && !belongsToReasoning(candidate, cursor)) break;
      if (!belongsToReasoning(candidate, cursor) && !isInterimNarration(timeline, cursor)) break;
      items.push(candidate);
      cursor += 1;
    }
    const activities = items.filter(isRoutineActivity);
    const reasoning: TimelineItem = items.find((candidate) => candidate.kind === "reasoning") ?? {
      id: `reasoning-${item.id}`,
      kind: "reasoning",
      title: "Reasoning",
      body: "",
      state: items.some((candidate) => candidate.state === "running") ? "running" : "completed",
      timestamp: item.timestamp,
    };
    // Settling can fold earlier assistant narration into this span. That newly
    // prepended text must not rename a disclosure the reader already opened or
    // closed while the turn was live, so the first durable reasoning/activity
    // member owns the key; folded narration is only a tool-free fallback.
    const durableMember = items.find((candidate) => candidate.kind === "reasoning" || isRoutineActivity(candidate));
    const baseKey = reasoningSpanBaseKey(durableMember ?? items[0] ?? item);
    const ordinal = reasoningKeyCounts.get(baseKey) ?? 0;
    reasoningKeyCounts.set(baseKey, ordinal + 1);
    groups.push({ kind: "reasoning", key: `reasoning:${baseKey}:${ordinal}`, reasoning, activities, items, index });
    index = cursor - 1;
  }
  return groups;
}

/** A separator is useful only when an answer follows visible work in the same turn. */
export function shouldSeparateFinalAnswer(timeline: readonly TimelineItem[], index: number, active = false): boolean {
  const item = timeline[index];
  if (item?.kind !== "assistant" || !hasVisibleTimelineContent(item) || item.phase === "commentary" || item.state === "running" || timelineBoundaryLabel(item)) return false;
  // While the turn is live, an older unphased assistant row is still part of
  // the provider's output stream. The final-answer boundary is a settled-turn
  // affordance; drawing it here creates a false large gap before the answer.
  if (active) return false;
  let start = index;
  while (start > 0 && timeline[start - 1]?.kind !== "user") start -= 1;
  let end = index + 1;
  while (end < timeline.length && timeline[end]?.kind !== "user") end += 1;
  const assistants = timeline.slice(start, end).filter((candidate) => candidate.kind === "assistant" && hasVisibleTimelineContent(candidate) && !timelineBoundaryLabel(candidate));
  const phaseAware = assistants.some((candidate) => candidate.phase !== undefined);
  if (phaseAware && item.phase !== "final_answer") return false;
  const laterAssistant = timeline.slice(index + 1, end).some((candidate) => candidate.kind === "assistant" && hasVisibleTimelineContent(candidate) && !timelineBoundaryLabel(candidate)
    && (item.phase === "final_answer" ? candidate.phase === "final_answer" : true));
  if (laterAssistant) return false;
  return timeline.slice(start, index).some((item) => item.kind !== "user" && !timelineBoundaryLabel(item));
}

const executionId = /\b(?:call|event|exec(?:ution)?|request|session|trace)[-_][a-z0-9-]{6,}\b/giu;
const uuid = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu;

function cleanTitle(value: string): string {
  return value.replace(executionId, "").replace(uuid, "").replace(/\s{2,}/gu, " ").replace(/^[\s:.-]+|[\s:.-]+$/gu, "").trim();
}

export function activityLabel(item: TimelineItem): "Read" | "Write" | "Edit" | "Run" | "Delegate" | "Issue" | "Activity" {
  if (item.kind === "command") return "Run";
  if (item.kind === "subagent") return "Delegate";
  if (item.kind === "error" || item.state === "failed") return "Issue";
  if (item.kind === "tool" && (/<(?:a|button|input|select|textarea)\b[^>]*\bnode_id=/iu.test(item.body) || /"(?:url|title)"\s*:/u.test(item.body))) return "Read";
  const value = `${item.title ?? ""} ${item.kind}`.toLowerCase();
  if (/\b(read|inspect(?:ed|ing)?|open(?:ed|ing)?|fetch(?:ed|ing)?|find|found|list(?:ed|ing)?|view(?:ed|ing)?|search(?:ed|ing)?|browse(?:d|ing)?|scan(?:ned|ning)?)\b/u.test(value)) return "Read";
  if (/\b(edit|patch|update|replace|modify|change|changed)\b/u.test(value)) return "Edit";
  if (/\b(write|create|created|save|add|generate)\b/u.test(value)) return "Write";
  if (/\b(run|exec|execute|shell|terminal|javascript|typescript|python|powershell|bash|cmd|js|ts|py)\b/u.test(value)) return "Run";
  return item.kind === "file" ? "Read" : "Activity";
}

export function activityTarget(item: TimelineItem): string {
  const label = activityLabel(item);
  const title = cleanTitle(item.title ?? "");
  if (!title || /^(?:activity|js|py|read|ts|tool)$/iu.test(title)) return "";
  const withoutVerb = title.replace(/^\s*(?:read|inspect(?:ed)?|open(?:ed)?|fetch(?:ed)?|find|found|list(?:ed)?|view(?:ed)?|search(?:ed)?|browse(?:d)?|scan(?:ned)?|write|wrote|create(?:d)?|save(?:d)?|add(?:ed)?|generate(?:d)?|edit(?:ed)?|patch(?:ed)?|update(?:d)?|replace(?:d)?|modify|modified|change(?:d)?|run|ran|execute(?:d)?|delegate(?:d)?)\s*/iu, "").trim();
  const target = withoutVerb && withoutVerb.toLowerCase() !== label.toLowerCase() ? withoutVerb : "";
  return target.length > 110 ? `${target.slice(0, 107).trimEnd()}...` : target;
}

const genericReasoningTitle = /^(?:reasoning|working|thinking|protected reasoning|activity)$/iu;

/** Repair obvious prose boundaries without changing code or inventing provider content. */
export function formatReasoningText(value: string): string {
  return value.split(/(```[\s\S]*?```|`[^`\n]*`)/gu).map((segment, index) => index % 2 === 1
    ? segment
    : segment.replace(/([a-z0-9][.!?:;])(?=[A-Z])/gu, "$1 ")).join("");
}

function plainPreviewText(value: string): string {
  return value
    .replace(/```[a-z0-9_-]*|```/giu, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/<[^>]+>/gu, " ")
    .replace(/^\s{0,3}(?:#{1,6}|[-*+]|\d+[.)])\s+/gmu, "")
    .replace(/[*_~`>|]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function concisePreview(value: string, maximum = 118): string {
  const plain = plainPreviewText(value);
  if (!plain) return "Details";
  if (plain.length <= maximum) return plain;
  const sentence = plain.slice(0, maximum + 1).match(/^(.{38,}?[.!?])(?:\s|$)/u)?.[1];
  if (sentence) return sentence;
  const candidate = plain.slice(0, maximum + 1);
  const boundary = candidate.lastIndexOf(" ");
  return `${candidate.slice(0, boundary > maximum * .62 ? boundary : maximum).trimEnd()}…`;
}

/** Use a provider's meaningful title when present, otherwise a stable first-line preview. */
export function reasoningPreview(item: TimelineItem): string {
  const title = cleanTitle(item.title ?? "");
  if (title && !genericReasoningTitle.test(title)) return concisePreview(formatReasoningText(title));
  const body = formatReasoningText(item.body);
  const plain = plainPreviewText(body);
  if (!plain) return "Thinking…";
  // While a thought is still being written, lead with its freshest lines so the
  // row visibly feeds through instead of freezing on the opening sentence.
  if (item.state === "running" && plain.length > 118) return `…${plain.slice(-118).trimStart()}`;
  return concisePreview(body);
}

/** A disclosure is useful only when its body adds at least one visible character. */
export function thinkingExpansionAddsContent(item: TimelineItem): boolean {
  const body = plainPreviewText(formatReasoningText(item.body));
  if (!body) return false;
  // A thought that is still being written always has more coming: its body only
  // matches its preview for the instant before the next chunk lands. Judging it by
  // that instant is what left every short thought between tool calls sealed shut -
  // the row rendered disabled, so its text never opened and the reader watched a
  // one-line summary of a thought they were never allowed to read.
  if (item.state === "running") return true;
  return body !== plainPreviewText(reasoningPreview(item));
}

/** Lead with the first call and disclose the exact ordered sequence only on demand. */
function firstReadableValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const values = value.map(firstReadableValue).filter((item): item is string => Boolean(item));
    return values.length ? values.join("\n") : undefined;
  }
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    for (const key of ["output", "content", "text", "result", "summary", "message", "patch", "diff"]) {
      const readable = firstReadableValue(object[key]);
      if (readable) return readable;
    }
  }
  return undefined;
}

/** Reduce provider wrappers to the content a person asked to inspect. */
export function readableActivityBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    for (const key of ["output", "content", "text", "result", "summary", "patch", "diff"]) {
      const readable = firstReadableValue(parsed[key]);
      if (readable) return readable;
    }
    const safeLines = [
      typeof parsed.title === "string" ? parsed.title.trim() : "",
      typeof parsed.url === "string" ? parsed.url.trim() : "",
      typeof parsed.path === "string" ? parsed.path.trim() : "",
    ].filter(Boolean);
    if (safeLines.length) return safeLines.join("\n");
    return "Details are available from the agent that performed this activity.";
  } catch {
    const content = trimmed.match(/<content>([\s\S]*?)<\/content>/iu)?.[1]?.trim();
    if (content) return content;
    return trimmed
      .replace(/^\s*<(?:path|type)>[^\n]*<\/(?:path|type)>\s*$/gimu, "")
      .replace(/^\s*<\/?(?:context|content)>\s*$/gimu, "")
      .replace(/^\s*\((?:Showing|Use offset)[^\n]*\)\s*$/gimu, "")
      .trim();
  }
}

const errorReference = /(?:[,;]\s*)?(?:request|trace|execution)\s*(?:id|identifier)\s*[:=]\s*[a-z0-9._:-]{6,}\b/giu;

/** Keep provider failures useful without exposing raw transport identifiers. */
export function timelineErrorNoticeText(item: TimelineItem): string {
  const source = readableActivityBody(item.body) || cleanTitle(item.title ?? "") || "The agent could not complete this response.";
  const readable = source
    .replace(errorReference, "")
    .replace(executionId, "")
    .replace(uuid, "")
    .replace(/\s+/gu, " ")
    .replace(/\s+([,.;:!?])/gu, "$1")
    .replace(/[,;:\s-]+$/gu, "")
    .trim();
  if (!readable) return "The agent could not complete this response.";
  return readable.length > 360 ? `${readable.slice(0, 357).trimEnd()}…` : readable;
}

function ReadingGlyph() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 5.5c3.4-.8 6.2-.1 8.5 2.1v11.2c-2.3-2.2-5.1-2.9-8.5-2.1Z"/><path d="M20.5 5.5c-3.4-.8-6.2-.1-8.5 2.1v11.2c2.3-2.2 5.1-2.9 8.5-2.1Z"/><path d="M7 9.1h2.3M7 12h2.3M14.7 9.1H17M14.7 12H17"/></svg>;
}

function WritingGlyph() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19h4L19.2 8.8a2 2 0 0 0-4-4L5 15Z"/><path d="m13.8 6.2 4 4M4 21h16"/></svg>;
}

function EditingGlyph() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h9M4 10h7M4 15h5"/><path d="m11 19 1-4 6.8-6.8a1.8 1.8 0 0 1 2.5 2.5L14.5 17.5Z"/></svg>;
}

function ActivityGlyph({ label }: { label: ReturnType<typeof activityLabel> }) {
  if (label === "Read") return <ReadingGlyph />;
  if (label === "Write") return <WritingGlyph />;
  if (label === "Edit") return <EditingGlyph />;
  if (label === "Run") return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m6 0h4"/></svg>;
  if (label === "Delegate") return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="8" r="3"/><circle cx="17" cy="7.5" r="2.5"/><path d="M2.5 20a5.5 5.5 0 0 1 11 0M13 20a4 4 0 0 1 8 0"/></svg>;
  if (label === "Issue") return <AlertIcon />;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7"/><path d="M12 8v4l3 2"/></svg>;
}

/**
 * One copy control for the whole transcript, and it always answers.
 *
 * The web clipboard write these buttons used is refused outright in this window,
 * and nothing caught the rejection — so pressing copy replaced the entire app
 * with the fault card. Copying goes through the desktop clipboard now, and the
 * result is shown on the button itself: a control that silently does nothing is
 * the same defect wearing a quieter coat.
 */
export function CopyButton({ className, text, label }: { className: string; text: string; label: string }) {
  const [result, setResult] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (result === "idle") return;
    const timer = setTimeout(() => setResult("idle"), 1_600);
    return () => clearTimeout(timer);
  }, [result]);
  const shown = result === "copied" ? "Copied" : result === "failed" ? "Copy failed" : label;
  return <button
    type="button"
    className={className}
    data-copy-state={result}
    aria-label={shown}
    onClick={() => { void copyToClipboard(text).then((copied) => setResult(copied ? "copied" : "failed")); }}
  >{result === "copied" ? <CheckIcon /> : <CopyIcon />}</button>;
}

function TimelineItemMeta({ item, copyText, copyLabel }: { item: TimelineItem; copyText: string; copyLabel: string }) {
  const time = new Date(item.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return <span className="timeline-item-meta">
    <time dateTime={item.timestamp}>{time}</time>
    <CopyButton className="timeline-copy-button" text={copyText} label={copyLabel} />
  </span>;
}

const ActivityDisclosure = memo(function ActivityDisclosure({ item }: { item: TimelineItem }) {
  const [expanded, setExpanded] = useState(false);
  const [enlarged, setEnlarged] = useState(false);
  const toggle = (): void => setExpanded((current) => !current);
  const label = activityLabel(item);
  const visibleLabel = item.kind === "subagent" ? "Spawned sub-agent" : label;
  const target = activityTarget(item);
  const body = readableActivityBody(item.body);
  const long = body.length > 1_600 || body.split("\n").length > 22;
  const collapse = () => { setEnlarged(false); setExpanded(false); };
  return <div className={`activity-disclosure ${item.state === "failed" ? "activity-failed" : ""}`}>
    <div className="activity-line">
      <button type="button" className="activity-row" aria-expanded={expanded} onClick={toggle}>
        <span className="activity-glyph"><ActivityGlyph label={label} /></span>
        <strong>{visibleLabel}</strong>
        {target ? <span className="activity-target">{target}</span> : null}
        <ChevronDownIcon className={expanded ? "expanded" : ""}/>
      </button>
      <TimelineItemMeta item={item} copyText={body} copyLabel={`Copy ${visibleLabel.toLowerCase()} details`}/>
    </div>
    {/* The row above already names this activity, and its own chevron already closes it.
        Repeating both inside the panel read as three different things where there is one:
        the same rule the thinking rows follow, where the opened body carries on from the
        line that opened it instead of restating it. */}
    {expanded ? <section className={`activity-snippet ${enlarged ? "activity-snippet-enlarged" : ""}`} aria-label={`${visibleLabel} details`}>
      {long ? <header>
        <button type="button" onClick={() => setEnlarged((current) => !current)}>{enlarged ? "Reduce" : "Enlarge"}</button>
      </header> : null}
      <pre>{body}</pre>
      {/* Only a body long enough to push its own row off screen earns a way back. */}
      {long ? <footer><button type="button" onClick={collapse}><ChevronDownIcon />Collapse</button></footer> : null}
    </section> : null}
  </div>;
});

function ThinkingFlow({ segment, onLinkOpen }: {
  segment: Extract<ReasoningSegment, { kind: "thinking" }>;
  onLinkOpen?: ((url: string) => void) | undefined;
}) {
  const { item } = segment;
  const body = formatReasoningText(item.body);
  return <div className="reasoning-segment reasoning-thinking-segment">
    <div className={`reasoning-flow ${item.state === "running" ? "reasoning-flow-running" : ""}`}>
      <RichText onLinkOpen={onLinkOpen}>{body}</RichText>
      <TimelineItemMeta item={item} copyText={body} copyLabel="Copy thinking"/>
    </div>
  </div>;
}

export type ReasoningDisplay = "compact" | "expanded";

/**
 * The span and the thought that are being written right now.
 *
 * A thought that is arriving is the one thing in the transcript worth looking at, and
 * making the reader find it - open the span, then open the row - meant it was normally
 * missed entirely: by the time both were open the turn had often ended, so reasoning
 * only ever appeared finished. These ids are opened automatically as they start and
 * stay open afterwards, so a thought is watchable while it is written and still there
 * to scroll back to.
 */
export function liveReasoningIds(groups: readonly TimelineGroup[]): { readonly groups: readonly string[]; readonly segments: readonly string[] } {
  const groupKeys: string[] = [];
  const segmentIds: string[] = [];
  for (const group of groups) {
    if (group.kind !== "reasoning") continue;
    const segments = reasoningSegments(group.items, group.key);
    const live = segments.filter((segment) => segment.kind === "thinking" && segment.item.state === "running");
    if (!live.length) continue;
    groupKeys.push(reasoningGroupKey(group));
    for (const segment of live) segmentIds.push(segment.id);
  }
  return { groups: groupKeys, segments: segmentIds };
}

/** One stable name for a span, used by the transcript to remember what is open. */
export function reasoningGroupKey(group: Extract<TimelineGroup, { kind: "reasoning" }>): string {
  return group.key;
}

/** Combine remembered choices with disclosures that are live in this render. */
export function activeDisclosureIds(manual: ReadonlySet<string>, live: readonly string[], closed: ReadonlySet<string>): ReadonlySet<string> {
  const next = new Set([...manual].filter((id) => !closed.has(id)));
  for (const id of live) if (!closed.has(id)) next.add(id);
  return next;
}

/** Adds or removes one key, returning a new set only when something actually changed. */
function withMember(current: ReadonlySet<string>, key: string, member: boolean): ReadonlySet<string> {
  if (current.has(key) === member) return current;
  const next = new Set(current);
  if (member) next.add(key); else next.delete(key);
  return next;
}

/**
 * Latch only disclosures the reader actually saw open while they were live.
 *
 * Settled history supplies no live ids, so opening an old task never spreads its
 * reasoning automatically. A close made during streaming is authoritative and is
 * therefore never added back by a later chunk or history reconciliation.
 */
export function rememberLiveDisclosureIds(opened: ReadonlySet<string>, live: readonly string[], closed: ReadonlySet<string>): ReadonlySet<string> {
  let next = opened;
  for (const id of live) if (!closed.has(id)) next = withMember(next, id, true);
  return next;
}

/**
 * The row stands for a thought the reader can actually read.
 *
 * That is the line between the two things a reasoning row can be. A real thought
 * is the record of how the turn was arrived at: it belongs to the transcript and
 * outlives the turn, waiting behind a quiet collapsed control for whoever scrolls
 * back. A row whose whole body is the word for the act of thinking says only
 * "something is happening right now" — which the working pulse already says, and
 * which stops being true the moment the turn ends. Left in the transcript it reads
 * as a model stuck mid-turn, so it is not kept. Asking what the text holds, rather
 * than recognising a marker of our own, covers a harness that sends the same
 * placeholder just as well.
 */
export function carriesThinking(item: TimelineItem): boolean {
  if (item.kind !== "reasoning") return false;
  const title = cleanTitle(item.title ?? "");
  if (title && !genericReasoningTitle.test(title)) return true;
  return holdsReadableThought(item.body);
}

/** Text with something in it to read, as opposed to a label for the act itself. */
function holdsReadableThought(body: string): boolean {
  const plain = plainPreviewText(formatReasoningText(body)).replace(/[.…]+$/u, "").trim();
  return plain.length > 0 && !genericReasoningTitle.test(plain);
}

export function withCurrentActivity(timeline: readonly TimelineItem[], active: boolean): readonly TimelineItem[] {
  let currentIndex = -1;
  let runningAssistantIndex = -1;
  if (active) {
    for (let index = timeline.length - 1; index >= 0; index -= 1) {
      const item = timeline[index]!;
      if (item.kind === "user") break;
      if (item.state === "running" && speaksForWork(item)) {
        currentIndex = index;
        break;
      }
      if (runningAssistantIndex < 0 && item.state === "running" && item.kind === "assistant") runningAssistantIndex = index;
    }
    // An externally owned harness can persist each reasoning/tool record only
    // after that individual record finishes, while the surrounding turn keeps
    // working. In that shape every row says `completed` even though the newest
    // trailing reasoning span is still the live envelope. Later commentary is
    // part of that same active envelope, not a reason to append a second inert
    // WorkingPulse below it. Walk through commentary to the nearest real work
    // row, but never cross a final answer, compaction boundary, failure, or user
    // turn: historical reasoning behind those boundaries must remain settled.
    if (currentIndex < 0) {
      for (let index = timeline.length - 1; index >= 0; index -= 1) {
        const item = timeline[index]!;
        if (item.kind === "user") break;
        if (timelineBoundaryLabel(item) || item.kind === "error" || item.state === "failed"
          || (item.kind === "assistant" && item.phase === "final_answer")) break;
        if (!hasVisibleTimelineContent(item)) continue;
        if (speaksForWork(item)) { currentIndex = index; break; }
      }
    }
    // Commentary-only harnesses still need their ordinary transcript row plus the
    // non-clickable pulse. Preserve the provider's live row only when there is no
    // real Reasoning/activity disclosure available to own the active state.
    if (currentIndex < 0) currentIndex = runningAssistantIndex;
  }
  const normalized: TimelineItem[] = timeline.map((candidate, candidateIndex) => {
    if (candidate.state === "failed") return candidate;
    if (candidateIndex === currentIndex) return candidate.state === "running" ? candidate : { ...candidate, state: "running" };
    return candidate.state === "running" ? { ...candidate, state: "completed" } : candidate;
  });
  // A reasoning row with nothing to read is a status line wearing a thought's clothes.
  // A harness announces the thought before it writes a word of it, and keeping that
  // announcement put a row on screen that says "Thinking" and cannot be opened,
  // because there is nothing behind it yet. The pulse speaks for a span that has not
  // written anything; a row appears when there are words in it, and settles into the
  // quiet collapsed Reasoning control the reader opens when they scroll back.
  return normalized.filter((item) => item.kind !== "reasoning" || carriesThinking(item));
}

/**
 * The session is working and nothing on screen says so yet.
 *
 * Working is a fact about the session, not an entry in the transcript, so it is
 * answered here and drawn as its own status line. Synthesising a reasoning row for
 * it put a thought the model never had into the reader's history: while it lasted
 * it offered a dropdown over nothing, and on the way out the transcript had to
 * recognise and delete a row it had written itself.
 */
export function showsWorkingPulse(timeline: readonly TimelineItem[], active: boolean, blockedByProviderStatus = false): boolean {
  if (!active || blockedByProviderStatus) return false;
  // A running assistant message is visible output, not evidence of thinking. Treating it
  // as the live activity left a working task with nothing marked live at all, which is the
  // common shape for harnesses that stream commentary instead of reasoning items. Only a
  // reasoning or activity row speaks for the span; anything else still needs the pulse.
  const streaming = timeline.find((item) => item.state === "running");
  if (streaming !== undefined && speaksForWork(streaming)) return false;
  // Only current view state may suppress the pulse. withCurrentActivity projects a
  // genuinely active trailing reasoning/action span to `running`; older settled work
  // remains completed and cannot stand in for the current turn.
  let lastUserIndex = -1;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    if (timeline[index]!.kind === "user") { lastUserIndex = index; break; }
  }
  return !timeline.slice(lastUserIndex + 1).some((item) => item.state === "running" && speaksForWork(item));
}

/** Late provider/replay events must never leave private work visually below a completed final answer. */
export function normalizeFinalAnswerOrder(timeline: readonly TimelineItem[], active = false): readonly TimelineItem[] {
  const normalized: TimelineItem[] = [];
  let start = 0;
  while (start < timeline.length) {
    let end = start + 1;
    while (end < timeline.length && timeline[end]?.kind !== "user") end += 1;
    const turn = timeline.slice(start, end);
    if (active && end === timeline.length) {
      normalized.push(...turn);
      start = end;
      continue;
    }
    let finalIndex = turn.findIndex((item) => item.kind === "assistant" && item.phase === "final_answer");
    if (finalIndex < 0) {
      const hasPhaseMetadata = turn.some((item) => item.kind === "assistant" && item.phase !== undefined && hasVisibleTimelineContent(item));
      // Providers without a final-answer phase (OpenCode emits none) never
      // qualify for the explicit path above. Once the turn has settled, its last
      // visible assistant row is the answer, and any tool/file rows the provider
      // echoed after that row (OpenCode appends the session diff at the very end
      // of a turn) belong above the answer, not beneath it. Live turns stay
      // untouched until they stop producing.
      if (!hasPhaseMetadata && !turn.some((item) => item.state === "running")) {
        for (let index = turn.length - 1; index >= 0; index -= 1) {
          const candidate = turn[index];
          if (candidate !== undefined && candidate.kind === "assistant" && hasVisibleTimelineContent(candidate) && !timelineBoundaryLabel(candidate)) {
            finalIndex = index;
            break;
          }
        }
      }
    }
    const lateWork = finalIndex < 0 ? [] : turn.slice(finalIndex + 1).filter((item) => !timelineBoundaryLabel(item)
      && (item.kind === "reasoning" || isRoutineActivity(item) || (item.kind === "assistant" && item.phase === "commentary")));
    if (finalIndex < 0 || lateWork.length === 0) normalized.push(...turn);
    else {
      const lateIds = new Set(lateWork.map((item) => item.id));
      normalized.push(...turn.slice(0, finalIndex), ...lateWork, ...turn.slice(finalIndex).filter((item) => !lateIds.has(item.id)));
    }
    start = end;
  }
  return normalized;
}

/**
 * Whether a span is open is the reader's decision, so it is held by the transcript
 * rather than by this component. A streaming turn reshapes the rows around it -
 * history catches up, rows are reordered, a group splits - and any of that can give
 * this component a new identity and destroy its state. Holding `expanded` here meant
 * the panel closed itself under a reader who was watching a thought arrive, which is
 * also why live reasoning was so hard to see at all.
 */
function ReasoningGroupImpl({ items, groupKey, expanded, onToggleGroup, onLinkOpen }: {
  items: readonly TimelineItem[];
  groupKey: string;
  expanded: boolean;
  onToggleGroup: () => void;
  onLinkOpen?: ((url: string) => void) | undefined;
}) {
  const segments = reasoningSegments(items, groupKey);
  const running = items.some((item) => item.state === "running");
  return <section className="reasoning-group" aria-busy={running || undefined} data-scroll-anchor={items[0]?.id} data-scroll-members={items.map((item) => encodeURIComponent(item.id)).join("|")}>
    <button type="button" className={`reasoning-disclosure ${running ? "reasoning-running" : ""}`} aria-expanded={expanded} onClick={onToggleGroup}>
      <span className="reasoning-mark" aria-hidden="true"><i/><i/><i/></span>
      {/* The trailing ellipsis is the tense marker: dots alone read as decoration, so a
          span that is still being written should say so in the word itself. */}
      <span className="reasoning-label">{running ? "Reasoning…" : "Reasoning"}</span>
      <ChevronDownIcon className={expanded ? "expanded" : ""}/>
    </button>
    {expanded ? <div className="reasoning-detail">
      <div className="reasoning-segments">{segments.map((segment) => segment.kind === "thinking"
        ? <ThinkingFlow key={segment.id} segment={segment} onLinkOpen={onLinkOpen}/>
        : segment.kind === "compaction"
          ? <CompactionDisclosure key={segment.id} item={segment.item} label={segment.label} nested/>
          : <ActivityDisclosure key={segment.id} item={segment.items[0]!}/>)}</div>
    </div> : null}
  </section>;
}

// Settled groups carry the same item objects render after render, so a row that
// is not streaming must not re-render while a later turn streams beside it.
// Comparing item identity (not the freshly derived items array) is what keeps a
// finished turn's expensive reasoning bodies off the per-delta render path.
const ReasoningGroup = memo(ReasoningGroupImpl, (previous, next) =>
  previous.groupKey === next.groupKey
  && previous.onLinkOpen === next.onLinkOpen
  && previous.expanded === next.expanded
  && previous.onToggleGroup === next.onToggleGroup
  && previous.items.length === next.items.length
  && previous.items.every((item, index) => item === next.items[index]));

/** A single reasoning row shown outside the transcript, which owns nothing to hold for it. */
function StandaloneReasoningGroup({ item, onLinkOpen }: { item: TimelineItem; onLinkOpen?: ((url: string) => void) | undefined }) {
  const [open, setOpen] = useState(false);
  const items = useMemo(() => [item], [item]);
  const toggleGroup = useCallback(() => setOpen((current) => !current), []);
  return <ReasoningGroup
    items={items}
    groupKey={`standalone:${item.messageId ?? item.id}`}
    expanded={open}
    onToggleGroup={toggleGroup}
    onLinkOpen={onLinkOpen}
  />;
}

const CompactionDisclosure = memo(function CompactionDisclosure({ item, label, nested = false }: { item: TimelineItem; label: string; nested?: boolean }) {
  const [open, setOpen] = useState(false);
  const rawDetail = compactionDetailText(item, label);
  const detail = (rawDetail.replace(compactionSummaryNotice, "").trim() || rawDetail);
  return <section className={`timeline-compaction-disclosure ${nested ? "timeline-compaction-nested" : ""}`} data-scroll-anchor={nested ? undefined : item.id}>
    <button type="button" className="timeline-compaction-toggle" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
      <CompactionIcon />
      <span>{label}</span>
      <ChevronDownIcon className={open ? "expanded" : ""}/>
    </button>
    {open ? <div className="timeline-compaction-detail" role="note">
      <RichText>{formatReasoningText(detail)}</RichText>
      <div className="timeline-compaction-footer"><CopyButton className="timeline-copy-button timeline-compaction-copy" text={detail} label="Copy compaction summary" /></div>
    </div> : null}
  </section>;
});

const TimelineBoundary = memo(function TimelineBoundary({ item, label, final = false }: { item?: TimelineItem | undefined; label: string; final?: boolean | undefined }) {
  if (item && label === "Session compacted") return <CompactionDisclosure item={item} label={label}/>;
  return <div className={`timeline-boundary ${final ? "timeline-final-boundary" : ""}`} role="separator" aria-label={label}>
    {final ? null : <span>{label}</span>}
  </div>;
});

function QuietIssueIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v6M12 16.7h.01"/></svg>;
}

const TimelineErrorNotice = memo(function TimelineErrorNotice({ item, onContinue }: { item: TimelineItem; onContinue?: (() => void) | undefined }) {
  return <div className="timeline-error-notice" role="alert" aria-live="assertive" aria-atomic="true">
    <QuietIssueIcon />
    <span>{timelineErrorNoticeText(item)}</span>
    {onContinue ? <button type="button" className="timeline-error-recovery" onClick={onContinue}>Continue in composer</button> : null}
  </div>;
});

/** Keep retry information useful without exposing provider transport identifiers. */
export function providerStatusNoticeText(status: ProviderStatus): string {
  const readable = status.message
    .replace(errorReference, "")
    .replace(executionId, "")
    .replace(uuid, "")
    .replace(/\s+/gu, " ")
    .replace(/\s+([,.;:!?])/gu, "$1")
    .replace(/[,;:\s-]+$/gu, "")
    .trim();
  const detail = readable.length > 240 ? `${readable.slice(0, 237).trimEnd()}…` : readable;
  return detail ? `Retrying — ${detail}` : "Retrying…";
}

const ProviderStatusNotice = memo(function ProviderStatusNotice({ status }: { status: ProviderStatus }) {
  return <div className="timeline-provider-status" data-provider-status={status.kind} role="status" aria-live="polite">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 8a8 8 0 1 0 1 6"/><path d="M19 4v4h-4"/></svg>
    <span>{providerStatusNoticeText(status)}</span>
  </div>;
});

const ActiveCompactionStatus = memo(function ActiveCompactionStatus({ kind }: { kind: "automatic" | "manual" | null }) {
  const label = kind === "automatic" ? "Automatically compacting context…" : "Compacting context…";
  return <div className="timeline-compaction-event timeline-compaction-active" role="status" aria-live="polite" aria-label={label}>
    <CompactionIcon />
    <span>{label}</span>
  </div>;
});

/** Working with no readable thought yet: status, never a dropdown over nothing. */
const WorkingPulse = memo(function WorkingPulse() {
  return <section className="reasoning-group working-pulse" aria-busy>
    <div className="reasoning-disclosure reasoning-running" role="status" aria-label="Reasoning">
      <span className="reasoning-mark" aria-hidden="true"><i/><i/><i/></span>
      <span className="reasoning-label">Reasoning…</span>
    </div>
  </section>;
});

function WorkflowMessageAttachment({ workflow, onOpen }: { workflow: TimelineWorkflow; onOpen?: ((id: string) => void) | undefined }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  return <>
    <button type="button" className="message-workflow-chip" onClick={() => setDetailsOpen(true)} aria-label={`View attached workflow ${workflow.name}`}>
      <WorkflowIcon />
      <span><strong>{workflow.name}</strong><small>{workflow.eventCount} events · {workflow.screenshotCount} screenshots</small></span>
    </button>
    {detailsOpen ? <div className="message-workflow-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDetailsOpen(false); }}>
      <section className="message-workflow-panel" role="dialog" aria-modal="true" aria-label={`${workflow.name} workflow details`}>
        <header><span><WorkflowIcon /><strong>{workflow.name}</strong></span><button type="button" aria-label="Close workflow details" onClick={() => setDetailsOpen(false)}><XIcon /></button></header>
        <p>Recorded workflow attached to this message.</p>
        <dl><div><dt>Events</dt><dd>{workflow.eventCount}</dd></div><div><dt>Screenshots</dt><dd>{workflow.screenshotCount}</dd></div></dl>
        {workflow.applications?.length ? <p className="message-workflow-apps">Captured in {workflow.applications.join(", ")}</p> : null}
        {onOpen ? <button type="button" className="message-workflow-open" onClick={() => { setDetailsOpen(false); onOpen(workflow.id); }}>Open workflow</button> : null}
      </section>
    </div> : null}
  </>;
}

function MessageAnnotationBadges({ annotations }: { annotations: NonNullable<TimelineItem["annotations"]> }) {
  const [open, setOpen] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open === null) return;
    const dismiss = (event: KeyboardEvent | PointerEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === "Escape") setOpen(null);
        return;
      }
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(null);
    };
    window.addEventListener("keydown", dismiss);
    window.addEventListener("pointerdown", dismiss);
    return () => {
      window.removeEventListener("keydown", dismiss);
      window.removeEventListener("pointerdown", dismiss);
    };
  }, [open]);
  return <div ref={root} className="message-annotations" aria-label="Response annotations">{annotations.map((annotation, index) => <span className="message-annotation" key={annotation.id}>
    <button type="button" aria-label={`View annotation ${index + 1}`} aria-expanded={open === index} onClick={() => setOpen((current) => current === index ? null : index)}><AnnotationIcon /><strong>{index + 1}</strong></button>
    {open === index ? <span className="message-annotation-detail" role="note"><small>Selected response</small><blockquote>{annotation.text}</blockquote><small>Your annotation</small>{annotation.annotation ? <p>{annotation.annotation}</p> : null}{annotation.audio ? annotation.audio.dataUrl ? <AudioPlaybackChip name={annotation.audio.name} dataUrl={annotation.audio.dataUrl} dictation durationSeconds={annotation.audio.durationSeconds}/> : <p>Recording preview is unavailable in reopened history.</p> : null}</span> : null}
  </span>)}</div>;
}

export function ChatTimeline({ timeline, providerId, provider, providerStatus, reasoningDisplay = "compact", isCompacting = false, compactionKind = null, active = false, onLinkOpen, onWorkflowOpen, onAnnotateSelection, onContinueInComposer }: {
  timeline: readonly TimelineItem[];
  providerId: ProviderId;
  provider?: Provider | undefined;
  providerStatus?: ProviderStatus | undefined;
  reasoningDisplay?: ReasoningDisplay;
  isCompacting?: boolean;
  compactionKind?: "automatic" | "manual" | null;
  active?: boolean;
  onLinkOpen?: ((url: string) => void) | undefined;
  onWorkflowOpen?: ((id: string) => void) | undefined;
  onAnnotateSelection?: ((text: string, anchor: { x: number; y: number }) => void) | undefined;
  onContinueInComposer?: (() => void) | undefined;
}) {
  // Two sets, not one flag: in flow-through mode a span is open until the reader
  // closes it, and in compact mode closed until the reader opens it. Recording the
  // decision rather than the resulting state is what lets both modes share it.
  // Asking to watch a span that has not written anything yet is remembered, so the
  // thought that follows is already open when it arrives.
  const [openedGroups, setOpenedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [closedGroups, setClosedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [annotationMenu, setAnnotationMenu] = useState<{ text: string; x: number; y: number } | null>(null);
  useEffect(() => {
    if (!annotationMenu) return;
    const close = (event: KeyboardEvent | MouseEvent) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      setAnnotationMenu(null);
    };
    window.addEventListener("keydown", close);
    window.addEventListener("mousedown", close);
    return () => { window.removeEventListener("keydown", close); window.removeEventListener("mousedown", close); };
  }, [annotationMenu]);
  const visibleTimeline = withCurrentActivity(normalizeFinalAnswerOrder(coalesceCompactionCopies(timeline), active), active);
  const groups = groupTimeline(visibleTimeline, active);
  const live = liveReasoningIds(groups);
  const liveKey = `${live.groups.join("|")}::${live.segments.join("|")}`;
  // The live ids make the first committed streaming render open immediately.
  // Remember that committed state so terminal settlement or an authoritative
  // history page cannot close the thought while the reader is watching it.
  useEffect(() => {
    if (!live.groups.length) return;
    setOpenedGroups((current) => rememberLiveDisclosureIds(current, live.groups, closedGroups));
  }, [liveKey, closedGroups]);
  const activeGroups = useMemo(
    () => activeDisclosureIds(openedGroups, live.groups, closedGroups),
    [openedGroups, closedGroups, liveKey],
  );
  const groupExpanded = useCallback(
    (key: string): boolean => !closedGroups.has(key) && (activeGroups.has(key) || reasoningDisplay === "expanded"),
    [activeGroups, closedGroups, reasoningDisplay],
  );
  const toggleGroup = useCallback((key: string): void => {
    const open = groupExpanded(key);
    setOpenedGroups((current) => withMember(current, key, !open));
    setClosedGroups((current) => withMember(current, key, open));
  }, [groupExpanded]);
  return <>{groups.map((group) => {
    if (group.kind === "boundary") return <TimelineBoundary key={group.item.id} item={group.item} label={group.label}/>;
    if (group.kind === "reasoning") {
      const key = reasoningGroupKey(group);
      const segments = reasoningSegments(group.items, key);
      if (segments.length === 1 && segments[0]?.kind === "compaction") {
        const segment = segments[0];
        return <CompactionDisclosure key={key} item={segment.item} label={segment.label}/>;
      }
      return <ReasoningGroup
        key={key}
        groupKey={key}
        items={group.items}
        expanded={groupExpanded(key)}
        onToggleGroup={() => toggleGroup(key)}
        onLinkOpen={onLinkOpen}
      />;
    }
    if (group.item.kind === "error") return <TimelineErrorNotice key={group.item.id} item={group.item} onContinue={onContinueInComposer}/>;
    const finalBoundary = shouldSeparateFinalAnswer(visibleTimeline, group.index, active);
    const identityMode = assistantIdentityMode(visibleTimeline, group.index, active);
    const card = <ChatTimelineCard key={group.item.id} item={group.item} providerId={providerId} provider={provider} identityMode={identityMode} copyText={identityMode === "final" ? finalAnswerCopyText(visibleTimeline, group.index) : undefined} onLinkOpen={onLinkOpen} onWorkflowOpen={onWorkflowOpen} onSelectionContextMenu={onAnnotateSelection ? (text, anchor) => setAnnotationMenu({ text, ...anchor }) : undefined}/>;
    return finalBoundary ? <div className="final-answer-block" key={group.item.id}><TimelineBoundary label="Final answer" final/>{card}</div> : card;
  })}{providerStatus ? <ProviderStatusNotice status={providerStatus}/> : null}{showsWorkingPulse(visibleTimeline, active, providerStatus?.kind === "retry") ? <WorkingPulse /> : null}{isCompacting ? <ActiveCompactionStatus kind={compactionKind} /> : null}{annotationMenu ? createPortal(<div className="annotation-context-menu" role="menu" style={{ left: Math.min(annotationMenu.x, window.innerWidth - 150), top: Math.min(annotationMenu.y, window.innerHeight - 58) }} onMouseDown={(event) => event.stopPropagation()}><button type="button" role="menuitem" onClick={() => { onAnnotateSelection?.(annotationMenu.text, { x: annotationMenu.x, y: annotationMenu.y }); setAnnotationMenu(null); }}><AnnotationIcon />Annotate</button></div>, document.body) : null}</>;
}

export const ChatTimelineCard = memo(function ChatTimelineCard({ item, providerId, provider, identityMode = "final", copyText, onLinkOpen, onWorkflowOpen, onSelectionContextMenu }: {
  item: TimelineItem;
  providerId: ProviderId;
  provider?: Provider | undefined;
  /** Set with assistantIdentityMode when rendering a complete timeline. */
  identityMode?: AssistantIdentityMode;
  copyText?: string | undefined;
  onLinkOpen?: ((url: string) => void) | undefined;
  onWorkflowOpen?: ((id: string) => void) | undefined;
  onSelectionContextMenu?: ((text: string, anchor: { x: number; y: number }) => void) | undefined;
}) {
  const [lightbox, setLightbox] = useState<{ dataUrl: string; name: string } | null>(null);
  useEffect(() => {
    if (!lightbox) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setLightbox(null); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [lightbox]);
  const time = new Date(item.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (item.kind === "user" || item.kind === "assistant") {
    const assistantName = providerDisplayName(providerId, provider);
    const identity = item.kind === "assistant" && identityMode !== "none";
    const liveIdentity = identityMode === "live";
    const intermediate = item.kind === "assistant" && !identity;
    const progress = item.kind === "assistant" && (item.phase === "commentary" || item.state === "running");
    const footerCopyText = item.kind === "user" ? item.body.trim() : identityMode === "final" ? copyText : undefined;
    const visibleFooterCopyText = item.kind === "user" && item.annotations?.length
      ? responseAnnotationCopyText(item.body, item.annotations)
      : footerCopyText;
    const footerCopyLabel = item.kind === "user" ? "Copy your message" : "Copy final answer";
    const imageGallery = item.images?.length ? <div className={`message-images ${item.kind === "user" ? "message-images-before" : ""}`}>{item.images.map((image, index) => image.dataUrl ? <button type="button" key={`${image.name}-${index}`} aria-label={`Expand ${image.name}`} onClick={() => setLightbox({ dataUrl: image.dataUrl!, name: image.name })}><img src={image.dataUrl} alt={image.name} referrerPolicy="no-referrer"/></button> : <span className="message-image-unavailable" key={`${image.name}-${index}`}><ScreenshotIcon /><span><strong>{image.name}</strong><small>Image preview was not retained in history</small></span></span>)}</div> : null;
    const audioGallery = item.audio?.length ? <div className={`message-audio ${item.kind === "user" ? "message-audio-before" : ""}`} aria-label="Voice recordings">{item.audio.map((audio, index) => audio.dataUrl ? <AudioPlaybackChip key={`${audio.name}-${index}`} name={audio.name} dataUrl={audio.dataUrl} dictation={audio.dictation === true} durationSeconds={audio.durationSeconds}/> : <span className="message-image-unavailable" key={`${audio.name}-${index}`}><span><strong>{audio.name}</strong><small>Recording preview was not retained in history</small></span></span>)}</div> : null;
    const workflowGallery = item.workflows?.length ? <div className="message-workflows" aria-label="Attached workflows">{item.workflows.map((workflow) => <WorkflowMessageAttachment key={workflow.id} workflow={workflow} onOpen={onWorkflowOpen}/>)}</div> : null;
    return <><article className={`message message-${item.kind} ${identity ? "message-with-identity" : "message-without-identity"} ${intermediate ? "message-intermediate" : ""} ${progress ? "message-progress" : ""}`} aria-busy={item.state === "running" || undefined} data-scroll-anchor={item.id}>
      <div className={item.kind === "assistant" ? "assistant-message-row" : undefined}>
      {identity ? <span className="assistant-identity" data-mode={identityMode} aria-label={liveIdentity ? `${assistantName} thinking` : assistantName}>
        <ProviderLogo providerId={providerId} provider={provider} size={28}/>
      </span> : null}
      <div className="message-content">
        {item.origin?.kind === "cross_session" ? <p className="message-origin"><BranchIcon /><span>From another Tethoq task · {item.origin.sourceTitle || "Untitled task"}</span></p> : null}
        {workflowGallery}
        {item.kind === "user" ? imageGallery : null}
        {item.kind === "user" ? audioGallery : null}
        {item.annotations?.length ? <MessageAnnotationBadges annotations={item.annotations}/> : null}
        {item.body ? <div className="message-body" onContextMenu={item.kind === "assistant" && onSelectionContextMenu ? (event) => {
          const selection = window.getSelection();
          if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
          const range = selection.getRangeAt(0);
          if (!event.currentTarget.contains(range.commonAncestorContainer)) return;
          const text = selection.toString().trim().slice(0, 24_000);
          if (!text) return;
          event.preventDefault();
          onSelectionContextMenu(text, { x: event.clientX, y: event.clientY });
        } : undefined}><RichText onImageOpen={setLightbox} onLinkOpen={onLinkOpen}>{item.body}</RichText></div> : null}
        {item.kind === "assistant" ? imageGallery : null}
        {item.kind === "assistant" ? audioGallery : null}
        {footerCopyText ? <div className="message-footer">
          <time dateTime={item.timestamp}>{time}</time>
          <CopyButton className="copy-message" text={visibleFooterCopyText ?? footerCopyText} label={footerCopyLabel} />
        </div> : item.kind === "user" && item.annotations?.length ? <div className="message-footer">
          <time dateTime={item.timestamp}>{time}</time>
          <CopyButton className="copy-message" text={visibleFooterCopyText ?? ""} label={footerCopyLabel} />
        </div> : null}
      </div>
      </div>
    </article>{lightbox ? <div className="image-lightbox" role="dialog" aria-modal="true" aria-label={lightbox.name} onMouseDown={(event) => { if (event.target === event.currentTarget) setLightbox(null); }}><button type="button" aria-label="Close image preview" onClick={() => setLightbox(null)}><XIcon /></button><figure><img src={lightbox.dataUrl} alt={lightbox.name} referrerPolicy="no-referrer"/><figcaption>{lightbox.name}</figcaption></figure></div> : null}</>;
  }
  return <StandaloneReasoningGroup item={item} onLinkOpen={onLinkOpen}/>;
});
