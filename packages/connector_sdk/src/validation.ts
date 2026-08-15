import { connectorRpcMethods, type ConnectorRpcMethod } from "./types.js";

export const MAX_JSONL_BYTES = 8 * 1024 * 1024;

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: string | number;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcSuccess {
  readonly jsonrpc: "2.0";
  readonly id: string | number;
  readonly result: unknown;
}

export interface JsonRpcFailure {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly error: { readonly code: number; readonly message: string; readonly data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcFailure;

export function parseJsonLine(line: string | Buffer): unknown {
  const byteLength = typeof line === "string" ? Buffer.byteLength(line, "utf8") : line.byteLength;
  if (byteLength === 0) throw new Error("JSONL message is empty");
  if (byteLength > MAX_JSONL_BYTES) throw new Error(`JSONL message exceeds ${MAX_JSONL_BYTES} bytes`);
  return JSON.parse(line.toString()) as unknown;
}

export function isConnectorRpcMethod(value: unknown): value is ConnectorRpcMethod {
  return typeof value === "string" && (connectorRpcMethods as readonly string[]).includes(value);
}

export function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  if (!isRecord(value) || value.jsonrpc !== "2.0") return false;
  const hasId = typeof value.id === "string" || typeof value.id === "number" || value.id === null;
  if (typeof value.method === "string") return value.id === undefined || (hasId && value.id !== null);
  if (!hasId) return false;
  return ("result" in value) !== ("error" in value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
