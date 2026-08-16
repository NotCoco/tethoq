import { spawn, type ChildProcess } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { normalize, posix, resolve, win32 } from "node:path";
import type { LocalOpenHandler, LocalOpenHandlerId } from "../shared/desktop_api.js";

export interface DetectedLocalOpenHandler extends LocalOpenHandler {
  readonly executable?: string;
}

export interface ExistingLocalTarget {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly line?: number;
  readonly column?: number;
}

interface DetectionOptions {
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly isExecutable?: (path: string) => Promise<boolean>;
}

interface LocalOpenShell {
  openPath(path: string): Promise<string>;
  showItemInFolder(path: string): void;
}

interface LocalOpenOptions {
  readonly shell: LocalOpenShell;
  readonly spawnProcess?: typeof spawn;
}

const integrations: readonly {
  readonly id: Exclude<LocalOpenHandlerId, "system">;
  readonly label: string;
  readonly icon: LocalOpenHandler["icon"];
  readonly windows: readonly string[];
  readonly mac: readonly string[];
  readonly unix: readonly string[];
}[] = [
  { id: "vscode", label: "Visual Studio Code", icon: "vscode", windows: ["Code.exe"], mac: ["/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"], unix: ["code"] },
  { id: "cursor", label: "Cursor", icon: "cursor", windows: ["Cursor.exe"], mac: ["/Applications/Cursor.app/Contents/Resources/app/bin/cursor"], unix: ["cursor"] },
  { id: "windsurf", label: "Windsurf", icon: "windsurf", windows: ["Windsurf.exe"], mac: ["/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf"], unix: ["windsurf"] },
  { id: "sublime", label: "Sublime Text", icon: "sublime", windows: ["sublime_text.exe"], mac: ["/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl"], unix: ["subl"] },
  { id: "notepadpp", label: "Notepad++", icon: "notepadpp", windows: ["notepad++.exe"], mac: [], unix: [] },
  { id: "zed", label: "Zed", icon: "zed", windows: ["Zed.exe"], mac: ["/Applications/Zed.app/Contents/MacOS/cli"], unix: ["zed"] },
];

export function systemLocalOpenHandler(platform: NodeJS.Platform = process.platform): DetectedLocalOpenHandler {
  return {
    id: "system",
    label: platform === "win32" ? "File Explorer" : platform === "darwin" ? "Finder" : "Files",
    icon: "explorer",
  };
}

function fixedApplicationCandidates(id: Exclude<LocalOpenHandlerId, "system">, environment: NodeJS.ProcessEnv): readonly string[] {
  const local = environment.LOCALAPPDATA;
  const programFiles = environment.ProgramFiles;
  const programFilesX86 = environment["ProgramFiles(x86)"];
  const candidates: Partial<Record<Exclude<LocalOpenHandlerId, "system">, readonly (string | undefined)[]>> = {
    vscode: [local && win32.join(local, "Programs", "Microsoft VS Code", "Code.exe"), programFiles && win32.join(programFiles, "Microsoft VS Code", "Code.exe"), programFilesX86 && win32.join(programFilesX86, "Microsoft VS Code", "Code.exe")],
    cursor: [local && win32.join(local, "Programs", "cursor", "Cursor.exe"), programFiles && win32.join(programFiles, "Cursor", "Cursor.exe")],
    windsurf: [local && win32.join(local, "Programs", "Windsurf", "Windsurf.exe"), programFiles && win32.join(programFiles, "Windsurf", "Windsurf.exe")],
    sublime: [programFiles && win32.join(programFiles, "Sublime Text", "sublime_text.exe"), programFilesX86 && win32.join(programFilesX86, "Sublime Text", "sublime_text.exe")],
    notepadpp: [programFiles && win32.join(programFiles, "Notepad++", "notepad++.exe"), programFilesX86 && win32.join(programFilesX86, "Notepad++", "notepad++.exe")],
    zed: [local && win32.join(local, "Programs", "Zed", "Zed.exe")],
  };
  return (candidates[id] ?? []).filter((candidate): candidate is string => typeof candidate === "string");
}

function pathCandidates(names: readonly string[], platform: NodeJS.Platform, environment: NodeJS.ProcessEnv): readonly string[] {
  const paths = platform === "win32" ? win32 : posix;
  const entries = (environment.PATH ?? environment.Path ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  return entries.flatMap((entry) => {
    if (!isSafeLocalAbsolutePath(entry, platform)) return [];
    return names.map((name) => paths.join(entry, name));
  });
}

async function executableFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); }
  catch { return false; }
}

export async function detectLocalOpenHandlers(options: DetectionOptions = {}): Promise<readonly DetectedLocalOpenHandler[]> {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const exists = options.isExecutable ?? executableFile;
  const handlers: DetectedLocalOpenHandler[] = [systemLocalOpenHandler(platform)];
  for (const integration of integrations) {
    const names = platform === "win32" ? integration.windows : platform === "darwin" ? integration.mac : integration.unix;
    const paths = platform === "win32" ? win32 : posix;
    const fixed = platform === "win32" ? fixedApplicationCandidates(integration.id, environment) : names.filter((candidate) => paths.isAbsolute(candidate));
    const searched = pathCandidates(names.filter((candidate) => !paths.isAbsolute(candidate)), platform, environment);
    let executable: string | undefined;
    for (const candidate of [...fixed, ...searched]) {
      if (await exists(candidate)) { executable = paths.normalize(candidate); break; }
    }
    if (executable) handlers.push({ id: integration.id, label: integration.label, icon: integration.icon, executable });
  }
  return handlers;
}

export function isSafeLocalAbsolutePath(path: string, platform: NodeJS.Platform = process.platform): boolean {
  const paths = platform === "win32" ? win32 : posix;
  if (!path || path.length > 32_768 || path.includes("\0") || !paths.isAbsolute(path)) return false;
  if (platform === "win32") {
    // Network and Win32 device namespaces can trigger remote access or bypass normal path rules.
    if (/^\\\\/u.test(path) || /^\\[?.]\\/u.test(path)) return false;
    return /^[a-z]:[\\/]/iu.test(path);
  }
  return path.startsWith("/");
}

export async function existingLocalTarget(path: string, line?: number, column?: number): Promise<ExistingLocalTarget> {
  if (!isSafeLocalAbsolutePath(path)) throw new Error("Choose an absolute path on this computer");
  const canonical = await realpath(normalize(resolve(path))).catch(() => { throw new Error("That file or folder no longer exists"); });
  if (!isSafeLocalAbsolutePath(canonical)) throw new Error("That path does not resolve to a local file or folder");
  const details = await stat(canonical);
  if (!details.isFile() && !details.isDirectory()) throw new Error("Only files and folders can be opened");
  return {
    path: canonical,
    kind: details.isDirectory() ? "directory" : "file",
    ...(line === undefined ? {} : { line }),
    ...(column === undefined ? {} : { column }),
  };
}

function editorArguments(handlerId: LocalOpenHandlerId, target: ExistingLocalTarget): readonly string[] {
  const location = target.line === undefined ? target.path : `${target.path}:${target.line}:${target.column ?? 1}`;
  if (handlerId === "vscode" || handlerId === "cursor" || handlerId === "windsurf") return target.line === undefined ? [target.path] : ["--goto", location];
  if (handlerId === "notepadpp") return target.line === undefined ? [target.path] : [`-n${target.line}`, target.path];
  if (handlerId === "sublime" || handlerId === "zed") return [location];
  return [target.path];
}

async function spawnDetached(executable: string, args: readonly string[], spawnProcess: typeof spawn): Promise<void> {
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    const child: ChildProcess = spawnProcess(executable, [...args], { detached: true, shell: false, stdio: "ignore", windowsHide: true });
    const failed = (error: Error) => rejectSpawn(error);
    child.once("error", failed);
    child.once("spawn", () => {
      child.off("error", failed);
      child.unref();
      resolveSpawn();
    });
  });
}

export async function openExistingLocalTarget(target: ExistingLocalTarget, handler: DetectedLocalOpenHandler, options: LocalOpenOptions): Promise<void> {
  if (handler.id === "system") {
    if (target.kind === "file") options.shell.showItemInFolder(target.path);
    else {
      const error = await options.shell.openPath(target.path);
      if (error) throw new Error(error);
    }
    return;
  }
  if (!handler.executable) throw new Error(`${handler.label} is not installed`);
  await spawnDetached(handler.executable, editorArguments(handler.id, target), options.spawnProcess ?? spawn);
}

export function publicLocalOpenHandlers(handlers: readonly DetectedLocalOpenHandler[]): readonly LocalOpenHandler[] {
  return handlers.map(({ id, label, icon }) => ({ id, label, icon }));
}
