import { useEffect, useState } from "react";
import { AlertIcon, BranchIcon, ChevronDownIcon, CompactionIcon, CopyIcon, ScreenshotIcon, WorkflowIcon, XIcon } from "./icons";
import { ProviderLogo, providerDisplayName } from "./components";
import { RichText } from "./RichText";
import type { Provider, ProviderId, TimelineItem, TimelineWorkflow } from "./types";

const routineActivityKinds = new Set<TimelineItem["kind"]>(["tool", "command", "file", "subagent"]);

function isRoutineActivity(item: TimelineItem): boolean {
  return routineActivityKinds.has(item.kind);
}

/** Do not leave timestamp/copy-control shells for empty provider deltas. */
export function hasVisibleTimelineContent(item: TimelineItem): boolean {
  if (item.kind !== "user" && item.kind !== "assistant") return true;
  const body = item.body.trim();
  if (item.images?.length || item.workflows?.length) return true;
  if (!body || /^<!--[\s\S]*-->$/u.test(body)) return false;
  const rawBlock = body.match(/^<([a-z][\w:-]*)\b[^>]*>[\s\S]*<\/\1>$/iu);
  return !rawBlock && !/^<[a-z][\w:-]*\b[^>]*\/?>$/iu.test(body);
}

type TimelineGroup =
  | { kind: "item"; item: TimelineItem; index: number }
  | { kind: "boundary"; item: TimelineItem; index: number; label: string }
  | { kind: "reasoning"; reasoning: TimelineItem; activities: TimelineItem[]; items: TimelineItem[]; index: number };

export type ReasoningSegment =
  | { kind: "thinking"; id: string; item: TimelineItem }
  | { kind: "activity"; id: string; items: TimelineItem[] };

const compactionNotice = /^(?:(?:context|conversation)\s+(?:was\s+|has\s+been\s+|automatically\s+)?compacted(?:\s+successfully)?|(?:automatic\s+|context\s+)?compaction\s+(?:complete|completed))[.!]?$/iu;
const automaticCompactionNotice = /\b(?:automatically\s+compacted|automatic\s+compaction)\b/iu;
const systemTitle = /^(?:system|system message|system update|notice)$/iu;

/** Normalize sparse provider notices into quiet transcript boundaries. */
export function timelineBoundaryLabel(item: TimelineItem): string | null {
  if (item.kind === "user") return null;
  const title = cleanTitle(item.title ?? "");
  const body = item.body.trim();
  const compactionCandidate = [title, body, `${title} ${body}`.trim()].find((candidate) => candidate.length <= 140 && compactionNotice.test(candidate));
  if (compactionCandidate) return automaticCompactionNotice.test(compactionCandidate) ? "Automatically compacted context" : "Context compacted";
  if (systemTitle.test(title) && body.length <= 240) return body || "System update";
  if (/^\s*\[(?:system|notice)\]\s*/iu.test(body) && body.length <= 240) {
    return body.replace(/^\s*\[(?:system|notice)\]\s*/iu, "").trim() || "System update";
  }
  return null;
}

function turnBounds(timeline: readonly TimelineItem[], index: number): readonly [number, number] {
  let start = index;
  while (start > 0 && timeline[start - 1]?.kind !== "user") start -= 1;
  let end = index + 1;
  while (end < timeline.length && timeline[end]?.kind !== "user") end += 1;
  return [start, end];
}

/** A turn gets one identity mark on its final (or only) answer. */
export function shouldShowAssistantIdentity(timeline: readonly TimelineItem[], index: number): boolean {
  const item = timeline[index];
  if (item?.kind !== "assistant" || !hasVisibleTimelineContent(item) || timelineBoundaryLabel(item)) return false;
  const [start, end] = turnBounds(timeline, index);
  const assistantIndexes: number[] = [];
  for (let cursor = start; cursor < end; cursor += 1) {
    if (timeline[cursor]?.kind === "assistant" && hasVisibleTimelineContent(timeline[cursor]!) && !timelineBoundaryLabel(timeline[cursor]!)) assistantIndexes.push(cursor);
  }
  if (item.phase === "commentary") return false;
  if (item.phase === "final_answer") return !assistantIndexes.slice(assistantIndexes.indexOf(index) + 1).some((cursor) => timeline[cursor]?.phase === "final_answer");
  if (assistantIndexes.some((cursor) => timeline[cursor]?.phase !== undefined)) return false;
  return index === assistantIndexes.at(-1);
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
export function reasoningSegments(items: readonly TimelineItem[]): ReasoningSegment[] {
  const segments: ReasoningSegment[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    if (item.kind === "reasoning") {
      segments.push({ kind: "thinking", id: `thinking:${item.id}`, item });
      continue;
    }
    if (!isRoutineActivity(item)) continue;
    if (item.kind === "subagent") {
      segments.push({ kind: "activity", id: `activity:${item.id}`, items: [item] });
      continue;
    }
    const activities: TimelineItem[] = [];
    let cursor = index;
    while (cursor < items.length && isRoutineActivity(items[cursor]!) && items[cursor]!.kind !== "subagent") {
      activities.push(items[cursor]!);
      cursor += 1;
    }
    if (activities.length) segments.push({ kind: "activity", id: `activity:${activities[0]!.id}`, items: activities });
    index = cursor - 1;
  }
  return segments;
}

/** Keep every uninterrupted reasoning and execution span behind one quiet control. */
export function groupTimeline(timeline: readonly TimelineItem[]): TimelineGroup[] {
  const groups: TimelineGroup[] = [];
  for (let index = 0; index < timeline.length; index += 1) {
    const item = timeline[index]!;
    if (!hasVisibleTimelineContent(item)) continue;
    const boundaryLabel = timelineBoundaryLabel(item);
    if (boundaryLabel) {
      groups.push({ kind: "boundary", item, index, label: boundaryLabel });
      continue;
    }
    if (item.kind !== "reasoning" && !isRoutineActivity(item)) {
      groups.push({ kind: "item", item, index });
      continue;
    }
    const items: TimelineItem[] = [];
    let cursor = index;
    while (cursor < timeline.length) {
      const candidate = timeline[cursor]!;
      if (timelineBoundaryLabel(candidate) || (candidate.kind !== "reasoning" && !isRoutineActivity(candidate))) break;
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
    groups.push({ kind: "reasoning", reasoning, activities, items, index });
    index = cursor - 1;
  }
  return groups;
}

/** A separator is useful only when an answer follows visible work in the same turn. */
export function shouldSeparateFinalAnswer(timeline: readonly TimelineItem[], index: number): boolean {
  const item = timeline[index];
  if (item?.kind !== "assistant" || !hasVisibleTimelineContent(item) || item.phase === "commentary" || item.state === "running" || timelineBoundaryLabel(item)) return false;
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
  return concisePreview(formatReasoningText(item.body) || title || "Thinking");
}

/** A disclosure is useful only when its body adds at least one visible character. */
export function thinkingExpansionAddsContent(item: TimelineItem): boolean {
  const body = plainPreviewText(formatReasoningText(item.body));
  if (!body) return false;
  return body !== plainPreviewText(reasoningPreview(item));
}

/** Lead with the first call and disclose the exact ordered sequence only on demand. */
export function activitySegmentPreview(items: readonly TimelineItem[]): string {
  const first = items[0];
  if (!first) return "Tool calls";
  const label = activityLabel(first);
  const visibleLabel = first.kind === "subagent" ? "Spawned sub-agent" : label;
  const target = activityTarget(first) || concisePreview(readableActivityBody(first.body), 92);
  const firstCall = concisePreview(target && target.toLowerCase() !== visibleLabel.toLowerCase()
    ? `${visibleLabel}${first.kind === "subagent" ? " · " : " "}${target}`
    : visibleLabel, 104);
  return items.length > 1 ? `${firstCall} · ${items.length - 1} more` : firstCall;
}

export function defaultExpandedSegmentIds(segments: readonly ReasoningSegment[], display: ReasoningDisplay): string[] {
  return display === "expanded" ? segments.filter((segment) => segment.kind === "thinking" && thinkingExpansionAddsContent(segment.item)).map((segment) => segment.id) : [];
}

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

function TimelineItemMeta({ item, copyText, copyLabel }: { item: TimelineItem; copyText: string; copyLabel: string }) {
  const time = new Date(item.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return <span className="timeline-item-meta">
    <time dateTime={item.timestamp}>{time}</time>
    <button type="button" className="timeline-copy-button" title={copyLabel} aria-label={copyLabel} onClick={() => void navigator.clipboard.writeText(copyText)}><CopyIcon /></button>
  </span>;
}

function ActivityDisclosure({ item }: { item: TimelineItem }) {
  const [expanded, setExpanded] = useState(false);
  const [enlarged, setEnlarged] = useState(false);
  const label = activityLabel(item);
  const visibleLabel = item.kind === "subagent" ? "Spawned sub-agent" : label;
  const target = activityTarget(item);
  const body = readableActivityBody(item.body);
  const long = body.length > 1_600 || body.split("\n").length > 22;
  const collapse = () => { setExpanded(false); setEnlarged(false); };
  return <div className={`activity-disclosure ${item.state === "failed" ? "activity-failed" : ""}`}>
    <div className="activity-line">
      <button type="button" className="activity-row" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
        <span className="activity-glyph"><ActivityGlyph label={label} /></span>
        <strong>{visibleLabel}</strong>
        {target ? <span className="activity-target">{target}</span> : null}
        <ChevronDownIcon className={expanded ? "expanded" : ""}/>
      </button>
      <TimelineItemMeta item={item} copyText={body} copyLabel={`Copy ${visibleLabel.toLowerCase()} details`}/>
    </div>
    {expanded ? <section className={`activity-snippet ${enlarged ? "activity-snippet-enlarged" : ""}`} aria-label={`${visibleLabel} details`}>
      <header>
        <strong>{visibleLabel}</strong>
        <div>
          {long ? <button type="button" onClick={() => setEnlarged((current) => !current)}>{enlarged ? "Reduce" : "Enlarge"}</button> : null}
          <button type="button" onClick={collapse}>Collapse <ChevronDownIcon /></button>
        </div>
      </header>
      <pre>{body}</pre>
      <footer><button type="button" onClick={collapse}><ChevronDownIcon />Collapse</button></footer>
    </section> : null}
  </div>;
}

function ThinkingDisclosure({ segment, expanded, onToggle, onLinkOpen }: {
  segment: Extract<ReasoningSegment, { kind: "thinking" }>;
  expanded: boolean;
  onToggle: () => void;
  onLinkOpen?: ((url: string) => void) | undefined;
}) {
  const { item } = segment;
  const body = formatReasoningText(item.body);
  const expandable = thinkingExpansionAddsContent(item);
  return <div className="reasoning-segment reasoning-thinking-segment">
    <div className="reasoning-segment-line">
      <button type="button" className="reasoning-segment-row" aria-expanded={expandable ? expanded : undefined} disabled={!expandable} onClick={expandable ? onToggle : undefined}>
        <span className="reasoning-segment-preview">{reasoningPreview(item)}</span>
        {expandable ? <ChevronDownIcon className={expanded ? "expanded" : ""}/> : null}
      </button>
      <TimelineItemMeta item={item} copyText={body} copyLabel="Copy thinking"/>
    </div>
    {expandable && expanded ? <div className={`reasoning-flow ${item.state === "running" ? "reasoning-flow-running" : ""}`}><RichText onLinkOpen={onLinkOpen}>{body}</RichText></div> : null}
  </div>;
}

function ActivitySegmentDisclosure({ segment, expanded, onToggle }: {
  segment: Extract<ReasoningSegment, { kind: "activity" }>;
  expanded: boolean;
  onToggle: () => void;
}) {
  const first = segment.items[0]!;
  const label = activityLabel(first);
  return <div className="reasoning-segment reasoning-activity-segment">
    <button type="button" className="reasoning-segment-row" aria-expanded={expanded} onClick={onToggle}>
      <span className="activity-glyph"><ActivityGlyph label={label}/></span>
      <span className="reasoning-segment-preview">{activitySegmentPreview(segment.items)}</span>
      <ChevronDownIcon className={expanded ? "expanded" : ""}/>
    </button>
    {expanded ? <div className="reasoning-activities">{segment.items.map((activity) => <ActivityDisclosure key={activity.id} item={activity}/>)}</div> : null}
  </div>;
}

export type ReasoningDisplay = "compact" | "expanded";

export function withCurrentActivity(timeline: readonly TimelineItem[], active: boolean): readonly TimelineItem[] {
  let currentIndex = -1;
  if (active) {
    for (let index = timeline.length - 1; index >= 0; index -= 1) {
      const item = timeline[index]!;
      if (item.kind === "user") break;
      if (item.state === "running" && (item.kind === "assistant" || item.kind === "reasoning" || isRoutineActivity(item))) {
        currentIndex = index;
        break;
      }
    }
    for (let index = timeline.length - 1; currentIndex < 0 && index >= 0; index -= 1) {
      const item = timeline[index]!;
      if (item.kind === "user" || item.phase === "final_answer") break;
      if (item.kind === "reasoning" || isRoutineActivity(item)) {
        currentIndex = index;
        break;
      }
    }
  }
  const normalized: TimelineItem[] = timeline.map((candidate, candidateIndex): TimelineItem => {
    if (candidate.state === "failed") return candidate;
    if (candidateIndex === currentIndex) return candidate.state === "running" ? candidate : { ...candidate, state: "running" };
    return candidate.state === "running" ? { ...candidate, state: "completed" } : candidate;
  });
  if (!active || currentIndex >= 0) return normalized;
  const anchor = timeline.at(-1);
  const placeholder: TimelineItem = {
    id: `tethoq-live-reasoning-${anchor?.id ?? "task"}`,
    kind: "reasoning",
    title: "Working",
    body: "Working…",
    state: "running",
    timestamp: anchor?.timestamp ?? new Date(0).toISOString(),
  };
  return [...normalized, placeholder];
}

/** Late provider/replay events must never leave private work visually below a completed final answer. */
export function normalizeFinalAnswerOrder(timeline: readonly TimelineItem[]): readonly TimelineItem[] {
  const normalized: TimelineItem[] = [];
  let start = 0;
  while (start < timeline.length) {
    let end = start + 1;
    while (end < timeline.length && timeline[end]?.kind !== "user") end += 1;
    const turn = timeline.slice(start, end);
    const firstFinal = turn.findIndex((item) => item.kind === "assistant" && item.phase === "final_answer");
    if (firstFinal < 0) normalized.push(...turn);
    else {
      const lateWork = turn.slice(firstFinal + 1).filter((item) => !timelineBoundaryLabel(item) && (item.kind === "reasoning" || isRoutineActivity(item)));
      if (!lateWork.length) normalized.push(...turn);
      else {
        const lateIds = new Set(lateWork.map((item) => item.id));
        normalized.push(...turn.slice(0, firstFinal), ...lateWork, ...turn.slice(firstFinal).filter((item) => !lateIds.has(item.id)));
      }
    }
    start = end;
  }
  return normalized;
}

function ReasoningGroup({ items, reasoningDisplay = "compact", onLinkOpen }: { items: readonly TimelineItem[]; reasoningDisplay?: ReasoningDisplay; onLinkOpen?: ((url: string) => void) | undefined }) {
  const [expanded, setExpanded] = useState(false);
  const [expandedSegments, setExpandedSegments] = useState<ReadonlySet<string>>(() => new Set());
  const segments = reasoningSegments(items);
  const thinking = segments.filter((segment) => segment.kind === "thinking");
  const expandableThinking = thinking.filter((segment) => thinkingExpansionAddsContent(segment.item));
  const activities = segments.filter((segment) => segment.kind === "activity");
  const allThinkingExpanded = expandableThinking.length > 0 && expandableThinking.every((segment) => expandedSegments.has(segment.id));
  const allActivitiesExpanded = activities.length > 0 && activities.every((segment) => expandedSegments.has(segment.id));
  const toggleSegment = (id: string) => setExpandedSegments((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleCategory = (kind: ReasoningSegment["kind"]) => setExpandedSegments((current) => {
    const targets = kind === "thinking" ? expandableThinking : activities;
    const collapse = targets.length > 0 && targets.every((segment) => current.has(segment.id));
    const next = new Set(current);
    for (const segment of targets) if (collapse) next.delete(segment.id); else next.add(segment.id);
    return next;
  });
  const toggleOuter = () => {
    const opening = !expanded;
    setExpanded(opening);
    if (opening && reasoningDisplay === "expanded") setExpandedSegments((current) => {
      const next = new Set(current);
      for (const id of defaultExpandedSegmentIds(segments, reasoningDisplay)) next.add(id);
      return next;
    });
  };
  const running = items.some((item) => item.state === "running");
  return <section className="reasoning-group" aria-busy={running || undefined}>
    <button type="button" className={`reasoning-disclosure ${running ? "reasoning-running" : ""}`} aria-expanded={expanded} onClick={toggleOuter}>
      <span className="reasoning-mark" aria-hidden="true"><i/><i/><i/></span>
      <span className="reasoning-label">Reasoning</span>
      <ChevronDownIcon className={expanded ? "expanded" : ""}/>
    </button>
    {expanded ? <div className="reasoning-detail">
      <div className="reasoning-category-controls" role="group" aria-label="Reasoning detail controls">
        <button type="button" disabled={!expandableThinking.length} aria-pressed={allThinkingExpanded} onClick={() => toggleCategory("thinking")}>{allThinkingExpanded ? "Collapse thinking" : "Expand thinking"}</button>
        <button type="button" disabled={!activities.length} aria-pressed={allActivitiesExpanded} onClick={() => toggleCategory("activity")}>{allActivitiesExpanded ? "Collapse tool calls" : "Expand tool calls"}</button>
      </div>
      <div className="reasoning-segments">{segments.map((segment) => segment.kind === "thinking"
        ? <ThinkingDisclosure key={segment.id} segment={segment} expanded={expandedSegments.has(segment.id)} onToggle={() => toggleSegment(segment.id)} onLinkOpen={onLinkOpen}/>
        : <ActivitySegmentDisclosure key={segment.id} segment={segment} expanded={expandedSegments.has(segment.id)} onToggle={() => toggleSegment(segment.id)}/>)}</div>
    </div> : null}
  </section>;
}

function TimelineBoundary({ label, final = false }: { label: string; final?: boolean | undefined }) {
  if (label === "Context compacted" || label === "Automatically compacted context") {
    return <div className="timeline-compaction-event timeline-compaction-completed" role="note" aria-label={label}>
      <CompactionIcon />
      <span>{label}</span>
    </div>;
  }
  return <div className={`timeline-boundary ${final ? "timeline-final-boundary" : ""}`} role="separator" aria-label={label}>
    {final ? null : <span>{label}</span>}
  </div>;
}

function QuietIssueIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v6M12 16.7h.01"/></svg>;
}

function TimelineErrorNotice({ item }: { item: TimelineItem }) {
  return <div className="timeline-error-notice" role="status" aria-live="polite">
    <QuietIssueIcon />
    <span>{timelineErrorNoticeText(item)}</span>
  </div>;
}

function ActiveCompactionStatus({ kind }: { kind: "automatic" | "manual" | null }) {
  const label = kind === "automatic" ? "Automatically compacting context…" : "Compacting context…";
  return <div className="timeline-compaction-event timeline-compaction-active" role="status" aria-live="polite" aria-label={label}>
    <CompactionIcon />
    <span>{label}</span>
  </div>;
}

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

export function ChatTimeline({ timeline, providerId, provider, reasoningDisplay = "compact", isCompacting = false, compactionKind = null, active = false, onLinkOpen, onWorkflowOpen }: {
  timeline: readonly TimelineItem[];
  providerId: ProviderId;
  provider?: Provider | undefined;
  reasoningDisplay?: ReasoningDisplay;
  isCompacting?: boolean;
  compactionKind?: "automatic" | "manual" | null;
  active?: boolean;
  onLinkOpen?: ((url: string) => void) | undefined;
  onWorkflowOpen?: ((id: string) => void) | undefined;
}) {
  const visibleTimeline = withCurrentActivity(normalizeFinalAnswerOrder(timeline), active);
  return <>{groupTimeline(visibleTimeline).map((group) => {
    if (group.kind === "boundary") return <TimelineBoundary key={group.item.id} label={group.label}/>;
    if (group.kind === "reasoning") return <ReasoningGroup key={group.items[0]?.id ?? group.reasoning.id} items={group.items} reasoningDisplay={reasoningDisplay} onLinkOpen={onLinkOpen}/>;
    if (group.item.kind === "error") return <TimelineErrorNotice key={group.item.id} item={group.item}/>;
    const finalBoundary = shouldSeparateFinalAnswer(visibleTimeline, group.index);
    const showIdentity = shouldShowAssistantIdentity(visibleTimeline, group.index);
    const card = <ChatTimelineCard key={group.item.id} item={group.item} providerId={providerId} provider={provider} showIdentity={showIdentity} copyText={showIdentity ? finalAnswerCopyText(visibleTimeline, group.index) : undefined} onLinkOpen={onLinkOpen} onWorkflowOpen={onWorkflowOpen}/>;
    return finalBoundary ? <div className="final-answer-block" key={group.item.id}><TimelineBoundary label="Final answer" final/>{card}</div> : card;
  })}{isCompacting ? <ActiveCompactionStatus kind={compactionKind} /> : null}</>;
}

export function ChatTimelineCard({ item, providerId, provider, showIdentity = true, copyText, onLinkOpen, onWorkflowOpen }: {
  item: TimelineItem;
  providerId: ProviderId;
  provider?: Provider | undefined;
  /** Set with shouldShowAssistantIdentity when rendering a complete timeline. */
  showIdentity?: boolean;
  copyText?: string | undefined;
  onLinkOpen?: ((url: string) => void) | undefined;
  onWorkflowOpen?: ((id: string) => void) | undefined;
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
    const identity = item.kind === "assistant" && showIdentity;
    const intermediate = item.kind === "assistant" && !identity;
    const progress = item.kind === "assistant" && (item.phase === "commentary" || item.state === "running");
    const footerCopyText = item.kind === "user" ? item.body.trim() : identity ? copyText : undefined;
    const footerCopyLabel = item.kind === "user" ? "Copy your message" : "Copy final answer";
    const imageGallery = item.images?.length ? <div className={`message-images ${item.kind === "user" ? "message-images-before" : ""}`}>{item.images.map((image, index) => image.dataUrl ? <button type="button" key={`${image.name}-${index}`} aria-label={`Expand ${image.name}`} onClick={() => setLightbox({ dataUrl: image.dataUrl!, name: image.name })}><img src={image.dataUrl} alt={image.name} referrerPolicy="no-referrer"/></button> : <span className="message-image-unavailable" key={`${image.name}-${index}`}><ScreenshotIcon /><span><strong>{image.name}</strong><small>Image preview was not retained in history</small></span></span>)}</div> : null;
    const workflowGallery = item.workflows?.length ? <div className="message-workflows" aria-label="Attached workflows">{item.workflows.map((workflow) => <WorkflowMessageAttachment key={workflow.id} workflow={workflow} onOpen={onWorkflowOpen}/>)}</div> : null;
    return <><article className={`message message-${item.kind} ${identity ? "message-with-identity" : "message-without-identity"} ${intermediate ? "message-intermediate" : ""} ${progress ? "message-progress" : ""}`} aria-busy={item.state === "running" || undefined}>
      <div className={item.kind === "assistant" ? "assistant-message-row" : undefined}>
      {identity ? <span className="assistant-identity" title={assistantName} aria-label={assistantName}>
        <ProviderLogo providerId={providerId} provider={provider} size={28}/>
      </span> : null}
      <div className="message-content">
        {item.origin?.kind === "cross_session" ? <p className="message-origin"><BranchIcon /><span>From another Tethoq task · {item.origin.sourceTitle || "Untitled task"}</span></p> : null}
        {workflowGallery}
        {item.kind === "user" ? imageGallery : null}
        <div className="message-body"><RichText onImageOpen={setLightbox} onLinkOpen={onLinkOpen}>{item.body}</RichText></div>
        {item.kind === "assistant" ? imageGallery : null}
        {footerCopyText ? <div className="message-footer">
          <time dateTime={item.timestamp}>{time}</time>
          <button className="copy-message" title={footerCopyLabel} aria-label={footerCopyLabel} onClick={() => void navigator.clipboard.writeText(footerCopyText)}><CopyIcon /></button>
        </div> : null}
      </div>
      </div>
    </article>{lightbox ? <div className="image-lightbox" role="dialog" aria-modal="true" aria-label={lightbox.name} onMouseDown={(event) => { if (event.target === event.currentTarget) setLightbox(null); }}><button type="button" aria-label="Close image preview" onClick={() => setLightbox(null)}><XIcon /></button><figure><img src={lightbox.dataUrl} alt={lightbox.name} referrerPolicy="no-referrer"/><figcaption>{lightbox.name}</figcaption></figure></div> : null}</>;
  }
  return <ReasoningGroup items={[item]} onLinkOpen={onLinkOpen}/>;
}
