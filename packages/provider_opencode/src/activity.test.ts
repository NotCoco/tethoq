import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SqliteOpenCodeActivityReader, defaultOpenCodeDatabasePath } from "./activity.js";

test("OpenCode persisted activity detects every fresh unfinished turn", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-opencode-activity-"));
  const databasePath = join(directory, "opencode.db");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      time_updated INTEGER NOT NULL
    );
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
  const insertSession = database.prepare("INSERT INTO session (id, time_updated) VALUES (?, ?)");
  const insertMessage = database.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)");
  const insertPart = database.prepare("INSERT INTO part (id, message_id, time_updated) VALUES (?, ?, ?)");
  const now = 1_800_000_000_000;
  for (const id of ["fresh", "user_only", "completed", "failed"]) insertSession.run(id, now - 500);
  for (const id of ["stale", "active_part", "unrequested"]) insertSession.run(id, now - 60_000);
  insertMessage.run("m-fresh", "fresh", now - 1_000, now - 1_000, JSON.stringify({ role: "assistant", time: { created: now - 1_000 } }));
  insertMessage.run("m-user-only", "user_only", now - 750, now - 750, JSON.stringify({ role: "user", time: { created: now - 750 } }));
  insertMessage.run("m-completed", "completed", now - 1_000, now - 1_000, JSON.stringify({ role: "assistant", time: { created: now - 1_000, completed: now - 500 } }));
  insertMessage.run("m-failed", "failed", now - 1_000, now - 1_000, JSON.stringify({ role: "assistant", time: { created: now - 1_000 }, error: { name: "Error" } }));
  insertMessage.run("m-stale", "stale", now - 60_000, now - 60_000, JSON.stringify({ role: "assistant", time: { created: now - 60_000 } }));
  insertMessage.run("m-part", "active_part", now - 60_000, now - 60_000, JSON.stringify({ role: "assistant", time: { created: now - 60_000 } }));
  insertMessage.run("m-unrequested", "unrequested", now - 60_000, now - 60_000, JSON.stringify({ role: "assistant", time: { created: now - 60_000 } }));
  insertPart.run("p-active", "m-part", now - 500);
  // A user record has no completion timestamp, even if it was only partially
  // saved and never started a turn. It cannot revive a completed/failed task.
  insertMessage.run("m-orphan-after-completed", "completed", now - 200, now - 200, JSON.stringify({ role: "user", time: { created: now - 200 } }));
  insertMessage.run("m-orphan-after-failed", "failed", now - 200, now - 200, JSON.stringify({ role: "user", time: { created: now - 200 } }));
  // Conversely, a follow-up during a still-running assistant must not hide it.
  insertMessage.run("m-steer", "fresh", now - 200, now - 200, JSON.stringify({ role: "user", time: { created: now - 200 } }));
  database.close();

  const reader = new SqliteOpenCodeActivityReader({ databasePath, freshnessMs: 10_000, now: () => new Date(now) });
  context.after(async () => {
    reader.close();
    await rm(directory, { recursive: true, force: true });
  });

  const working = await reader.readWorkingSessionIds(new Set(["fresh", "user_only", "completed", "failed", "stale", "active_part"]));
  assert.ok(working);
  assert.deepEqual([...working].sort(), ["active_part", "fresh"]);

  const discovered = await reader.readWorkingSessionIds(new Set(), { discoverRecent: true });
  assert.ok(discovered);
  assert.deepEqual([...discovered].sort(), ["active_part", "fresh"], "discovery follows unfinished assistant work, not user records that never carry a completion timestamp");

  const retained = await reader.readWorkingSessionIds(new Set(["active_part"]));
  assert.ok(retained);
  assert.deepEqual([...retained], ["active_part"], "an exact known-active check preserves a long turn between discovery passes");
});

test("provider-wide activity discovery has no 512-row blind spot", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-opencode-complete-activity-"));
  const databasePath = join(directory, "opencode.db");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, time_updated INTEGER NOT NULL);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE INDEX message_session_time_created_id_idx ON message (session_id, time_created, id);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, time_updated INTEGER NOT NULL);
    CREATE INDEX part_message_id_id_idx ON part (message_id, id);
  `);
  const insertSession = database.prepare("INSERT INTO session (id, time_updated) VALUES (?, ?)");
  const insertMessage = database.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)");
  const insertPart = database.prepare("INSERT INTO part (id, message_id, time_updated) VALUES (?, ?, ?)");
  const now = 1_800_000_000_000;
  database.exec("BEGIN");
  // Insert the target message before every newer catalogue/message row. Only
  // its existing session's part becomes fresh later, reproducing the case that
  // session.time_updated-only discovery used to hide.
  insertSession.run("old-session-active-part", now - 60_000);
  insertMessage.run("old-active-message", "old-session-active-part", now - 60_000, now - 60_000, JSON.stringify({
    role: "assistant",
    time: { created: now - 60_000 },
  }));
  insertPart.run("old-active-part", "old-active-message", now - 60_000);
  for (let index = 0; index < 520; index += 1) {
    const sessionId = `newer-complete-${index}`;
    insertSession.run(sessionId, now - index);
    insertMessage.run(`message-${index}`, sessionId, now - index, now - index, JSON.stringify({
      role: "assistant",
      time: { created: now - index, completed: now - index },
    }));
    insertPart.run(`part-${index}`, `message-${index}`, now - index);
  }
  insertSession.run("new-session-active-message", now + 1);
  insertMessage.run("new-active-message", "new-session-active-message", now + 1, now + 1, JSON.stringify({
    role: "assistant",
    time: { created: now + 1 },
  }));
  insertSession.run("middle-session-active-part", now - 250);
  insertMessage.run("middle-active-message", "middle-session-active-part", now - 20_000, now - 20_000, JSON.stringify({
    role: "assistant",
    time: { created: now - 20_000 },
  }));
  insertPart.run("middle-active-part", "middle-active-message", now - 400);
  // Updating an existing streaming part does not change its rowid. This active
  // task is now older than 512 session, message, and part rows, so every
  // bounded-tail implementation misses it despite its fresh provider time.
  database.prepare("UPDATE part SET time_updated = ? WHERE id = ?").run(now - 500, "old-active-part");
  database.exec("COMMIT");
  database.close();

  const reader = new SqliteOpenCodeActivityReader({ databasePath, freshnessMs: 10_000, now: () => new Date(now) });
  context.after(async () => {
    reader.close();
    await rm(directory, { recursive: true, force: true });
  });

  assert.deepEqual(
    [...(await reader.readWorkingSessionIds(new Set(), { discoverRecent: true }) ?? [])].sort(),
    ["middle-session-active-part", "new-session-active-message", "old-session-active-part"],
    "a database wake checks every lightweight session id, so stale ordering and rowid tails cannot hide fresh activity",
  );
  assert.deepEqual(
    [...(await reader.readWorkingSessionIds(new Set(), { discoverAll: true }) ?? [])].sort(),
    ["middle-session-active-part", "new-session-active-message", "old-session-active-part"],
    "startup and safety discovery use the same complete lightweight catalogue",
  );
});

test("OpenCode database path supports an explicit override and the XDG data home", () => {
  assert.equal(defaultOpenCodeDatabasePath({ TETHOQ_OPENCODE_DB_PATH: "D:\\canonical\\open.db", UAR_OPENCODE_DB_PATH: "D:\\legacy\\open.db" }, "C:\\home"), "D:\\canonical\\open.db");
  assert.equal(defaultOpenCodeDatabasePath({ UAR_OPENCODE_DB_PATH: "D:\\shared\\open.db" }, "C:\\home"), "D:\\shared\\open.db");
  assert.equal(defaultOpenCodeDatabasePath({ XDG_DATA_HOME: "D:\\data" }, "C:\\home"), join("D:\\data", "opencode", "opencode.db"));
});

test("OpenCode activity skips SQLite entirely when no running session is known", async () => {
  const reader = new SqliteOpenCodeActivityReader({ databasePath: join(tmpdir(), "missing-opencode-activity.db") });
  const working = await reader.readWorkingSessionIds(new Set());
  assert.deepEqual([...working ?? []], []);
  reader.close();
});

test("OpenCode activity watcher follows database and WAL lifecycle changes", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-opencode-watch-"));
  const databasePath = join(directory, "opencode.db");
  const setup = new DatabaseSync(databasePath);
  setup.exec("PRAGMA journal_mode=WAL; CREATE TABLE activity_probe (value INTEGER NOT NULL);");
  setup.close();
  const reader = new SqliteOpenCodeActivityReader({ databasePath });
  context.after(async () => {
    reader.close();
    await rm(directory, { recursive: true, force: true });
  });
  let changes = 0;
  const unwatch = reader.watchChanges(() => { changes += 1; });

  const writer = new DatabaseSync(databasePath);
  writer.exec("INSERT INTO activity_probe VALUES (1)");
  writer.close();

  for (let attempt = 0; attempt < 100 && changes === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(changes > 0, "a database or WAL write must wake the activity reconciler");
  unwatch();
});

test("OpenCode activity watcher rearms after its directory becomes available", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "uar-opencode-watch-rearm-"));
  const directory = join(root, "late-opencode");
  const databasePath = join(directory, "opencode.db");
  const reader = new SqliteOpenCodeActivityReader({ databasePath });
  context.after(async () => {
    reader.close();
    await rm(root, { recursive: true, force: true });
  });
  let changes = 0;
  reader.watchChanges(() => { changes += 1; });

  await mkdir(directory);
  await new Promise((resolve) => setTimeout(resolve, 350));
  const writer = new DatabaseSync(databasePath);
  writer.exec("CREATE TABLE activity_probe (value INTEGER NOT NULL); INSERT INTO activity_probe VALUES (1)");
  writer.close();

  for (let attempt = 0; attempt < 200 && changes === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(changes > 0, "a bounded retry must restore change wakes after Desktop recreates its database directory");
});
