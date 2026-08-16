import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { JsonFileStore } from "./persistence.js";
import { openAiTranscriptionSourceId, xAiTranscriptionSourceId } from "./dictation.js";

export type ConfigurableTranscriptionSourceId =
  | typeof openAiTranscriptionSourceId
  | typeof xAiTranscriptionSourceId;

interface EncryptedCredential {
  readonly iv: string;
  readonly tag: string;
  readonly data: string;
}

interface DictationCredentialState {
  readonly version: 1;
  readonly credentials: Partial<Record<ConfigurableTranscriptionSourceId, EncryptedCredential>>;
}

const supportedSourceIds = new Set<ConfigurableTranscriptionSourceId>([
  openAiTranscriptionSourceId,
  xAiTranscriptionSourceId,
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encryptedCredential(value: unknown): EncryptedCredential {
  if (!isRecord(value)
    || typeof value.iv !== "string"
    || typeof value.tag !== "string"
    || typeof value.data !== "string"
    || value.iv.length > 128
    || value.tag.length > 128
    || value.data.length > 4_096) {
    throw new Error("Persisted dictation credential is invalid");
  }
  return { iv: value.iv, tag: value.tag, data: value.data };
}

function validateState(value: unknown): DictationCredentialState {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.credentials)) {
    throw new Error("Dictation credential file is invalid");
  }
  const credentials: DictationCredentialState["credentials"] = {};
  for (const [sourceId, credential] of Object.entries(value.credentials)) {
    if (!supportedSourceIds.has(sourceId as ConfigurableTranscriptionSourceId)) {
      throw new Error("Dictation credential file contains an unsupported source");
    }
    credentials[sourceId as ConfigurableTranscriptionSourceId] = encryptedCredential(credential);
  }
  return { version: 1, credentials };
}

export function defaultDictationCredentialStatePath(configPath: string): string {
  return `${dirname(configPath)}/dictation-credentials.json`;
}

export class DictationCredentialStore {
  readonly #store: JsonFileStore<DictationCredentialState>;
  readonly #key: Buffer;
  #state: DictationCredentialState = { version: 1, credentials: {} };
  #loaded = false;
  #writeTail: Promise<void> = Promise.resolve();

  public constructor(path: string, encryptionSecret: string) {
    this.#store = new JsonFileStore(path, validateState);
    this.#key = createHash("sha256").update(encryptionSecret, "utf8").digest();
  }

  public async read(): Promise<Partial<Record<ConfigurableTranscriptionSourceId, string>>> {
    this.#state = await this.#store.read({ version: 1, credentials: {} });
    this.#loaded = true;
    const result: Partial<Record<ConfigurableTranscriptionSourceId, string>> = {};
    for (const sourceId of supportedSourceIds) {
      const encrypted = this.#state.credentials[sourceId];
      if (encrypted === undefined) continue;
      try {
        result[sourceId] = this.#decrypt(sourceId, encrypted);
      } catch {
        throw new Error(`Saved ${sourceId === openAiTranscriptionSourceId ? "OpenAI" : "xAI"} dictation key could not be decrypted`);
      }
    }
    return result;
  }

  public async set(sourceId: ConfigurableTranscriptionSourceId, apiKey: string | undefined): Promise<void> {
    if (!supportedSourceIds.has(sourceId)) throw new Error("Dictation source is not configurable");
    if (!this.#loaded) await this.read();
    const credentials = { ...this.#state.credentials };
    if (apiKey === undefined) delete credentials[sourceId];
    else credentials[sourceId] = this.#encrypt(sourceId, apiKey);
    const next: DictationCredentialState = { version: 1, credentials };
    const write = this.#writeTail.then(() => this.#store.write(next));
    this.#writeTail = write.catch(() => undefined);
    await write;
    this.#state = next;
  }

  public async flush(): Promise<void> {
    await this.#writeTail;
  }

  #encrypt(sourceId: ConfigurableTranscriptionSourceId, value: string): EncryptedCredential {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from(sourceId, "utf8"));
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return {
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    };
  }

  #decrypt(sourceId: ConfigurableTranscriptionSourceId, value: EncryptedCredential): string {
    const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(value.iv, "base64"));
    decipher.setAAD(Buffer.from(sourceId, "utf8"));
    decipher.setAuthTag(Buffer.from(value.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(value.data, "base64")), decipher.final()]).toString("utf8");
  }
}
