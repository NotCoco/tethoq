import type { ProviderError } from "../../protocol/src/index.js";

export class ProviderAdapterError extends Error {
  public constructor(
    public readonly providerId: string,
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProviderAdapterError";
  }

  public toProviderError(now = new Date()): ProviderError {
    return {
      providerId: this.providerId,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      occurredAt: now.toISOString(),
    };
  }
}

export class UnsupportedProviderCapabilityError extends ProviderAdapterError {
  public constructor(providerId: string, capability: string) {
    super(providerId, "CAPABILITY_UNSUPPORTED", `${providerId} does not document support for ${capability}`, false);
    this.name = "UnsupportedProviderCapabilityError";
  }
}

export function providerErrorFromUnknown(providerId: string, error: unknown): ProviderError {
  if (error instanceof ProviderAdapterError) return error.toProviderError();
  return {
    providerId,
    code: "PROVIDER_FAILURE",
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
    occurredAt: new Date().toISOString(),
  };
}
