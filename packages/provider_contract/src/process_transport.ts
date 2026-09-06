import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { buildSpawnCommand, resolveCommand } from "./command.js";
import type { JsonRpcTransport } from "./json_rpc.js";

export interface ProcessTransportOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stderr?: (line: string) => void;
}
export class JsonLineProcessTransport implements JsonRpcTransport {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #spawnResult: Promise<Error | null>;
  readonly #listeners = new Set<(message: unknown) => void>();
  readonly #closeListeners = new Set<(error: Error) => void>();
  readonly #errors: string[] = [];
  #processError: Error | null = null;
  #closed = false;

  public constructor(options: ProcessTransportOptions) {
    const resolved = resolveCommand(options.command);
    const launch = buildSpawnCommand(resolved, options.args);
    const spawnOptions: SpawnOptions = {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
      ...(launch.windowsVerbatimArguments === true ? { windowsVerbatimArguments: true } : {}),
    };
    this.#child = spawn(launch.command, [...launch.args], spawnOptions) as ChildProcessWithoutNullStreams;
    this.#spawnResult = new Promise<Error | null>((resolveSpawn) => {
      let settled = false;
      const settle = (error: Error | null): void => {
        if (settled) return;
        settled = true;
        resolveSpawn(error);
      };
      this.#child.once("spawn", () => settle(null));
      this.#child.on("error", (error) => {
        this.#processError ??= error;
        settle(this.#processError);
        this.notifyUnexpectedClose(this.#processError);
      });
    });
    this.#child.once("exit", (code, signal) => {
      if (this.#closed) return;
      const error = this.#processError ?? new Error(
        `Process transport exited before closing${code === null ? "" : ` with code ${code}`}${signal === null ? "" : ` after ${signal}`}`,
      );
      this.#processError = error;
      this.notifyUnexpectedClose(error);
    });
    const decoder = new StringDecoder("utf8");
    let lineParts: string[] = [];
    let lineChars = 0;
    const appendLinePart = (part: string): void => {
      if (part.length === 0) return;
      lineParts.push(part);
      lineChars += part.length;
    };
    const takeLine = (): string => {
      const line = lineParts.length === 0 ? "" : lineParts.length === 1 ? lineParts[0]! : lineParts.join("");
      lineParts = [];
      lineChars = 0;
      return line;
    };
    const parseLine = (rawLine: string): void => {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.length === 0) return;
      try {
        const parsed = JSON.parse(line) as unknown;
        for (const listener of this.#listeners) listener(parsed);
      } catch (error) {
        this.#errors.push(`Invalid JSON line: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    const consumeText = (text: string): void => {
      let offset = 0;
      while (offset < text.length) {
        const newline = text.indexOf("\n", offset);
        if (newline < 0) {
          appendLinePart(offset === 0 ? text : text.slice(offset));
          return;
        }
        appendLinePart(text.slice(offset, newline));
        parseLine(takeLine());
        offset = newline + 1;
      }
    };
    this.#child.stdout.on("data", (chunk: Buffer) => {
      consumeText(decoder.write(chunk));
    });
    this.#child.stdout.once("end", () => {
      consumeText(decoder.end());
      if (lineChars > 0) parseLine(takeLine());
    });
    let errorBuffer = "";
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk: string) => {
      errorBuffer += chunk;
      let newline: number;
      while ((newline = errorBuffer.indexOf("\n")) >= 0) {
        const line = errorBuffer.slice(0, newline).replace(/\r$/u, "");
        errorBuffer = errorBuffer.slice(newline + 1);
        this.#errors.push(line);
        if (this.#errors.length > 200) this.#errors.shift();
        options.stderr?.(line);
      }
    });
  }

  public onMessage(listener: (message: unknown) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public onClose(listener: (error: Error) => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  public async send(message: unknown): Promise<void> {
    if (this.#processError !== null) throw this.#processError;
    if (this.#closed) throw new Error("Process transport is closed");
    const spawnError = await this.#spawnResult;
    if (spawnError !== null) throw spawnError;
    if (this.#processError !== null) throw this.#processError;
    if (this.#closed) throw new Error("Process transport is closed");
    await new Promise<void>((resolve, reject) => {
      this.#child.stdin.write(`${JSON.stringify(message)}\n`, (error) => error === null || error === undefined ? resolve() : reject(error));
    });
  }

  public recentStderr(): readonly string[] {
    return this.#errors;
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#spawnResult;
    if (this.#child.pid === undefined) return;
    this.#child.stdin.end();
    if (this.#child.exitCode === null) await terminateProcessTree(this.#child, "SIGTERM");
    await new Promise<void>((resolve) => {
      if (this.#child.exitCode !== null) resolve();
      else {
        const timer = setTimeout(() => {
          if (this.#child.exitCode === null) void terminateProcessTree(this.#child, "SIGKILL");
          resolve();
        }, 2_000);
        this.#child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      }
    });
  }

  private notifyUnexpectedClose(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const listener of this.#closeListeners) listener(error);
    this.#closeListeners.clear();
  }
}

async function terminateProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid !== undefined) {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
        shell: false,
      });
      killer.once("error", () => resolve());
      killer.once("exit", () => resolve());
    });
    return;
  }
  child.kill(signal);
}
