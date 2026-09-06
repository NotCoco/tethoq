import type { MessageAttachment } from "../../../packages/provider_contract/src/index.js";
import type { TranscriptionSourceDescriptor } from "../../../packages/protocol/src/index.js";
import { tethoqEnvironmentValue } from "./environment.js";

const openAiTranscriptionUrl = "https://api.openai.com/v1/audio/transcriptions";
const xAiTranscriptionUrl = "https://api.x.ai/v1/stt";
const openAiCredentialCheckUrl = "https://api.openai.com/v1/models";
const xAiCredentialCheckUrl = "https://api.x.ai/v1/models";
const bridgeMaximumAudioBytes = 25 * 1024 * 1024;
const transcriptionRequestTimeoutMs = 12 * 60_000;
const openAiAudioTypes = new Set([
  "audio/flac",
  "audio/m4a",
  "audio/mp3",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "audio/x-m4a",
  "audio/x-wav",
]);
const xAiAudioTypes = new Set([
  "audio/aac",
  "audio/flac",
  "audio/m4a",
  "audio/mp3",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/opus",
  "audio/wav",
  "audio/x-m4a",
  "audio/x-wav",
  "video/x-matroska",
]);

export const openAiTranscriptionSourceId = "openai-stt";
export const xAiTranscriptionSourceId = "xai-stt";

export interface DictationOptions {
  readonly dictionary?: readonly string[];
}

export interface DictationTranscriber {
  transcribe(audio: MessageAttachment, options?: DictationOptions): Promise<{ readonly text: string }>;
}

export interface TranscriptionSource {
  readonly id: string;
  readonly label: string;
  readonly setupEnvironmentVariable: string;
  readonly maxAudioBytes: number;
  readonly transcriber: DictationTranscriber;
  readonly credential?: {
    readonly label: string;
    readonly setupUrl: string;
    validate(apiKey: string): Promise<void>;
    set(apiKey: string | undefined): void;
  };
  isReady(): boolean;
}

export class TranscriptionSourceRegistry {
  readonly #sources: ReadonlyMap<string, TranscriptionSource>;

  public constructor(sources: readonly TranscriptionSource[]) {
    const sourceMap = new Map<string, TranscriptionSource>();
    for (const source of sources) {
      if (sourceMap.has(source.id)) throw new Error(`Duplicate transcription source ${source.id}`);
      sourceMap.set(source.id, source);
    }
    this.#sources = sourceMap;
  }

  public list(): readonly TranscriptionSourceDescriptor[] {
    return [...this.#sources.values()].map((source) => ({
      id: source.id,
      label: source.label,
      status: source.isReady() ? "ready" : "needs_credential",
      setupEnvironmentVariable: source.setupEnvironmentVariable,
      ...(source.credential !== undefined ? { credential: {
        kind: "api_key" as const,
        label: source.credential.label,
        setupUrl: source.credential.setupUrl,
      } } : {}),
      capabilities: {
        batch: true,
        maxAudioBytes: source.maxAudioBytes,
      },
    }));
  }

  public async validateCredential(sourceId: string, apiKey: string): Promise<void> {
    const source = this.#sources.get(sourceId);
    if (source?.credential === undefined) throw new Error("Dictation source is not configurable");
    await source.credential.validate(apiKey);
  }

  public setCredential(sourceId: string, apiKey: string | undefined): void {
    const source = this.#sources.get(sourceId);
    if (source?.credential === undefined) throw new Error("Dictation source is not configurable");
    source.credential.set(apiKey);
  }

  public async transcribe(
    sourceId: string,
    audio: MessageAttachment,
    options: DictationOptions = {},
  ): Promise<{ readonly text: string }> {
    const source = this.#sources.get(sourceId);
    if (source === undefined) throw new Error("Dictation source is not supported");
    if (!source.isReady()) {
      throw new Error(`${source.label} needs an API key. Open its setup from the dictation source menu.`);
    }
    if (audio.byteLength > source.maxAudioBytes) {
      throw new Error(`Dictation audio exceeds the ${source.label} upload limit`);
    }
    return source.transcriber.transcribe(audio, options);
  }
}

export function defaultTranscriptionSourceRegistry(options: {
  readonly openAiApiKey?: string;
  readonly xAiApiKey?: string;
  readonly fetch?: typeof fetch;
} = {}): TranscriptionSourceRegistry {
  const openAi = new OpenAiDictationTranscriber({
    ...(options.openAiApiKey !== undefined ? { apiKey: options.openAiApiKey } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  });
  const xAi = new XAiDictationTranscriber({
    ...(options.xAiApiKey !== undefined ? { apiKey: options.xAiApiKey } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  });
  return new TranscriptionSourceRegistry([
    {
      id: openAiTranscriptionSourceId,
      label: "OpenAI speech-to-text",
      setupEnvironmentVariable: "TETHOQ_OPENAI_API_KEY",
      maxAudioBytes: bridgeMaximumAudioBytes,
      transcriber: openAi,
      credential: {
        label: "OpenAI API key",
        setupUrl: "https://platform.openai.com/api-keys",
        validate: (apiKey) => openAi.validateCredential(apiKey),
        set: (apiKey) => openAi.setCredential(apiKey),
      },
      isReady: () => openAi.isConfigured,
    },
    {
      id: xAiTranscriptionSourceId,
      label: "xAI speech-to-text",
      setupEnvironmentVariable: "XAI_API_KEY",
      maxAudioBytes: bridgeMaximumAudioBytes,
      transcriber: xAi,
      credential: {
        label: "xAI API key",
        setupUrl: "https://console.x.ai/",
        validate: (apiKey) => xAi.validateCredential(apiKey),
        set: (apiKey) => xAi.setCredential(apiKey),
      },
      isReady: () => xAi.isConfigured,
    },
  ]);
}

export function singleTranscriptionSourceRegistry(
  transcriber: DictationTranscriber,
): TranscriptionSourceRegistry {
  return new TranscriptionSourceRegistry([{
    id: openAiTranscriptionSourceId,
    label: "OpenAI speech-to-text",
    setupEnvironmentVariable: "TETHOQ_OPENAI_API_KEY",
    maxAudioBytes: bridgeMaximumAudioBytes,
    transcriber,
    isReady: () => true,
  }]);
}

export class OpenAiDictationTranscriber implements DictationTranscriber {
  #apiKey: string | undefined;
  readonly #fetch: typeof fetch;

  public constructor(options: { readonly apiKey?: string; readonly fetch?: typeof fetch } = {}) {
    this.#apiKey = options.apiKey ?? tethoqEnvironmentValue(process.env, "TETHOQ_OPENAI_API_KEY");
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  public get isConfigured(): boolean {
    return configured(this.#apiKey);
  }

  public setCredential(apiKey: string | undefined): void {
    this.#apiKey = apiKey;
  }

  public async validateCredential(apiKey: string): Promise<void> {
    await validateProviderCredential(this.#fetch, openAiCredentialCheckUrl, apiKey, "OpenAI");
  }

  public async transcribe(
    audio: MessageAttachment,
    options: DictationOptions = {},
  ): Promise<{ readonly text: string }> {
    validateAudio(audio, openAiAudioTypes, bridgeMaximumAudioBytes);
    if (!this.isConfigured) {
      throw new Error(
        "OpenAI speech-to-text needs an API key. Open its setup from the dictation source menu.",
      );
    }
    const bytes = Uint8Array.from(Buffer.from(audio.dataBase64, "base64"));
    const body = new FormData();
    body.append("model", "gpt-4o-transcribe");
    const dictionary = normalizeDictionary(options.dictionary ?? []);
    if (dictionary.length > 0) {
      body.append("prompt", `Preferred spellings and vocabulary: ${dictionary.join(", ")}`);
    }
    body.append("file", new Blob([bytes], { type: audio.mimeType }), audio.name);
    const response = await this.#fetch(openAiTranscriptionUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#apiKey!.trim()}`,
      },
      body,
      signal: AbortSignal.timeout(transcriptionRequestTimeoutMs),
    });
    return transcriptFromResponse(response, "OpenAI API key");
  }
}

export class XAiDictationTranscriber implements DictationTranscriber {
  #apiKey: string | undefined;
  readonly #fetch: typeof fetch;

  public constructor(options: { readonly apiKey?: string; readonly fetch?: typeof fetch } = {}) {
    this.#apiKey = options.apiKey ?? process.env.XAI_API_KEY;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  public get isConfigured(): boolean {
    return configured(this.#apiKey);
  }

  public setCredential(apiKey: string | undefined): void {
    this.#apiKey = apiKey;
  }

  public async validateCredential(apiKey: string): Promise<void> {
    await validateProviderCredential(this.#fetch, xAiCredentialCheckUrl, apiKey, "xAI");
  }

  public async transcribe(
    audio: MessageAttachment,
    options: DictationOptions = {},
  ): Promise<{ readonly text: string }> {
    validateAudio(audio, xAiAudioTypes, bridgeMaximumAudioBytes);
    if (!this.isConfigured) {
      throw new Error(
        "xAI speech-to-text needs an API key. Open its setup from the dictation source menu.",
      );
    }
    const bytes = Uint8Array.from(Buffer.from(audio.dataBase64, "base64"));
    const body = new FormData();
    for (const entry of normalizeDictionary(options.dictionary ?? []).filter((entry) => entry.length <= 50)) {
      body.append("keyterm", entry);
    }
    // xAI requires file to be the final multipart field.
    body.append("file", new Blob([bytes], { type: audio.mimeType }), audio.name);
    const response = await this.#fetch(xAiTranscriptionUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#apiKey!.trim()}`,
      },
      body,
      signal: AbortSignal.timeout(transcriptionRequestTimeoutMs),
    });
    return transcriptFromResponse(response, "xAI API key");
  }
}

function configured(apiKey: string | undefined): boolean {
  return apiKey !== undefined && apiKey.trim().length > 0;
}

async function validateProviderCredential(
  request: typeof fetch,
  url: string,
  apiKey: string,
  provider: string,
): Promise<void> {
  const trimmed = apiKey.trim();
  if (trimmed.length < 8 || trimmed.length > 512) throw new Error(`${provider} API key is not valid`);
  let response: Response;
  try {
    response = await request(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${trimmed}` },
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    throw new Error(`${provider} could not be reached to check this API key`);
  }
  if (response.status === 401 || response.status === 403) throw new Error(`${provider} rejected this API key`);
  if (!response.ok) throw new Error(`${provider} could not check this API key (${response.status})`);
}

async function transcriptFromResponse(
  response: Response,
  credentialLabel: string,
): Promise<{ readonly text: string }> {
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Tethoq could not authorize dictation; check the saved ${credentialLabel}`);
    }
    throw new Error(`Dictation transcription failed (${response.status})`);
  }
  const result = await response.json() as { readonly text?: unknown };
  if (typeof result.text !== "string") throw new Error("Dictation returned an invalid transcript");
  return { text: result.text.trim() };
}

function validateAudio(
  audio: MessageAttachment,
  acceptedAudioTypes: ReadonlySet<string>,
  maxAudioBytes: number,
): void {
  if (!acceptedAudioTypes.has(audio.mimeType.toLowerCase())) throw new Error("Dictation audio format is not supported");
  if (audio.byteLength < 1_000 || audio.byteLength > maxAudioBytes) {
    throw new Error(`Dictation audio must be between 1 KiB and ${maxAudioBytes / (1024 * 1024)} MiB`);
  }
  const decoded = Buffer.from(audio.dataBase64, "base64");
  if (decoded.byteLength !== audio.byteLength) throw new Error("Dictation audio length does not match its data");
}

function normalizeDictionary(entries: readonly string[]): readonly string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const value = entry.trim();
    const key = value.toLocaleLowerCase();
    if (value.length === 0 || value.length > 80 || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
    if (result.length === 100) break;
  }
  return result;
}
