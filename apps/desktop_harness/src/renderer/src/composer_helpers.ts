export interface UploadableAttachment {
  readonly name: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly dataBase64: string;
}

export interface UploadRequest {
  (type: string, payload?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface TranscriptionSource {
  readonly id: string;
  readonly label: string;
  readonly status: "ready" | "needs_credential";
  readonly setupEnvironmentVariable: string;
  readonly credential?: {
    readonly kind: "api_key";
    readonly label: string;
    readonly setupUrl: string;
  };
  readonly capabilities: {
    readonly batch: boolean;
    readonly maxAudioBytes: number;
  };
}

export const maximumMessageAttachmentBytes = 50 * 1024 * 1024;

export interface ComposerSlashCommand {
  readonly id: string;
  readonly command: string;
  readonly description: string;
}

export const composerSlashCommands: readonly ComposerSlashCommand[] = [
  {
    id: "simplify",
    command: "/simplify",
    description: "Shorten the previous or upcoming answer",
  },
];

export function slashCommandSuggestions(
  value: string,
  commands: readonly ComposerSlashCommand[] = composerSlashCommands,
): readonly ComposerSlashCommand[] | null {
  const match = /^\/([a-z0-9_-]*)$/iu.exec(value);
  if (!match) return null;
  const query = match[1]?.toLowerCase() ?? "";
  return commands.filter((item) => item.command.slice(1).toLowerCase().startsWith(query));
}

export function insertedSlashCommand(command: ComposerSlashCommand): string {
  return `${command.command} `;
}

export function appendAttachmentsWithinLimits<T extends { readonly path: string; readonly byteLength: number }>(
  current: readonly T[],
  incoming: readonly T[],
  maximumCount = 4,
  maximumBytes = maximumMessageAttachmentBytes,
): { readonly items: readonly T[]; readonly acceptedCount: number; readonly rejectedForCount: boolean; readonly rejectedForBytes: boolean } {
  const items = [...current];
  const paths = new Set(items.map((item) => item.path));
  let totalBytes = items.reduce((total, item) => total + item.byteLength, 0);
  let rejectedForCount = false;
  let rejectedForBytes = false;
  for (const item of incoming) {
    if (paths.has(item.path)) continue;
    if (items.length >= maximumCount) {
      rejectedForCount = true;
      continue;
    }
    if (totalBytes + item.byteLength > maximumBytes) {
      rejectedForBytes = true;
      continue;
    }
    items.push(item);
    paths.add(item.path);
    totalBytes += item.byteLength;
  }
  return { items, acceptedCount: items.length - current.length, rejectedForCount, rejectedForBytes };
}

export function resolveComposerModelId(
  models: readonly { readonly id: string; readonly name: string }[],
  sessionModel: string,
): string {
  return models.find((model) => model.id === sessionModel || model.name === sessionModel)?.id ?? "default";
}

const ambiguousSelectionValues = new Set(["", "auto", "default", "cli default", "session default"]);

export function isAmbiguousSelectionValue(value: string | null | undefined): boolean {
  return ambiguousSelectionValues.has(value?.trim().toLowerCase() ?? "");
}

export interface ConcreteModelSelection {
  readonly modelId: string;
  readonly reasoningEffort?: string;
}

export function resolveConcreteModelSelection(
  models: readonly { readonly id: string; readonly name: string; readonly isDefault?: boolean; readonly efforts: readonly string[]; readonly defaultEffort?: string }[],
  current: { readonly modelId?: string; readonly reasoningEffort?: string } = {},
  preferred?: { readonly modelId: string; readonly reasoningEffort?: string },
): ConcreteModelSelection | null {
  const concreteModel = !isAmbiguousSelectionValue(current.modelId)
    ? models.find((model) => model.id === current.modelId || model.name === current.modelId)
    : undefined;
  const preferredModel = preferred && !isAmbiguousSelectionValue(preferred.modelId)
    ? models.find((model) => model.id === preferred.modelId || model.name === preferred.modelId)
    : undefined;
  const model = concreteModel ?? preferredModel ?? models.find((item) => item.isDefault) ?? models[0];
  if (!model) return null;
  const supportedEfforts = model.efforts.filter((effort) => !isAmbiguousSelectionValue(effort));
  const supported = (value: string | undefined): string | undefined => {
    const concrete = !isAmbiguousSelectionValue(value) ? value?.trim() : undefined;
    return concrete && supportedEfforts.includes(concrete) ? concrete : undefined;
  };
  const currentEffort = supported(current.reasoningEffort);
  const preferredEffort = preferredModel?.id === model.id ? supported(preferred?.reasoningEffort) : undefined;
  const nativeDefault = supported(model.defaultEffort);
  const reasoningEffort = currentEffort ?? preferredEffort ?? nativeDefault ?? supportedEfforts[0];
  return { modelId: model.id, ...(reasoningEffort ? { reasoningEffort } : {}) };
}

export async function uploadAttachments(
  items: readonly UploadableAttachment[],
  request: UploadRequest,
  onUploadStarted: (uploadId: string) => void,
): Promise<readonly string[]> {
  const attachmentIds: string[] = [];
  for (const item of items) {
    const started = await request("attachment.upload.begin", {
      name: item.name,
      mimeType: item.mimeType,
      byteLength: item.byteLength,
    });
    const uploadId = typeof started.uploadId === "string" ? started.uploadId : "";
    if (!uploadId) throw new Error("The bridge did not start the attachment upload.");
    onUploadStarted(uploadId);
    const chunkBytes = typeof started.chunkBytes === "number"
      ? Math.min(192 * 1024, Math.max(32 * 1024, started.chunkBytes))
      : 192 * 1024;
    const binary = atob(item.dataBase64);
    for (let offset = 0; offset < binary.length; offset += chunkBytes) {
      const end = Math.min(binary.length, offset + chunkBytes);
      let chunk = "";
      for (let index = offset; index < end; index += 1) chunk += binary[index] ?? "";
      await request("attachment.upload.chunk", { uploadId, offset, dataBase64: btoa(chunk) });
    }
    const completed = await request("attachment.upload.complete", { uploadId });
    const attachmentId = typeof completed.attachmentId === "string" ? completed.attachmentId : "";
    if (!attachmentId) throw new Error("The bridge did not complete the attachment upload.");
    attachmentIds.push(attachmentId);
  }
  return attachmentIds;
}

export function chooseTranscriptionSource(
  sources: readonly TranscriptionSource[],
  preferredId?: string | null,
): TranscriptionSource | undefined {
  return sources.find((source) => source.id === preferredId && source.status === "ready")
    ?? sources.find((source) => source.status === "ready")
    ?? sources.find((source) => source.id === preferredId)
    ?? sources[0];
}

export function appendTranscript(content: string, transcript: string): string {
  const clean = transcript.trim();
  if (!clean) return content;
  if (!content) return clean;
  return `${content}${/\s$/.test(content) ? "" : " "}${clean}`;
}

export function growTextarea(textarea: HTMLTextAreaElement, maxHeight = 184): void {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
  textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
}

export async function blobToUploadable(blob: Blob, name = "tethoq-dictation.webm"): Promise<UploadableAttachment> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const step = 32 * 1024;
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + step)));
  }
  return {
    name,
    mimeType: blob.type.split(";")[0] || "audio/webm",
    byteLength: bytes.byteLength,
    dataBase64: btoa(binary),
  };
}
