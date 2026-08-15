import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

export type ResolvedCommandKind = "exe" | "cmd" | "bat" | "ps1";

export interface ResolvedCommand {
  /** Concrete file that should be spawned (or through its interpreter). */
  readonly file: string;
  /** How the file must be launched on Windows. */
  readonly kind: ResolvedCommandKind;
  /** Original command string for display/errors. */
  readonly source: string;
}

export interface CommandResolutionEnvironment {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
}

function existsFile(path: string): boolean {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a command name to a concrete file and the launch strategy needed.
 *
 * On Windows, bare command names are found through PATH + PATHEXT (the same
 * search the shell performs). `.cmd`/`.bat` shims must be launched through
 * `cmd.exe`, and `.ps1` scripts through `powershell.exe`; plain executables
 * are spawned directly. On POSIX the operating system resolves PATH and
 * shebangs, so bare names are returned unchanged.
 */
export function resolveCommand(command: string, environment: CommandResolutionEnvironment = {}): ResolvedCommand {
  const platform = environment.platform ?? process.platform;
  const env = environment.env ?? process.env;
  const lower = command.toLowerCase();
  const explicitScript = lower.endsWith(".cmd") || lower.endsWith(".bat") || lower.endsWith(".ps1");
  const hasSeparator = command.includes("/") || command.includes("\\");
  const hasKnownExtension = [".exe", ".cmd", ".bat", ".com", ".ps1", ".js", ".mjs"].some((ext) => lower.endsWith(ext));
  if (hasSeparator || hasKnownExtension) {
    if (explicitScript) {
      if (lower.endsWith(".cmd")) return { file: command, kind: "cmd", source: command };
      if (lower.endsWith(".bat")) return { file: command, kind: "bat", source: command };
      return { file: command, kind: "ps1", source: command };
    }
    return { file: command, kind: "exe", source: command };
  }
  if (platform !== "win32") return { file: command, kind: "exe", source: command };
  const searchPath = env.PATH ?? "";
  const pathExt = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").toLowerCase().split(";").filter((entry) => entry.length > 0);
  for (const dir of searchPath.split(delimiter)) {
    if (dir === "") continue;
    for (const ext of pathExt) {
      const candidate = join(dir, command + ext);
      if (!existsFile(candidate)) continue;
      if (ext === ".cmd") return { file: candidate, kind: "cmd", source: command };
      if (ext === ".bat") return { file: candidate, kind: "bat", source: command };
      if (ext === ".ps1") return { file: candidate, kind: "ps1", source: command };
      return { file: candidate, kind: "exe", source: command };
    }
  }
  return { file: command, kind: "exe", source: command };
}

/** Quote a single argument for a `cmd.exe` command line (npm-shim style). */
function quoteWindowsArg(arg: string): string {
  if (arg === "") return '""';
  if (!/[\s"]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

export interface SpawnCommandLine {
  readonly command: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments?: boolean;
}

/**
 * Build the exact spawn arguments for a resolved command. `.cmd`/`.bat` files
 * are launched through `cmd.exe /d /s /c` with a quoted command line (the same
 * pattern npm shims use); `.ps1` through `powershell.exe -File`.
 */
export function buildSpawnCommand(resolved: ResolvedCommand, args: readonly string[]): SpawnCommandLine {
  if (resolved.kind === "exe") return { command: resolved.file, args };
  if (resolved.kind === "ps1") {
    return { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resolved.file, ...args], windowsVerbatimArguments: true };
  }
  const inner = `"${resolved.file}" ${args.map(quoteWindowsArg).join(" ")}`;
  return { command: "cmd.exe", args: ["/d", "/s", "/c", inner], windowsVerbatimArguments: true };
}
