import type { TimelineItem } from "./types";
import { visibleContextTransferText } from "../../../../../packages/protocol/src/context_visibility";
import { meshParentPrompt } from "../../../../../packages/protocol/src/mesh";

/**
 * Folds one incoming row into the transcript.
 *
 * Providers that stream send only the newest text, so those rows extend what is
 * already shown. Providers that resend the whole message replace it instead.
 */
export function mergeTimeline(existing: TimelineItem[], incoming: TimelineItem): TimelineItem[] {
  if (incoming.kind === "user" && incoming.mesh && incoming.delegationId) {
    const matches = (item: TimelineItem) => item.kind === "user"
      && (item.delegationId === incoming.delegationId
        || incoming.messageId !== undefined && item.messageId === incoming.messageId);
    const meshIndex = existing.findIndex((item) => item.kind === "user" && item.delegationId === incoming.delegationId);
    const found = meshIndex >= 0 ? meshIndex : existing.findIndex(matches);
    if (found >= 0) return existing.flatMap((item, index) => index === found
      ? [adoptCanonicalUserEcho(item, incoming)] : matches(item) ? [] : [item]);
  }
  const exact = existing.findIndex((item) => item.id === incoming.id);
  if (exact < 0 && isPendingScheduledPresentation(incoming)
    && existing.some((item) => item.kind === "user"
      && item.scheduledTaskId === incoming.scheduledTaskId
      && item.messageId !== undefined)) {
    // An explicitly retried schedule can discover that the provider accepted
    // the earlier attempt. Its canonical row already owns the presentation;
    // never paint another local copy merely because the retry acknowledged it.
    return existing;
  }
  const providerPart = exact < 0
    ? existing.findIndex((item) => sameProviderPart(item, incoming))
    : -1;
  // A newly created side chat can hydrate its canonical user row before the
  // matching message.started event crosses the live event stream. User messages
  // are one visible row, so their provider message identity is sufficient to
  // adopt that late live echo instead of painting the queued instruction twice.
  const providerUserMessage = exact < 0 && providerPart < 0 && incoming.kind === "user" && incoming.messageId !== undefined
    ? existing.findIndex((item) => item.kind === "user" && item.messageId === incoming.messageId)
    : -1;
  const persistedUserAction = exact < 0 && providerPart < 0 && providerUserMessage < 0 && incoming.kind === "user"
    ? nearestPersistedUserActionIndex(existing, incoming)
    : -1;
  const scheduledUserEcho = exact < 0 && providerPart < 0 && providerUserMessage < 0 && persistedUserAction < 0
    ? scheduledUserEchoIndex(existing, incoming)
    : -1;
  const optimisticUserEcho = exact < 0 && providerPart < 0 && providerUserMessage < 0 && persistedUserAction < 0 && scheduledUserEcho < 0
    ? optimisticUserEchoIndex(existing, incoming)
    : -1;
  const found = exact >= 0
    ? exact
    : providerPart >= 0
      ? providerPart
      : providerUserMessage >= 0
        ? providerUserMessage
        : persistedUserAction >= 0
          ? persistedUserAction
          : scheduledUserEcho >= 0 ? scheduledUserEcho : optimisticUserEcho;
  if (found >= 0) return existing.map((item, index) => {
    if (index !== found) return item;
    // A temporary Mesh history row is also an optimistic presentation; it must
    // adopt the provider identity before the persisted-row coalescing path.
    if (scheduledUserEcho >= 0 || optimisticUserEcho >= 0) return adoptCanonicalUserEcho(item, incoming);
    if (item.kind === "user" && incoming.kind === "user"
      && item.state !== "running" && item.streamDelta !== true
      && !composerEchoRow.test(item.id) && !composerEchoRow.test(incoming.id)) {
      const coalesced = coalescePersistedUserAction(item, incoming);
      return sameTimelineItem(item, coalesced) ? item : coalesced;
    }
    // A replayed batch can deliver the same event twice. Re-appending its chunk
    // would silently duplicate text inside the streaming answer.
    if (incoming.sourceEventId !== undefined && incoming.sourceEventId === item.sourceEventId) return item;
    // Chunked providers send only the newest text, so every chunk appends even
    // when two consecutive chunks happen to be identical. Providers that resend
    // the whole message keep the older replace-unless-changed behaviour.
    const appendBody = incoming.streamDelta === true
      ? sameProviderMessage(item, incoming) && (providerPart >= 0 || item.streamDelta === true || item.state === "running")
      : incoming.streamDelta === false
        ? false
        : incoming.state === "running" && item.state === "running" && incoming.body !== item.body;
    return { ...item, ...incoming, body: appendBody ? `${item.body}${incoming.body}` : incoming.body,
      ...(item.images !== undefined && incoming.images !== undefined ? { images: adoptCanonicalImages(item.images, incoming.images) } : {}) };
  });
  return [...existing, incoming];
}

/**
 * Enriches the row painted at the send boundary and adopts any provider echo
 * that raced ahead of acknowledgement. Only rows which appeared after this
 * delivery began are eligible, so an older identical prompt can never stand in
 * for a newly sent one.
 */
export function mergeAcceptedComposerRow(
  existing: readonly TimelineItem[],
  accepted: TimelineItem,
  userRowIdsBeforeDelivery: ReadonlySet<string>,
): TimelineItem[] {
  const optimisticIndex = existing.findIndex((item) => item.id === accepted.id);
  if (optimisticIndex >= 0) {
    const current = existing[optimisticIndex]!;
    const presentationId = current.presentationId ?? accepted.presentationId;
    const enriched: TimelineItem = { ...current, ...accepted, ...(presentationId ? { presentationId } : {}) };
    if (sameTimelineItem(current, enriched)) return existing as TimelineItem[];
    return existing.map((item, index) => index === optimisticIndex ? enriched : item);
  }
  for (let index = existing.length - 1; index >= 0; index -= 1) {
    const candidate = existing[index]!;
    if (candidate.kind !== "user" || userRowIdsBeforeDelivery.has(candidate.id)) continue;
    const normalEcho = optimisticUserEchoIndex([accepted], candidate) === 0;
    const attachmentOnlyEcho = !sentBody(accepted)
      && !sentBody(candidate)
      && composerRowHasVisibleAttachments(accepted)
      && attachmentDescriptorsCompatible(
        accepted.images,
        candidate.images,
        (image) => `${image.name}:${image.mimeType}`,
      )
      && attachmentDescriptorsCompatible(
        accepted.audio,
        candidate.audio,
        (audio) => `${audio.name}:${audio.mimeType}`,
      )
      && attachmentDescriptorsCompatible(
        accepted.files,
        candidate.files,
        (file) => `${file.name}:${file.mimeType}`,
      )
      && attachmentDescriptorsCompatible(
        accepted.workflows,
        candidate.workflows,
        (workflow) => workflow.id,
      )
      && withinOptimisticEchoWindow(accepted, candidate);
    if (!normalEcho && !attachmentOnlyEcho) continue;
    const adopted = adoptCanonicalUserEcho(accepted, candidate);
    if (sameTimelineItem(candidate, adopted)) return existing as TimelineItem[];
    return existing.map((item, candidateIndex) => candidateIndex === index ? adopted : item);
  }
  return [...existing, accepted];
}

/** Retracts only the local presentation owned by one failed composer delivery. */
export function rollbackOptimisticComposerRow(
  existing: readonly TimelineItem[],
  presentationId: string,
): TimelineItem[] {
  const retained = existing.filter((item) => item.id !== presentationId && item.presentationId !== presentationId);
  return retained.length === existing.length ? existing as TimelineItem[] : retained;
}

function adoptCanonicalUserEcho(local: TimelineItem, canonical: TimelineItem): TimelineItem {
  const mesh = local.mesh ?? canonical.mesh;
  const {
    queuedNewTaskDeliveryId: _localDeliveryId,
    queuedNewTaskDeliveryState: _localDeliveryState,
    queuedNewTaskDeliveryError: _localDeliveryError,
    ...localPresentation
  } = local;
  const {
    queuedNewTaskDeliveryId: _canonicalDeliveryId,
    queuedNewTaskDeliveryState: _canonicalDeliveryState,
    queuedNewTaskDeliveryError: _canonicalDeliveryError,
    ...canonicalPresentation
  } = canonical;
  return {
    ...localPresentation,
    ...canonicalPresentation,
    presentationId: canonical.mesh && !local.mesh
      ? canonical.presentationId ?? local.presentationId ?? local.id
      : local.presentationId ?? local.id,
    ...(mesh ? { mesh, body: mesh.segments.flatMap((segment) => segment.type === "text" ? [segment.text] : []).join("") } : {}),
    ...(canonical.images !== undefined || local.images !== undefined ? { images: adoptCanonicalImages(local.images, canonical.images) } : {}),
    ...(canonical.audio !== undefined || local.audio !== undefined ? { audio: adoptCanonicalAudio(local.audio, canonical.audio) } : {}),
    ...(canonical.files === undefined && local.files !== undefined ? { files: local.files } : {}),
    ...(canonical.workflows === undefined && local.workflows !== undefined ? { workflows: local.workflows } : {}),
    ...(canonical.annotations !== undefined || local.annotations !== undefined ? { annotations: adoptCanonicalAnnotations(local.annotations, canonical.annotations) } : {}),
  };
}

function adoptCanonicalImages(local: TimelineItem["images"], canonical: TimelineItem["images"]): NonNullable<TimelineItem["images"]> {
  if (canonical === undefined) return local ?? [];
  if (local === undefined) return canonical;
  const consumed = new Set<number>();
  return canonical.map((image) => {
    const index = local.findIndex((candidate, index) => !consumed.has(index)
      && candidate.name === image.name && candidate.mimeType === image.mimeType);
    if (index >= 0) consumed.add(index);
    if (image.dataUrl) return image;
    const preview = local[index];
    return preview?.dataUrl ? { ...preview, ...image, dataUrl: preview.dataUrl, loading: false } : image;
  });
}

function adoptCanonicalAudio(local: TimelineItem["audio"], canonical: TimelineItem["audio"]): NonNullable<TimelineItem["audio"]> {
  if (canonical === undefined) return local ?? [];
  if (local === undefined) return canonical;
  return canonical.map((audio) => {
    if (audio.dataUrl) return audio;
    const preview = local.find((candidate) => candidate.name === audio.name && candidate.mimeType === audio.mimeType);
    return preview?.dataUrl ? { ...audio, dataUrl: preview.dataUrl } : audio;
  });
}

function adoptCanonicalAnnotations(local: TimelineItem["annotations"], canonical: TimelineItem["annotations"]): NonNullable<TimelineItem["annotations"]> {
  if (canonical === undefined) return local ?? [];
  if (local === undefined) return canonical;
  return canonical.map((annotation) => {
    if (annotation.audio !== undefined) return annotation;
    const preview = local.find((candidate) => candidate.id === annotation.id
      || candidate.text === annotation.text && candidate.annotation === annotation.annotation);
    return preview?.audio ? { ...annotation, audio: preview.audio } : annotation;
  });
}

/** A hydrated row and its live stream can use different renderer ids for one part. */
function sameProviderPart(item: TimelineItem, incoming: TimelineItem): boolean {
  return incoming.providerPartId !== undefined
    && incoming.messageId !== undefined
    && item.providerPartId === incoming.providerPartId
    && item.messageId === incoming.messageId
    && item.kind === incoming.kind;
}

/**
 * A chunk belongs to the row it is extending.
 *
 * Rows are usually keyed by a provider part id, which is unique, but a provider
 * that names no part shares one fallback row per kind. Requiring the same
 * provider message is what stops a later turn's first chunk from being glued to
 * the end of the previous turn's text on those shared rows.
 */
function sameProviderMessage(item: TimelineItem, incoming: TimelineItem): boolean {
  if (item.messageId === undefined || incoming.messageId === undefined) return true;
  return item.messageId === incoming.messageId;
}

/**
 * Closes every live row of a finished turn so only genuinely current work animates.
 *
 * Settling stops the animation; it does not change how the row was built. A slow
 * model goes quiet for longer than the catch-up threshold between two chunks, and
 * an idle report arriving in that gap used to strip the streaming marker as well —
 * after which the next chunk was treated as a whole new body and threw away every
 * word the thought had produced so far. The text only reappeared when the finished
 * transcript reloaded, which is why live reasoning looked like it was missing most
 * of itself on a slow provider and correct on a fast one.
 */
export function settleRunningTimeline(
  items: readonly TimelineItem[],
  terminalState: "completed" | "failed" = "completed",
): TimelineItem[] {
  if (!items.some((item) => item.state === "running" && item.kind !== "subagent")) return items as TimelineItem[];
  return items.map((item) => item.state === "running" && item.kind !== "subagent" ? { ...item, state: terminalState } : item);
}


/** A local row painted only after delivery acceptance, before the harness echoes it back. */
const composerEchoRow = /^local-\d+$/u;
const maximumOptimisticEchoSkewMs = 120_000;
const maximumPersistedUserEchoSkewMs = 100;
const maximumScheduledEventContentCharacters = 180;
const scheduledEventContentPrefixCharacters = 177;

function withinOptimisticEchoWindow(left: TimelineItem, right: TimelineItem): boolean {
  const leftAt = Date.parse(left.timestamp) || 0;
  const rightAt = Date.parse(right.timestamp) || 0;
  return Math.abs(leftAt - rightAt) <= maximumOptimisticEchoSkewMs;
}

function composerRowHasVisibleAttachments(item: TimelineItem): boolean {
  return (item.images?.length ?? 0) > 0
    || (item.audio?.length ?? 0) > 0
    || (item.files?.length ?? 0) > 0
    || (item.workflows?.length ?? 0) > 0;
}

/** Attachment notes are added for the reader and are not part of what was sent. */
function sentBody(item: TimelineItem): string {
  const body = visibleContextTransferText(item.body).split(/\n\nAttached file:/u)[0]!.trim();
  if (body) return body;
  return item.annotations?.length
    ? `annotations:${JSON.stringify(item.annotations.map(({ text, annotation }) => ({ text, annotation })))}`
    : "";
}

function audioOnlyComposerEcho(item: TimelineItem): boolean {
  return item.kind === "user"
    && composerEchoRow.test(item.id)
    && !sentBody(item)
    && (item.audio?.length ?? 0) > 0;
}

function emptyCanonicalUser(item: TimelineItem): boolean {
  return item.kind === "user" && !sentBody(item);
}

function optimisticUserEchoIndex(existing: readonly TimelineItem[], incoming: TimelineItem): number {
  if (incoming.kind !== "user" || composerEchoRow.test(incoming.id)) return -1;
  if (incoming.delegationId) {
    const meshIndex = existing.findIndex((item) => item.kind === "user" && item.delegationId === incoming.delegationId);
    if (meshIndex >= 0) return meshIndex;
  }
  const body = sentBody(incoming);
  const incomingAt = Date.parse(incoming.timestamp) || 0;
  for (let index = existing.length - 1; index >= 0; index -= 1) {
    const candidate = existing[index]!;
    if (candidate.delegationId && incoming.delegationId && candidate.delegationId !== incoming.delegationId) continue;
    const sameText = body && (sentBody(candidate) === body
      || candidate.mesh && meshParentPrompt(candidate.mesh.targets, candidate.mesh.segments).trim() === body);
    const audioOnly = !body && emptyCanonicalUser(incoming) && audioOnlyComposerEcho(candidate);
    const attachmentOnly = !body
      && emptyCanonicalUser(incoming)
      && composerRowHasVisibleAttachments(candidate)
      && composerRowHasVisibleAttachments(incoming)
      && persistedUserAttachmentsCompatible(candidate, incoming);
    const pendingMesh = candidate.mesh && candidate.messageId?.startsWith("tethoq-mesh:");
    if (candidate.kind !== "user" || (!composerEchoRow.test(candidate.id) && !pendingMesh) || (!sameText && !audioOnly && !attachmentOnly)) continue;
    const candidateAt = Date.parse(candidate.timestamp) || 0;
    if (Math.abs(incomingAt - candidateAt) <= maximumOptimisticEchoSkewMs) return index;
  }
  return -1;
}

/**
 * A schedule replay carries only a bounded prompt preview, while provider
 * history returns the full accepted prompt. The durable schedule marker makes
 * that deliberate prefix mismatch eligible to adopt exactly one local row.
 */
function scheduledUserEchoIndex(existing: readonly TimelineItem[], incoming: TimelineItem): number {
  if (incoming.kind !== "user" || composerEchoRow.test(incoming.id) || incoming.messageId === undefined) return -1;
  const incomingBody = sentBody(incoming);
  const incomingAt = Date.parse(incoming.timestamp);
  if (!incomingBody || !Number.isFinite(incomingAt)) return -1;
  for (let index = existing.length - 1; index >= 0; index -= 1) {
    const candidate = existing[index]!;
    if (!isPendingScheduledPresentation(candidate)) continue;
    if (incoming.scheduledTaskId !== undefined && incoming.scheduledTaskId !== candidate.scheduledTaskId) continue;
    const candidateBody = sentBody(candidate);
    const exactBody = candidateBody === incomingBody;
    // Reproduce the Bridge's exact preview transformation from the canonical
    // body. A normal prompt which happens to end in an ellipsis is not a preview
    // and must not become a wildcard for a different provider message.
    const boundedPreview = incomingBody.length > maximumScheduledEventContentCharacters
      && candidateBody === `${incomingBody.slice(0, scheduledEventContentPrefixCharacters).trimEnd()}…`;
    if (!exactBody && !boundedPreview) continue;
    const candidateAt = Date.parse(candidate.timestamp);
    if (!Number.isFinite(candidateAt)) continue;
    const sameScheduledTask = incoming.scheduledTaskId !== undefined
      && incoming.scheduledTaskId === candidate.scheduledTaskId;
    // Text alone is only safe near dispatch. An explicit scheduled-task marker
    // may identify an older accepted attempt, while an unmarked same-text row
    // from hours ago can be an unrelated manual provider turn.
    if (sameScheduledTask || Math.abs(incomingAt - candidateAt) <= maximumOptimisticEchoSkewMs) return index;
  }
  return -1;
}

function isPendingScheduledPresentation(item: TimelineItem): boolean {
  return item.kind === "user"
    && composerEchoRow.test(item.id)
    && item.id === item.presentationId
    && item.scheduledTaskId !== undefined
    && item.messageId === undefined;
}

/**
 * Has the harness echoed this row back to us yet?
 *
 * Your message appears the moment you send it, under an id this app invents, and
 * the harness later returns the same message under an id of its own. Nothing about
 * the two rows matches - not the id, and not the message id, which the invented row
 * has never had - so both survived the reconcile and your message sat on screen
 * twice. The echo has to be at least as new as the row it replaces, or sending the
 * same words twice would let the older copy stand in for the newer one.
 */
function echoedBackIndex(
  page: readonly TimelineItem[],
  row: TimelineItem,
  consumed?: ReadonlySet<number>,
): number {
  const sentAt = Date.parse(row.timestamp) || 0;
  let nearest = -1;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < page.length; index += 1) {
    if (consumed?.has(index)) continue;
    if (scheduledUserEchoIndex([row], page[index]!) === 0) return index;
    if (optimisticUserEchoIndex([row], page[index]!) !== 0) continue;
    const itemAt = Date.parse(page[index]!.timestamp) || 0;
    if (itemAt < sentAt - maximumOptimisticEchoSkewMs) continue;
    const distance = Math.abs(itemAt - sentAt);
    if (distance < nearestDistance) {
      nearest = index;
      nearestDistance = distance;
    }
  }
  return nearest;
}
function timelineSemanticKey(item: TimelineItem): string | null {
  if (item.messageId && (item.kind === "user" || item.kind === "assistant" || item.kind === "reasoning")) return `${item.kind}:${item.messageId}`;
  if (item.kind === "command" && item.messageId) return `command:${item.messageId}`;
  if (item.kind === "tool" && item.detail) return `tool:${item.detail}`;
  return null;
}

/** Codex can rename one persisted user action after its completion record lands. */
function attachmentDescriptorsCompatible<T>(
  left: readonly T[] | undefined,
  right: readonly T[] | undefined,
  describe: (value: T) => string,
): boolean {
  if (!left?.length || !right?.length) return true;
  if (left.length !== right.length) return false;
  const leftDescriptions = left.map(describe).sort();
  const rightDescriptions = right.map(describe).sort();
  return leftDescriptions.every((value, index) => value === rightDescriptions[index]);
}

function persistedUserAttachmentsCompatible(left: TimelineItem, right: TimelineItem): boolean {
  return attachmentDescriptorsCompatible(left.images, right.images, (image) => `${image.name}:${image.mimeType ?? ""}`)
    && attachmentDescriptorsCompatible(left.audio, right.audio, (audio) => `${audio.name}:${audio.mimeType}`)
    && attachmentDescriptorsCompatible(left.files, right.files, (file) => `${file.name}:${file.mimeType ?? ""}`)
    && attachmentDescriptorsCompatible(left.workflows, right.workflows, (workflow) => workflow.id)
    && attachmentDescriptorsCompatible(left.annotations, right.annotations, (annotation) => `${annotation.text}:${annotation.annotation}`);
}

function samePersistedUserAction(left: TimelineItem, right: TimelineItem): boolean {
  if (left.kind !== "user" || right.kind !== "user" || composerEchoRow.test(left.id) || composerEchoRow.test(right.id)) return false;
  if (left.delegationId && right.delegationId && left.delegationId !== right.delegationId) return false;
  if (sentBody(left) !== sentBody(right) || !persistedUserAttachmentsCompatible(left, right)) return false;
  const leftTurnId = left.turnId?.trim();
  const rightTurnId = right.turnId?.trim();
  if (leftTurnId && rightTurnId) {
    if (leftTurnId !== rightTurnId) return false;
    // Codex's canonical completion and response record can reach the renderer
    // through different paths and at very different wall-clock times. Their
    // shared turn plus opposite canonical markers is the trustworthy join.
    if (left.canonicalUserMessage !== right.canonicalUserMessage
      && (left.canonicalUserMessage === true || right.canonicalUserMessage === true)) return true;
  }
  const leftAt = Date.parse(left.timestamp);
  const rightAt = Date.parse(right.timestamp);
  return Number.isFinite(leftAt) && Number.isFinite(rightAt)
    && Math.abs(leftAt - rightAt) <= maximumPersistedUserEchoSkewMs;
}

function nearestPersistedUserActionIndex(
  items: readonly TimelineItem[],
  target: TimelineItem,
  consumed?: ReadonlySet<number>,
): number {
  const targetAt = Date.parse(target.timestamp);
  let nearest = -1;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < items.length; index += 1) {
    if (consumed?.has(index) || !samePersistedUserAction(items[index]!, target)) continue;
    const candidateAt = Date.parse(items[index]!.timestamp);
    const distance = Number.isFinite(targetAt) && Number.isFinite(candidateAt)
      ? Math.abs(targetAt - candidateAt)
      : index;
    if (distance <= nearestDistance) {
      nearest = index;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function mergeDescribedCollections<T>(
  preferred: readonly T[] | undefined,
  secondary: readonly T[] | undefined,
  describe: (value: T) => string,
  merge: (preferredValue: T, secondaryValue: T) => T,
): T[] | undefined {
  if (!preferred?.length) return secondary ? [...secondary] : undefined;
  if (!secondary?.length) return [...preferred];
  const secondaryByDescription = new Map(secondary.map((value) => [describe(value), value]));
  const result = preferred.map((value) => {
    const other = secondaryByDescription.get(describe(value));
    if (other === undefined) return value;
    secondaryByDescription.delete(describe(value));
    return merge(value, other);
  });
  return [...result, ...secondaryByDescription.values()];
}

function coalescePersistedUserAction(left: TimelineItem, right: TimelineItem): TimelineItem {
  const preferred = right.canonicalUserMessage === true && left.canonicalUserMessage !== true ? right : left;
  const secondary = preferred === left ? right : left;
  const images = mergeDescribedCollections(
    preferred.images,
    secondary.images,
    (image) => `${image.name}:${image.mimeType ?? ""}`,
    (image, other) => ({
      ...other,
      ...image,
      ...(image.dataUrl || other.dataUrl ? { dataUrl: image.dataUrl || other.dataUrl } : {}),
      ...((image.dataUrl || other.dataUrl) ? { loading: false } : {}),
    }),
  );
  const audio = mergeDescribedCollections(
    preferred.audio,
    secondary.audio,
    (clip) => `${clip.name}:${clip.mimeType}`,
    (clip, other) => ({
      ...other,
      ...clip,
      dataUrl: clip.dataUrl || other.dataUrl,
      ...((clip.durationSeconds ?? other.durationSeconds) !== undefined
        ? { durationSeconds: clip.durationSeconds ?? other.durationSeconds }
        : {}),
      ...(clip.dictation === true || other.dictation === true ? { dictation: true } : {}),
    }),
  );
  const files = mergeDescribedCollections(
    preferred.files,
    secondary.files,
    (file) => `${file.name}:${file.mimeType ?? ""}`,
    (file, other) => ({ ...other, ...file }),
  );
  const workflows = mergeDescribedCollections(
    preferred.workflows,
    secondary.workflows,
    (workflow) => workflow.id,
    (workflow, other) => ({
      ...other,
      ...workflow,
      eventCount: Math.max(workflow.eventCount, other.eventCount),
      screenshotCount: Math.max(workflow.screenshotCount, other.screenshotCount),
      ...(workflow.applications?.length || other.applications?.length
        ? { applications: [...new Set([...(workflow.applications ?? []), ...(other.applications ?? [])])] }
        : {}),
    }),
  );
  const annotations = mergeDescribedCollections(
    preferred.annotations,
    secondary.annotations,
    (annotation) => `${annotation.text}:${annotation.annotation}`,
    (annotation, other) => ({
      ...other,
      ...annotation,
      ...(annotation.audio ?? other.audio ? { audio: annotation.audio ?? other.audio } : {}),
      ...((annotation.audioAttachmentIndex ?? other.audioAttachmentIndex) !== undefined
        ? { audioAttachmentIndex: annotation.audioAttachmentIndex ?? other.audioAttachmentIndex }
        : {}),
    }),
  );
  return {
    ...secondary,
    ...preferred,
    ...((right.presentationId ?? left.presentationId) ? { presentationId: right.presentationId ?? left.presentationId } : {}),
    ...(images ? { images } : {}),
    ...(audio ? { audio } : {}),
    ...(files ? { files } : {}),
    ...(workflows ? { workflows } : {}),
    ...(annotations ? { annotations } : {}),
  };
}

/** Stable identity for the first row the reader has chosen to keep revealed. */
export function timelineRevealAnchorKey(item: TimelineItem): string {
  if (item.messageId && item.providerPartId) return `part:${item.kind}:${item.messageId}:${item.providerPartId}`;
  if (item.messageId) return `message:${item.kind}:${item.messageId}`;
  return `id:${item.id}`;
}

/** Resolve a reader-owned reveal boundary after rows before it are reconciled. */
export function anchoredTimelineRevealStart(
  items: readonly TimelineItem[],
  fallbackStart: number,
  anchorKey?: string | null,
): number {
  if (anchorKey) {
    const anchored = items.findIndex((item) => timelineRevealAnchorKey(item) === anchorKey);
    if (anchored >= 0) return anchored;
  }
  return Math.max(0, Math.min(fallbackStart, items.length));
}

function completedFinalAnswer(item: TimelineItem): boolean {
  return item.kind === "assistant"
    && !item.presentationOnly
    && item.phase === "final_answer"
    && item.state !== "running"
    && item.body.trim().length > 0;
}

function terminalFailure(item: TimelineItem): boolean {
  return item.kind === "error" && item.state === "failed" && item.body.trim().length > 0;
}

function toolSnapshotScore(item: TimelineItem): number {
  const terminal = item.state === "completed" || item.state === "failed" ? 1_000_000 : 0;
  const body = item.body.trim();
  const placeholder = /^(?:tool (?:started|output|completed)|running|pending|completed with no output|failed without additional output)[.…!]*$/iu.test(body);
  return terminal + (placeholder ? 0 : body.length) + (item.title?.trim().length ?? 0);
}

/**
 * History and live events are two views of the same OpenCode tool part. Keep the
 * richer snapshot, let a terminal snapshot close a stale running one, and retain
 * the live row id so React never tears down the row while it is being enriched.
 */
function reconcileToolSnapshot(target: TimelineItem, liveItem: TimelineItem): TimelineItem | null {
  if (target.kind !== "tool" || liveItem.kind !== "tool") return null;
  const preferred = toolSnapshotScore(target) > toolSnapshotScore(liveItem) ? target : liveItem;
  return preferred === liveItem ? liveItem : { ...liveItem, ...target, id: liveItem.id };
}

function sameOptionalJson(left: unknown, right: unknown): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

/** Preserve React identity when a canonical refresh contains no visible change. */
function sameTimelineItem(left: TimelineItem, right: TimelineItem): boolean {
  return left === right || (
    left.id === right.id
    && left.presentationId === right.presentationId
    && left.scheduledTaskId === right.scheduledTaskId
    && left.queuedNewTaskDeliveryId === right.queuedNewTaskDeliveryId
    && left.queuedNewTaskDeliveryState === right.queuedNewTaskDeliveryState
    && left.queuedNewTaskDeliveryError === right.queuedNewTaskDeliveryError
    && left.messageId === right.messageId
    && left.providerPartId === right.providerPartId
    && left.turnId === right.turnId
    && left.canonicalUserMessage === right.canonicalUserMessage
    && left.kind === right.kind
    && left.phase === right.phase
    && left.title === right.title
    && left.body === right.body
    && left.detail === right.detail
    && left.notice === right.notice
    && left.state === right.state
    && left.delegationId === right.delegationId
    && left.childSessionId === right.childSessionId
    && left.childProviderId === right.childProviderId
    && left.childModelId === right.childModelId
    && left.childReasoningEffort === right.childReasoningEffort
    && left.childInterruptedAt === right.childInterruptedAt
    && left.childStatusUpdatedAt === right.childStatusUpdatedAt
    && left.timestamp === right.timestamp
    && left.streamDelta === right.streamDelta
    && left.sourceEventId === right.sourceEventId
    && sameOptionalJson(left.images, right.images)
    && sameOptionalJson(left.mesh, right.mesh)
    && sameOptionalJson(left.audio, right.audio)
    && sameOptionalJson(left.files, right.files)
    && sameOptionalJson(left.workflows, right.workflows)
    && sameOptionalJson(left.annotations, right.annotations)
    && sameOptionalJson(left.origin, right.origin)
  );
}

/** Add deferred image previews without replacing live text, state, or row identity. */
function mergeHydratedImages(
  current: NonNullable<TimelineItem["images"]>,
  incoming: NonNullable<TimelineItem["images"]>,
): NonNullable<TimelineItem["images"]> {
  const merged = current.map((image) => ({ ...image }));
  const consumed = new Set<number>();
  for (let incomingIndex = 0; incomingIndex < incoming.length; incomingIndex += 1) {
    const next = incoming[incomingIndex]!;
    let currentIndex = merged.findIndex((image, index) => !consumed.has(index)
      && image.name === next.name
      && (image.mimeType ?? "") === (next.mimeType ?? "")
      && (image.retrievalId === undefined || next.retrievalId === undefined || image.retrievalId === next.retrievalId));
    if (currentIndex < 0 && incomingIndex < merged.length && !consumed.has(incomingIndex)) currentIndex = incomingIndex;
    if (currentIndex < 0) {
      merged.push({ ...next });
      consumed.add(merged.length - 1);
      continue;
    }
    consumed.add(currentIndex);
    const existing = merged[currentIndex]!;
    if (existing.retrievalId !== undefined && next.retrievalId !== undefined && existing.retrievalId !== next.retrievalId) continue;
    const readyDataUrl = existing.retrievalId !== undefined && existing.retrievalId === next.retrievalId
      ? next.dataUrl ?? existing.dataUrl : existing.dataUrl ?? next.dataUrl;
    merged[currentIndex] = {
      ...existing,
      ...next,
      ...(readyDataUrl ? { dataUrl: readyDataUrl, loading: false } : {}),
      ...(!readyDataUrl && (existing.loading === false || next.loading !== true) ? { loading: false } : {}),
    };
  }
  return merged;
}

export function mergeTimelineImageHydration(
  timeline: readonly TimelineItem[],
  hydratedPage: readonly TimelineItem[],
): TimelineItem[] {
  const hydratedRows = hydratedPage.filter((item) => item.images?.length);
  if (hydratedRows.length === 0) return timeline as TimelineItem[];
  const rowIndexesById = new Map(hydratedRows.map((item, index) => [item.id, index] as const));
  const consumedHydratedRows = new Set<number>();
  let changed = false;
  const merged = timeline.map((item) => {
    if (item.images?.length === 0) return item;
    let hydratedIndex = rowIndexesById.get(item.id) ?? -1;
    if (hydratedIndex < 0 && item.kind === "user") {
      hydratedIndex = nearestPersistedUserActionIndex(hydratedRows, item, consumedHydratedRows);
    }
    if (hydratedIndex < 0 || consumedHydratedRows.has(hydratedIndex)) return item;
    const images = hydratedRows[hydratedIndex]?.images;
    if (images === undefined) return item;
    consumedHydratedRows.add(hydratedIndex);
    const nextImages = mergeHydratedImages(item.images ?? [], images);
    if (sameOptionalJson(item.images, nextImages)) return item;
    changed = true;
    return { ...item, images: nextImages };
  });
  return changed ? merged : timeline as TimelineItem[];
}

/** A failed canonical read must not leave an image placeholder claiming to load forever. */
export function settleTimelineImagePlaceholders(timeline: readonly TimelineItem[]): TimelineItem[] {
  let changed = false;
  const settled = timeline.map((item) => {
    if (!item.images?.some((image) => image.loading === true)) return item;
    changed = true;
    return {
      ...item,
      images: item.images.map((image) => image.loading === true ? { ...image, loading: false } : image),
    };
  });
  return changed ? settled : timeline as TimelineItem[];
}

/** Keep live rows that authoritative provider history has not caught up with yet. */
export function reconcileTimelinePage(page: readonly TimelineItem[], live: readonly TimelineItem[]): TimelineItem[] {
  // A retried/reordered history response may contain the same canonical row
  // twice. Remove exact provider identities before reconciling with live state,
  // otherwise one delayed final answer is painted twice even though the store
  // itself contains only one message.
  const deduplicatedPage: TimelineItem[] = [];
  for (const item of page) {
    const exactIndex = deduplicatedPage.findIndex((candidate) => candidate.id === item.id);
    if (exactIndex >= 0) {
      if (deduplicatedPage[exactIndex]!.kind === "user" && item.kind === "user") {
        deduplicatedPage[exactIndex] = coalescePersistedUserAction(deduplicatedPage[exactIndex]!, item);
      }
      continue;
    }
    const actionIndex = item.kind === "user" ? nearestPersistedUserActionIndex(deduplicatedPage, item) : -1;
    if (actionIndex >= 0) {
      deduplicatedPage[actionIndex] = coalescePersistedUserAction(deduplicatedPage[actionIndex]!, item);
      continue;
    }
    deduplicatedPage.push(item);
  }
  const merged = [...deduplicatedPage];
  const consumedPageIndexes = new Set<number>();
  const pageTimes = deduplicatedPage.map((item) => Date.parse(item.timestamp) || 0);
  const oldestPageTime = pageTimes.length ? Math.min(...pageTimes) : 0;
  const newestPageTime = pageTimes.length ? Math.max(...pageTimes) : 0;
  const adopt = (target: TimelineItem, liveItem: TimelineItem): TimelineItem => {
    // A refreshed page may defer the same image again after cache eviction or
    // reconnection. Keep its decoded preview mounted while those bytes arrive.
    if (liveItem.images !== undefined) target = { ...target, images: adoptCanonicalImages(liveItem.images, target.images) };
    if (audioOnlyComposerEcho(liveItem) && emptyCanonicalUser(target)) {
      return {
        ...liveItem,
        ...target,
        ...(target.audio === undefined && liveItem.audio !== undefined ? { audio: liveItem.audio } : {}),
      };
    }
    const toolSnapshot = reconcileToolSnapshot(target, liveItem);
    if (toolSnapshot !== null) return toolSnapshot;
    if (liveItem.state === "running") {
      const body = liveItem.streamDelta !== false
        && liveItem.kind === "reasoning" && target.kind === "reasoning" && target.body.length > liveItem.body.length
        ? target.body
        : liveItem.body;
      return { ...target, ...liveItem, body };
    }
    // History can hold a shorter copy of a finished thought (storage keeps a
    // summary where the live stream carried every word). Never let a reconcile
    // shrink what was already fully shown.
    if (liveItem.kind === "reasoning" && target.kind === "reasoning" && liveItem.body.length > target.body.length) {
      return { ...target, body: liveItem.body };
    }
    return target;
  };
  const nextPageIndex = (predicate: (item: TimelineItem) => boolean): number => {
    for (let index = 0; index < deduplicatedPage.length; index += 1) {
      if (!consumedPageIndexes.has(index) && predicate(deduplicatedPage[index]!)) return index;
    }
    return -1;
  };
  const unmatched: TimelineItem[] = [];
  for (const liveItem of live) {
    if (liveItem.kind === "user") {
      // The same canonical Mesh row may replace both its local presentation and
      // a raw provider echo left by an earlier refresh. These are identity joins,
      // so consuming one alias must not prevent the other from being retired.
      const meshIndex = deduplicatedPage.findIndex((item) => item.kind === "user" && item.mesh
        && (liveItem.delegationId !== undefined && item.delegationId === liveItem.delegationId
          || liveItem.messageId !== undefined && item.messageId === liveItem.messageId));
      if (meshIndex >= 0) {
        consumedPageIndexes.add(meshIndex);
        merged[meshIndex] = adoptCanonicalUserEcho(liveItem, merged[meshIndex]!);
        continue;
      }
    }
    // Once the harness has returned your message, the row this app invented to show
    // it immediately has done its job. Adopt the provider identity without
    // replacing the mounted card or its ready local image preview.
    if (liveItem.kind === "user"
      && (composerEchoRow.test(liveItem.id) || liveItem.mesh && liveItem.messageId?.startsWith("tethoq-mesh:"))
      && !audioOnlyComposerEcho(liveItem)) {
      const echoIndex = echoedBackIndex(deduplicatedPage, liveItem, consumedPageIndexes);
      if (echoIndex >= 0) {
        consumedPageIndexes.add(echoIndex);
        merged[echoIndex] = adoptCanonicalUserEcho(liveItem, merged[echoIndex]!);
        continue;
      }
    }
    let pageIndex = nextPageIndex((item) => item.id === liveItem.id);
    if (pageIndex < 0 && liveItem.providerPartId) {
      pageIndex = nextPageIndex((item) => item.providerPartId === liveItem.providerPartId);
    }
    if (pageIndex < 0) {
      const semanticKey = timelineSemanticKey(liveItem);
      if (semanticKey) pageIndex = nextPageIndex((item) => timelineSemanticKey(item) === semanticKey);
    }
    if (pageIndex < 0 && liveItem.kind === "user") {
      pageIndex = nearestPersistedUserActionIndex(deduplicatedPage, liveItem, consumedPageIndexes);
    }
    if (pageIndex < 0 && completedFinalAnswer(liveItem)) {
      const liveAt = Date.parse(liveItem.timestamp) || 0;
      pageIndex = nextPageIndex((item) => completedFinalAnswer(item)
        && item.body === liveItem.body
        && Math.abs((Date.parse(item.timestamp) || 0) - liveAt) <= maximumOptimisticEchoSkewMs);
    }
    if (pageIndex < 0 && terminalFailure(liveItem)) {
      const liveAt = Date.parse(liveItem.timestamp) || 0;
      pageIndex = nextPageIndex((item) => terminalFailure(item)
        && item.body === liveItem.body
        && Math.abs((Date.parse(item.timestamp) || 0) - liveAt) <= maximumOptimisticEchoSkewMs);
    }
    if (pageIndex < 0 && audioOnlyComposerEcho(liveItem)) {
      const liveAt = Date.parse(liveItem.timestamp) || 0;
      pageIndex = nextPageIndex((item) => emptyCanonicalUser(item)
        && Math.abs((Date.parse(item.timestamp) || 0) - liveAt) <= maximumOptimisticEchoSkewMs);
    }
    if (pageIndex >= 0) {
      consumedPageIndexes.add(pageIndex);
      merged[pageIndex] = merged[pageIndex]!.kind === "user" && liveItem.kind === "user"
        && !composerEchoRow.test(merged[pageIndex]!.id) && !composerEchoRow.test(liveItem.id)
        ? coalescePersistedUserAction(merged[pageIndex]!, liveItem)
        : adopt(merged[pageIndex]!, liveItem);
      continue;
    }
    unmatched.push(liveItem);
  }
  for (const liveItem of unmatched) {
    const liveTime = Date.parse(liveItem.timestamp) || 0;
    const keep = !deduplicatedPage.length
      || composerEchoRow.test(liveItem.id)
      // A newest-page refresh is only a partial view of canonical history. It
      // must never treat an already hydrated user action as stale merely because
      // that action fell just outside the refreshed page (or its byte budget).
      // Canonical echoes still replace their matching row above, and local
      // composer echoes are still removed once the provider returns them.
      || liveItem.kind === "user"
      || liveItem.state === "running"
      || completedFinalAnswer(liveItem)
      || liveTime > newestPageTime
      || liveTime < oldestPageTime;
    // A settled transient row inside the page's canonical time window has been
    // superseded by that page. Only current/newer rows and genuinely older paged
    // history survive, otherwise stale reasoning shells accumulate forever.
    if (!keep) continue;
    let insertIndex = 0;
    while (insertIndex < merged.length && (Date.parse(merged[insertIndex]!.timestamp) || 0) <= liveTime) insertIndex += 1;
    merged.splice(insertIndex, 0, liveItem);
  }
  const previousById = new Map(live.map((item) => [item.id, item]));
  const stable = merged.map((item) => {
    const previous = previousById.get(item.id);
    return previous && sameTimelineItem(previous, item) ? previous : item;
  });
  return stable.length === live.length && stable.every((item, index) => item === live[index])
    ? live as TimelineItem[]
    : stable;
}
