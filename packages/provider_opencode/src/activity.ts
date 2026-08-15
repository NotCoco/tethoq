import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface OpenCodeActivityReader {
  readWorkingSessionIds(): Promise<ReadonlySet<string>>;
  close(): void;
}

export interface SqliteOpenCodeActivityReaderOptions {
  readonly databasePath?: string;
  readonly freshnessMs?: number;
  readonly now?: () => Date;
}

interface SqliteDatabase {
  prepare(sql: string): {
    all(...anonymousParameters: readonly unknown[]): readonly unknown[];
  };
  close(): void;
}

const activityQuery = `
  WITH latest_assistant AS (
    SELECT
      session.id AS session_id,
      (
        SELECT message.id
        FROM message
        WHERE message.session_id = session.id
          AND json_extract(message.data, '$.role') = 'assistant'
        ORDER BY message.time_created DESC, message.id DESC
        LIMIT 1
      ) AS message_id
    FROM session
  )
  SELECT latest_assistant.session_id
  FROM latest_assistant
  JOIN message ON message.id = latest_assistant.message_id
  WHERE json_extract(message.data, '$.time.completed') IS NULL
    AND json_type(message.data, '$.error') IS NULL
    AND MAX(
      message.time_updated,
      COALESCE((
        SELECT MAX(part.time_updated)
        FROM part
        WHERE part.message_id = message.id
      ), 0)
    ) >= ?
`;

export class SqliteOpenCodeActivityReader implements OpenCodeActivityReader {
  readonly #databasePath: string;
  readonly #freshnessMs: number;
  readonly #now: () => Date;
  #database: SqliteDatabase | null = null;
  #unavailable = false;

  public constructor(options: SqliteOpenCodeActivityReaderOptions = {}) {
    this.#databasePath = options.databasePath ?? defaultOpenCodeDatabasePath();
    this.#freshnessMs = options.freshnessMs ?? 30 * 60 * 1_000;
    this.#now = options.now ?? (() => new Date());
  }

  public async readWorkingSessionIds(): Promise<ReadonlySet<string>> {
    const database = await this.database();
    if (database === null) return new Set();
    try {
      const rows = database.prepare(activityQuery).all(this.#now().getTime() - this.#freshnessMs);
      return new Set(rows.flatMap((row) => isRecord(row) && typeof row.session_id === "string" ? [row.session_id] : []));
    } catch {
      this.close();
      return new Set();
    }
  }

  public close(): void {
    this.#database?.close();
    this.#database = null;
  }

  private async database(): Promise<SqliteDatabase | null> {
    if (this.#database !== null) return this.#database;
    if (this.#unavailable || !existsSync(this.#databasePath)) return null;
    try {
      const { DatabaseSync } = await import("node:sqlite");
      this.#database = new DatabaseSync(this.#databasePath, { readOnly: true, timeout: 1_000 });
      return this.#database;
    } catch {
      this.#unavailable = true;
      return null;
    }
  }
}

export function defaultOpenCodeDatabasePath(environment: NodeJS.ProcessEnv = process.env, userHome = homedir()): string {
  const override = environment.TETHOQ_OPENCODE_DB_PATH ?? environment.UAR_OPENCODE_DB_PATH;
  if (override !== undefined) return override;
  const dataHome = environment.XDG_DATA_HOME ?? join(userHome, ".local", "share");
  return join(dataHome, "opencode", "opencode.db");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
