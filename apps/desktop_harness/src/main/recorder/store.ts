import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type {
  RecorderPrivacy,
  RecorderStopReason,
  StagedWorkflow,
  WorkflowCaptureSummary,
  WorkflowDescriptor,
  WorkflowManifest,
} from "./types.js";

const MANIFEST_FILE = "workflow.json";
const EVENTS_FILE = "events.ndjson";

export interface WorkflowWriteSession {
  readonly id: string;
  readonly directory: string;
  readonly manifestPath: string;
  readonly eventsPath: string;
  readonly fullScreensDirectory: string;
  readonly cursorCropsDirectory: string;
  readonly dragSummariesDirectory: string;
  readonly manifest: WorkflowManifest;
}

export class WorkflowStore {
  readonly #rootDirectory: string;
  #stream: WriteStream | undefined;

  public constructor(rootDirectory: string) {
    this.#rootDirectory = resolve(rootDirectory);
  }

  public get rootDirectory(): string {
    return this.#rootDirectory;
  }

  public async create(manifest: WorkflowManifest): Promise<WorkflowWriteSession> {
    await mkdir(this.#rootDirectory, { recursive: true });
    const directory = join(this.#rootDirectory, `.recording-${manifest.id}`);
    await mkdir(directory, { recursive: false });
    const session: WorkflowWriteSession = {
      id: manifest.id,
      directory,
      manifestPath: join(directory, MANIFEST_FILE),
      eventsPath: join(directory, EVENTS_FILE),
      fullScreensDirectory: join(directory, "screens", "full"),
      cursorCropsDirectory: join(directory, "screens", "cursor"),
      dragSummariesDirectory: join(directory, "screens", "drag-summary"),
      manifest,
    };
    await Promise.all([
      mkdir(session.fullScreensDirectory, { recursive: true }),
      mkdir(session.cursorCropsDirectory, { recursive: true }),
      mkdir(session.dragSummariesDirectory, { recursive: true }),
      writeJsonAtomic(session.manifestPath, manifest),
      writeFile(session.eventsPath, "", { flag: "wx" }),
    ]);
    this.#stream = createWriteStream(session.eventsPath, { flags: "a", encoding: "utf8" });
    this.#stream.on("error", () => { /* surfaced by append/close when possible */ });
    return session;
  }

  public append(event: unknown): boolean {
    const stream = this.#stream;
    if (stream === undefined || stream.destroyed) return false;
    return stream.write(`${JSON.stringify(event)}\n`);
  }

  public async stop(session: WorkflowWriteSession, manifest: WorkflowManifest): Promise<StagedWorkflow> {
    await this.closeStream();
    await writeJsonAtomic(session.manifestPath, manifest);
    const finalDirectory = join(this.#rootDirectory, `.staged-${session.id}`);
    await rename(session.directory, finalDirectory);
    const movedManifest = rebaseManifestPaths({ ...manifest, status: "staged" as const }, session.directory, finalDirectory);
    await writeJsonAtomic(join(finalDirectory, MANIFEST_FILE), movedManifest);
    return descriptorFromManifest(finalDirectory, movedManifest) as StagedWorkflow;
  }

  public async finalize(staged: StagedWorkflow, name: string): Promise<WorkflowDescriptor> {
    const cleanName = validateWorkflowName(name);
    const source = assertInside(this.#rootDirectory, staged.path);
    const destination = join(this.#rootDirectory, `${slug(cleanName)}-${staged.id}`);
    await rename(source, destination);
    const manifestPath = join(destination, MANIFEST_FILE);
    const existing = await readManifest(manifestPath);
    const manifest: WorkflowManifest = rebaseManifestPaths({ ...existing, name: cleanName, status: "saved" }, source, destination);
    await writeJsonAtomic(manifestPath, manifest);
    return descriptorFromManifest(destination, manifest);
  }

  public async discard(staged: StagedWorkflow | undefined): Promise<void> {
    await this.closeStream();
    if (staged !== undefined) await rm(assertInside(this.#rootDirectory, staged.path), { recursive: true, force: true });
  }

  public async abort(session: WorkflowWriteSession | undefined): Promise<void> {
    await this.closeStream();
    if (session !== undefined) await rm(assertInside(this.#rootDirectory, session.directory), { recursive: true, force: true });
  }

  public async enforceSizeLimit(session: WorkflowWriteSession, maximumBytes: number): Promise<number> {
    await this.closeStream();
    let total = await directorySize(session.directory);
    if (total <= maximumBytes) return total;
    const candidates = (await Promise.all([
      removableFiles(session.dragSummariesDirectory),
      removableFiles(session.fullScreensDirectory),
      removableFiles(session.cursorCropsDirectory),
    ])).flat().sort((left, right) => right.modifiedAt - left.modifiedAt || right.path.localeCompare(left.path));
    for (const candidate of candidates) {
      if (total <= maximumBytes) break;
      await rm(candidate.path, { force: true });
      total = Math.max(0, total - candidate.bytes);
    }
    return total;
  }

  public async list(): Promise<WorkflowDescriptor[]> {
    await mkdir(this.#rootDirectory, { recursive: true });
    const entries = await readdir(this.#rootDirectory, { withFileTypes: true });
    const descriptors = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".recording-"))
      .map(async (entry): Promise<WorkflowDescriptor | undefined> => {
        try {
          const directory = join(this.#rootDirectory, entry.name);
          return descriptorFromManifest(directory, await readManifest(join(directory, MANIFEST_FILE)));
        } catch {
          return undefined;
        }
      }));
    return descriptors.filter((entry): entry is WorkflowDescriptor => entry !== undefined)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  public async get(id: string): Promise<WorkflowDescriptor | undefined> {
    validateId(id);
    return (await this.list()).find((workflow) => workflow.id === id);
  }

  public async delete(id: string): Promise<void> {
    const descriptor = await this.get(id);
    if (descriptor === undefined) throw new Error("Workflow not found");
    await rm(assertInside(this.#rootDirectory, descriptor.path), { recursive: true, force: true });
  }

  private async closeStream(): Promise<void> {
    const stream = this.#stream;
    this.#stream = undefined;
    if (stream === undefined || stream.destroyed) return;
    await new Promise<void>((resolvePromise, reject) => {
      stream.once("error", reject);
      stream.end(resolvePromise);
    });
  }
}

export async function recoverInterruptedWorkflows(rootDirectory: string, privacy: RecorderPrivacy, now = Date.now()): Promise<void> {
  await mkdir(rootDirectory, { recursive: true });
  const entries = await readdir(rootDirectory, { withFileTypes: true });
  await Promise.all(entries.filter((entry) => entry.isDirectory() && entry.name.startsWith(".recording-")).map(async (entry) => {
    const directory = join(rootDirectory, entry.name);
    try {
      const manifestPath = join(directory, MANIFEST_FILE);
      const manifest = await readManifest(manifestPath);
      const stoppedAt = new Date(now).toISOString();
      const recovered: WorkflowManifest = {
        ...manifest,
        status: "staged",
        stoppedAt,
        stoppedWallTimeMs: now,
        durationMs: Math.max(0, now - manifest.startedWallTimeMs),
        stopReason: "error" as RecorderStopReason,
        privacy,
      };
      await writeJsonAtomic(manifestPath, recovered);
      await rename(directory, join(rootDirectory, `.staged-${manifest.id}`));
    } catch {
      // Leave unrecognized data untouched; it may belong to a newer format.
    }
  }));
}

export function descriptorFromManifest(directory: string, manifest: WorkflowManifest): WorkflowDescriptor {
  if (manifest.status === "recording" || manifest.stoppedAt === undefined || manifest.durationMs === undefined || manifest.stopReason === undefined) {
    throw new Error("Workflow has not stopped");
  }
  return {
    id: manifest.id,
    name: manifest.name,
    status: manifest.status,
    path: directory,
    manifestPath: join(directory, MANIFEST_FILE),
    eventsPath: join(directory, EVENTS_FILE),
    startedAt: manifest.startedAt,
    stoppedAt: manifest.stoppedAt,
    durationMs: manifest.durationMs,
    stopReason: manifest.stopReason,
    summary: manifest.summary,
    privacy: manifest.privacy,
  };
}

export async function directorySize(path: string): Promise<number> {
  const entries = await readdir(path, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? await directorySize(child) : (await stat(child)).size;
  }))).reduce((sum, value) => sum + value, 0);
}

async function removableFiles(directory: string): Promise<Array<{ path: string; bytes: number; modifiedAt: number }>> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return (await Promise.all(entries.filter((entry) => entry.isFile() && !entry.isSymbolicLink()).map(async (entry) => {
    const path = join(directory, entry.name);
    const info = await stat(path);
    return { path, bytes: info.size, modifiedAt: info.mtimeMs };
  }))).filter((entry) => Number.isFinite(entry.bytes));
}

function validateWorkflowName(name: string): string {
  const value = name.trim().replace(/\s+/g, " ");
  if (value.length < 1 || value.length > 80) throw new Error("Workflow name must be between 1 and 80 characters");
  if (/[\u0000-\u001f<>:"/\\|?*]/u.test(value)) throw new Error("Workflow name contains unsupported characters");
  return value;
}

function validateId(id: string): void {
  if (!/^[a-f0-9-]{16,64}$/u.test(id)) throw new Error("Invalid workflow ID");
}

function slug(value: string): string {
  const result = value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 48);
  return result || "workflow";
}

function assertInside(root: string, candidate: string): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(`${resolvedRoot}${sep}`)) throw new Error("Workflow path escaped its storage directory");
  return resolvedCandidate;
}

async function readManifest(path: string): Promise<WorkflowManifest> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as WorkflowManifest;
  if (parsed.formatVersion !== 1 || typeof parsed.id !== "string" || typeof parsed.startedAt !== "string" || (parsed.status !== "recording" && parsed.status !== "staged" && parsed.status !== "saved")) {
    throw new Error(`Invalid workflow manifest: ${basename(dirname(path))}`);
  }
  return parsed;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

function rebaseManifestPaths(manifest: WorkflowManifest, from: string, to: string): WorkflowManifest {
  const fromPrefix = `${resolve(from)}${sep}`;
  const toPrefix = `${resolve(to)}${sep}`;
  const replace = (value: unknown): unknown => {
    if (typeof value === "string" && value.startsWith(fromPrefix)) return `${toPrefix}${value.slice(fromPrefix.length)}`;
    if (Array.isArray(value)) return value.map(replace);
    if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replace(entry)]));
    return value;
  };
  return replace(manifest) as WorkflowManifest;
}

export function emptySummary(): WorkflowCaptureSummary {
  return {
    apps: [],
    eventCount: 0,
    screenshotCount: 0,
    clickCount: 0,
    dragCount: 0,
    keyEventCount: 0,
    droppedFrames: 0,
    contextErrors: 0,
    bytesWritten: 0,
  };
}
