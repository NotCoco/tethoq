const componentCount = 3;

export function makeGlobalSessionId(hostId: string, providerId: string, providerSessionId: string): string {
  for (const [name, value] of [["hostId", hostId], ["providerId", providerId], ["providerSessionId", providerSessionId]] as const) {
    if (value.length === 0) throw new Error(`${name} must not be empty`);
  }
  return [hostId, providerId, providerSessionId].map(encodeURIComponent).join("/");
}

export interface ParsedSessionId {
  readonly hostId: string;
  readonly providerId: string;
  readonly providerSessionId: string;
}

export function parseGlobalSessionId(id: string): ParsedSessionId {
  const parts = id.split("/");
  if (parts.length !== componentCount) throw new Error("Global session ID must contain exactly three encoded components");
  try {
    const decoded = parts.map(decodeURIComponent);
    const [hostId, providerId, providerSessionId] = decoded;
    if (!hostId || !providerId || !providerSessionId) throw new Error("Global session ID contains an empty component");
    return { hostId, providerId, providerSessionId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid global session ID: ${message}`, { cause: error });
  }
}

export function makeProviderMessageId(providerId: string, nativeMessageId: string): string {
  if (!providerId || !nativeMessageId) throw new Error("Provider and native message IDs are required");
  return `${encodeURIComponent(providerId)}/${encodeURIComponent(nativeMessageId)}`;
}
