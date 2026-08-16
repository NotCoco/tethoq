import { JsonFileStore } from "../../../agent_bridge/src/persistence.js";
import { lstat, readFile } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import {
  MAX_TASK_OVERRIDES,
  MAX_TASK_TITLE_CHARACTERS,
  type AgentModelDefault,
  type DesktopAlertLevel,
  type DesktopCloseAction,
  type DesktopLaunchAtLogin,
  type LocalOpenHandlerId,
  type TaskOverride,
} from "../shared/desktop_api.js";

export const DESKTOP_PREFERENCES_VERSION = 1 as const;

export interface DesktopPreferences {
  readonly version: typeof DESKTOP_PREFERENCES_VERSION;
  /** Master gate for optional, experimental desktop capabilities. Defaults to off. */
  readonly experimentalFeatures: boolean;
  /** Local presentation only. This never changes a provider's reasoning effort. */
  readonly reasoningDisplay: "compact" | "expanded";
  /** Local handler used for task folders and paths surfaced in transcripts. */
  readonly localOpenHandlerId: LocalOpenHandlerId;
  /** Window close behaviour. Tray is the default so running work survives a stray close. */
  readonly closeAction: DesktopCloseAction;
  /** Operating-system login item state. `tray` starts Tethoq without opening a window. */
  readonly launchAtLogin: DesktopLaunchAtLogin;
  /** Notification appetite. `attention` keeps decisions and failures, drops routine completions. */
  readonly alerts: DesktopAlertLevel;
  /** Concrete defaults keyed by provider ID. Dynamic provider catalogues stay out of this file. */
  readonly agentDefaults: Readonly<Record<string, AgentModelDefault>>;
  /** Absolute path only; file contents remain in the main process. */
  readonly globalAgentsPath: string | null;
  /** User-owned task name, pin, and archive state keyed by session ID. */
  readonly taskOverrides: Readonly<Record<string, TaskOverride>>;
}

const LOCAL_OPEN_HANDLER_IDS = new Set<LocalOpenHandlerId>(["system", "vscode", "cursor", "windsurf", "sublime", "notepadpp", "zed"]);
const CLOSE_ACTIONS = new Set<DesktopCloseAction>(["tray", "quit"]);
const LAUNCH_AT_LOGIN_VALUES = new Set<DesktopLaunchAtLogin>(["off", "window", "tray"]);
const ALERT_LEVELS = new Set<DesktopAlertLevel>(["all", "attention", "off"]);
const MAX_SESSION_ID_CHARACTERS = 400;
const MAX_GLOBAL_AGENTS_BYTES = 128 * 1024;

function preferenceString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(normalized) ? normalized : undefined;
}

function validateAgentDefaults(value: unknown): Readonly<Record<string, AgentModelDefault>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const result: Record<string, AgentModelDefault> = {};
  for (const [rawProviderId, rawSelection] of Object.entries(value).slice(0, 100)) {
    const providerId = preferenceString(rawProviderId, 160);
    if (!providerId || typeof rawSelection !== "object" || rawSelection === null || Array.isArray(rawSelection)) continue;
    const selection = rawSelection as Record<string, unknown>;
    const modelId = preferenceString(selection.modelId, 320);
    const reasoningEffort = preferenceString(selection.reasoningEffort, 80);
    if (modelId) result[providerId] = { modelId, ...(reasoningEffort ? { reasoningEffort } : {}) };
  }
  return result;
}

/**
 * Drops every field the user has not actually set so a cleared pin or restored
 * archive leaves no residue in the file, and so `{}` never accumulates as a key.
 */
export function normalizeTaskOverride(value: unknown): TaskOverride | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const title = preferenceString(input.title, MAX_TASK_TITLE_CHARACTERS);
  const normalized: TaskOverride = {
    ...(title ? { title } : {}),
    ...(input.pinned === true ? { pinned: true } : {}),
    ...(input.archived === true ? { archived: true } : {}),
  };
  return Object.keys(normalized).length ? normalized : undefined;
}

function validateTaskOverrides(value: unknown): Readonly<Record<string, TaskOverride>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const result: Record<string, TaskOverride> = {};
  for (const [rawSessionId, rawOverride] of Object.entries(value).slice(0, MAX_TASK_OVERRIDES)) {
    const sessionId = preferenceString(rawSessionId, MAX_SESSION_ID_CHARACTERS);
    const override = normalizeTaskOverride(rawOverride);
    if (sessionId && override) result[sessionId] = override;
  }
  return result;
}

export function validateDesktopPreferences(value: unknown): DesktopPreferences {
  const input = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    version: DESKTOP_PREFERENCES_VERSION,
    experimentalFeatures: input.experimentalFeatures === true,
    reasoningDisplay: input.reasoningDisplay === "expanded" ? "expanded" : "compact",
    localOpenHandlerId: typeof input.localOpenHandlerId === "string" && LOCAL_OPEN_HANDLER_IDS.has(input.localOpenHandlerId as LocalOpenHandlerId)
      ? input.localOpenHandlerId as LocalOpenHandlerId
      : "system",
    closeAction: typeof input.closeAction === "string" && CLOSE_ACTIONS.has(input.closeAction as DesktopCloseAction)
      ? input.closeAction as DesktopCloseAction
      : "tray",
    launchAtLogin: typeof input.launchAtLogin === "string" && LAUNCH_AT_LOGIN_VALUES.has(input.launchAtLogin as DesktopLaunchAtLogin)
      ? input.launchAtLogin as DesktopLaunchAtLogin
      : "off",
    alerts: typeof input.alerts === "string" && ALERT_LEVELS.has(input.alerts as DesktopAlertLevel)
      ? input.alerts as DesktopAlertLevel
      : "all",
    agentDefaults: validateAgentDefaults(input.agentDefaults),
    globalAgentsPath: typeof input.globalAgentsPath === "string"
      && isAbsolute(input.globalAgentsPath)
      && basename(input.globalAgentsPath).toLocaleLowerCase() === "agents.md"
      ? resolve(input.globalAgentsPath)
      : null,
    taskOverrides: validateTaskOverrides(input.taskOverrides),
  };
}

/** Reads a selected instruction file without ever exposing its contents to the renderer. */
export async function readGlobalAgentInstructions(path: string | null): Promise<string | undefined> {
  if (path === null || !isAbsolute(path) || basename(path).toLocaleLowerCase() !== "agents.md") return undefined;
  const absolutePath = resolve(path);
  const stat = await lstat(absolutePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_GLOBAL_AGENTS_BYTES) {
    throw new Error("Choose a regular AGENTS.md file smaller than 128 KB");
  }
  const content = await readFile(absolutePath, "utf8");
  if (!content.trim() || content.includes("\0")) throw new Error("That AGENTS.md file cannot be used");
  return content;
}

export class DesktopPreferencesStore {
  readonly #store: JsonFileStore<DesktopPreferences>;
  readonly #listeners = new Set<(preferences: DesktopPreferences) => void>();
  #value: DesktopPreferences;

  private constructor(path: string, value: DesktopPreferences) {
    this.#store = new JsonFileStore(path, validateDesktopPreferences);
    this.#value = value;
  }

  public static async load(path: string): Promise<DesktopPreferencesStore> {
    const store = new JsonFileStore(path, validateDesktopPreferences);
    const defaults: DesktopPreferences = { version: DESKTOP_PREFERENCES_VERSION, experimentalFeatures: false, reasoningDisplay: "compact", localOpenHandlerId: "system", closeAction: "tray", launchAtLogin: "off", alerts: "all", agentDefaults: {}, globalAgentsPath: null, taskOverrides: {} };
    const value = await store.read(defaults);
    const validated = validateDesktopPreferences(value);
    if (JSON.stringify(validated) !== JSON.stringify(value)) await store.write(validated);
    return new DesktopPreferencesStore(path, validated);
  }

  public value(): DesktopPreferences {
    return this.#value;
  }

  public onChange(listener: (preferences: DesktopPreferences) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Persists and announces one change. An unchanged value never writes or notifies. */
  async #commit(next: DesktopPreferences): Promise<DesktopPreferences> {
    if (JSON.stringify(next) === JSON.stringify(this.#value)) return this.#value;
    await this.#store.write(next);
    this.#value = next;
    for (const listener of this.#listeners) listener(next);
    return next;
  }

  public async setExperimentalFeatures(enabled: boolean): Promise<DesktopPreferences> {
    return await this.#commit({ ...this.#value, experimentalFeatures: enabled === true });
  }

  public async setReasoningDisplay(value: "compact" | "expanded"): Promise<DesktopPreferences> {
    return await this.#commit({ ...this.#value, reasoningDisplay: value });
  }

  public async setLocalOpenHandler(value: LocalOpenHandlerId): Promise<DesktopPreferences> {
    return await this.#commit({ ...this.#value, localOpenHandlerId: LOCAL_OPEN_HANDLER_IDS.has(value) ? value : "system" });
  }

  public async setCloseAction(value: DesktopCloseAction): Promise<DesktopPreferences> {
    if (!CLOSE_ACTIONS.has(value)) throw new Error("The close setting is invalid");
    return await this.#commit({ ...this.#value, closeAction: value });
  }

  public async setLaunchAtLogin(value: DesktopLaunchAtLogin): Promise<DesktopPreferences> {
    if (!LAUNCH_AT_LOGIN_VALUES.has(value)) throw new Error("The startup setting is invalid");
    return await this.#commit({ ...this.#value, launchAtLogin: value });
  }

  public async setAlerts(value: DesktopAlertLevel): Promise<DesktopPreferences> {
    if (!ALERT_LEVELS.has(value)) throw new Error("The alerts setting is invalid");
    return await this.#commit({ ...this.#value, alerts: value });
  }

  /**
   * Merges one task's local name, pin, and archive state. Clearing every field
   * removes the entry, and a full map evicts its least recently touched key so a
   * long-lived install cannot grow this file without bound.
   */
  public async setTaskOverride(sessionIdValue: string, patch: TaskOverride): Promise<DesktopPreferences> {
    const sessionId = preferenceString(sessionIdValue, MAX_SESSION_ID_CHARACTERS);
    if (!sessionId) throw new Error("The task is invalid");
    const merged = normalizeTaskOverride({ ...this.#value.taskOverrides[sessionId], ...patch });
    const taskOverrides: Record<string, TaskOverride> = { ...this.#value.taskOverrides };
    delete taskOverrides[sessionId];
    if (merged) {
      const keys = Object.keys(taskOverrides);
      if (keys.length >= MAX_TASK_OVERRIDES) for (const stale of keys.slice(0, keys.length - MAX_TASK_OVERRIDES + 1)) delete taskOverrides[stale];
      taskOverrides[sessionId] = merged;
    }
    return await this.#commit({ ...this.#value, taskOverrides });
  }

  public async setAgentDefault(providerIdValue: string, selectionValue: AgentModelDefault): Promise<DesktopPreferences> {
    const providerId = preferenceString(providerIdValue, 160);
    const modelId = preferenceString(selectionValue.modelId, 320);
    const reasoningEffort = preferenceString(selectionValue.reasoningEffort, 80);
    if (!providerId || !modelId) throw new Error("The agent default selection is invalid");
    const selection: AgentModelDefault = { modelId, ...(reasoningEffort ? { reasoningEffort } : {}) };
    return await this.#commit({ ...this.#value, agentDefaults: { ...this.#value.agentDefaults, [providerId]: selection } });
  }

  public async setGlobalAgentsPath(path: string | null): Promise<DesktopPreferences> {
    if (path !== null) await readGlobalAgentInstructions(path);
    return await this.#commit({ ...this.#value, globalAgentsPath: path === null ? null : resolve(path) });
  }
}
