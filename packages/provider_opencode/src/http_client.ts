import { ProviderAdapterError } from "../../provider_contract/src/index.js";

export type FetchLike = typeof fetch;

export interface OpenCodeHttpClientOptions {
  readonly baseUrl?: string;
  readonly username?: string;
  readonly password?: string;
  readonly fetch?: FetchLike;
  readonly requestTimeoutMs?: number;
}

export class OpenCodeHttpClient {
  readonly #baseUrl: URL;
  readonly #fetch: FetchLike;
  readonly #authorization: string | undefined;
  readonly #requestTimeoutMs: number;

  public constructor(options: OpenCodeHttpClientOptions = {}) {
    this.#baseUrl = new URL(options.baseUrl ?? "http://127.0.0.1:4096/");
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#authorization = options.password !== undefined
      ? `Basic ${Buffer.from(`${options.username ?? "opencode"}:${options.password}`).toString("base64")}`
      : undefined;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  public get baseUrl(): string {
    return this.#baseUrl.toString();
  }

  public async request<T>(
    method: string,
    path: string,
    options: { readonly body?: unknown; readonly query?: Readonly<Record<string, string | number | boolean | undefined>>; readonly signal?: AbortSignal } = {},
  ): Promise<T> {
    const url = this.url(path, options.query);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("OpenCode request timed out")), this.#requestTimeoutMs);
    const forwardAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", forwardAbort, { once: true });
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (this.#authorization !== undefined) headers.Authorization = this.#authorization;
      if (options.body !== undefined) headers["Content-Type"] = "application/json";
      const response = await this.#fetch(url, {
        method,
        headers,
        signal: controller.signal,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new ProviderAdapterError("opencode", `HTTP_${response.status}`, `OpenCode returned ${response.status}`, response.status >= 500 || response.status === 429);
      }
      if (response.status === 204) return undefined as T;
      const text = await response.text();
      return (text ? JSON.parse(text) : undefined) as T;
    } catch (error) {
      if (error instanceof ProviderAdapterError) throw error;
      throw new ProviderAdapterError("opencode", "HTTP_REQUEST_FAILED", `OpenCode request failed: ${error instanceof Error ? error.message : String(error)}`, true, { cause: error });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", forwardAbort);
    }
  }

  public async *sse(path: string, options: { readonly query?: Readonly<Record<string, string | number | boolean | undefined>>; readonly signal?: AbortSignal } = {}): AsyncGenerator<unknown> {
    const url = this.url(path, options.query);
    const headers: Record<string, string> = { Accept: "text/event-stream", "Cache-Control": "no-cache" };
    if (this.#authorization !== undefined) headers.Authorization = this.#authorization;
    const response = await this.#fetch(url, { method: "GET", headers, ...(options.signal !== undefined ? { signal: options.signal } : {}) });
    if (!response.ok || response.body === null) throw new ProviderAdapterError("opencode", `SSE_${response.status}`, `Unable to subscribe to OpenCode events (${response.status})`, true);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let dataLines: string[] = [];
    const parseEvent = (lines: readonly string[]): unknown => {
      const data = lines.join("\n");
      try {
        return JSON.parse(data) as unknown;
      } catch {
        return { type: "protocol.error", properties: { message: "Invalid JSON in OpenCode SSE event", data } };
      }
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        while (true) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          const raw = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
          if (line === "") {
            if (dataLines.length > 0) {
              yield parseEvent(dataLines);
              dataLines = [];
            }
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart());
          }
        }
      }
      const finalLine = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
      if (finalLine.startsWith("data:")) dataLines.push(finalLine.slice(5).trimStart());
      if (dataLines.length > 0) yield parseEvent(dataLines);
    } finally {
      reader.releaseLock();
    }
  }

  private url(path: string, query?: Readonly<Record<string, string | number | boolean | undefined>>): URL {
    const url = new URL(path.replace(/^\//, ""), this.#baseUrl);
    if (query !== undefined) {
      for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url;
  }
}
