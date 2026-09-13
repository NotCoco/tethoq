import { createHash } from "node:crypto";
import { mkdir, open, realpath, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { type JsonObject, type RemoteMessage } from "../../../packages/protocol/src/index.js";
import { JsonFileStore } from "./persistence.js";

export const presentedImagePrefix = "presented_image_";
const maximumImageBytes = 25 * 1024 * 1024;
const imageChunkBytes = 480 * 1024;
const maximumImagesPerTask = 1_000;

interface PresentedImage {
  readonly id: string;
  readonly asset: string;
  readonly mimeType: string;
  readonly name: string;
  readonly caption: string;
  readonly createdAt: string;
  readonly size: number;
  readonly requestDigest: string;
}
interface ImageIndex { readonly version: 1; readonly images: readonly PresentedImage[] }

const digest = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const validId = (value: unknown): value is string => typeof value === "string" && /^presented_image_[a-f0-9]{64}$/u.test(value);
const imageTypes = ["image/png", "image/jpeg", "image/gif", "image/webp"];

function validateIndex(value: unknown): ImageIndex {
  const index = value as ImageIndex | null;
  if (index?.version !== 1 || !Array.isArray(index.images) || index.images.length > maximumImagesPerTask
    || !index.images.every(image => image && validId(image.id) && /^[a-f0-9]{64}$/u.test(image.asset)
      && /^[a-f0-9]{64}$/u.test(image.requestDigest)
      && imageTypes.includes(image.mimeType) && typeof image.name === "string" && image.name.length <= 240
      && typeof image.caption === "string" && image.caption.length <= 2_000
      && typeof image.createdAt === "string" && Number.isFinite(Date.parse(image.createdAt))
      && Number.isSafeInteger(image.size) && image.size > 0 && image.size <= maximumImageBytes)) {
    throw new Error("The task's saved image index is invalid");
  }
  return index;
}

function localPath(path: string): void {
  if (!path || path.length > 32_768 || path.includes("\0") || !isAbsolute(path)
    || path.startsWith("\\") || path.startsWith("//")
    || (process.platform === "win32" && !/^[a-z]:[\\/]/iu.test(path))) {
    throw new Error("Use an absolute local image path. Network shares and URLs are not supported by show image.");
  }
}

function imageMimeType(bytes: Buffer): string {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && bytes.toString("ascii", 12, 16) === "IHDR" && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0) return "image/png";
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 10 && /^(?:GIF87a|GIF89a)$/u.test(bytes.toString("ascii", 0, 6))) return "image/gif";
  if (bytes.length >= 16 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  throw new Error("This file is not a supported image. Show a PNG, JPEG, GIF, or WebP image.");
}

/** Images stay on disk; transcripts and events carry only small descriptors. */
export class PresentedImageStore {
  #writeTail: Promise<void> = Promise.resolve();

  public constructor(private readonly directory: string) {}

  private taskDirectory(sessionId: string): string { return join(this.directory, digest(sessionId)); }
  private index(sessionId: string): JsonFileStore<ImageIndex> {
    return new JsonFileStore(join(this.taskDirectory(sessionId), "index.json"), validateIndex);
  }

  public async present(sessionId: string, path: string, caption: string, requestId: string): Promise<RemoteMessage> {
    if (!requestId.trim() || requestId.length > 256) throw new Error("Use a unique request_id for each image presentation; reuse it only to retry that presentation.");
    if (caption.length > 2_000) throw new Error("Image caption must be at most 2000 characters");
    // Serialize reads as well as writes, bounding concurrent image allocations.
    const result = this.#writeTail.then(async () => {
      const index = this.index(sessionId);
      const current = await index.read({ version: 1, images: [] });
      const id = `${presentedImagePrefix}${digest(`${sessionId}\0${requestId}`)}`;
      const requestDigest = digest(JSON.stringify([path, caption.trim()]));
      const previous = current.images.find(image => image.id === id);
      if (previous) {
        if (previous.requestDigest !== requestDigest) throw new Error("This request_id already belongs to a different image presentation. Use a new request_id.");
        return this.message(sessionId, previous);
      }
      if (current.images.length >= maximumImagesPerTask) throw new Error("This task has reached its saved-image limit");
      localPath(path);
      const resolved = await realpath(path);
      localPath(resolved);
      const file = await open(resolved, "r");
      let bytes: Buffer;
      try {
        const before = await file.stat();
        if (!before.isFile() || before.size <= 0 || before.size > maximumImageBytes) throw new Error("Choose an image file between 1 byte and 25 MB");
        bytes = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < bytes.length) {
          const read = await file.read(bytes, offset, bytes.length - offset, offset);
          if (read.bytesRead === 0) throw new Error("The image changed while it was being saved; try again");
          offset += read.bytesRead;
        }
        const after = await file.stat();
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("The image changed while it was being saved; try again");
      } finally { await file.close(); }
      const mimeType = imageMimeType(bytes);
      const image: PresentedImage = { id, asset: digest(bytes), mimeType, size: bytes.length, requestDigest,
        name: basename(resolved).slice(0, 240), caption: caption.trim(), createdAt: new Date().toISOString() };
      const taskDirectory = this.taskDirectory(sessionId);
      await mkdir(taskDirectory, { recursive: true, mode: 0o700 });
      await writeFile(join(taskDirectory, image.asset), bytes, { flag: "wx", mode: 0o600 }).catch((error: unknown) => {
        if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
      });
      await index.write({ version: 1, images: [...current.images, image] });
      return this.message(sessionId, image);
    });
    this.#writeTail = result.then(() => undefined, () => undefined);
    return await result;
  }

  public async messages(sessionId: string): Promise<readonly RemoteMessage[]> {
    return (await this.index(sessionId).read({ version: 1, images: [] })).images.map(image => this.message(sessionId, image));
  }

  public async flush(): Promise<void> { await this.#writeTail; }

  public async chunk(sessionId: string, retrievalId: string, offset: number): Promise<JsonObject> {
    if (!validId(retrievalId)) throw new Error("Image reference is invalid");
    const image = (await this.index(sessionId).read({ version: 1, images: [] })).images.find(item => item.id === retrievalId);
    if (!image) throw new Error("This image does not belong to the requested task");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= image.size || offset % imageChunkBytes !== 0) throw new Error("Image chunk offset is invalid");
    const file = await open(join(this.taskDirectory(sessionId), image.asset), "r");
    try {
      const bytes = Buffer.alloc(Math.min(imageChunkBytes, image.size - offset));
      let readBytes = 0;
      while (readBytes < bytes.length) {
        const read = await file.read(bytes, readBytes, bytes.length - readBytes, offset + readBytes);
        if (read.bytesRead === 0) throw new Error("The saved image is incomplete");
        readBytes += read.bytesRead;
      }
      const next = offset + bytes.length;
      return { retrievalId, offset, totalBytes: image.size, dataBase64: bytes.toString("base64"),
        nextOffset: next < image.size ? next : null, mimeType: image.mimeType, name: image.name };
    } finally { await file.close(); }
  }

  private message(sessionId: string, image: PresentedImage): RemoteMessage {
    return { id: image.id, providerMessageId: image.id, sessionId, role: "assistant", createdAt: image.createdAt,
      completedAt: image.createdAt, status: "completed", nativeMetadata: { phase: "final_answer", tethoqPresentedImage: true },
      parts: [...(image.caption ? [{ type: "text" as const, text: image.caption }] : []),
        { type: "image", retrievalId: image.id, mimeType: image.mimeType, name: image.name }] };
  }
}
