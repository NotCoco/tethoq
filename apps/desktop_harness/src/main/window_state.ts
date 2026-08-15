import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BrowserWindow, Rectangle } from "electron";

export interface WindowState {
  readonly width: number;
  readonly height: number;
  readonly x?: number;
  readonly y?: number;
  readonly maximized: boolean;
}

export const DEFAULT_WINDOW_STATE: WindowState = Object.freeze({
  width: 1460,
  height: 920,
  maximized: false,
});

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && Number.isFinite(value);
}

export function parseWindowState(value: unknown): WindowState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return DEFAULT_WINDOW_STATE;
  const input = value as Record<string, unknown>;
  const width = isFiniteInteger(input.width) ? Math.max(760, Math.min(input.width, 7680)) : DEFAULT_WINDOW_STATE.width;
  const height = isFiniteInteger(input.height) ? Math.max(480, Math.min(input.height, 4320)) : DEFAULT_WINDOW_STATE.height;
  return {
    width,
    height,
    ...(isFiniteInteger(input.x) ? { x: input.x } : {}),
    ...(isFiniteInteger(input.y) ? { y: input.y } : {}),
    maximized: input.maximized === true,
  };
}

export async function readWindowState(path: string): Promise<WindowState> {
  try {
    return parseWindowState(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch {
    return DEFAULT_WINDOW_STATE;
  }
}

async function writeWindowState(path: string, state: WindowState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

export function trackWindowState(window: BrowserWindow, path: string): () => Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  let lastNormalBounds: Rectangle = window.getNormalBounds();
  let tail = Promise.resolve();
  const persist = (): void => {
    if (!window.isMaximized() && !window.isMinimized()) lastNormalBounds = window.getBounds();
    clearTimeout(timer);
    timer = setTimeout(() => {
      const state: WindowState = { ...lastNormalBounds, maximized: window.isMaximized() };
      tail = tail.then(() => writeWindowState(path, state)).catch(() => undefined);
    }, 300);
    timer.unref();
  };
  window.on("resize", persist);
  window.on("move", persist);
  window.on("maximize", persist);
  window.on("unmaximize", persist);
  return async () => {
    clearTimeout(timer);
    if (!window.isDestroyed()) {
      if (!window.isMaximized() && !window.isMinimized()) lastNormalBounds = window.getBounds();
      tail = tail.then(() => writeWindowState(path, { ...lastNormalBounds, maximized: window.isMaximized() })).catch(() => undefined);
    }
    await tail;
  };
}
