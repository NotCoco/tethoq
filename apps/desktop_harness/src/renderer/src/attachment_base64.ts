/** A multiple of three keeps every non-final base64 chunk independently valid. */
export const attachmentBase64ChunkBytes = 48 * 1024;

function binaryString(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

/** Runs inside the attachment worker; never call this on the renderer hot path. */
export function encodeAttachmentBytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += attachmentBase64ChunkBytes) {
    chunks.push(btoa(binaryString(bytes.subarray(offset, Math.min(bytes.byteLength, offset + attachmentBase64ChunkBytes)))));
  }
  return chunks.join("");
}
