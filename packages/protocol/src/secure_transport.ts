import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomUUID,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from "node:crypto";
import { canonicalizeJson, verifyCredentialSignature, type SignedCredential } from "./pairing.js";

/**
 * End-to-end encryption for the bridge transport.
 *
 * The relay forwards opaque payloads but terminates TLS, so a relay operator or
 * anyone who compromises that host can read task titles and message text in
 * flight. This layer removes the relay from the trust boundary: each connection
 * agrees a fresh key directly between the computer and the paired device.
 *
 * Ephemeral X25519 keys give forward secrecy, and each side signs its ephemeral
 * key with the Ed25519 identity it already owns from pairing — the host with its
 * host identity, the device with the key inside its host-signed credential. No
 * new pairing material is required, so existing pairings keep working.
 *
 * Routing fields stay in clear text because the relay needs them; only the
 * bridge envelope itself is encrypted.
 */

export const SECURE_TRANSPORT_SCHEME = "x25519-hkdf-sha256-aes256gcm" as const;
export const SECURE_TRANSPORT_VERSION = 1 as const;

const HKDF_HASH = "sha256";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const RAW_X25519_BYTES = 32;
/** DER prefix for an X25519 SubjectPublicKeyInfo, so raw 32-byte keys can cross the wire. */
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
/** AES-GCM must never repeat a (key, nonce) pair; a session is closed long before this. */
const MAX_FRAME_COUNTER = 2 ** 48;
/** One decrypt allocation ceiling, matched to the relay's own payload limit. */
export const MAX_SECURE_FRAME_BYTES = 8 * 1024 * 1024;

export type SecureTransportRole = "host" | "device";

export interface SecureHandshakeOffer {
  readonly scheme: typeof SECURE_TRANSPORT_SCHEME;
  readonly version: typeof SECURE_TRANSPORT_VERSION;
  /** Base64url raw 32-byte X25519 public key, fresh for this connection. */
  readonly ephemeralPublicKey: string;
  /** Base64url Ed25519 signature over the canonical bind for this offer. */
  readonly signature: string;
}

export interface SecureHandshakeAccept extends SecureHandshakeOffer {
  readonly kind: "secure_handshake";
  /** The host-signed credential naming the device key that signed this accept. */
  readonly credential: SignedCredential;
  readonly deviceId: string;
}

export interface SecureFrame {
  readonly kind: "secure";
  /** Frame counter for this direction, used as the AES-GCM nonce and as AAD. */
  readonly counter: number;
  /** Base64url ciphertext with its appended GCM tag. */
  readonly ciphertext: string;
}

function base64url(input: Uint8Array): string {
  return Buffer.from(input).toString("base64url");
}

function fromBase64url(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function rawX25519PublicKey(key: KeyObject): Buffer {
  const spki = key.export({ type: "spki", format: "der" });
  return Buffer.from(spki.subarray(spki.length - RAW_X25519_BYTES));
}

export function importX25519PublicKey(raw: Buffer): KeyObject {
  if (raw.length !== RAW_X25519_BYTES) throw new Error("An X25519 public key must be 32 bytes");
  return createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

export interface EphemeralKeyPair {
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject;
}

export function createEphemeralKeyPair(): EphemeralKeyPair {
  return generateKeyPairSync("x25519");
}

/**
 * The exact bytes each side signs. Every value that identifies the session is
 * covered, so a relay cannot substitute its own ephemeral key: the device's
 * signature commits to the host key it actually received, and the host's
 * signature commits to the key it actually sent.
 */
export function handshakeBind(input: {
  readonly role: SecureTransportRole;
  readonly hostId: string;
  readonly deviceId?: string;
  readonly hostEphemeralPublicKey: string;
  readonly deviceEphemeralPublicKey?: string;
}): Buffer {
  return Buffer.from(canonicalizeJson({
    purpose: "tethoq-secure-transport-handshake",
    scheme: SECURE_TRANSPORT_SCHEME,
    version: SECURE_TRANSPORT_VERSION,
    role: input.role,
    hostId: input.hostId,
    deviceId: input.deviceId ?? null,
    hostEphemeralPublicKey: input.hostEphemeralPublicKey,
    deviceEphemeralPublicKey: input.deviceEphemeralPublicKey ?? null,
  }), "utf8");
}

export interface SecureTransportKeys {
  readonly hostToDevice: Buffer;
  readonly deviceToHost: Buffer;
}

/**
 * Both ephemeral public keys are folded into the HKDF salt, so a session key is
 * only reachable by the two parties that chose those keys. Each direction gets
 * its own key so a reflected frame can never decrypt.
 */
export function deriveSecureTransportKeys(input: {
  readonly sharedSecret: Buffer;
  readonly hostId: string;
  readonly deviceId: string;
  readonly hostEphemeralPublicKey: string;
  readonly deviceEphemeralPublicKey: string;
}): SecureTransportKeys {
  if (input.sharedSecret.length !== KEY_BYTES) throw new Error("The shared secret must be 32 bytes");
  const salt = createHash(HKDF_HASH).update(canonicalizeJson({
    purpose: "tethoq-secure-transport-salt",
    scheme: SECURE_TRANSPORT_SCHEME,
    version: SECURE_TRANSPORT_VERSION,
    hostId: input.hostId,
    deviceId: input.deviceId,
    hostEphemeralPublicKey: input.hostEphemeralPublicKey,
    deviceEphemeralPublicKey: input.deviceEphemeralPublicKey,
  })).digest();
  const derive = (label: string): Buffer =>
    Buffer.from(hkdfSync(HKDF_HASH, input.sharedSecret, salt, Buffer.from(label, "utf8"), KEY_BYTES));
  return {
    hostToDevice: derive("tethoq-secure-transport-v1:host-to-device"),
    deviceToHost: derive("tethoq-secure-transport-v1:device-to-host"),
  };
}

export function secureSharedSecret(privateKey: KeyObject, peerPublicKey: KeyObject): Buffer {
  return diffieHellman({ privateKey, publicKey: peerPublicKey });
}

function nonce(counter: number): Buffer {
  if (!Number.isInteger(counter) || counter < 0 || counter >= MAX_FRAME_COUNTER) {
    throw new Error("The secure transport frame counter is out of range");
  }
  const value = Buffer.alloc(NONCE_BYTES);
  value.writeUIntBE(counter, NONCE_BYTES - 6, 6);
  return value;
}

function associatedData(direction: string, counter: number): Buffer {
  return Buffer.from(`${SECURE_TRANSPORT_SCHEME}:${SECURE_TRANSPORT_VERSION}:${direction}:${counter}`, "utf8");
}

export function sealSecureFrame(key: Buffer, direction: string, counter: number, plaintext: string): SecureFrame {
  const cipher = createCipheriv("aes-256-gcm", key, nonce(counter));
  cipher.setAAD(associatedData(direction, counter));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { kind: "secure", counter, ciphertext: base64url(Buffer.concat([body, cipher.getAuthTag()])) };
}

export function openSecureFrame(key: Buffer, direction: string, frame: SecureFrame): string {
  const sealed = fromBase64url(frame.ciphertext);
  if (sealed.length < TAG_BYTES) throw new Error("The secure frame is too short to authenticate");
  if (sealed.length > MAX_SECURE_FRAME_BYTES) throw new Error("The secure frame is too large");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce(frame.counter));
  decipher.setAAD(associatedData(direction, frame.counter));
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)), decipher.final()]).toString("utf8");
}

export function parseSecureFrame(value: unknown): SecureFrame | null {
  if (!isRecord(value) || value.kind !== "secure") return null;
  if (typeof value.counter !== "number" || !Number.isInteger(value.counter) || value.counter < 0) {
    throw new Error("The secure frame counter is invalid");
  }
  if (typeof value.ciphertext !== "string" || value.ciphertext.length === 0) {
    throw new Error("The secure frame ciphertext is invalid");
  }
  return { kind: "secure", counter: value.counter, ciphertext: value.ciphertext };
}

export function parseSecureHandshakeOffer(value: unknown): SecureHandshakeOffer | null {
  if (!isRecord(value)) return null;
  if (value.scheme !== SECURE_TRANSPORT_SCHEME || value.version !== SECURE_TRANSPORT_VERSION) return null;
  if (typeof value.ephemeralPublicKey !== "string" || typeof value.signature !== "string") return null;
  return {
    scheme: SECURE_TRANSPORT_SCHEME,
    version: SECURE_TRANSPORT_VERSION,
    ephemeralPublicKey: value.ephemeralPublicKey,
    signature: value.signature,
  };
}

export function parseSecureHandshakeAccept(value: unknown): SecureHandshakeAccept | null {
  if (!isRecord(value) || value.kind !== "secure_handshake") return null;
  const offer = parseSecureHandshakeOffer(value);
  if (offer === null) throw new Error("The secure handshake scheme is not supported");
  if (!isRecord(value.credential) || typeof value.credential.payload !== "string" || typeof value.credential.signature !== "string") {
    throw new Error("The secure handshake credential is malformed");
  }
  if (typeof value.deviceId !== "string" || value.deviceId.length === 0) throw new Error("The secure handshake device is missing");
  return {
    ...offer,
    kind: "secure_handshake",
    deviceId: value.deviceId,
    credential: { payload: value.credential.payload, signature: value.credential.signature },
  };
}

/** Host side: the offer sent inside `protocol.hello`. */
export function createSecureHandshakeOffer(input: {
  readonly hostId: string;
  readonly hostPrivateKeyPem: string;
  readonly keyPair?: EphemeralKeyPair;
}): { readonly offer: SecureHandshakeOffer; readonly keyPair: EphemeralKeyPair } {
  const keyPair = input.keyPair ?? createEphemeralKeyPair();
  const ephemeralPublicKey = base64url(rawX25519PublicKey(keyPair.publicKey));
  const signature = sign(null, handshakeBind({
    role: "host",
    hostId: input.hostId,
    hostEphemeralPublicKey: ephemeralPublicKey,
  }), createPrivateKey(input.hostPrivateKeyPem));
  return {
    offer: { scheme: SECURE_TRANSPORT_SCHEME, version: SECURE_TRANSPORT_VERSION, ephemeralPublicKey, signature: base64url(signature) },
    keyPair,
  };
}

/**
 * Device side: verifies the host's offer against the host key stored at pairing,
 * then answers with its own signed ephemeral key.
 */
export function acceptSecureHandshake(input: {
  readonly offer: SecureHandshakeOffer;
  readonly hostId: string;
  readonly hostPublicKeyPem: string;
  readonly deviceId: string;
  readonly devicePrivateKeyPem: string;
  readonly credential: SignedCredential;
  readonly keyPair?: EphemeralKeyPair;
}): { readonly accept: SecureHandshakeAccept; readonly keys: SecureTransportKeys } {
  const hostEphemeralPublicKey = input.offer.ephemeralPublicKey;
  const hostOfferValid = verify(
    null,
    handshakeBind({ role: "host", hostId: input.hostId, hostEphemeralPublicKey }),
    createPublicKey(input.hostPublicKeyPem),
    fromBase64url(input.offer.signature),
  );
  if (!hostOfferValid) throw new Error("The computer's encryption key was not signed by the paired host");
  const keyPair = input.keyPair ?? createEphemeralKeyPair();
  const deviceEphemeralPublicKey = base64url(rawX25519PublicKey(keyPair.publicKey));
  const signature = sign(null, handshakeBind({
    role: "device",
    hostId: input.hostId,
    deviceId: input.deviceId,
    hostEphemeralPublicKey,
    deviceEphemeralPublicKey,
  }), createPrivateKey(input.devicePrivateKeyPem));
  const keys = deriveSecureTransportKeys({
    sharedSecret: secureSharedSecret(keyPair.privateKey, importX25519PublicKey(fromBase64url(hostEphemeralPublicKey))),
    hostId: input.hostId,
    deviceId: input.deviceId,
    hostEphemeralPublicKey,
    deviceEphemeralPublicKey,
  });
  return {
    accept: {
      kind: "secure_handshake",
      scheme: SECURE_TRANSPORT_SCHEME,
      version: SECURE_TRANSPORT_VERSION,
      deviceId: input.deviceId,
      credential: input.credential,
      ephemeralPublicKey: deviceEphemeralPublicKey,
      signature: base64url(signature),
    },
    keys,
  };
}

/**
 * Host side: verifies the device's accept and derives the same keys. The
 * credential is checked by the caller's pairing manager first, which is what
 * proves the signing key belongs to a device this host actually paired.
 */
export function completeSecureHandshake(input: {
  readonly accept: SecureHandshakeAccept;
  readonly hostId: string;
  readonly hostPublicKeyPem: string;
  readonly keyPair: EphemeralKeyPair;
}): { readonly keys: SecureTransportKeys; readonly deviceId: string; readonly credentialId: string } {
  const credential = verifyCredentialSignature(input.accept.credential, input.hostPublicKeyPem);
  if (credential.hostId !== input.hostId) throw new Error("The secure handshake credential belongs to another host");
  if (credential.deviceId !== input.accept.deviceId) throw new Error("The secure handshake device does not match its credential");
  const hostEphemeralPublicKey = base64url(rawX25519PublicKey(input.keyPair.publicKey));
  const deviceEphemeralPublicKey = input.accept.ephemeralPublicKey;
  const valid = verify(
    null,
    handshakeBind({
      role: "device",
      hostId: input.hostId,
      deviceId: credential.deviceId,
      hostEphemeralPublicKey,
      deviceEphemeralPublicKey,
    }),
    createPublicKey(credential.devicePublicKeyPem),
    fromBase64url(input.accept.signature),
  );
  if (!valid) throw new Error("The device's encryption key signature is invalid");
  const keys = deriveSecureTransportKeys({
    sharedSecret: secureSharedSecret(input.keyPair.privateKey, importX25519PublicKey(fromBase64url(deviceEphemeralPublicKey))),
    hostId: input.hostId,
    deviceId: credential.deviceId,
    hostEphemeralPublicKey,
    deviceEphemeralPublicKey,
  });
  return { keys, deviceId: credential.deviceId, credentialId: credential.credentialId };
}

/**
 * One direction of an established session. Outbound counters increase; inbound
 * counters must not repeat or move backwards, which rejects a replayed frame
 * even though the relay can reorder or duplicate what it forwards.
 */
export class SecureChannel {
  #outboundCounter = 0;
  #highestInboundCounter = -1;

  public constructor(
    private readonly keys: SecureTransportKeys,
    private readonly role: SecureTransportRole,
    public readonly sessionId: string = randomUUID(),
  ) {}

  get #sendKey(): Buffer {
    return this.role === "host" ? this.keys.hostToDevice : this.keys.deviceToHost;
  }

  get #receiveKey(): Buffer {
    return this.role === "host" ? this.keys.deviceToHost : this.keys.hostToDevice;
  }

  get #sendDirection(): string {
    return this.role === "host" ? "host-to-device" : "device-to-host";
  }

  get #receiveDirection(): string {
    return this.role === "host" ? "device-to-host" : "host-to-device";
  }

  public seal(plaintext: string): SecureFrame {
    const frame = sealSecureFrame(this.#sendKey, this.#sendDirection, this.#outboundCounter, plaintext);
    this.#outboundCounter += 1;
    return frame;
  }

  public open(frame: SecureFrame): string {
    if (frame.counter <= this.#highestInboundCounter) throw new Error("A secure transport frame was replayed or reordered");
    const plaintext = openSecureFrame(this.#receiveKey, this.#receiveDirection, frame);
    this.#highestInboundCounter = frame.counter;
    return plaintext;
  }

  /**
   * Short human-comparable fingerprint of the agreed keys. Both ends print the
   * same value only when no one sat in the middle.
   */
  public fingerprint(): string {
    const digest = createHash("sha256")
      .update(this.keys.hostToDevice)
      .update(this.keys.deviceToHost)
      .digest();
    return [...digest.subarray(0, 4)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  public matches(other: SecureChannel): boolean {
    const left = Buffer.from(this.fingerprint(), "hex");
    const right = Buffer.from(other.fingerprint(), "hex");
    return left.length === right.length && timingSafeEqual(left, right);
  }
}
