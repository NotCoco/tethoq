import type {
  HookKeyboardEvent,
  HookMouseEvent,
  RecorderInputHook,
  RecorderInputListeners,
} from "./types.js";

interface NativeModifiers {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

interface NativeKeyboardEvent extends NativeModifiers {
  readonly keycode: number;
}

interface NativeMouseEvent extends NativeModifiers {
  readonly x: number;
  readonly y: number;
  readonly button: unknown;
  readonly clicks: number;
}

/**
 * Both native-module loading and OS hook activation are deferred until the
 * user explicitly starts a recording.
 */
export class WindowsInputHook implements RecorderInputHook {
  #hook: typeof import("uiohook-napi")["uIOhook"] | undefined;
  #listeners: RecorderInputListeners | undefined;
  #started = false;
  #pressedKeys = new Set<number>();
  #keyNames = new Map<number, string>();

  readonly #keydown = (event: NativeKeyboardEvent): void => {
    const repeat = this.#pressedKeys.has(event.keycode);
    this.#pressedKeys.add(event.keycode);
    this.#listeners?.keydown(keyboardEvent(event, this.#keyNames.get(event.keycode), repeat));
  };
  readonly #keyup = (event: NativeKeyboardEvent): void => {
    this.#listeners?.keyup(keyboardEvent(event, this.#keyNames.get(event.keycode), false));
    this.#pressedKeys.delete(event.keycode);
  };
  readonly #mousedown = (event: NativeMouseEvent): void => this.#listeners?.mousedown(mouseEvent(event));
  readonly #mouseup = (event: NativeMouseEvent): void => this.#listeners?.mouseup(mouseEvent(event));
  readonly #mousemove = (event: NativeMouseEvent): void => this.#listeners?.mousemove(mouseEvent(event));
  readonly #click = (event: NativeMouseEvent): void => this.#listeners?.click(mouseEvent(event));

  public async start(listeners: RecorderInputListeners): Promise<void> {
    if (this.#started) throw new Error("The workflow input hook is already active");
    // Loading the native N-API module is intentionally deferred until the user
    // presses Record. Idle Tethoq processes do not load or start an input hook.
    const { uIOhook, UiohookKey } = await import("uiohook-napi");
    this.#hook = uIOhook;
    this.#listeners = listeners;
    this.#pressedKeys.clear();
    this.#keyNames = new Map(Object.entries(UiohookKey).flatMap(([name, code]) => {
      if (typeof code !== "number" || !Number.isFinite(code) || this.#keyNames.has(code)) return [];
      return [[code, name] as const];
    }));
    uIOhook.on("keydown", this.#keydown);
    uIOhook.on("keyup", this.#keyup);
    uIOhook.on("mousedown", this.#mousedown);
    uIOhook.on("mouseup", this.#mouseup);
    uIOhook.on("mousemove", this.#mousemove);
    uIOhook.on("click", this.#click);
    try {
      uIOhook.start();
      this.#started = true;
    } catch (error) {
      this.removeListeners();
      this.#listeners = undefined;
      this.#hook = undefined;
      this.#pressedKeys.clear();
      this.#keyNames.clear();
      throw error;
    }
  }

  public stop(): void {
    const uIOhook = this.#hook;
    if (uIOhook === undefined) return;
    if (!this.#started) {
      this.removeListeners();
      this.#listeners = undefined;
      this.#hook = undefined;
      this.#pressedKeys.clear();
      this.#keyNames.clear();
      return;
    }
    this.#started = false;
    try {
      uIOhook.stop();
    } finally {
      this.removeListeners();
      this.#listeners = undefined;
      this.#hook = undefined;
      this.#pressedKeys.clear();
      this.#keyNames.clear();
    }
  }

  private removeListeners(): void {
    const uIOhook = this.#hook;
    if (uIOhook === undefined) return;
    uIOhook.off("keydown", this.#keydown);
    uIOhook.off("keyup", this.#keyup);
    uIOhook.off("mousedown", this.#mousedown);
    uIOhook.off("mouseup", this.#mouseup);
    uIOhook.off("mousemove", this.#mousemove);
    uIOhook.off("click", this.#click);
  }
}

function modifiers(event: NativeModifiers): Pick<HookKeyboardEvent, "alt" | "ctrl" | "meta" | "shift"> {
  return {
    alt: event.altKey,
    ctrl: event.ctrlKey,
    meta: event.metaKey,
    shift: event.shiftKey,
  };
}

function keyboardEvent(event: NativeKeyboardEvent, key: string | undefined, repeat: boolean): HookKeyboardEvent {
  return { keycode: event.keycode, ...(key ? { key } : {}), repeat, ...modifiers(event) };
}

function mouseEvent(event: NativeMouseEvent): HookMouseEvent {
  return {
    x: Math.round(event.x),
    y: Math.round(event.y),
    button: typeof event.button === "number" ? event.button : 0,
    clicks: event.clicks,
    ...modifiers(event),
  };
}
