import type { PairingPayload } from "@uar/protocol";

export interface PairingQrDocument {
  readonly type: "uar.pairing";
  readonly version: 1;
  readonly payload: PairingPayload;
  readonly directUrl?: string;
}

export function validatePublicBridgeUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "wss:" || url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new Error("Public bridge URL must be a wss:// address without credentials or a fragment");
  }
  return url.toString();
}

export function pairingQrText(payload: PairingPayload, directUrl?: string): string {
  const document: PairingQrDocument = {
    type: "uar.pairing",
    version: 1,
    payload,
    ...(directUrl !== undefined ? { directUrl: validatePublicBridgeUrl(directUrl) } : {}),
  };
  return JSON.stringify(document);
}
