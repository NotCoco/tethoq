import { agentEventTypes, connectionStates, sessionStates, type ApprovalResponse, type JsonObject, type JsonValue, type SessionTransferRequest, type UserInputResponse } from "./models.js";
import { CURRENT_PROTOCOL_VERSION, type BridgeEnvelope, type EventEnvelope, type HelloEnvelope, type RequestEnvelope, type ResponseEnvelope } from "./envelopes.js";

export class ProtocolValidationError extends Error {
  public readonly path: string;

  public constructor(message: string, path = "$") {
    super(`${path}: ${message}`);
    this.name = "ProtocolValidationError";
    this.path = path;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string, path = "$"): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) throw new ProtocolValidationError("expected a non-empty string", `${path}.${key}`);
  return value;
}

function requireNumber(record: Record<string, unknown>, key: string, path = "$"): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ProtocolValidationError("expected a finite number", `${path}.${key}`);
  return value;
}

function requireObject(record: Record<string, unknown>, key: string, path = "$"): JsonObject {
  const value = record[key];
  if (!isJsonObject(value)) throw new ProtocolValidationError("expected a JSON object", `${path}.${key}`);
  return value;
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isRecord(value)) return Object.values(value).every(isJsonValue);
  return false;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

export function parseEnvelope(input: string | unknown): BridgeEnvelope {
  let value: unknown = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input) as unknown;
    } catch (error) {
      throw new ProtocolValidationError(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!isRecord(value)) throw new ProtocolValidationError("expected an object");
  if (value.protocolVersion !== CURRENT_PROTOCOL_VERSION) throw new ProtocolValidationError(`unsupported protocol version ${String(value.protocolVersion)}`, "$.protocolVersion");
  const base = {
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    messageId: requireString(value, "messageId"),
    hostId: requireString(value, "hostId"),
    sentAt: requireString(value, "sentAt"),
  } as const;
  const kind = requireString(value, "kind");
  const type = requireString(value, "type");

  if (kind === "request") {
    const result: RequestEnvelope = { ...base, kind, type, requestId: requireString(value, "requestId"), payload: requireObject(value, "payload") };
    return result;
  }
  if (kind === "response") {
    if (typeof value.ok !== "boolean") throw new ProtocolValidationError("expected a boolean", "$.ok");
    let errorBody: ResponseEnvelope["error"] | undefined;
    if (value.error !== undefined) {
      if (!isRecord(value.error)) throw new ProtocolValidationError("expected an object", "$.error");
      errorBody = {
        code: requireString(value.error, "code", "$.error"),
        message: requireString(value.error, "message", "$.error"),
        retryable: value.error.retryable === true,
        ...(isJsonObject(value.error.details) ? { details: value.error.details } : {}),
      };
    }
    const result: ResponseEnvelope = {
      ...base,
      kind,
      type,
      requestId: requireString(value, "requestId"),
      ok: value.ok,
      payload: requireObject(value, "payload"),
      ...(errorBody !== undefined ? { error: errorBody } : {}),
    };
    return result;
  }
  if (kind === "event") {
    if (type !== "event.batch") throw new ProtocolValidationError("event envelope type must be event.batch", "$.type");
    const result: EventEnvelope = { ...base, kind, type, sequence: requireNumber(value, "sequence"), payload: requireObject(value, "payload") };
    return result;
  }
  if (kind === "hello") {
    if (type !== "protocol.hello") throw new ProtocolValidationError("hello envelope type must be protocol.hello", "$.type");
    if (!Array.isArray(value.supportedVersions) || !value.supportedVersions.every((entry) => Number.isInteger(entry))) {
      throw new ProtocolValidationError("expected an integer array", "$.supportedVersions");
    }
    if (value.role !== "host" && value.role !== "device") throw new ProtocolValidationError("expected host or device", "$.role");
    const result: HelloEnvelope = {
      ...base,
      kind,
      type,
      supportedVersions: value.supportedVersions,
      role: value.role,
      ...(typeof value.credential === "string" ? { credential: value.credential } : {}),
    };
    return result;
  }
  throw new ProtocolValidationError(`unsupported envelope kind ${kind}`, "$.kind");
}

export function validateApprovalResponse(value: unknown): ApprovalResponse {
  if (!isRecord(value)) throw new ProtocolValidationError("expected an object", "$.approval");
  const response = {
    requestId: requireString(value, "requestId", "$.approval"),
    choiceId: requireString(value, "choiceId", "$.approval"),
    respondedAt: requireString(value, "respondedAt", "$.approval"),
  } satisfies ApprovalResponse;
  const timestamp = Date.parse(response.respondedAt);
  if (!Number.isFinite(timestamp)) throw new ProtocolValidationError("expected an ISO-8601 timestamp", "$.approval.respondedAt");
  return response;
}

export function validateUserInputResponse(value: unknown): UserInputResponse {
  if (!isRecord(value)) throw new ProtocolValidationError("expected an object", "$.userInput");
  const answers = requireObject(value, "answers", "$.userInput");
  const response = {
    requestId: requireString(value, "requestId", "$.userInput"),
    answers,
    respondedAt: requireString(value, "respondedAt", "$.userInput"),
  } satisfies UserInputResponse;
  const timestamp = Date.parse(response.respondedAt);
  if (!Number.isFinite(timestamp)) throw new ProtocolValidationError("expected an ISO-8601 timestamp", "$.userInput.respondedAt");
  return response;
}

export function validateSessionTransferRequest(value: unknown): SessionTransferRequest {
  if (!isRecord(value)) throw new ProtocolValidationError("expected an object", "$.transfer");
  const sessionId = requireString(value, "sessionId", "$.transfer").trim();
  if (sessionId.length === 0) throw new ProtocolValidationError("expected a non-empty string", "$.transfer.sessionId");
  const promptValue = value.prompt;
  if (promptValue !== undefined && typeof promptValue !== "string") {
    throw new ProtocolValidationError("expected a string", "$.transfer.prompt");
  }
  const prompt = promptValue?.trim();
  if (prompt !== undefined && prompt.length === 0) {
    throw new ProtocolValidationError("expected a non-empty string", "$.transfer.prompt");
  }
  if ((prompt?.length ?? 0) > 32_000) {
    throw new ProtocolValidationError("must not exceed 32000 characters", "$.transfer.prompt");
  }
  return {
    sessionId,
    ...(prompt !== undefined ? { prompt } : {}),
  };
}

export function isSessionState(value: unknown): boolean {
  return typeof value === "string" && (sessionStates as readonly string[]).includes(value);
}

export function isConnectionState(value: unknown): boolean {
  return typeof value === "string" && (connectionStates as readonly string[]).includes(value);
}

export function isAgentEventType(value: unknown): boolean {
  return typeof value === "string" && (agentEventTypes as readonly string[]).includes(value);
}
