import { existsSync } from "node:fs";
import type { ListSessionsOptions } from "../../provider_contract/src/index.js";
import { defaultOpenCodeDatabasePath } from "./activity.js";
import { readOpenCodeSqliteRows } from "./sqlite_query.js";

export interface OpenCodeSessionIndexEntry {
  readonly id: string;
  readonly parentID?: string;
  readonly directory: string;
  readonly title: string;
  readonly agent?: string;
  readonly model?: unknown;
  readonly time: {
    readonly created: number;
    readonly updated: number;
  };
}

export interface OpenCodeSessionIndexPage {
  readonly entries: readonly OpenCodeSessionIndexEntry[];
  readonly nextCursor: string | null;
}

export interface OpenCodeSessionIndexReader {
  /** `undefined` means the local index is unavailable and HTTP should be used. */
  readPage(options: ListSessionsOptions): Promise<OpenCodeSessionIndexPage | undefined>;
  /** Lightweight usage metadata; never reads text, images, or tool-output parts. */
  readMessageInfo?(sessionId: string, limit: number): Promise<readonly unknown[] | undefined>;
  close(): void;
}

export interface SqliteOpenCodeSessionIndexReaderOptions {
  readonly databasePath?: string;
}

interface SessionIndexCursor {
  readonly version: 1;
  readonly sortKey: "created_at" | "updated_at";
  readonly sortDirection: "asc" | "desc";
  readonly time: number;
  readonly id: string;
  readonly workingDirectory: string | null;
  readonly parentProviderSessionId: string | null;
}

const cursorPrefix = "opencode-sqlite-v1:";
const maximumPageSize = 500;

export function isOpenCodeSessionIndexCursor(value: string): boolean {
  return value.startsWith(cursorPrefix);
}

export class SqliteOpenCodeSessionIndexReader implements OpenCodeSessionIndexReader {
  readonly #databasePath: string;
  #disposed = false;

  public constructor(options: SqliteOpenCodeSessionIndexReaderOptions = {}) {
    this.#databasePath = options.databasePath ?? defaultOpenCodeDatabasePath();
  }

  public async readPage(options: ListSessionsOptions): Promise<OpenCodeSessionIndexPage | undefined> {
    if (this.#disposed) return undefined;
    const limit = pageLimit(options.limit);
    const sortKey = options.sortKey ?? "updated_at";
    const sortDirection = options.sortDirection ?? "desc";
    const cursor = options.cursor === undefined ? undefined : decodeCursor(options.cursor, {
      sortKey,
      sortDirection,
      workingDirectory: options.workingDirectory ?? null,
      parentProviderSessionId: options.parentProviderSessionId ?? null,
    });
    if (!existsSync(this.#databasePath)) return undefined;

    const sortColumn = sortKey === "created_at" ? "time_created" : "time_updated";
    const comparison = sortDirection === "asc" ? ">" : "<";
    const conditions = ["time_archived IS NULL"];
    const parameters: unknown[] = [];
    if (options.workingDirectory !== undefined) {
      conditions.push("directory = ?");
      parameters.push(options.workingDirectory);
    }
    if (options.parentProviderSessionId !== undefined) {
      conditions.push("parent_id = ?");
      parameters.push(options.parentProviderSessionId);
    }
    if (cursor !== undefined) {
      conditions.push(`(${sortColumn} ${comparison} ? OR (${sortColumn} = ? AND id ${comparison} ?))`);
      parameters.push(cursor.time, cursor.time, cursor.id);
    }

    try {
      const rows = await readOpenCodeSqliteRows(this.#databasePath, `
        SELECT id, parent_id, directory, title, time_created, time_updated, agent, model
        FROM session
        WHERE ${conditions.join(" AND ")}
        ORDER BY ${sortColumn} ${sortDirection.toUpperCase()}, id ${sortDirection.toUpperCase()}
        LIMIT ?
      `, [...parameters, limit + 1]);
      const entries = rows.slice(0, limit).map(normalizeRow);
      const hasMore = rows.length > limit;
      const last = entries.at(-1);
      return {
        entries,
        nextCursor: hasMore && last !== undefined
          ? encodeCursor({
              version: 1,
              sortKey,
              sortDirection,
              time: sortKey === "created_at" ? last.time.created : last.time.updated,
              id: last.id,
              workingDirectory: options.workingDirectory ?? null,
              parentProviderSessionId: options.parentProviderSessionId ?? null,
            })
          : null,
      };
    } catch {
      return undefined;
    }
  }

  public close(): void {
    this.#disposed = true;
  }

  public async readMessageInfo(sessionId: string, limit: number): Promise<readonly unknown[] | undefined> {
    if (this.#disposed || !existsSync(this.#databasePath)) return undefined;
    try {
      const rows = await readOpenCodeSqliteRows(this.#databasePath, `
        SELECT data FROM message WHERE session_id = ?
        ORDER BY time_created DESC, id DESC LIMIT ?
      `, [sessionId, pageLimit(limit)]);
      if (rows.length === 0) return undefined;
      return [...rows].reverse().map((row) => {
        if (!isRecord(row) || typeof row.data !== "string") throw new Error("Invalid OpenCode message metadata");
        const info: unknown = JSON.parse(row.data);
        if (!isRecord(info) || typeof info.role !== "string") throw new Error("Invalid OpenCode message metadata");
        return { info };
      });
    } catch {
      // Local state is opt-in and version-dependent. An unreadable schema must
      // fall back to the documented HTTP endpoint, never report zero usage.
      return undefined;
    }
  }
}

function pageLimit(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isInteger(value) || value <= 0) throw new RangeError("OpenCode SQLite session page limit must be a positive integer");
  return Math.min(value, maximumPageSize);
}

function normalizeRow(value: unknown): OpenCodeSessionIndexEntry {
  if (!isRecord(value)
    || typeof value.id !== "string"
    || typeof value.directory !== "string"
    || typeof value.title !== "string"
    || typeof value.time_created !== "number"
    || !Number.isFinite(value.time_created)
    || typeof value.time_updated !== "number"
    || !Number.isFinite(value.time_updated)) {
    throw new Error("OpenCode SQLite session row is invalid");
  }
  const parentID = typeof value.parent_id === "string" && value.parent_id !== "" ? value.parent_id : undefined;
  const agent = typeof value.agent === "string" && value.agent !== "" ? value.agent : undefined;
  const model = parseModel(value.model);
  return {
    id: value.id,
    ...(parentID !== undefined ? { parentID } : {}),
    directory: value.directory,
    title: value.title,
    ...(agent !== undefined ? { agent } : {}),
    ...(model !== undefined ? { model } : {}),
    time: { created: value.time_created, updated: value.time_updated },
  };
}

function parseModel(value: unknown): unknown {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || value === "") return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) || typeof parsed === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function encodeCursor(cursor: SessionIndexCursor): string {
  return cursorPrefix + Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(
  value: string,
  expected: Pick<SessionIndexCursor, "sortKey" | "sortDirection" | "workingDirectory" | "parentProviderSessionId">,
): SessionIndexCursor {
  if (!isOpenCodeSessionIndexCursor(value)) throw new Error("OpenCode SQLite session cursor has the wrong format");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value.slice(cursorPrefix.length), "base64url").toString("utf8")) as unknown;
  } catch {
    throw new Error("OpenCode SQLite session cursor is invalid");
  }
  if (!isRecord(parsed)
    || parsed.version !== 1
    || (parsed.sortKey !== "created_at" && parsed.sortKey !== "updated_at")
    || (parsed.sortDirection !== "asc" && parsed.sortDirection !== "desc")
    || typeof parsed.time !== "number"
    || !Number.isFinite(parsed.time)
    || typeof parsed.id !== "string"
    || parsed.id === ""
    || (parsed.workingDirectory !== null && typeof parsed.workingDirectory !== "string")
    || (parsed.parentProviderSessionId !== null && typeof parsed.parentProviderSessionId !== "string")) {
    throw new Error("OpenCode SQLite session cursor is invalid");
  }
  const cursor = parsed as unknown as SessionIndexCursor;
  if (cursor.sortKey !== expected.sortKey
    || cursor.sortDirection !== expected.sortDirection
    || cursor.workingDirectory !== expected.workingDirectory
    || cursor.parentProviderSessionId !== expected.parentProviderSessionId) {
    throw new Error("OpenCode SQLite session cursor does not match this listing");
  }
  return cursor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
