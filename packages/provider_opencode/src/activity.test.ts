import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SqliteOpenCodeActivityReader, defaultOpenCodeDatabasePath } from "./activity.js";

test("OpenCode persisted activity detects only fresh unfinished assistant work", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-opencode-activity-"));
  const databasePath = join(directory, "opencode.db");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY);
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX message_session_time_created_id_idx ON message (session_id, time_created, id);
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      time_updated INTEGER NOT NULL
    );
    CREATE INDEX part_message_id_id_idx ON part (message_id, id);
  `);
  const insertSession = database.prepare("INSERT INTO session (id) VALUES (?)");
  const insertMessage = database.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)");
  const insertPart = database.prepare("INSERT INTO part (id, message_id, time_updated) VALUES (?, ?, ?)");
  for (const id of ["fresh", "completed", "failed", "stale", "active_part"]) insertSession.run(id);
  const now = 1_800_000_000_000;
  insertMessage.run("m-fresh", "fresh", now - 1_000, now - 1_000, JSON.stringify({ role: "assistant", time: { created: now - 1_000 } }));
  insertMessage.run("m-completed", "completed", now - 1_000, now - 1_000, JSON.stringify({ role: "assistant", time: { created: now - 1_000, completed: now - 500 } }));
  insertMessage.run("m-failed", "failed", now - 1_000, now - 1_000, JSON.stringify({ role: "assistant", time: { created: now - 1_000 }, error: { name: "Error" } }));
  insertMessage.run("m-stale", "stale", now - 60_000, now - 60_000, JSON.stringify({ role: "assistant", time: { created: now - 60_000 } }));
  insertMessage.run("m-part", "active_part", now - 60_000, now - 60_000, JSON.stringify({ role: "assistant", time: { created: now - 60_000 } }));
  insertPart.run("p-active", "m-part", now - 500);
  database.close();

  const reader = new SqliteOpenCodeActivityReader({ databasePath, freshnessMs: 10_000, now: () => new Date(now) });
  context.after(async () => {
    reader.close();
    await rm(directory, { recursive: true, force: true });
  });

  const working = await reader.readWorkingSessionIds();
  assert.ok(working);
  assert.deepEqual([...working].sort(), ["active_part", "fresh"]);
});

test("OpenCode database path supports an explicit override and the XDG data home", () => {
  assert.equal(defaultOpenCodeDatabasePath({ TETHOQ_OPENCODE_DB_PATH: "D:\\canonical\\open.db", UAR_OPENCODE_DB_PATH: "D:\\legacy\\open.db" }, "C:\\home"), "D:\\canonical\\open.db");
  assert.equal(defaultOpenCodeDatabasePath({ UAR_OPENCODE_DB_PATH: "D:\\shared\\open.db" }, "C:\\home"), "D:\\shared\\open.db");
  assert.equal(defaultOpenCodeDatabasePath({ XDG_DATA_HOME: "D:\\data" }, "C:\\home"), join("D:\\data", "opencode", "opencode.db"));
});
