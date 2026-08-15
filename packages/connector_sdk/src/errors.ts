export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;
export const RPC_NOT_INITIALIZED = -32001;
export const RPC_ALREADY_INITIALIZED = -32002;
export const RPC_CAPABILITY_NOT_DECLARED = -32003;
export const RPC_PROTOCOL_MISMATCH = -32004;

export class ConnectorProtocolError extends Error {
  public constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ConnectorProtocolError";
  }
}

export class ConnectorRemoteError extends ConnectorProtocolError {
  public constructor(code: number, message: string, data?: unknown) {
    super(code, message, data);
    this.name = "ConnectorRemoteError";
  }
}

export class ConnectorTimeoutError extends Error {
  public constructor(public readonly method: string, public readonly timeoutMs: number) {
    super(`Connector request ${method} timed out after ${timeoutMs}ms`);
    this.name = "ConnectorTimeoutError";
  }
}
