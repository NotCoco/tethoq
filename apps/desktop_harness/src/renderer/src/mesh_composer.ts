import type { MeshTarget } from "./Composer";

// Private-use characters exist only in the editable view. Drafts and provider
// requests retain plain text and separate target positions.
const markerPattern = /[\uE000-\uF8FF]/gu;

export function meshTargetRoute({ providerId, modelId, reasoningEffort }: MeshTarget) {
  return { providerId, ...(modelId ? { modelId } : {}), ...(reasoningEffort ? { reasoningEffort } : {}) };
}

export function anchorMeshTargets(targets: readonly MeshTarget[]): readonly MeshTarget[] {
  const used = new Set(targets.map((target) => target.composerToken));
  let code = 0xE000;
  return targets.map((target) => {
    if (target.composerToken) return target;
    while (used.has(String.fromCharCode(code))) code += 1;
    const composerToken = String.fromCharCode(code++);
    used.add(composerToken);
    return { ...target, composerToken, offset: target.offset ?? 0 };
  });
}

export function moveMeshTargets(before: string, after: string, targets: readonly MeshTarget[]): readonly MeshTarget[] {
  if (before === after) return targets;
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let oldEnd = before.length;
  let newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd -= 1; newEnd -= 1; }
  return targets.map((target) => {
    const offset = target.offset ?? 0;
    return { ...target, offset: offset <= start ? offset : offset >= oldEnd ? offset + newEnd - oldEnd : start };
  });
}

export function meshDraftParts(content: string, targets: readonly MeshTarget[]) {
  const parts: ({ text: string } | { target: MeshTarget; targetIndex: number })[] = [];
  let cursor = 0;
  const ordered = targets.map((target, targetIndex) => ({ target, targetIndex }))
    .sort((left, right) => (left.target.offset ?? 0) - (right.target.offset ?? 0));
  for (const item of ordered) {
    const offset = Math.max(cursor, Math.min(content.length, item.target.offset ?? 0));
    if (offset > cursor) parts.push({ text: content.slice(cursor, offset) });
    parts.push(item);
    cursor = offset;
  }
  if (cursor < content.length) parts.push({ text: content.slice(cursor) });
  return parts;
}

export function meshEditorValue(content: string, targets: readonly MeshTarget[]): string {
  return meshDraftParts(content, targets).map((part) => "text" in part ? part.text : part.target.composerToken).join("");
}

export function readMeshEditorValue(value: string, knownTargets: readonly MeshTarget[]) {
  const targets: MeshTarget[] = [];
  let removed = 0;
  const content = value.replace(markerPattern, (token: string, index: number) => {
    const target = knownTargets.find((candidate) => candidate.composerToken === token);
    if (!target) return token;
    if (!targets.some((candidate) => candidate.composerToken === token)) targets.push({ ...target, offset: index - removed });
    removed += token.length;
    return "";
  });
  return { content, targets };
}
