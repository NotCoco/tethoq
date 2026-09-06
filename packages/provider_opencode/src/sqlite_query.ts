import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

interface SqliteDatabase {
  prepare(sql: string): {
    all(...anonymousParameters: readonly unknown[]): readonly unknown[];
  };
  close(): void;
}

const electronQuerySource = [
  "const { DatabaseSync } = require('node:sqlite');",
  "const databasePath = process.argv[1];",
  "const request = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8'));",
  "const database = new DatabaseSync(databasePath, { readOnly: true, timeout: 1000 });",
  "try { process.stdout.write(JSON.stringify(database.prepare(request.sql).all(...request.parameters))); } finally { database.close(); }",
].join("\n");

/**
 * Electron's node:sqlite binding can retain a very large native allocation for
 * a multi-gigabyte database. Run the same read in the packaged ordinary-Node
 * runtime there; ordinary Bridge Node processes use the direct, cheaper path.
 */
export async function readOpenCodeSqliteRows(
  databasePath: string,
  sql: string,
  parameters: readonly unknown[],
): Promise<readonly unknown[]> {
  if (process.versions.electron !== undefined) {
    const resourcesPath = (process as NodeJS.Process & { readonly resourcesPath?: string }).resourcesPath;
    const nodeExecutable = resourcesPath === undefined
      ? undefined
      : join(resourcesPath, "bridge-companion", "resources", "bridge", "runtime", "node.exe");
    if (nodeExecutable === undefined || !existsSync(nodeExecutable)) {
      throw new Error("The packaged Node runtime for OpenCode SQLite reads is unavailable");
    }
    return await readRowsInChild(nodeExecutable, databasePath, sql, parameters);
  }
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(databasePath, { readOnly: true, timeout: 1_000 }) as SqliteDatabase;
  try {
    return database.prepare(sql).all(...parameters);
  } finally {
    database.close();
  }
}

async function readRowsInChild(
  executable: string,
  databasePath: string,
  sql: string,
  parameters: readonly unknown[],
): Promise<readonly unknown[]> {
  const request = Buffer.from(JSON.stringify({ sql, parameters }), "utf8").toString("base64url");
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      executable,
      ["-e", electronQuerySource, databasePath, request],
      {
        encoding: "utf8",
        env: process.env,
        maxBuffer: 8 * 1024 * 1024,
        timeout: 5_000,
        windowsHide: true,
      },
      (error, output) => {
        if (error !== null) reject(error);
        else resolve(output);
      },
    );
  });
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed)) throw new Error("OpenCode SQLite helper returned a non-array result");
  return parsed;
}
