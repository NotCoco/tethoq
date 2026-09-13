import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, lstat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ProviderAdapterError } from "../../provider_contract/src/index.js";
import { OpenCodeHttpClient } from "./http_client.js";

export interface OpenCodeImagePolicyOptions {
  readonly stateRoot?: string;
  readonly cacheRoot?: string;
  readonly pluginSourcePath?: string;
}
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Local coordination only. Image filtering itself must run inside OpenCode. */
export class OpenCodeImagePolicy {
  readonly #stateRoot: string;
  readonly #cacheRoot: string;
  readonly #pluginSourcePath: string;
  readonly #pending = new Map<string, Promise<void>>();
  public constructor(options: OpenCodeImagePolicyOptions = {}) {
    this.#stateRoot = options.stateRoot ?? join(homedir(), ".tethoq", "opencode-images");
    this.#cacheRoot = resolve(options.cacheRoot ?? join(tmpdir(), "tethoq", "opencode-images"));
    this.#pluginSourcePath = options.pluginSourcePath ?? join(homedir(), ".config", "opencode", "tethoq_images.mjs");
  }
  public isCachedImage(url: unknown): url is string {
    if (typeof url !== "string" || !url.startsWith("file:")) return false;
    try { return resolve(fileURLToPath(url)).startsWith(this.#cacheRoot + sep); } catch { return false; }
  }
  public async prepare(client: OpenCodeHttpClient, sessionID: string, directory: string): Promise<void> {
    const key = hash(`${new URL(client.baseUrl).port}\n${process.platform === "win32" ? resolve(directory).toLowerCase() : resolve(directory)}`);
    const pending = this.#pending.get(key) ?? this.ensureReady(client, directory, key);
    this.#pending.set(key, pending);
    try { await pending; } finally { if (this.#pending.get(key) === pending) this.#pending.delete(key); }
    await mkdir(this.#stateRoot, { recursive: true });
    await writeFile(join(this.#stateRoot, `${hash(sessionID)}.json`), JSON.stringify({ version: 1, sessionID, lastActivity: Date.now() }), { flag: "wx" })
      .catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    const registered = JSON.parse(await readFile(join(this.#stateRoot, `${hash(sessionID)}.json`), "utf8")) as { version?: number; sessionID?: string };
    if (registered.version !== 1 || registered.sessionID !== sessionID) throw new ProviderAdapterError("opencode", "IMAGE_POLICY_UNAVAILABLE",
      "Tethoq could not confirm image handling for this task. Your message has been retained.", false);
  }
  private async ensureReady(client: OpenCodeHttpClient, directory: string, key: string): Promise<void> {
    const revision = hash(await readFile(this.#pluginSourcePath, "utf8"));
    const ready = async (): Promise<boolean> => {
      try {
        const value = JSON.parse(await readFile(join(this.#stateRoot, `ready-${key}.json`), "utf8")) as { version: number; revision?: string; pid: number };
        if (value.version !== 1 || value.revision !== revision || !Number.isSafeInteger(value.pid) || value.pid <= 0) return false;
        process.kill(value.pid, 0);
        return true;
      } catch { return false; }
    };
    // Tool discovery initializes the native plugin registry without a model call.
    await client.request("GET", "/experimental/tool/ids", { query: { directory } });
    if (await ready()) return;
    const idle = async (): Promise<boolean> => {
      const statuses = await client.request<Record<string, { type?: string }>>("GET", "/session/status", { query: { directory } });
      return !!statuses && Object.values(statuses).every(status => status.type === "idle");
    };
    // Native terminal output can precede runner teardown. Allow that short gap
    // to settle without treating a completed task as a failed installation.
    const deadline = Date.now() + 2_000;
    let isIdle = await idle();
    while (!isIdle && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
      isIdle = await idle();
    }
    if (!isIdle) {
      throw new ProviderAdapterError("opencode", "IMAGE_POLICY_PENDING", "OpenCode is finishing existing work. Image handling will update when this workspace is idle; your message has been retained.", true);
    }
    // Reload an idle workspace so an already-running server picks up the bundled
    // plugin. Never terminate the server or another workspace's active tasks.
    await client.request("POST", "/instance/dispose", { query: { directory } });
    await client.request("GET", "/experimental/tool/ids", { query: { directory } });
    if (!await ready()) throw new ProviderAdapterError("opencode", "IMAGE_POLICY_UNAVAILABLE",
      "OpenCode could not load Tethoq's image handling. Your message has been retained; repair the OpenCode tools before retrying.", false);
  }
  /** UI history may display a cached image; this never feeds the provider prompt. */
  public async hydrateHistory(value: unknown): Promise<void> {
    if (!Array.isArray(value)) return;
    for (const row of value) {
      if (!Array.isArray(row?.parts)) continue;
      for (const part of row.parts) {
        if (part?.type !== "file" || !/^image\//i.test(part.mime ?? "") || !this.isCachedImage(part.url)) continue;
        const path = fileURLToPath(part.url);
        const stat = await lstat(path).catch(() => undefined);
        if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 25 * 1024 * 1024) {
          part.type = "text";
          part.text = `[Image: ${part.filename ?? 'image'} — temporary image expired]`;
          delete part.url;
          continue;
        }
        const bytes = await readFile(path).catch(() => undefined);
        if (bytes) part.url = `data:${part.mime};base64,${bytes.toString("base64")}`;
      }
    }
  }
}
