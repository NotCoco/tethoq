import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { join } from "node:path";

import { buildSpawnCommand, resolveCommand } from "../../provider_contract/src/index.js";

type CodexCommandSource = "configured" | "desktop" | "path";

interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease?: readonly string[];
  readonly text: string;
}

interface CodexCommandCandidate {
  readonly command: string;
  readonly source: Exclude<CodexCommandSource, "configured">;
}

export interface CodexCommandSelection {
  readonly command: string;
  readonly source: CodexCommandSource;
  readonly version?: string;
}

export interface CodexCommandResolverOptions {
  readonly configuredCommand?: string;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam for the command found through PATH. */
  readonly pathCommand?: string;
  /** Test seam for Desktop-managed command discovery. */
  readonly desktopCommands?: readonly string[];
  /** Test seam for version probing. */
  readonly probeVersion?: (command: string) => Promise<string | undefined>;
}

export class CodexCommandResolver {
  readonly #options: CodexCommandResolverOptions;
  #selection: Promise<CodexCommandSelection> | null = null;

  public constructor(options: CodexCommandResolverOptions = {}) {
    this.#options = options;
  }

  /** Successful discovery is shared by detection and every App Server launch. */
  public async resolve(): Promise<CodexCommandSelection> {
    if (this.#selection !== null) return await this.#selection;
    const selection = resolveCodexCommand(this.#options);
    this.#selection = selection;
    try {
      return await selection;
    } catch (error) {
      // A Desktop update can briefly replace its hashed bin directory. Cache a
      // real selection, not a transient discovery failure.
      if (this.#selection === selection) this.#selection = null;
      throw error;
    }
  }

  public invalidate(): void {
    this.#selection = null;
  }
}

export async function resolveCodexCommand(options: CodexCommandResolverOptions = {}): Promise<CodexCommandSelection> {
  if (options.configuredCommand !== undefined) {
    return { command: options.configuredCommand, source: "configured" };
  }

  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { command: "codex", source: "path" };

  const env = options.env ?? process.env;
  const pathCommand = options.pathCommand ?? resolveCommand("codex", { platform, env }).file;
  const desktopCommands = options.desktopCommands ?? await discoverDesktopCodexCommands(env);
  const candidates = uniqueCandidates([
    { command: pathCommand, source: "path" },
    ...desktopCommands.map((command): CodexCommandCandidate => ({ command, source: "desktop" })),
  ]);
  const probeVersion = options.probeVersion ?? ((command: string) => probeCodexVersion(command, env));
  const probed = await Promise.all(candidates.map(async (candidate) => {
    try {
      const output = await probeVersion(candidate.command);
      const version = output === undefined ? undefined : parseCodexVersion(output);
      return version === undefined ? undefined : { candidate, version };
    } catch {
      return undefined;
    }
  }));
  const valid = probed.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  const compatible = valid.some((entry) => entry.candidate.source === "desktop")
    ? valid.filter((entry) => entry.candidate.source === "desktop")
    : valid;
  compatible.sort((left, right) => {
    const versionOrder = compareVersions(right.version, left.version);
    if (versionOrder !== 0) return versionOrder;
    return left.candidate.command.localeCompare(right.candidate.command);
  });
  // A Desktop-managed executable is the format-compatibility authority for
  // tasks Desktop writes. PATH is only the automatic fallback when Desktop is
  // absent; an explicit configured command remains authoritative above.
  const selected = compatible[0];
  if (selected === undefined) {
    throw new Error("No compatible Codex CLI executable was found on this Windows host");
  }
  return {
    command: selected.candidate.command,
    source: selected.candidate.source,
    version: selected.version.text,
  };
}

export async function probeCodexVersion(command: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const resolved = resolveCommand(command, { platform: process.platform, env });
  const launch = buildSpawnCommand(resolved, ["--version"]);
  return await new Promise((resolve) => {
    execFile(launch.command, [...launch.args], {
      env,
      timeout: 5_000,
      windowsHide: true,
      ...(launch.windowsVerbatimArguments === true ? { windowsVerbatimArguments: true } : {}),
    }, (error, stdout, stderr) => {
      if (error !== null) {
        resolve(undefined);
        return;
      }
      const output = `${stdout}\n${stderr}`.trim();
      resolve(output || undefined);
    });
  });
}

async function discoverDesktopCodexCommands(env: NodeJS.ProcessEnv): Promise<readonly string[]> {
  const localAppData = env.LOCALAPPDATA?.trim();
  if (!localAppData) return [];
  const binDirectory = join(localAppData, "OpenAI", "Codex", "bin");
  const commands: string[] = [];
  const rootCommand = join(binDirectory, "codex.exe");
  if (await fileExists(rootCommand)) commands.push(rootCommand);
  try {
    const entries = await readdir(binDirectory, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isDirectory()) return;
      const command = join(binDirectory, entry.name, "codex.exe");
      if (await fileExists(command)) commands.push(command);
    }));
  } catch {
    // Codex Desktop is optional; PATH remains a valid candidate.
  }
  return commands;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function uniqueCandidates(candidates: readonly CodexCommandCandidate[]): readonly CodexCommandCandidate[] {
  const result: CodexCommandCandidate[] = [];
  const indexes = new Map<string, number>();
  for (const candidate of candidates) {
    const key = candidate.command.toLocaleLowerCase();
    const existingIndex = indexes.get(key);
    if (existingIndex === undefined) {
      indexes.set(key, result.length);
      result.push(candidate);
      continue;
    }
    // PATH can resolve to Codex Desktop's root executable. Preserve its
    // Desktop provenance so the compatibility filter does not discard that
    // exact, potentially newest binary in favour of an older hashed sibling.
    if (result[existingIndex]?.source === "path" && candidate.source === "desktop") result[existingIndex] = candidate;
  }
  return result;
}

function parseCodexVersion(output: string): ParsedVersion | undefined {
  const match = /(?:^|[^0-9])v?(\d+)\.(\d+)\.(\d+)(?:-([0-9a-z.-]+))?/iu.exec(output);
  if (match === null) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return undefined;
  const prerelease = match[4]?.split(".");
  return {
    major,
    minor,
    patch,
    ...(prerelease !== undefined ? { prerelease } : {}),
    text: `${major}.${minor}.${patch}${prerelease === undefined ? "" : `-${prerelease.join(".")}`}`,
  };
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  if (left.prerelease === undefined || right.prerelease === undefined) {
    if (left.prerelease === right.prerelease) return 0;
    return left.prerelease === undefined ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/u.test(leftPart);
    const rightNumeric = /^\d+$/u.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) - Number(rightPart);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart.localeCompare(rightPart);
  }
  return 0;
}
