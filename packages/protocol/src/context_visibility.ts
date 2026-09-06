const privateTransfers = [
  ["[[TETHOQ_BRANCH_TRANSCRIPT_BOOTSTRAP_V1]]", "[[TETHOQ_BRANCH_USER_REQUEST_V1]]"],
  ["[[TETHOQ_CONTEXT_HANDOFF_V1]]", "[[TETHOQ_CONTEXT_HANDOFF_USER_REQUEST_V1]]"],
] as const;
const privateGuidance = [
  ["<tethoq_response_guidance>", "</tethoq_response_guidance>"],
  ["<tethoq_task_goal>", "</tethoq_task_goal>"],
] as const;
const legacyGoalStart = "Tethoq persistent task goal (private control context; do not quote this block):";
const legacyGoalEnd = "Keep this objective in view across turns. The goal lifecycle is controlled by Tethoq and is independent of whether this turn is busy or finished.";

/** Readable text from old provider echoes, including an unfinished streamed envelope. */
export function visibleContextTransferText(value: string): string {
  const text = value.trimStart();
  for (const [start, endMarker] of privateGuidance) {
    if (text.startsWith(start)) {
      const end = text.indexOf(endMarker, start.length);
      return end < 0 ? "" : visibleContextTransferText(text.slice(end + endMarker.length).trimStart());
    }
    if (text.length >= 8 && start.startsWith(text)) return "";
  }
  if (text.startsWith(legacyGoalStart)) {
    const end = text.indexOf(legacyGoalEnd, legacyGoalStart.length);
    return end < 0 ? "" : visibleContextTransferText(text.slice(end + legacyGoalEnd.length).trimStart());
  }
  if (text.length >= 8 && legacyGoalStart.startsWith(text)) return "";
  for (const [start, request] of privateTransfers) {
    if (text.length >= 8 && start.startsWith(text)) return "";
    if (!text.startsWith(start)) continue;
    const boundary = `\n${request}`;
    const offset = text.indexOf(boundary, start.length);
    if (offset < 0) return "";
    const content = text.slice(offset + boundary.length);
    return content === "" || /^\r?\n/u.test(content) ? content.replace(/^\r?\n/u, "") : "";
  }
  return value;
}
