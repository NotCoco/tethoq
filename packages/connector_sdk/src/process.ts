import { extname } from "node:path";

export interface SpawnCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments: boolean;
}

/** Launch scripts without invoking a shell or concatenating untrusted arguments. */
export function buildSpawnCommand(command: string, args: readonly string[]): SpawnCommand {
  if (process.platform === "win32" && extname(command).toLowerCase() === ".cmd") {
    return {
      command: process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", quoteWindowsCommand(command, args)],
      windowsVerbatimArguments: true,
    };
  }
  return { command, args, windowsVerbatimArguments: false };
}

function quoteWindowsCommand(command: string, args: readonly string[]): string {
  return [command, ...args].map(quoteWindowsArgument).join(" ");
}

function quoteWindowsArgument(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error("Connector argument contains a forbidden character");
  return `"${value.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/g, "$1$1")}"`;
}
