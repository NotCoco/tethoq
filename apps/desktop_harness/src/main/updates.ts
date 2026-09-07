import type { AppUpdater } from "electron-updater";
import type { DesktopUpdateAction, DesktopUpdateState } from "../shared/desktop_api.js";

type Updater = Pick<AppUpdater, "on" | "removeListener" | "checkForUpdates" | "downloadUpdate" | "quitAndInstall" | "autoDownload" | "autoInstallOnAppQuit" | "allowPrerelease" | "allowDowngrade">;

export class DesktopUpdateManager {
  #state: DesktopUpdateState;
  #busy = false;
  #disposed = false;
  #startupTimer: ReturnType<typeof setTimeout> | undefined;
  #checkTimer: ReturnType<typeof setInterval> | undefined;
  #listeners: (() => void)[] = [];

  constructor(private readonly options: {
    readonly currentVersion: string;
    readonly updater?: Updater;
    readonly onState: (state: DesktopUpdateState) => void;
    readonly beforeInstall: () => Promise<void>;
  }) {
    this.#state = { phase: options.updater ? "idle" : "unavailable", currentVersion: options.currentVersion };
    const updater = options.updater;
    if (!updater) return;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    // Tethoq's 0.x installers are published as GitHub preview releases.
    updater.allowPrerelease = options.currentVersion.startsWith("0.") || options.currentVersion.includes("-");
    updater.allowDowngrade = false;
    const listen = (event: Parameters<Updater["on"]>[0], listener: (...args: any[]) => void): void => {
      updater.on(event, listener);
      this.#listeners.push(() => updater.removeListener(event, listener));
    };
    listen("checking-for-update", () => this.set({ phase: "checking" }));
    listen("update-available", (info: { version: string }) => this.set({ phase: "available", version: info.version }));
    listen("update-not-available", () => this.set({ phase: "idle", message: "You’re up to date." }));
    listen("download-progress", (progress: { percent: number }) => this.set({ phase: "downloading", ...(this.#state.version ? { version: this.#state.version } : {}), percent: Math.max(0, Math.min(100, Math.round(progress.percent))) }));
    listen("update-downloaded", (info: { version: string }) => this.set({ phase: "downloaded", version: info.version }));
    listen("error", (error: Error) => {
      console.error("Tethoq update failed", error);
      this.set({ phase: "error", message: "The update could not be completed. Check your connection and try again." });
    });
  }

  state(): DesktopUpdateState { return this.#state; }

  start(): void {
    if (!this.options.updater || this.#startupTimer || this.#checkTimer || this.#disposed) return;
    this.#startupTimer = setTimeout(() => { void this.action("check"); }, 30_000);
    this.#checkTimer = setInterval(() => { void this.action("check"); }, 4 * 60 * 60 * 1000);
    this.#startupTimer.unref();
    this.#checkTimer.unref();
  }

  async action(action: DesktopUpdateAction): Promise<DesktopUpdateState> {
    const updater = this.options.updater;
    if (!updater || this.#busy || this.#disposed) return this.#state;
    if (action === "check" && ["downloaded", "installing"].includes(this.#state.phase)) return this.#state;
    if (action === "download" && this.#state.phase !== "available") return this.#state;
    if (action === "install" && this.#state.phase !== "downloaded") return this.#state;
    this.#busy = true;
    const downloaded = this.#state;
    try {
      if (action === "check") {
        this.set({ phase: "checking" });
        await updater.checkForUpdates();
      } else if (action === "download") {
        this.set({ phase: "downloading", ...(this.#state.version ? { version: this.#state.version } : {}), percent: 0 });
        await updater.downloadUpdate();
      } else {
        await this.options.beforeInstall();
        this.set({ phase: "installing", ...(downloaded.version ? { version: downloaded.version } : {}) });
        updater.quitAndInstall(true, true);
      }
    } catch (error) {
      if (action === "install") {
        this.set({ ...downloaded, message: error instanceof Error ? error.message : "Tethoq could not restart for the update." });
      } else {
        console.error("Tethoq update failed", error);
        this.set({ phase: "error", message: "The update could not be completed. Check your connection and try again." });
      }
    } finally {
      this.#busy = false;
    }
    return this.#state;
  }

  dispose(): void {
    this.#disposed = true;
    clearTimeout(this.#startupTimer);
    clearInterval(this.#checkTimer);
    for (const remove of this.#listeners) remove();
    this.#listeners = [];
  }

  private set(value: Omit<DesktopUpdateState, "currentVersion">): void {
    if (this.#disposed) return;
    this.#state = { ...value, currentVersion: this.options.currentVersion };
    this.options.onState(this.#state);
  }
}
