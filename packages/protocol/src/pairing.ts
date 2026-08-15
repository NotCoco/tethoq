import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomInt,
  randomUUID,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from "node:crypto";
import type { JsonValue } from "./models.js";

export interface HostIdentity {
  readonly publicKeyPem: string;
  readonly privateKeyPem: string;
}

export interface DeviceIdentity extends HostIdentity {
  readonly deviceId: string;
}

export interface PairingPayload {
  readonly version: 1;
  readonly hostId: string;
  readonly hostPublicKeyPem: string;
  readonly pairingId: string;
  readonly secret: string;
  readonly shortCode: string;
  readonly expiresAt: string;
  readonly relayUrl?: string;
  readonly relayToken?: string;
}

interface PendingPairing {
  readonly hostId: string;
  readonly secretHash: Buffer;
  readonly shortCodeHash: Buffer;
  readonly expiresAt: number;
  readonly consumed: boolean;
  readonly deviceId?: string;
  readonly devicePublicKeyPem?: string;
  readonly credential?: SignedCredential;
}

export interface DeviceCredentialPayload {
  readonly version: 1;
  readonly credentialId: string;
  readonly hostId: string;
  readonly deviceId: string;
  readonly devicePublicKeyPem: string;
  readonly issuedAt: string;
}


export interface PairingState {
  readonly version: 1;
  readonly devices: readonly DeviceCredentialPayload[];
  readonly revokedCredentialIds: readonly string[];
}

export interface SignedCredential {
  readonly payload: string;
  readonly signature: string;
}

export interface SignedDeviceAction<T extends JsonValue = JsonValue> {
  readonly credential: SignedCredential;
  readonly actionId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly action: T;
  readonly signature: string;
}

function base64url(input: Uint8Array | string): string {
  return Buffer.from(input).toString("base64url");
}

function fromBase64url(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

/**
 * Canonical JSON shared with the Flutter client (see
 * apps/remote_client/lib/src/json.dart). Keys are sorted recursively and
 * values use the same formatting as JSON.stringify. Non-finite numbers and
 * whole numbers outside the JavaScript safe integer range are rejected so
 * both sides either sign identical bytes or fail loudly instead of
 * serializing the same value differently.
 */
export function canonicalizeJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON does not allow non-finite numbers");
    if (Number.isInteger(value) && Math.abs(value) > Number.MAX_SAFE_INTEGER) {
      throw new Error("Canonical JSON whole numbers must fit in the JavaScript safe integer range");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalizeJson(value[key] ?? null)}`).join(",")}}`;
}

function asJsonValue(value: DeviceCredentialPayload): JsonValue {
  return {
    version: value.version,
    credentialId: value.credentialId,
    hostId: value.hostId,
    deviceId: value.deviceId,
    devicePublicKeyPem: value.devicePublicKeyPem,
    issuedAt: value.issuedAt,
  };
}

export function createHostIdentity(): HostIdentity {
  const pair = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

export function createDeviceIdentity(deviceId = `device_${randomUUID()}`): DeviceIdentity {
  return { deviceId, ...createHostIdentity() };
}

function shortCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

function hashSecret(secret: Buffer): Buffer {
  return createHash("sha256").update(secret).digest();
}

function safeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function privateKey(pem: string): KeyObject | string {
  return pem;
}

function publicKey(pem: string): KeyObject | string {
  return pem;
}

export class PairingManager {
  readonly #pending = new Map<string, PendingPairing>();
  readonly #devices = new Map<string, DeviceCredentialPayload>();
  readonly #revoked = new Set<string>();

  public constructor(
    private readonly hostId: string,
    private readonly identity: HostIdentity,
    private readonly pairingTtlMs = 5 * 60 * 1_000,
    state?: PairingState,
    private readonly onStateChange?: (state: PairingState) => void,
  ) {
    if (!hostId) throw new Error("hostId is required");
    if (state !== undefined) {
      if (state.version !== 1) throw new Error("Unsupported pairing state version");
      for (const device of state.devices) {
        if (device.hostId !== hostId) throw new Error("Persisted device belongs to another host");
        this.#devices.set(device.credentialId, device);
      }
      for (const credentialId of state.revokedCredentialIds) this.#revoked.add(credentialId);
    }
  }

  public startPairing(options: { readonly relayUrl?: string; readonly relayToken?: string; readonly now?: number } = {}): PairingPayload {
    const now = options.now ?? Date.now();
    this.prune(now);
    const pairingId = `pair_${randomUUID()}`;
    const secret = randomBytes(32);
    const verificationCode = shortCode();
    this.#pending.set(pairingId, {
      hostId: this.hostId,
      secretHash: hashSecret(secret),
      shortCodeHash: hashSecret(Buffer.from(verificationCode, "utf8")),
      expiresAt: now + this.pairingTtlMs,
      consumed: false,
    });
    return {
      version: 1,
      hostId: this.hostId,
      hostPublicKeyPem: this.identity.publicKeyPem,
      pairingId,
      secret: base64url(secret),
      shortCode: verificationCode,
      expiresAt: new Date(now + this.pairingTtlMs).toISOString(),
      ...(options.relayUrl !== undefined ? { relayUrl: options.relayUrl } : {}),
      ...(options.relayToken !== undefined ? { relayToken: options.relayToken } : {}),
    };
  }

  public confirmPairing(input: {
    readonly pairingId: string;
    readonly secret: string;
    readonly shortCode: string;
    readonly deviceId: string;
    readonly devicePublicKeyPem: string;
    readonly now?: number;
  }): SignedCredential {
    const now = input.now ?? Date.now();
    this.prune(now);
    const pending = this.#pending.get(input.pairingId);
    if (pending === undefined || pending.hostId !== this.hostId) throw new Error("Pairing request is unknown or expired");
    const suppliedHash = hashSecret(fromBase64url(input.secret));
    if (!safeEqual(pending.secretHash, suppliedHash)) throw new Error("Pairing secret is invalid");
    if (!/^\d{6}$/.test(input.shortCode) || !safeEqual(
      pending.shortCodeHash,
      hashSecret(Buffer.from(input.shortCode, "utf8")),
    )) throw new Error("Pairing verification code is invalid");
    if (pending.consumed) {
      if (pending.deviceId === input.deviceId && pending.devicePublicKeyPem === input.devicePublicKeyPem && pending.credential !== undefined) return pending.credential;
      throw new Error("Pairing request has already been consumed by another device identity");
    }
    const credential: DeviceCredentialPayload = {
      version: 1,
      credentialId: `cred_${randomUUID()}`,
      hostId: this.hostId,
      deviceId: input.deviceId,
      devicePublicKeyPem: input.devicePublicKeyPem,
      issuedAt: new Date(now).toISOString(),
    };
    const signed = signCredential(credential, this.identity.privateKeyPem);
    this.#pending.set(input.pairingId, { ...pending, consumed: true, deviceId: input.deviceId, devicePublicKeyPem: input.devicePublicKeyPem, credential: signed });
    this.#devices.set(credential.credentialId, credential);
    this.onStateChange?.(this.exportState());
    return signed;
  }

  public listDevices(): readonly DeviceCredentialPayload[] {
    return [...this.#devices.values()].filter((device) => !this.#revoked.has(device.credentialId));
  }

  public revoke(credentialId: string): boolean {
    if (!this.#devices.has(credentialId)) return false;
    this.#revoked.add(credentialId);
    this.onStateChange?.(this.exportState());
    return true;
  }

  public exportState(): PairingState {
    return {
      version: 1,
      devices: [...this.#devices.values()],
      revokedCredentialIds: [...this.#revoked],
    };
  }

  public verifyCredential(credential: SignedCredential): DeviceCredentialPayload {
    const payload = verifyCredentialSignature(credential, this.identity.publicKeyPem);
    if (payload.hostId !== this.hostId) throw new Error("Credential belongs to another host");
    if (this.#revoked.has(payload.credentialId)) throw new Error("Credential has been revoked");
    const registered = this.#devices.get(payload.credentialId);
    if (registered === undefined || registered.devicePublicKeyPem !== payload.devicePublicKeyPem) {
      throw new Error("Credential is not registered on this host");
    }
    return payload;
  }

  private prune(now: number): void {
    for (const [id, pending] of this.#pending) if (pending.expiresAt <= now) this.#pending.delete(id);
  }
}

export function signCredential(payload: DeviceCredentialPayload, hostPrivateKeyPem: string): SignedCredential {
  const encoded = base64url(canonicalizeJson(asJsonValue(payload)));
  const signature = sign(null, Buffer.from(encoded), privateKey(hostPrivateKeyPem));
  return { payload: encoded, signature: base64url(signature) };
}

export function verifyCredentialSignature(credential: SignedCredential, hostPublicKeyPem: string): DeviceCredentialPayload {
  const valid = verify(null, Buffer.from(credential.payload), publicKey(hostPublicKeyPem), fromBase64url(credential.signature));
  if (!valid) throw new Error("Credential signature is invalid");
  const parsed = JSON.parse(fromBase64url(credential.payload).toString("utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null) throw new Error("Credential payload is invalid");
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1 || typeof record.credentialId !== "string" || typeof record.hostId !== "string" || typeof record.deviceId !== "string" || typeof record.devicePublicKeyPem !== "string" || typeof record.issuedAt !== "string") {
    throw new Error("Credential payload fields are invalid");
  }
  return {
    version: 1,
    credentialId: record.credentialId,
    hostId: record.hostId,
    deviceId: record.deviceId,
    devicePublicKeyPem: record.devicePublicKeyPem,
    issuedAt: record.issuedAt,
  };
}

function actionSigningInput<T extends JsonValue>(input: Omit<SignedDeviceAction<T>, "signature">): Buffer {
  return Buffer.from(canonicalizeJson({
    credential: { payload: input.credential.payload, signature: input.credential.signature },
    actionId: input.actionId,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    action: input.action,
  }));
}

export function signDeviceAction<T extends JsonValue>(input: {
  readonly credential: SignedCredential;
  readonly action: T;
  readonly devicePrivateKeyPem: string;
  readonly actionId?: string;
  readonly issuedAt?: string;
  readonly expiresAt?: string;
}): SignedDeviceAction<T> {
  const issuedAt = input.issuedAt ?? new Date().toISOString();
  const expiresAt = input.expiresAt ?? new Date(Date.parse(issuedAt) + 60_000).toISOString();
  const unsigned = {
    credential: input.credential,
    actionId: input.actionId ?? `action_${randomUUID()}`,
    issuedAt,
    expiresAt,
    action: input.action,
  };
  return {
    ...unsigned,
    signature: base64url(sign(null, actionSigningInput(unsigned), privateKey(input.devicePrivateKeyPem))),
  };
}

export function verifyActionSignature<T extends JsonValue>(signed: SignedDeviceAction<T>, devicePublicKeyPem: string): T {
  const valid = verify(null, actionSigningInput(signed), publicKey(devicePublicKeyPem), fromBase64url(signed.signature));
  if (!valid) throw new Error("Device action signature is invalid");
  return signed.action;
}

export class DeviceActionVerifier {
  readonly #replay = new Map<string, number>();

  public constructor(private readonly manager: PairingManager, private readonly maxClockSkewMs = 30_000) {}

  public verify<T extends JsonValue>(signed: SignedDeviceAction<T>, now = Date.now()): { readonly credential: DeviceCredentialPayload; readonly action: T } {
    this.prune(now);
    const credential = this.manager.verifyCredential(signed.credential);
    const issuedAt = Date.parse(signed.issuedAt);
    const expiresAt = Date.parse(signed.expiresAt);
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) throw new Error("Action timestamps are invalid");
    if (issuedAt > now + this.maxClockSkewMs) throw new Error("Action was issued too far in the future");
    if (expiresAt < now) throw new Error("Action has expired");
    if (expiresAt <= issuedAt) throw new Error("Action expiration must follow issuance");
    if (this.#replay.has(signed.actionId)) throw new Error("Action has already been used");
    const action = verifyActionSignature(signed, credential.devicePublicKeyPem);
    this.#replay.set(signed.actionId, expiresAt);
    return { credential, action };
  }

  private prune(now: number): void {
    for (const [id, expiresAt] of this.#replay) if (expiresAt < now) this.#replay.delete(id);
  }
}
