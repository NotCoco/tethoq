import { encodeAttachmentBytesToBase64 } from "./attachment_base64";

interface EncodeAttachmentRequest {
  readonly id: number;
  readonly blob: Blob;
}

interface AttachmentWorkerScope {
  addEventListener(type: "message", listener: (event: MessageEvent<EncodeAttachmentRequest>) => void): void;
  postMessage(value: { readonly id: number; readonly dataBase64?: string; readonly error?: string }): void;
}

const workerScope = self as unknown as AttachmentWorkerScope;

workerScope.addEventListener("message", (event) => {
  const { id, blob } = event.data;
  void blob.arrayBuffer().then((buffer) => {
    workerScope.postMessage({ id, dataBase64: encodeAttachmentBytesToBase64(new Uint8Array(buffer)) });
  }).catch((error: unknown) => {
    workerScope.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  });
});
