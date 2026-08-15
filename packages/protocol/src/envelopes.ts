import type { JsonObject } from "./models.js";

export const CURRENT_PROTOCOL_VERSION = 1 as const;
export type ProtocolVersion = typeof CURRENT_PROTOCOL_VERSION;

interface EnvelopeBase {
  readonly protocolVersion: ProtocolVersion;
  readonly messageId: string;
  readonly hostId: string;
  readonly sentAt: string;
}

export interface RequestEnvelope extends EnvelopeBase {
  readonly kind: "request";
  readonly type: string;
  readonly requestId: string;
  readonly payload: JsonObject;
}

export interface ResponseEnvelope extends EnvelopeBase {
  readonly kind: "response";
  readonly type: string;
  readonly requestId: string;
  readonly ok: boolean;
  readonly payload: JsonObject;
  readonly error?: ProtocolErrorBody;
}

export interface EventEnvelope extends EnvelopeBase {
  readonly kind: "event";
  readonly type: "event.batch";
  readonly sequence: number;
  readonly payload: JsonObject;
}

export interface HelloEnvelope extends EnvelopeBase {
  readonly kind: "hello";
  readonly type: "protocol.hello";
  readonly supportedVersions: readonly number[];
  readonly role: "host" | "device";
  readonly credential?: string;
}

export interface ProtocolErrorBody {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: JsonObject;
}

export type BridgeEnvelope = RequestEnvelope | ResponseEnvelope | EventEnvelope | HelloEnvelope;
