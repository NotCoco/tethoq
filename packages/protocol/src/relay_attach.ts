import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify } from "node:crypto";
import { canonicalizeJson, verifyCredentialSignature, type SignedCredential } from "./pairing.js";

/**
 * Proof that a relay attachment really comes from the computer that owns a room.
 *
 * A room's token is handed to every paired device, so possession of the token
 * cannot decide who the host is. Without this, any paired phone could attach as
 * `role: "host"`, evict the real computer, and become the room's centre. The
 * host therefore signs its attachment with the Ed25519 identity it already owns,
 * and the relay pins that key for the life of the room.
 *
 * The signature covers the room token's digest as well as the host ID, so a
 * captured attachment cannot be replayed into a room the attacker tokenised.
 */
export const RELAY_ATTACH_VERSION = 1 as const;
/** Accepted clock difference between the host and the relay. */
export const RELAY_ATTACH_SKEW_MS = 60_000;

export interface RelayHostAttachProof {
  readonly version: typeof RELAY_ATTACH_VERSION;
  readonly hostPublicKeyPem: string;
  readonly attachId: string;
  readonly issuedAt: string;
  readonly signature: string;
}

export function relayTokenDigest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function relayHostAttachBind(input: {
  readonly hostId: string;
  readonly attachId: string;
  readonly issuedAt: string;
  readonly tokenDigest: string;
}): Buffer {
  return Buffer.from(canonicalizeJson({
    purpose: "tethoq-relay-host-attach",
    version: RELAY_ATTACH_VERSION,
    hostId: input.hostId,
    attachId: input.attachId,
    issuedAt: input.issuedAt,
    tokenDigest: input.tokenDigest,
  }), "utf8");
}

export function signRelayHostAttach(input: {
  readonly hostId: string;
  readonly token: string;
  readonly hostPublicKeyPem: string;
  readonly hostPrivateKeyPem: string;
  readonly attachId?: string;
  readonly issuedAt?: string;
}): RelayHostAttachProof {
  const attachId = input.attachId ?? `attach_${randomUUID()}`;
  const issuedAt = input.issuedAt ?? new Date().toISOString();
  const signature = sign(null, relayHostAttachBind({
    hostId: input.hostId,
    attachId,
    issuedAt,
    tokenDigest: relayTokenDigest(input.token),
  }), createPrivateKey(input.hostPrivateKeyPem));
  return {
    version: RELAY_ATTACH_VERSION,
    hostPublicKeyPem: input.hostPublicKeyPem,
    attachId,
    issuedAt,
    signature: signature.toString("base64url"),
  };
}

export function parseRelayHostAttachProof(value: unknown): RelayHostAttachProof | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.version !== RELAY_ATTACH_VERSION) return null;
  const strings = ["hostPublicKeyPem", "attachId", "issuedAt", "signature"] as const;
  for (const key of strings) {
    const field = input[key];
    if (typeof field !== "string" || field.length === 0 || field.length > 4_096) return null;
  }
  return {
    version: RELAY_ATTACH_VERSION,
    hostPublicKeyPem: input.hostPublicKeyPem as string,
    attachId: input.attachId as string,
    issuedAt: input.issuedAt as string,
    signature: input.signature as string,
  };
}

/**
 * Verifies the proof itself. The caller still decides whether the presented key
 * is the one already pinned for this room; a valid signature only shows the
 * attacher holds the private key for the key it presented.
 */
export function verifyRelayHostAttach(input: {
  readonly proof: RelayHostAttachProof;
  readonly hostId: string;
  readonly token: string;
  readonly now?: number;
  readonly skewMs?: number;
}): void {
  const now = input.now ?? Date.now();
  const skewMs = input.skewMs ?? RELAY_ATTACH_SKEW_MS;
  const issuedAt = Date.parse(input.proof.issuedAt);
  if (!Number.isFinite(issuedAt)) throw new Error("Relay attachment timestamp is invalid");
  if (Math.abs(now - issuedAt) > skewMs) throw new Error("Relay attachment timestamp is outside the accepted window");
  let publicKey;
  try {
    publicKey = createPublicKey(input.proof.hostPublicKeyPem);
  } catch {
    throw new Error("Relay attachment host key is unreadable");
  }
  const valid = verify(
    null,
    relayHostAttachBind({
      hostId: input.hostId,
      attachId: input.proof.attachId,
      issuedAt: input.proof.issuedAt,
      tokenDigest: relayTokenDigest(input.token),
    }),
    publicKey,
    Buffer.from(input.proof.signature, "base64url"),
  );
  if (!valid) throw new Error("Relay attachment signature is invalid");
}

/**
 * Device attachment proof.
 *
 * The room token is the same for every device, so a token alone lets any paired
 * phone claim a sibling's device ID, evict it, and receive everything addressed
 * to it. The device therefore presents the host-signed credential it already
 * holds and signs with the key named inside it. The relay can check both,
 * because it has already pinned the host's public key for the room — no new key
 * distribution is needed, and the shared token stops carrying any authority.
 */
export interface RelayDeviceAttachProof {
  readonly version: typeof RELAY_ATTACH_VERSION;
  readonly credential: SignedCredential;
  readonly attachId: string;
  readonly issuedAt: string;
  readonly signature: string;
}

export function relayDeviceAttachBind(input: {
  readonly hostId: string;
  readonly deviceId: string;
  readonly attachId: string;
  readonly issuedAt: string;
  readonly tokenDigest: string;
}): Buffer {
  return Buffer.from(canonicalizeJson({
    purpose: "tethoq-relay-device-attach",
    version: RELAY_ATTACH_VERSION,
    hostId: input.hostId,
    deviceId: input.deviceId,
    attachId: input.attachId,
    issuedAt: input.issuedAt,
    tokenDigest: input.tokenDigest,
  }), "utf8");
}

export function signRelayDeviceAttach(input: {
  readonly hostId: string;
  readonly deviceId: string;
  readonly token: string;
  readonly credential: SignedCredential;
  readonly devicePrivateKeyPem: string;
  readonly attachId?: string;
  readonly issuedAt?: string;
}): RelayDeviceAttachProof {
  const attachId = input.attachId ?? `attach_${randomUUID()}`;
  const issuedAt = input.issuedAt ?? new Date().toISOString();
  const signature = sign(null, relayDeviceAttachBind({
    hostId: input.hostId,
    deviceId: input.deviceId,
    attachId,
    issuedAt,
    tokenDigest: relayTokenDigest(input.token),
  }), createPrivateKey(input.devicePrivateKeyPem));
  return {
    version: RELAY_ATTACH_VERSION,
    credential: input.credential,
    attachId,
    issuedAt,
    signature: signature.toString("base64url"),
  };
}

export function parseRelayDeviceAttachProof(value: unknown): RelayDeviceAttachProof | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.version !== RELAY_ATTACH_VERSION) return null;
  const credential = input.credential;
  if (typeof credential !== "object" || credential === null || Array.isArray(credential)) return null;
  const parts = credential as Record<string, unknown>;
  if (typeof parts.payload !== "string" || typeof parts.signature !== "string") return null;
  if (parts.payload.length > 4_096 || parts.signature.length > 512) return null;
  for (const key of ["attachId", "issuedAt", "signature"] as const) {
    const field = input[key];
    if (typeof field !== "string" || field.length === 0 || field.length > 512) return null;
  }
  return {
    version: RELAY_ATTACH_VERSION,
    credential: { payload: parts.payload, signature: parts.signature },
    attachId: input.attachId as string,
    issuedAt: input.issuedAt as string,
    signature: input.signature as string,
  };
}

/**
 * Proves the attaching peer is the device its credential names. Returns the
 * device ID the host actually issued rather than the one the client claimed.
 */
export function verifyRelayDeviceAttach(input: {
  readonly proof: RelayDeviceAttachProof;
  readonly hostId: string;
  readonly hostPublicKeyPem: string;
  readonly token: string;
  readonly now?: number;
  readonly skewMs?: number;
}): { readonly deviceId: string; readonly credentialId: string } {
  const now = input.now ?? Date.now();
  const skewMs = input.skewMs ?? RELAY_ATTACH_SKEW_MS;
  const issuedAt = Date.parse(input.proof.issuedAt);
  if (!Number.isFinite(issuedAt)) throw new Error("Relay attachment timestamp is invalid");
  if (Math.abs(now - issuedAt) > skewMs) throw new Error("Relay attachment timestamp is outside the accepted window");
  const credential = verifyCredentialSignature(input.proof.credential, input.hostPublicKeyPem);
  if (credential.hostId !== input.hostId) throw new Error("Relay attachment credential belongs to another host");
  let devicePublicKey;
  try {
    devicePublicKey = createPublicKey(credential.devicePublicKeyPem);
  } catch {
    throw new Error("Relay attachment device key is unreadable");
  }
  const valid = verify(
    null,
    relayDeviceAttachBind({
      hostId: input.hostId,
      deviceId: credential.deviceId,
      attachId: input.proof.attachId,
      issuedAt: input.proof.issuedAt,
      tokenDigest: relayTokenDigest(input.token),
    }),
    devicePublicKey,
    Buffer.from(input.proof.signature, "base64url"),
  );
  if (!valid) throw new Error("Relay attachment signature is invalid");
  return { deviceId: credential.deviceId, credentialId: credential.credentialId };
}
