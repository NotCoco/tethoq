import { randomUUID } from "node:crypto";
import type { MessageAttachment } from "../../../packages/provider_contract/src/index.js";

export const maxAttachmentBytes = 25 * 1024 * 1024;
export const maxAttachmentChunkBytes = 192 * 1024;
export const maxPendingAttachmentUploads = 32;
export const maxMessageAttachmentBytes = 50 * 1024 * 1024;

interface Upload {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly chunks: Buffer[];
  readonly createdAt: number;
  received: number;
  complete: boolean;
}

export interface BeginAttachmentUpload {
  readonly name: string;
  readonly mimeType: string;
  readonly byteLength: number;
}

export interface AttachmentConsumption {
  readonly attachments: readonly MessageAttachment[];
  commit(): void;
  release(): void;
}

export class AttachmentUploadManager {
  readonly #uploads = new Map<string, Upload>();
  readonly #leasedUploads = new Set<string>();
  readonly #maxBufferedBytes: number;
  readonly #maxMessageBytes: number;
  readonly #now: () => number;

  public constructor(options: {
    readonly maxBufferedBytes?: number;
    readonly maxMessageBytes?: number;
    readonly now?: () => number;
  } = {}) {
    this.#maxBufferedBytes = options.maxBufferedBytes ?? 100 * 1024 * 1024;
    this.#maxMessageBytes = options.maxMessageBytes ?? maxMessageAttachmentBytes;
    this.#now = options.now ?? Date.now;
  }

  public begin(input: BeginAttachmentUpload): { readonly uploadId: string; readonly chunkBytes: number } {
    this.pruneExpired();
    validateName(input.name);
    validateMimeType(input.mimeType);
    if (!Number.isSafeInteger(input.byteLength) || input.byteLength <= 0 || input.byteLength > maxAttachmentBytes) {
      throw new Error("Attachment must be between 1 byte and 25 MiB");
    }
    if (this.#uploads.size >= maxPendingAttachmentUploads) {
      throw new Error("Too many attachment uploads are pending");
    }
    const buffered = [...this.#uploads.values()].reduce((total, upload) => total + upload.byteLength, 0);
    if (buffered + input.byteLength > this.#maxBufferedBytes) throw new Error("Attachment upload capacity is temporarily full");
    const id = `upload_${randomUUID()}`;
    this.#uploads.set(id, {
      id,
      name: input.name,
      mimeType: input.mimeType,
      byteLength: input.byteLength,
      chunks: [],
      createdAt: this.#now(),
      received: 0,
      complete: false,
    });
    return { uploadId: id, chunkBytes: maxAttachmentChunkBytes };
  }

  public append(uploadId: string, offset: number, dataBase64: string): { readonly receivedBytes: number } {
    const upload = this.require(uploadId);
    if (upload.complete) throw new Error("Attachment upload is already complete");
    if (!Number.isSafeInteger(offset) || offset !== upload.received) throw new Error("Attachment chunk offset is invalid");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64)) throw new Error("Attachment chunk is not valid base64");
    const chunk = Buffer.from(dataBase64, "base64");
    if (chunk.byteLength === 0 || chunk.byteLength > maxAttachmentChunkBytes) throw new Error("Attachment chunk size is invalid");
    if (upload.received + chunk.byteLength > upload.byteLength) throw new Error("Attachment upload exceeds its declared size");
    upload.chunks.push(chunk);
    upload.received += chunk.byteLength;
    return { receivedBytes: upload.received };
  }

  public complete(uploadId: string): { readonly attachmentId: string } {
    const upload = this.require(uploadId);
    if (upload.received !== upload.byteLength) throw new Error("Attachment upload is incomplete");
    upload.complete = true;
    return { attachmentId: upload.id };
  }

  public consume(attachmentIds: readonly string[]): AttachmentConsumption {
    if (attachmentIds.length > 4) throw new Error("A message can contain at most four attachments");
    if (new Set(attachmentIds).size !== attachmentIds.length) throw new Error("Attachment IDs must be unique");
    const uploads = attachmentIds.map((id) => {
      const upload = this.require(id);
      if (!upload.complete) throw new Error("Attachment upload is incomplete");
      if (this.#leasedUploads.has(id)) throw new Error("Attachment upload is already in use");
      return upload;
    });
    const totalBytes = uploads.reduce((total, upload) => total + upload.byteLength, 0);
    if (totalBytes > this.#maxMessageBytes) {
      throw new Error("Message attachments cannot exceed 50 MiB in total");
    }
    const attachments = uploads.map((upload): MessageAttachment => ({
      name: upload.name,
      mimeType: upload.mimeType,
      byteLength: upload.byteLength,
      dataBase64: Buffer.concat(upload.chunks, upload.byteLength).toString("base64"),
    }));
    for (const upload of uploads) this.#leasedUploads.add(upload.id);
    let settled = false;
    return {
      attachments,
      commit: () => {
        if (settled) return;
        settled = true;
        for (const upload of uploads) {
          this.#leasedUploads.delete(upload.id);
          this.#uploads.delete(upload.id);
        }
      },
      release: () => {
        if (settled) return;
        settled = true;
        for (const upload of uploads) this.#leasedUploads.delete(upload.id);
      },
    };
  }

  public discard(uploadId: string): boolean {
    this.#leasedUploads.delete(uploadId);
    return this.#uploads.delete(uploadId);
  }

  private require(uploadId: string): Upload {
    this.pruneExpired();
    const upload = this.#uploads.get(uploadId);
    if (upload === undefined) throw new Error("Attachment upload is unknown or expired");
    return upload;
  }

  private pruneExpired(): void {
    const cutoff = this.#now() - 30 * 60 * 1_000;
    for (const [id, upload] of this.#uploads) {
      if (upload.createdAt < cutoff) {
        this.#leasedUploads.delete(id);
        this.#uploads.delete(id);
      }
    }
  }
}

function validateName(name: string): void {
  if (
    name.length === 0 ||
    name.length > 255 ||
    name !== name.trim() ||
    /[\x00-\x1f\x7f]/.test(name) ||
    name.includes("/") ||
    name.includes("\\")
  ) {
    throw new Error("Attachment name is invalid");
  }
}

function validateMimeType(mimeType: string): void {
  if (mimeType.length > 127 || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(mimeType)) {
    throw new Error("Attachment MIME type is invalid");
  }
}
