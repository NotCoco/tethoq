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
  type EarsSettings,
  type LocalOpenHandlerId,
  type TaskOverride,
  type TaskListMode,
} from "../shared/desktop_api.js";
import { defaultEarsSettings, normalizeEarsSettings } from "../../../../packages/protocol/src/ears.js";
import { normalizeProjectDirectory, normalizeSavedProjectDirectories } from "../shared/project_directories.js";

export const DESKTOP_PREFERENCES_VERSION = 1 as const;

export interface DesktopPreferences {
  readonly version: typeof DESKTOP_PREFERENCES_VERSION;
  /** Master gate for optional, experimental desktop capabilities. Defaults to off. */
  readonly experimentalFeatures: boolean;
  /** Local presentation only. This never changes a provider's reasoning effort. */
  readonly reasoningDisplay: "compact" | "expanded";
  /** Persisted task-rail organisation. */
  readonly taskListMode: TaskListMode;
  readonly savedProjectDirectories: readonly string[];
  /** Local handler used for task folders and paths surfaced in transcripts. */
  readonly localOpenHandlerId: LocalOpenHandlerId;
  readonly openLinksInApp: boolean;
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
  /** Backwards-compatible persisted mirror of the experimental-features gate. */
  readonly allowForeignSubagents: boolean;
  /** Per-session opt-in/opt-out recorded explicitly by the user; absence means "follow the default". */
  readonly foreignSubagentOverrides: Readonly<Record<string, boolean>>;
  readonly ears: EarsSettings;
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

/**
 * An override is a plain boolean. `false` is a real stored value (the user
 * opted a session out) so it must survive the normalize step, unlike task
 * overrides where an empty object means "nothing set".
 */
export function normalizeForeignSubagentOverride(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function validateForeignSubagentOverrides(value: unknown): Readonly<Record<string, boolean>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const result: Record<string, boolean> = {};
  for (const [rawSessionId, rawOverride] of Object.entries(value).slice(0, MAX_TASK_OVERRIDES)) {
    const sessionId = preferenceString(rawSessionId, MAX_SESSION_ID_CHARACTERS);
    const override = normalizeForeignSubagentOverride(rawOverride);
    if (sessionId && override !== undefined) result[sessionId] = override;
  }
  return result;
}

export function validateDesktopPreferences(value: unknown): DesktopPreferences {
  const input = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const experimentalFeatures = input.experimentalFeatures === true;
  return {
    version: DESKTOP_PREFERENCES_VERSION,
    experimentalFeatures,
    reasoningDisplay: input.reasoningDisplay === "expanded" ? "expanded" : "compact",
    taskListMode: input.taskListMode === "project" ? "project" : "recent",
    savedProjectDirectories: normalizeSavedProjectDirectories(input.savedProjectDirectories),
    openLinksInApp: input.openLinksInApp === true,
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
    // Kept in the persisted shape for backwards compatibility. Experimental
    // features are now the single master gate for cross-tool sub-agents.
    allowForeignSubagents: experimentalFeatures,
    foreignSubagentOverrides: validateForeignSubagentOverrides(input.foreignSubagentOverrides),
    ears: normalizeEarsSettings(input.ears),
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
    const defaults: DesktopPreferences = { version: DESKTOP_PREFERENCES_VERSION, experimentalFeatures: false, reasoningDisplay: "compact", taskListMode: "recent", savedProjectDirectories: [], localOpenHandlerId: "system", openLinksInApp: false, closeAction: "tray", launchAtLogin: "off", alerts: "all", agentDefaults: {}, globalAgentsPath: null, taskOverrides: {}, allowForeignSubagents: false, foreignSubagentOverrides: {}, ears: defaultEarsSettings };
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
    const experimentalFeatures = enabled === true;
    let foreignSubagentOverrides = this.#value.foreignSubagentOverrides;
    if (this.#value.allowForeignSubagents && !experimentalFeatures && Object.values(foreignSubagentOverrides).includes(true)) {
      const flipped: Record<string, boolean> = {};
      for (const [sessionId, override] of Object.entries(foreignSubagentOverrides)) flipped[sessionId] = override && false;
      foreignSubagentOverrides = flipped;
    }
    return await this.#commit({
      ...this.#value,
      experimentalFeatures,
      allowForeignSubagents: experimentalFeatures,
      foreignSubagentOverrides,
    });
  }

  public async setReasoningDisplay(value: "compact" | "expanded"): Promise<DesktopPreferences> {
    return await this.#commit({ ...this.#value, reasoningDisplay: value });
  }

  public async setOpenLinksInApp(enabled: boolean): Promise<DesktopPreferences> {
    return await this.#commit({ ...this.#value, openLinksInApp: enabled });
  }

  public async setTaskListMode(value: TaskListMode): Promise<DesktopPreferences> {
    if (value !== "recent" && value !== "project") throw new Error("The task list mode is invalid");
    return await this.#commit({ ...this.#value, taskListMode: value });
  }

  public async saveProject(directory: string): Promise<DesktopPreferences> {
    if (!isAbsolute(directory) || /[\u0000-\u001f\u007f]/u.test(directory)) throw new Error("Choose an absolute project folder");
    const savedProjectDirectories = normalizeSavedProjectDirectories([resolve(directory), ...this.#value.savedProjectDirectories]);
    return await this.#commit({ ...this.#value, savedProjectDirectories });
  }

  public async useProject(directory: string): Promise<DesktopPreferences> {
    const key = normalizeProjectDirectory(directory);
    const saved = this.#value.savedProjectDirectories.find((candidate) => normalizeProjectDirectory(candidate) === key);
    return saved ? await this.saveProject(saved) : this.#value;
  }

  /**
   * Toggles the master gate. Turning it off flips every stored `true` override
   * to `false` in storage so sessions the user allowed before the shutdown do
   * not silently regain permission when the gate reopens; turning it on never
   * touches stored values.
   */
  public async setAllowForeignSubagents(enabled: boolean): Promise<DesktopPreferences> {
    return await this.setExperimentalFeatures(enabled);
  }

  /**
   * Records one session's explicit choice. A full map evicts its least
   * recently touched key, matching the task override bound so neither record
   * can grow without limit.
   */
  public async setSessionForeignSubagents(sessionIdValue: string, allowed: boolean): Promise<DesktopPreferences> {
    const sessionId = preferenceString(sessionIdValue, MAX_SESSION_ID_CHARACTERS);
    if (!sessionId) throw new Error("The task is invalid");
    const foreignSubagentOverrides: Record<string, boolean> = { ...this.#value.foreignSubagentOverrides };
    delete foreignSubagentOverrides[sessionId];
    const keys = Object.keys(foreignSubagentOverrides);
    if (keys.length >= MAX_TASK_OVERRIDES) for (const stale of keys.slice(0, keys.length - MAX_TASK_OVERRIDES + 1)) delete foreignSubagentOverrides[stale];
    foreignSubagentOverrides[sessionId] = allowed === true;
    return await this.#commit({ ...this.#value, foreignSubagentOverrides });
  }

  /**
   * The master gate always wins: off means no session may spawn a foreign
   * subagent regardless of what is stored. When the gate is on, sessions the
   * user has not judged explicitly default to allowed.
   */
  public sessionMaySpawnForeignSubagents(sessionId: string): boolean {
    if (!this.#value.experimentalFeatures) return false;
    return this.#value.foreignSubagentOverrides[sessionId] ?? true;
  }

  /** The per-session control only has meaning while the master gate is on. */
  public foreignSubagentControlVisible(): boolean {
    return this.#value.experimentalFeatures;
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

  /** Moves a local draft's complete organisation state onto its provider-created task ID. */
  public async moveTaskOverride(fromSessionIdValue: string, toSessionIdValue: string): Promise<DesktopPreferences> {
    const fromSessionId = preferenceString(fromSessionIdValue, MAX_SESSION_ID_CHARACTERS);
    const toSessionId = preferenceString(toSessionIdValue, MAX_SESSION_ID_CHARACTERS);
    if (!fromSessionId || !toSessionId) throw new Error("The task is invalid");
    if (fromSessionId === toSessionId) return this.#value;
    const source = this.#value.taskOverrides[fromSessionId];
    if (!source) return this.#value;
    const taskOverrides: Record<string, TaskOverride> = { ...this.#value.taskOverrides };
    const moved = normalizeTaskOverride({ ...taskOverrides[toSessionId], ...source });
    delete taskOverrides[fromSessionId];
    delete taskOverrides[toSessionId];
    if (moved) taskOverrides[toSessionId] = moved;
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

  public async setEars(value: EarsSettings): Promise<DesktopPreferences> {
    return await this.#commit({ ...this.#value, ears: normalizeEarsSettings(value) });
  }
}
