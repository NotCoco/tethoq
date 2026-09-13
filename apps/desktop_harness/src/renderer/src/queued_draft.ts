import type { WorkflowAttachment } from "@shared/desktop_api";
import type { ComposerAttachment, ComposerDraftSnapshot } from "./Composer";
import type { SelectedAudio } from "./audio_dictation";
import { parseResponseAnnotations } from "./response_annotations";
import type { JsonObject } from "../../../../../packages/protocol/src/index";

/** Read everything before cancelling, so a missing attachment leaves the queue intact. */
export async function readQueuedComposerDraft(
  request: (type: string, payload: JsonObject) => Promise<Record<string, unknown>>,
  messageId: string,
  sessionId: string,
  workflow: (id: string) => Promise<WorkflowAttachment>,
): Promise<{ version: string; goal: boolean; draft: ComposerDraftSnapshot }> {
  const value = await request("message_queue.draft", { messageId });
  if (value.sessionId !== sessionId || typeof value.version !== "string" || typeof value.content !== "string"
    || !Array.isArray(value.attachments) || !Array.isArray(value.workflows)) throw new Error("The queued instruction could not be restored");
  const attachments: ComposerAttachment[] = [];
  for (const [index, info] of value.attachments.entries()) {
    if (!info || typeof info.name !== "string" || typeof info.mimeType !== "string" || !Number.isSafeInteger(info.byteLength)
      || info.byteLength < 0 || info.byteLength > 25 * 1024 * 1024) throw new Error("The queued attachment is unavailable");
    const total = Math.ceil(info.byteLength / 3) * 4;
    const chunks: string[] = [];
    let offset = 0;
    while (offset < total) {
      const part = await request("message_queue.draft_attachment", { messageId, version: value.version, index, offset });
      if (part.offset !== offset || part.totalCharacters !== total || typeof part.dataBase64 !== "string"
        || part.dataBase64.length === 0 || part.dataBase64.length > 480 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(part.dataBase64)) throw new Error("The queued attachment changed while loading");
      chunks.push(part.dataBase64);
      offset += part.dataBase64.length;
      if (offset > total || part.nextOffset !== (offset < total ? offset : null)) throw new Error("The queued attachment is incomplete");
    }
    const attachment = { name: info.name, mimeType: info.mimeType, byteLength: info.byteLength, dataBase64: chunks.join(""), path: `queued:${sessionId}:${messageId}:${index}` };
    attachments.push(info.mimeType === "audio/mpeg" ? { ...attachment, mimeType: "audio/mpeg", origin: "file-picker", durationSeconds: info.durationSeconds ?? 0 }
      : info.mimeType.startsWith("image/") ? attachment : { ...attachment, kind: "file" });
  }
  const workflowAttachments: WorkflowAttachment[] = [];
  for (const reference of value.workflows) {
    if (typeof reference?.id !== "string") throw new Error("The queued workflow is unavailable");
    workflowAttachments.push(await workflow(reference.id));
  }
  const parsed = parseResponseAnnotations(value.content);
  const audio = attachments.filter((item): item is SelectedAudio => item.mimeType === "audio/mpeg" && "durationSeconds" in item);
  const boundAudio = new Set<string>();
  const annotations = parsed?.annotations.map(annotation => {
    const attachment = annotation.audioAttachmentIndex === undefined ? undefined : audio[annotation.audioAttachmentIndex];
    if (annotation.audioAttachmentIndex !== undefined && !attachment) throw new Error("The queued voice annotation is unavailable");
    if (attachment) boundAudio.add(attachment.path);
    return { ...annotation, ...(attachment ? { audio: attachment } : {}) };
  }) ?? [];
  return { version: value.version, goal: value.goal === true, draft: { content: parsed?.body ?? value.content,
    attachments: attachments.filter(item => !boundAudio.has(item.path)), workflowAttachments, annotations } };
}
