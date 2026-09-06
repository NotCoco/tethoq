import type { JsonObject } from "../../../../../packages/protocol/src/index";
import type { DesktopEventBatch } from "@shared/desktop_api";
import { demoSnapshot } from "./demo";
import type { DesktopSnapshot, Session, TimelineItem } from "./types";

const promoHashes = new Set(["#promo-dashboard", "#promo-live", "#promo-mesh", "#promo-eyes"]);
const promoParentSessionId = "promo-atlas";
const promoChildSessionId = "promo-grok-review";

export const isPromoPreview = promoHashes.has(globalThis.location?.hash ?? "");

const isoAgo = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();

function promoInterfaceImage(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#111311"/><stop offset="1" stop-color="#080908"/></linearGradient><linearGradient id="chart" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#69d7a7"/><stop offset="1" stop-color="#98f2c3"/></linearGradient></defs>
  <rect width="1280" height="720" rx="34" fill="url(#bg)"/><rect x="34" y="34" width="230" height="652" rx="22" fill="#171917" stroke="#303530"/>
  <circle cx="78" cy="82" r="18" fill="#76dfa9"/><rect x="112" y="67" width="102" height="13" rx="6" fill="#ecf1ed"/><rect x="112" y="91" width="72" height="9" rx="4" fill="#737b75"/>
  <rect x="58" y="148" width="172" height="48" rx="12" fill="#252a26"/><rect x="76" y="166" width="112" height="11" rx="5" fill="#dce4de"/>
  <g fill="#666e68"><rect x="76" y="230" width="126" height="10" rx="5"/><rect x="76" y="278" width="142" height="10" rx="5"/><rect x="76" y="326" width="108" height="10" rx="5"/><rect x="76" y="374" width="132" height="10" rx="5"/></g>
  <text x="310" y="86" fill="#f2f5f2" font-family="Segoe UI,Arial" font-size="34" font-weight="700">Launch dashboard</text><text x="310" y="119" fill="#818983" font-family="Segoe UI,Arial" font-size="16">A clear view of today, without the clutter.</text>
  <rect x="310" y="158" width="604" height="330" rx="22" fill="#151815" stroke="#323732"/><text x="346" y="204" fill="#dfe6e0" font-family="Segoe UI,Arial" font-size="18" font-weight="600">Weekly activity</text>
  <path d="M350 412 C420 392 446 318 512 334 S620 412 690 308 S814 274 872 218" fill="none" stroke="url(#chart)" stroke-width="10" stroke-linecap="round"/>
  <g fill="#2b302c"><rect x="346" y="438" width="120" height="8" rx="4"/><rect x="486" y="438" width="120" height="8" rx="4"/><rect x="626" y="438" width="120" height="8" rx="4"/><rect x="766" y="438" width="110" height="8" rx="4"/></g>
  <rect x="938" y="158" width="308" height="154" rx="22" fill="#151815" stroke="#323732"/><text x="970" y="204" fill="#858e87" font-family="Segoe UI,Arial" font-size="15">ACTIVE TASKS</text><text x="970" y="270" fill="#f0f4f0" font-family="Segoe UI,Arial" font-size="48" font-weight="700">12</text>
  <rect x="938" y="334" width="308" height="154" rx="22" fill="#151815" stroke="#323732"/><text x="970" y="380" fill="#858e87" font-family="Segoe UI,Arial" font-size="15">NEEDS ATTENTION</text><text x="970" y="446" fill="#f0f4f0" font-family="Segoe UI,Arial" font-size="48" font-weight="700">2</text>
  <rect x="310" y="520" width="936" height="132" rx="22" fill="#151815" stroke="#323732"/><circle cx="356" cy="566" r="12" fill="#76dfa9"/><rect x="386" y="554" width="300" height="16" rx="8" fill="#e0e6e1"/><rect x="386" y="586" width="516" height="11" rx="5" fill="#707872"/><rect x="1068" y="552" width="142" height="46" rx="14" fill="#eef2ee"/>
  </svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

function baseSessions(primary: Session): Session[] {
  return [primary,
    { id: "promo-onboarding", providerId: "opencode", title: "Tighten onboarding copy", state: "completed", project: "Northstar", workingDirectory: "C:\\Demo\\Northstar", preview: "Reduced the first-run flow to one confident next action.", updatedAt: isoAgo(18), model: "DeepSeek V4", effort: "High" },
    { id: "promo-search", providerId: "grok", title: "Improve search ranking", state: "completed", project: "Beacon", workingDirectory: "C:\\Demo\\Beacon", preview: "The ranking signals are simpler and the regression set passes.", updatedAt: isoAgo(43), model: "Grok 4.6", effort: "High" },
    { id: "promo-checkout", providerId: "codex", title: "Add checkout coverage", state: "completed", project: "Market", workingDirectory: "C:\\Demo\\Market", preview: "Added the high-value browser paths and kept the suite fast.", updatedAt: isoAgo(71), model: "GPT-5.6 Terra", effort: "High" },
    { id: "promo-release", providerId: "opencode", title: "Prepare release notes", state: "completed", project: "Northstar", workingDirectory: "C:\\Demo\\Northstar", preview: "The customer-facing changes are grouped and ready to publish.", updatedAt: isoAgo(126), model: "DeepSeek V4", effort: "High" },
    { id: "promo-api", providerId: "grok", title: "Trace API latency", state: "completed", project: "Beacon", workingDirectory: "C:\\Demo\\Beacon", preview: "Found the slow edge and narrowed the fix to one cache boundary.", updatedAt: isoAgo(184), model: "Grok 4.6", effort: "Extra high" },
  ];
}

function primarySession(state: Session["state"], title = "Polish the launch dashboard"): Session {
  return {
    id: promoParentSessionId,
    providerId: "codex",
    title,
    state,
    project: "Atlas",
    workingDirectory: "C:\\Demo\\Atlas",
    preview: state === "working" ? "Refining the interface and checking the final interaction details." : "The launch view is clean, readable, and ready for a focused review.",
    updatedAt: isoAgo(2),
    model: "GPT-5.6 Sol",
    effort: "Ultra",
  };
}

function meshTimeline(): TimelineItem[] {
  return [{
    id: "promo-mesh-user-existing",
    messageId: "promo-mesh-existing-turn",
    kind: "user",
    body: "Make the launch dashboard feel fast and easy to scan.",
    timestamp: isoAgo(9),
    state: "completed",
  }, {
    id: "promo-mesh-answer-existing",
    messageId: "promo-mesh-existing-turn",
    kind: "assistant",
    phase: "final_answer",
    body: "The core hierarchy is in place. I kept the task rail compact and moved secondary controls behind deliberate reveals.",
    timestamp: isoAgo(7),
    state: "completed",
  }];
}

function liveTimeline(): TimelineItem[] {
  return [{ id: "promo-live-user", messageId: "promo-live-turn", kind: "user", body: "Polish the dashboard and verify the keyboard flow.", timestamp: isoAgo(11), state: "completed" },
    { id: "promo-live-reasoning", messageId: "promo-live-turn", kind: "reasoning", title: "Checking the interface hierarchy", body: "The main surface is already calm. I am tightening the final alignment and preserving the quick keyboard path.", timestamp: isoAgo(4), state: "running" },
    { id: "promo-live-read", messageId: "promo-live-turn", kind: "tool", title: "Read interface structure", body: "Reviewed the dashboard, task rail, composer, and command surfaces.", detail: "Interface review", timestamp: isoAgo(3), state: "completed" },
    { id: "promo-live-command", messageId: "promo-live-turn", kind: "command", title: "Run desktop checks", body: "npm run typecheck && npm test", detail: "C:\\Demo\\Atlas", timestamp: isoAgo(2), state: "running" },
    { id: "promo-live-file", messageId: "promo-live-turn", kind: "file", title: "Refined dashboard layout", body: "src/renderer/Dashboard.tsx\nsrc/renderer/dashboard.css", detail: "+42 -18", timestamp: isoAgo(1), state: "completed" }];
}

function eyesTimeline(): TimelineItem[] {
  return [{
    id: "promo-eyes-user",
    messageId: "promo-eyes-turn",
    kind: "user",
    body: "Use EYES to inspect this interface and flag the first thing you would simplify.",
    images: [{ name: "launch-dashboard.png", mimeType: "image/svg+xml", dataUrl: promoInterfaceImage() }],
    timestamp: isoAgo(5),
    state: "completed",
  }, {
    id: "promo-eyes-reasoning",
    messageId: "promo-eyes-turn",
    kind: "reasoning",
    title: "Routing visual evidence",
    body: "The task is using its configured visual-support model to inspect the attached interface.",
    timestamp: isoAgo(4),
    state: "completed",
  }, {
    id: "promo-eyes-tool",
    messageId: "promo-eyes-turn",
    kind: "tool",
    title: "EYES · Grok 4.6",
    body: "Inspected launch-dashboard.png and returned a visual hierarchy review.",
    detail: "Visual support completed",
    timestamp: isoAgo(3),
    state: "completed",
  }, {
    id: "promo-eyes-final",
    messageId: "promo-eyes-turn",
    kind: "assistant",
    phase: "final_answer",
    body: "EYES inspected the attached interface. The chart hierarchy is clear; I would merge the duplicate summary cards and keep the primary action unboxed.",
    timestamp: isoAgo(2),
    state: "completed",
  }];
}

function createPromoSnapshot(): DesktopSnapshot {
  const snapshot = structuredClone(demoSnapshot);
  snapshot.providers = snapshot.providers.filter((provider) => ["codex", "opencode", "grok", "direct"].includes(provider.id));
  snapshot.models = Object.fromEntries(Object.entries(snapshot.models).filter(([providerId]) => snapshot.providers.some((provider) => provider.id === providerId)));
  snapshot.approvals = [];
  snapshot.inputRequests = [];
  snapshot.goals = {};
  snapshot.goalClearRevisions = {};
  if (location.hash === "#promo-live") {
    const primary = primarySession("working", "Finish the dashboard interaction pass");
    snapshot.sessions = baseSessions(primary);
    snapshot.timelines = { [primary.id]: liveTimeline() };
    return snapshot;
  }
  if (location.hash === "#promo-eyes") {
    const primary = { ...primarySession("completed", "Review the launch interface with EYES"), providerId: "opencode", model: "DeepSeek V4", effort: "High", preview: "EYES confirmed the visual hierarchy and identified the first simplification." };
    snapshot.sessions = baseSessions(primary);
    snapshot.timelines = { [primary.id]: eyesTimeline() };
    return snapshot;
  }
  const primary = primarySession(location.hash === "#promo-dashboard" ? "working" : "completed");
  snapshot.sessions = baseSessions(primary);
  snapshot.timelines = { [primary.id]: meshTimeline() };
  return snapshot;
}

let runtimeSnapshot = isPromoPreview ? createPromoSnapshot() : null;
let eventSink: ((batch: DesktopEventBatch) => void) | null = null;
let eventSequence = 0;
let meshStarted = false;
const promoTimers: number[] = [];

function emit(events: Array<{ type: string; providerId: string; sessionId: string; payload: JsonObject }>): void {
  if (!eventSink) return;
  const occurredAt = new Date().toISOString();
  const normalized = events.map((event) => {
    const sequence = ++eventSequence;
    return {
      sequence,
      eventId: `promo-${sequence}`,
      type: event.type,
      hostId: "desktop-preview",
      providerId: event.providerId,
      sessionId: event.sessionId,
      occurredAt,
      payload: event.payload,
    } as DesktopEventBatch["events"][number];
  });
  eventSink({ latestSequence: eventSequence, replayGap: false, events: normalized });
}

function replaceSession(sessionId: string, update: Partial<Session>): void {
  if (!runtimeSnapshot) return;
  runtimeSnapshot.sessions = runtimeSnapshot.sessions.map((session) => session.id === sessionId ? { ...session, ...update } : session);
}

function setTimelineItem(sessionId: string, item: TimelineItem): void {
  if (!runtimeSnapshot) return;
  const timeline = runtimeSnapshot.timelines[sessionId] ?? [];
  const index = timeline.findIndex((candidate) => candidate.id === item.id);
  runtimeSnapshot.timelines[sessionId] = index < 0
    ? [...timeline, item]
    : timeline.map((candidate, candidateIndex) => candidateIndex === index ? item : candidate);
}

function schedule(delay: number, action: () => void): void {
  promoTimers.push(window.setTimeout(action, delay));
}

export function startPromoMesh(payload: JsonObject): Record<string, unknown> {
  if (!runtimeSnapshot || meshStarted) return { accepted: true, childSessionId: promoChildSessionId };
  meshStarted = true;
  const prompt = typeof payload.prompt === "string" && payload.prompt.trim() ? payload.prompt.trim() : "Audit the dashboard and remove visual clutter.";
  const startedAt = new Date().toISOString();
  const parent = runtimeSnapshot.sessions.find((session) => session.id === promoParentSessionId) ?? primarySession("completed");
  const child: Session = {
    id: promoChildSessionId,
    sessionKind: "task",
    parentSessionId: promoParentSessionId,
    relationshipKind: "subagent",
    relationshipSourceSessionId: promoParentSessionId,
    agentNickname: "Grok interface review",
    agentRole: "Visual reviewer",
    providerId: "grok",
    title: "Audit dashboard visual hierarchy",
    state: "working",
    project: parent.project,
    workingDirectory: parent.workingDirectory,
    preview: "Reading the interface and identifying the first high-value simplification.",
    updatedAt: startedAt,
    model: "Grok 4.6",
    effort: "Extra high",
  };
  runtimeSnapshot.sessions = [parent, child, ...runtimeSnapshot.sessions.filter((session) => session.id !== parent.id && session.id !== child.id)];
  replaceSession(parent.id, { state: "working", childCount: 1, childProviderIds: ["grok"], preview: prompt, updatedAt: startedAt });
  setTimelineItem(parent.id, { id: `${parent.id}:user:promo-mesh-user`, messageId: "promo-mesh-user", kind: "user", body: prompt, timestamp: startedAt, state: "completed" });
  setTimelineItem(parent.id, { id: `${parent.id}:delegation:promo-mesh-delegation`, kind: "subagent", title: "Delegated agent", body: "Grok 4.6 is reviewing the dashboard.", timestamp: startedAt, state: "running" });
  runtimeSnapshot.timelines[child.id] = [{ id: `${child.id}:user:promo-child-user`, messageId: "promo-child-user", kind: "user", body: prompt, timestamp: startedAt, state: "completed", origin: { kind: "delegation", sender: "tethoq" } }];
  emit([
    { type: "message.started", providerId: "codex", sessionId: parent.id, payload: { messageId: "promo-mesh-user", role: "user", text: prompt } },
    { type: "delegation.started", providerId: "codex", sessionId: parent.id, payload: { id: "promo-mesh-delegation", text: "Grok 4.6 is reviewing the dashboard." } },
    { type: "session.created", providerId: "grok", sessionId: child.id, payload: { session: child as unknown as JsonObject } },
  ]);

  schedule(420, () => {
    const timestamp = new Date().toISOString();
    setTimelineItem(child.id, { id: `${child.id}:reasoning:promo-child-reasoning`, messageId: "promo-child-turn", providerPartId: "promo-child-reasoning", kind: "reasoning", title: "Reasoning", body: "Inspecting hierarchy, repeated signals, and the primary action...", timestamp, state: "running", streamDelta: true });
    emit([{ type: "message.delta", providerId: "grok", sessionId: child.id, payload: { messageId: "promo-child-turn", partId: "promo-child-reasoning", role: "assistant", reasoning: true, text: "Inspecting hierarchy, repeated signals, and the primary action..." } }]);
  });
  schedule(1_050, () => {
    const timestamp = new Date().toISOString();
    setTimelineItem(child.id, { id: `${child.id}:reasoning:promo-child-reasoning`, messageId: "promo-child-turn", providerPartId: "promo-child-reasoning", kind: "reasoning", title: "Reasoning", body: "The main chart reads immediately. The duplicate summary cards compete with the one action that matters.", timestamp, state: "running", streamDelta: false });
    emit([{ type: "message.delta", providerId: "grok", sessionId: child.id, payload: { messageId: "promo-child-turn", partId: "promo-child-reasoning", role: "assistant", reasoning: true, replace: true, text: "The main chart reads immediately. The duplicate summary cards compete with the one action that matters." } }]);
  });
  schedule(1_620, () => {
    const timestamp = new Date().toISOString();
    setTimelineItem(child.id, { id: `${child.id}:tool:promo-interface-read`, messageId: "promo-child-turn", kind: "tool", title: "Read interface structure", body: "Compared the chart, summary cards, task rail, and primary action.", detail: "Visual hierarchy", timestamp, state: "completed" });
    emit([{ type: "tool.completed", providerId: "grok", sessionId: child.id, payload: { id: "promo-interface-read", name: "Read interface structure", text: "Compared the chart, summary cards, task rail, and primary action." } }]);
  });
  schedule(2_240, () => {
    const timestamp = new Date().toISOString();
    const finalBody = "The hierarchy is strong. I would merge the duplicate status cards, keep the activity total unboxed, and let the primary action carry the focus.";
    setTimelineItem(child.id, { id: `${child.id}:assistant:promo-child-final`, messageId: "promo-child-turn", providerPartId: "promo-child-final", kind: "assistant", phase: "final_answer", body: finalBody, timestamp, state: "completed" });
    replaceSession(child.id, { state: "completed", preview: finalBody, updatedAt: timestamp });
    setTimelineItem(parent.id, { id: `${parent.id}:delegation:promo-mesh-delegation`, kind: "subagent", title: "Delegated agent", body: "Grok 4.6 completed the interface review.", timestamp, state: "completed" });
    setTimelineItem(parent.id, { id: `${parent.id}:assistant:promo-mesh-parent-final`, messageId: "promo-mesh-parent-final", kind: "assistant", phase: "final_answer", body: "Grok 4.6 finished the review. Open the child task to see its focused visual-hierarchy recommendation.", timestamp, state: "completed" });
    replaceSession(parent.id, { state: "completed", preview: "Grok 4.6 finished the interface review.", updatedAt: timestamp });
    emit([
      { type: "message.completed", providerId: "grok", sessionId: child.id, payload: { messageId: "promo-child-turn", partId: "promo-child-final", role: "assistant", phase: "final_answer", text: finalBody } },
      { type: "session.updated", providerId: "grok", sessionId: child.id, payload: { state: "completed", modelId: "grok-4.6", reasoningEffort: "xhigh" } },
      { type: "delegation.completed", providerId: "codex", sessionId: parent.id, payload: { id: "promo-mesh-delegation", text: "Grok 4.6 completed the interface review." } },
      { type: "message.completed", providerId: "codex", sessionId: parent.id, payload: { messageId: "promo-mesh-parent-final", role: "assistant", phase: "final_answer", text: "Grok 4.6 finished the review. Open the child task to see its focused visual-hierarchy recommendation." } },
      { type: "session.updated", providerId: "codex", sessionId: parent.id, payload: { state: "completed" } },
    ]);
  });
  return { accepted: true, childSessionId: child.id };
}

export function promoSnapshot(): DesktopSnapshot | null {
  return runtimeSnapshot ? structuredClone(runtimeSnapshot) : null;
}

export function promoSessions(): Session[] | null {
  return runtimeSnapshot ? structuredClone(runtimeSnapshot.sessions) : null;
}

export function promoTimeline(sessionId: string): TimelineItem[] | null {
  return runtimeSnapshot ? structuredClone(runtimeSnapshot.timelines[sessionId] ?? []) : null;
}

export function promoChildren(sessionId: string): Session[] | null {
  return runtimeSnapshot ? structuredClone(runtimeSnapshot.sessions.filter((session) => session.parentSessionId === sessionId && session.relationshipKind === "subagent")) : null;
}

export function subscribePromoPreview(listener: (batch: DesktopEventBatch) => void): () => void {
  eventSink = listener;
  return () => {
    if (eventSink === listener) eventSink = null;
    for (const timer of promoTimers.splice(0)) window.clearTimeout(timer);
  };
}
