import { existsSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { readOpenCodeSqliteRows } from "./sqlite_query.js";

export interface OpenCodeActivityReader {
  /** `undefined` means the activity source could not be read authoritatively. */
  readWorkingSessionIds(
    sessionIds: ReadonlySet<string>,
    options?: OpenCodeActivityReadOptions,
  ): Promise<ReadonlySet<string> | undefined>;
  /** Optional fast wake-up; polling remains the recovery path. */
  watchChanges?(listener: () => void): () => void;
  close(): void;
}

export interface OpenCodeActivityReadOptions {
  /** Also inspect provider-wide activity after a database change instead of checking known IDs only. */
  readonly discoverRecent?: boolean;
  /** Also inspect the complete lightweight session catalogue for startup/safety recovery. */
  readonly discoverAll?: boolean;
}

export interface SqliteOpenCodeActivityReaderOptions {
  readonly databasePath?: string;
  readonly freshnessMs?: number;
  readonly now?: () => Date;
}

// User messages never receive time.completed; even an orphaned empty header
// can otherwise make a finished task look busy for the full freshness window.
// Follow the latest assistant, including while a new steer is being saved.
const exactActivityQuery = `
  WITH candidates AS (
    SELECT CAST(value AS TEXT) AS session_id
    FROM json_each(?)
  ), latest_message AS (
    SELECT
      candidates.session_id,
      (
        SELECT message.id
        FROM message
        WHERE message.session_id = candidates.session_id
          AND json_extract(message.data, '$.role') = 'assistant'
        ORDER BY message.time_created DESC, message.id DESC
        LIMIT 1
      ) AS message_id
    FROM candidates
  )
  SELECT latest_message.session_id
  FROM latest_message
  JOIN message ON message.id = latest_message.message_id
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

/**
 * Every provider-wide wake visits the lightweight session catalogue so no
 * arbitrary recent-row cap can hide one of many simultaneous tasks. The
 * latest-assistant and per-message part lookups remain indexed, so this does not
 * sweep the much larger message and part histories. The adapter separately
 * coalesces change wakes and performs missed-event safety reads on a calm
 * cadence instead of hot-polling this query.
 */
const completeActivityQuery = `
  WITH candidates AS (
    SELECT session.id AS session_id
    FROM session
    UNION ALL
    SELECT CAST(known.value AS TEXT) AS session_id
    FROM json_each(?) AS known
    WHERE NOT EXISTS (
      SELECT 1
      FROM session
      WHERE session.id = CAST(known.value AS TEXT)
    )
  ), latest_message AS (
    SELECT
      candidates.session_id,
      (
        SELECT message.id
        FROM message
        WHERE message.session_id = candidates.session_id
          AND json_extract(message.data, '$.role') = 'assistant'
        ORDER BY message.time_created DESC, message.id DESC
        LIMIT 1
      ) AS message_id
    FROM candidates
  )
  SELECT latest_message.session_id
  FROM latest_message
  JOIN message ON message.id = latest_message.message_id
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
  readonly #watchReleases = new Set<() => void>();

  public constructor(options: SqliteOpenCodeActivityReaderOptions = {}) {
    this.#databasePath = options.databasePath ?? defaultOpenCodeDatabasePath();
    this.#freshnessMs = options.freshnessMs ?? 30 * 60 * 1_000;
    this.#now = options.now ?? (() => new Date());
  }

  public async readWorkingSessionIds(
    sessionIds: ReadonlySet<string>,
    options: OpenCodeActivityReadOptions = {},
  ): Promise<ReadonlySet<string> | undefined> {
    const discoverProviderWide = options.discoverAll === true || options.discoverRecent === true;
    if (sessionIds.size === 0 && !discoverProviderWide) return new Set();
    if (!existsSync(this.#databasePath)) return undefined;
    try {
      const cutoff = this.#now().getTime() - this.#freshnessMs;
      const rows = await readOpenCodeSqliteRows(
        this.#databasePath,
        discoverProviderWide ? completeActivityQuery : exactActivityQuery,
        [JSON.stringify([...sessionIds]), cutoff],
      );
      return new Set(rows.flatMap((row) => isRecord(row) && typeof row.session_id === "string" ? [row.session_id] : []));
    } catch {
      return undefined;
    }
  }

  public watchChanges(listener: () => void): () => void {
    const databaseName = basename(this.#databasePath).toLocaleLowerCase();
    const relevantNames = new Set([databaseName, `${databaseName}-wal`, `${databaseName}-shm`]);
    let watcher: FSWatcher | undefined;
    let retryTimer: NodeJS.Timeout | undefined;
    let retryMs = 250;
    let released = false;
    const closeWatcher = (): void => {
      watcher?.close();
      watcher = undefined;
    };
    const scheduleRetry = (): void => {
      if (released || retryTimer !== undefined) return;
      closeWatcher();
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        arm();
      }, retryMs);
      retryTimer.unref?.();
      retryMs = Math.min(retryMs * 2, 30_000);
    };
    const arm = (): void => {
      if (released) return;
      try {
        // Watch the directory rather than the WAL itself: SQLite routinely
        // creates and removes WAL/SHM files while Desktop closes and reopens.
        watcher = watch(dirname(this.#databasePath), { persistent: false }, (_event, filename) => {
          if (filename === null || relevantNames.has(filename.toString().toLocaleLowerCase())) {
            retryMs = 250;
            listener();
          }
        });
        watcher.once("error", scheduleRetry);
      } catch {
        scheduleRetry();
      }
    };
    const release = (): void => {
      if (released) return;
      released = true;
      this.#watchReleases.delete(release);
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      retryTimer = undefined;
      closeWatcher();
    };
    this.#watchReleases.add(release);
    arm();
    return release;
  }

  public close(): void {
    for (const release of [...this.#watchReleases]) release();
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
