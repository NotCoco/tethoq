import { useEffect, useState } from "react";
import { AlertIcon, ChevronDownIcon, CopyIcon, ScreenshotIcon, XIcon } from "./icons";
import { ProviderLogo, providerDisplayName } from "./components";
import { RichText } from "./RichText";
import type { Provider, ProviderId, TimelineItem } from "./types";

const routineActivityKinds = new Set<TimelineItem["kind"]>(["tool", "command", "file", "subagent", "error"]);

function isRoutineActivity(item: TimelineItem): boolean {
  return routineActivityKinds.has(item.kind);
}

/** Do not leave timestamp/copy-control shells for empty provider deltas. */
export function hasVisibleTimelineContent(item: TimelineItem): boolean {
  if (item.kind !== "user" && item.kind !== "assistant") return true;
  const body = item.body.trim();
  if (item.images?.length) return true;
  if (!body || /^<!--[\s\S]*-->$/u.test(body)) return false;
  const rawBlock = body.match(/^<([a-z][\w:-]*)\b[^>]*>[\s\S]*<\/\1>$/iu);
  return !rawBlock && !/^<[a-z][\w:-]*\b[^>]*\/?>$/iu.test(body);
}

type TimelineGroup =
  | { kind: "item"; item: TimelineItem; index: number }
  | { kind: "boundary"; item: TimelineItem; index: number; label: string }
  | { kind: "reasoning"; reasoning: TimelineItem; activities: TimelineItem[]; index: number };

const compactionNotice = /^(?:(?:context|conversation)\s+(?:was\s+|has\s+been\s+|automatically\s+)?compacted(?:\s+successfully)?|(?:automatic\s+|context\s+)?compaction\s+(?:complete|completed))[.!]?$/iu;
const systemTitle = /^(?:system|system message|system update|notice)$/iu;

/** Normalize sparse provider notices into quiet transcript boundaries. */
export function timelineBoundaryLabel(item: TimelineItem): string | null {
  if (item.kind === "user") return null;
  const title = cleanTitle(item.title ?? "");
  const body = item.body.trim();
  if ([title, body, `${title} ${body}`.trim()].some((candidate) => candidate.length <= 140 && compactionNotice.test(candidate))) return "Context compacted";
  if (systemTitle.test(title) && body.length <= 240) return body || "System update";
  if (/^\s*\[(?:system|notice)\]\s*/iu.test(body) && body.length <= 240) {
    return body.replace(/^\s*\[(?:system|notice)\]\s*/iu, "").trim() || "System update";
  }
  return null;
}

/**
 * A turn gets one identity mark when it begins and one when its final visible
 * answer arrives. Reasoning and tool artifacts never receive a provider mark.
 */
export function shouldShowAssistantIdentity(timeline: readonly TimelineItem[], index: number): boolean {
  const item = timeline[index];
  if (item?.kind !== "assistant" || !hasVisibleTimelineContent(item) || timelineBoundaryLabel(item)) return false;
  let start = index;
  while (start > 0 && timeline[start - 1]?.kind !== "user") start -= 1;
  let end = index + 1;
  while (end < timeline.length && timeline[end]?.kind !== "user") end += 1;
  const assistantIndexes: number[] = [];
  for (let cursor = start; cursor < end; cursor += 1) {
    if (timeline[cursor]?.kind === "assistant" && hasVisibleTimelineContent(timeline[cursor]!) && !timelineBoundaryLabel(timeline[cursor]!)) assistantIndexes.push(cursor);
  }
  if (index === assistantIndexes[0]) return true;
  if (item.phase === "commentary" || item.state === "running") return false;
  if (item.phase === "final_answer") return !assistantIndexes.slice(assistantIndexes.indexOf(index) + 1).some((cursor) => timeline[cursor]?.phase === "final_answer");
  if (assistantIndexes.some((cursor) => timeline[cursor]?.phase !== undefined)) return false;
  return item.state === "completed" && index === assistantIndexes.at(-1);
}

/** Keep every routine execution sequence behind one quiet reasoning control. */
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
    const activities: TimelineItem[] = [];
    let cursor = item.kind === "reasoning" ? index + 1 : index;
    while (cursor < timeline.length && isRoutineActivity(timeline[cursor]!)) {
      activities.push(timeline[cursor]!);
      cursor += 1;
    }
    const reasoning: TimelineItem = item.kind === "reasoning" ? item : {
      id: `reasoning-${item.id}`,
      kind: "reasoning",
      title: "Reasoning",
      body: "",
      state: activities.some((activity) => activity.state === "running") ? "running" : "completed",
      timestamp: item.timestamp,
    };
    groups.push({ kind: "reasoning", reasoning, activities, index });
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

function ActivityDisclosure({ item }: { item: TimelineItem }) {
  const [expanded, setExpanded] = useState(false);
  const [enlarged, setEnlarged] = useState(false);
  const label = activityLabel(item);
  const target = activityTarget(item);
  const body = readableActivityBody(item.body);
  const long = body.length > 1_600 || body.split("\n").length > 22;
  const collapse = () => { setExpanded(false); setEnlarged(false); };
  return <div className={`activity-disclosure ${item.state === "failed" ? "activity-failed" : ""}`}>
    <button type="button" className="activity-row" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
      <span className="activity-glyph"><ActivityGlyph label={label} /></span>
      <strong>{label}</strong>
      {target ? <span className="activity-target">{target}</span> : null}
      {item.state === "running" ? <span className="activity-live" aria-label="In progress" /> : null}
      <ChevronDownIcon className={expanded ? "expanded" : ""}/>
    </button>
    {expanded ? <section className={`activity-snippet ${enlarged ? "activity-snippet-enlarged" : ""}`} aria-label={`${label} details`}>
      <header>
        <strong>{label}</strong>
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

function ReasoningGroup({ reasoning, activities, onLinkOpen }: { reasoning: TimelineItem; activities: readonly TimelineItem[]; onLinkOpen?: ((url: string) => void) | undefined }) {
  const [expanded, setExpanded] = useState(false);
  return <section className="reasoning-group" aria-busy={reasoning.state === "running" || undefined}>
    <button type="button" className={`reasoning-disclosure ${reasoning.state === "running" ? "reasoning-running" : ""}`} aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
      <span className="reasoning-mark" aria-hidden="true"><i/><i/><i/></span>
      <span className="reasoning-label">Reasoning</span>
      <ChevronDownIcon className={expanded ? "expanded" : ""}/>
    </button>
    {expanded ? <div className="reasoning-detail">
      {reasoning.body.trim() ? <div className={`reasoning-flow ${reasoning.state === "running" ? "reasoning-flow-running" : ""}`}><RichText onLinkOpen={onLinkOpen}>{reasoning.body}</RichText></div> : null}
      {activities.length ? <div className="reasoning-activities">{activities.map((activity) => <ActivityDisclosure key={activity.id} item={activity}/>)}</div> : null}
    </div> : null}
  </section>;
}

function TimelineBoundary({ label, final = false }: { label: string; final?: boolean | undefined }) {
  return <div className={`timeline-boundary ${final ? "timeline-final-boundary" : ""}`} role="separator" aria-label={label}>
    {final ? null : <span>{label}</span>}
  </div>;
}

export function ChatTimeline({ timeline, providerId, provider, onLinkOpen }: {
  timeline: readonly TimelineItem[];
  providerId: ProviderId;
  provider?: Provider | undefined;
  onLinkOpen?: ((url: string) => void) | undefined;
}) {
  return <>{groupTimeline(timeline).map((group) => {
    if (group.kind === "boundary") return <TimelineBoundary key={group.item.id} label={group.label}/>;
    if (group.kind === "reasoning") return <ReasoningGroup key={group.reasoning.id} reasoning={group.reasoning} activities={group.activities} onLinkOpen={onLinkOpen}/>;
    const finalBoundary = shouldSeparateFinalAnswer(timeline, group.index);
    const card = <ChatTimelineCard key={group.item.id} item={group.item} providerId={providerId} provider={provider} showIdentity={shouldShowAssistantIdentity(timeline, group.index)} onLinkOpen={onLinkOpen}/>;
    return finalBoundary ? <div className="final-answer-block" key={group.item.id}><TimelineBoundary label="Final answer" final/>{card}</div> : card;
  })}</>;
}

export function ChatTimelineCard({ item, providerId, provider, showIdentity = true, onLinkOpen }: {
  item: TimelineItem;
  providerId: ProviderId;
  provider?: Provider | undefined;
  /** Set with shouldShowAssistantIdentity when rendering a complete timeline. */
  showIdentity?: boolean;
  onLinkOpen?: ((url: string) => void) | undefined;
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
    return <><article className={`message message-${item.kind} ${identity ? "message-with-identity" : "message-without-identity"} ${intermediate ? "message-intermediate" : ""}`} aria-busy={item.state === "running" || undefined}>
      <div className={item.kind === "assistant" ? "assistant-message-row" : undefined}>
      {identity ? <span className="assistant-identity" title={assistantName} aria-label={assistantName}>
        <ProviderLogo providerId={providerId} provider={provider} size={28}/>
      </span> : null}
      <div className="message-content">
        <div className="message-body"><RichText onImageOpen={setLightbox} onLinkOpen={onLinkOpen}>{item.body}</RichText></div>
        {item.images?.length ? <div className="message-images">{item.images.map((image, index) => image.dataUrl ? <button type="button" key={`${image.name}-${index}`} aria-label={`Expand ${image.name}`} onClick={() => setLightbox({ dataUrl: image.dataUrl!, name: image.name })}><img src={image.dataUrl} alt={image.name} referrerPolicy="no-referrer"/><span><ScreenshotIcon />Click to expand</span></button> : <span className="message-image-unavailable" key={`${image.name}-${index}`}><ScreenshotIcon /><span><strong>{image.name}</strong><small>Image preview was not retained in history</small></span></span>)}</div> : null}
        <div className="message-meta">
          <time dateTime={item.timestamp}>{time}</time>
          <button className="copy-message" title="Copy message" aria-label="Copy message" onClick={() => void navigator.clipboard.writeText(item.body)}><CopyIcon /></button>
        </div>
      </div>
      </div>
    </article>{lightbox ? <div className="image-lightbox" role="dialog" aria-modal="true" aria-label={lightbox.name} onMouseDown={(event) => { if (event.target === event.currentTarget) setLightbox(null); }}><button type="button" aria-label="Close image preview" onClick={() => setLightbox(null)}><XIcon /></button><figure><img src={lightbox.dataUrl} alt={lightbox.name} referrerPolicy="no-referrer"/><figcaption>{lightbox.name}</figcaption></figure></div> : null}</>;
  }
  if (item.kind === "reasoning") return <ReasoningGroup reasoning={item} activities={[]} onLinkOpen={onLinkOpen}/>;
  const reasoning: TimelineItem = {
    id: `reasoning-${item.id}`,
    kind: "reasoning",
    title: "Reasoning",
    body: "",
    state: item.state === "running" ? "running" : "completed",
    timestamp: item.timestamp,
  };
  return <ReasoningGroup reasoning={reasoning} activities={[item]} onLinkOpen={onLinkOpen}/>;
}
