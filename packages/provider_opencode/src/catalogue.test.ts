import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  SqliteOpenCodeSessionIndexReader,
  type OpenCodeSessionIndexReader,
} from "./catalogue.js";
import type { FetchLike } from "./http_client.js";
import { OpenCodeAdapter } from "./opencode_adapter.js";

test("OpenCode context polling reads local usage without downloading transcript parts and falls back on schema errors", async (t) => {
  const { directory, databasePath, database } = await createDatabase("uar-opencode-context-");
  database.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)");
  const insert = database.prepare("INSERT INTO message VALUES (?, ?, ?, ?)");
  const info = (input: number) => ({ role: "assistant", providerID: "test", modelID: "model", tokens: { input, output: 3 }, cost: 0.1 });
  for (let index = 0; index < 510; index += 1) {
    insert.run(`msg_${index}`, "ses_context", index, JSON.stringify(info(index + 1)));
  }
  insert.run("msg_unfinished", "ses_context", 510, JSON.stringify({ role: "assistant", providerID: "test", modelID: "model" }));
  insert.run("msg_other", "ses_other", 1000, JSON.stringify(info(900_000)));
  let historyReads = 0;
  const adapter = new OpenCodeAdapter({
    hostId: "context-test", localActivity: { databasePath },
    fetch: async (input) => {
      if (new URL(String(input)).pathname === "/provider") {
        return new Response(JSON.stringify({ connected: ["test"], all: [{ id: "test", models: { model: { id: "model", limit: { context: 1000 } } } }] }));
      }
      historyReads += 1;
      return new Response(JSON.stringify([{ info: info(42) }]));
    },
  });
  t.after(async () => { await adapter.dispose(); database.close(); await rm(directory, { recursive: true, force: true }); });
  const context = await adapter.getSessionContext("ses_context");
  assert.equal(context.usedTokens, 513, "an unfinished tail must retain the latest recorded occupancy");
  assert.equal(context.usage?.inputTokens, (12 + 510) * 499 / 2, "keep the same latest-500-message accounting window");
  assert.equal(context.contextWindowTokens, 1000);
  assert.equal(historyReads, 0, "context heartbeats must not fetch text, images, or tool output");
  database.prepare("UPDATE message SET data = ? WHERE id = 'msg_unfinished'").run(JSON.stringify(info(700)));
  assert.equal((await adapter.getSessionContext("ses_context")).usedTokens, 703, "the next reading observes newly committed usage");
  database.exec("DROP TABLE message");
  assert.equal((await adapter.getSessionContext("ses_context")).usedTokens, 45, "unsupported local schemas use authoritative HTTP data");
  assert.equal(historyReads, 1);
});

test("OpenCode SQLite catalogue pages roots and children with filters and minimal metadata", async (context) => {
  const { directory, databasePath, database } = await createDatabase("uar-opencode-catalogue-");
  const insert = database.prepare(`
    INSERT INTO session (id, parent_id, directory, title, time_created, time_updated, time_archived, agent, model)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run("root-a", null, "C:\\one", "A", 10, 30, null, "build", JSON.stringify({ providerID: "deepseek", id: "v4", variant: "max" }));
  insert.run("child-a", "root-a", "C:\\one", "Child", 11, 25, null, "explore", null);
  insert.run("root-b", null, "C:\\two", "B", 20, 20, null, null, null);
  insert.run("root-c", null, "C:\\one", "C", 30, 10, null, null, null);
  insert.run("archived", null, "C:\\one", "Archived", 40, 40, 40, null, null);
  database.close();

  const reader = new SqliteOpenCodeSessionIndexReader({ databasePath });
  context.after(async () => {
    reader.close();
    await rm(directory, { recursive: true, force: true });
  });

  const first = await reader.readPage({ limit: 2, sortKey: "updated_at", sortDirection: "desc" });
  assert.ok(first);
  assert.deepEqual(first.entries.map((entry) => entry.id), ["root-a", "child-a"]);
  assert.deepEqual(first.entries[0], {
    id: "root-a",
    directory: "C:\\one",
    title: "A",
    agent: "build",
    model: { providerID: "deepseek", id: "v4", variant: "max" },
    time: { created: 10, updated: 30 },
  });
  assert.ok(first.nextCursor);

  const second = await reader.readPage({
    limit: 2,
    sortKey: "updated_at",
    sortDirection: "desc",
    cursor: first.nextCursor,
  });
  assert.ok(second);
  assert.deepEqual(second.entries.map((entry) => entry.id), ["root-b", "root-c"]);
  assert.equal(second.nextCursor, null);

  const children = await reader.readPage({ limit: 10, parentProviderSessionId: "root-a" });
  assert.ok(children);
  assert.deepEqual(children.entries.map((entry) => entry.id), ["child-a"]);
  assert.equal(children.entries[0]?.parentID, "root-a");

  const folder = await reader.readPage({
    limit: 10,
    workingDirectory: "C:\\one",
    sortKey: "created_at",
    sortDirection: "asc",
  });
  assert.ok(folder);
  assert.deepEqual(folder.entries.map((entry) => entry.id), ["root-a", "child-a", "root-c"]);
});

test("OpenCode SQLite catalogue keyset keeps equal-time rows stable in both directions", async (context) => {
  const { directory, databasePath, database } = await createDatabase("uar-opencode-catalogue-ties-");
  const insert = database.prepare("INSERT INTO session VALUES (?, NULL, 'C:\\one', ?, 10, 20, NULL, NULL, NULL)");
  for (const id of ["same-a", "same-b", "same-c"]) insert.run(id, id);
  database.close();

  const reader = new SqliteOpenCodeSessionIndexReader({ databasePath });
  context.after(async () => {
    reader.close();
    await rm(directory, { recursive: true, force: true });
  });

  assert.deepEqual(await collectIds(reader, "desc"), ["same-c", "same-b", "same-a"]);
  assert.deepEqual(await collectIds(reader, "asc"), ["same-a", "same-b", "same-c"]);

  const first = await reader.readPage({ limit: 1 });
  assert.ok(first?.nextCursor);
  await assert.rejects(
    async () => await reader.readPage({ limit: 1, sortDirection: "asc", cursor: first.nextCursor! }),
    /does not match this listing/,
  );
  await assert.rejects(
    async () => await reader.readPage({ limit: 1, workingDirectory: "C:\\other", cursor: first.nextCursor! }),
    /does not match this listing/,
  );
});

test("OpenCode adapter treats complete SQLite pages as authoritative and disposes the reader", async (context) => {
  const { directory, databasePath, database } = await createDatabase("uar-opencode-catalogue-adapter-");
  database.prepare("INSERT INTO session VALUES (?, NULL, ?, ?, ?, ?, NULL, NULL, NULL)")
    .run("newer", "C:\\one", "Newer", 10, 20);
  database.prepare("INSERT INTO session VALUES (?, NULL, ?, ?, ?, ?, NULL, NULL, NULL)")
    .run("older", "C:\\two", "Older", 5, 10);
  database.close();

  const reader = new SqliteOpenCodeSessionIndexReader({ databasePath });
  let httpSessionLists = 0;
  let activityReads = 0;
  const fetchLike: FetchLike = async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/session/status") return jsonResponse({});
    if (url.pathname === "/session") httpSessionLists += 1;
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: {
      async readWorkingSessionIds() {
        activityReads += 1;
        return new Set(["newer"]);
      },
      close() {},
    },
    catalogueReader: reader,
  });
  context.after(async () => {
    await adapter.dispose();
    await rm(directory, { recursive: true, force: true });
  });

  const first = await adapter.listSessions({ limit: 1, sortKey: "updated_at", sortDirection: "desc" });
  assert.equal(first.authoritative, true);
  assert.deepEqual(first.sessions.map((session) => session.providerSessionId), ["newer"]);
  assert.equal(first.sessions[0]?.state, "working", "startup activity is applied before the first catalogue page is normalized");
  assert.ok(first.nextCursor);
  const second = await adapter.listSessions({ limit: 1, sortKey: "updated_at", sortDirection: "desc", cursor: first.nextCursor });
  assert.equal(second.authoritative, true);
  assert.deepEqual(second.sessions.map((session) => session.providerSessionId), ["older"]);
  assert.equal(second.nextCursor, null);
  assert.equal(httpSessionLists, 0);
  assert.equal(activityReads, 1, "the first page awaits one bounded startup activity snapshot");

  await adapter.dispose();
  assert.equal(await reader.readPage({ limit: 1 }), undefined);
});

test("OpenCode adapter keeps a bounded HTTP fallback non-authoritative", async () => {
  let readerClosed = false;
  const unavailableReader: OpenCodeSessionIndexReader = {
    async readPage() { return undefined; },
    close() { readerClosed = true; },
  };
  let nativeLimit: string | null = null;
  let activityReads = 0;
  const fetchLike: FetchLike = async (input) => {
    const url = requestUrl(input);
    if (url.pathname === "/project") return jsonResponse([{ id: "global", worktree: "/" }]);
    if (url.pathname === "/session/status") return jsonResponse({});
    if (url.pathname === "/session") {
      nativeLimit = url.searchParams.get("limit");
      return jsonResponse([{ id: "recent", directory: "C:\\one", title: "Recent", time: { created: 1, updated: 1 } }]);
    }
    return new Response("not found", { status: 404 });
  };
  const adapter = new OpenCodeAdapter({
    hostId: "host_1",
    baseUrl: "http://127.0.0.1:4096/",
    fetch: fetchLike,
    activityReader: {
      async readWorkingSessionIds() {
        activityReads += 1;
        return new Set(["recent"]);
      },
      close() {},
    },
    catalogueReader: unavailableReader,
  });

  const page = await adapter.listSessions({ limit: 20 });
  assert.equal(page.authoritative, false);
  assert.equal(nativeLimit, "100");
  assert.equal(activityReads, 1, "HTTP fallback also coordinates with one bounded startup activity snapshot");
  await adapter.dispose();
  assert.equal(readerClosed, true);
});

test("OpenCode SQLite catalogue returns unavailable for a missing or incompatible database", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "uar-opencode-catalogue-unavailable-"));
  context.after(async () => await rm(directory, { recursive: true, force: true }));

  const missing = new SqliteOpenCodeSessionIndexReader({ databasePath: join(directory, "missing.db") });
  assert.equal(await missing.readPage({ limit: 20 }), undefined);
  missing.close();

  const incompatiblePath = join(directory, "incompatible.db");
  const database = new DatabaseSync(incompatiblePath);
  database.exec("CREATE TABLE unrelated (id TEXT PRIMARY KEY)");
  database.close();
  const incompatible = new SqliteOpenCodeSessionIndexReader({ databasePath: incompatiblePath });
  assert.equal(await incompatible.readPage({ limit: 20 }), undefined);
  incompatible.close();
});

async function createDatabase(prefix: string): Promise<{
  readonly directory: string;
  readonly databasePath: string;
  readonly database: DatabaseSync;
}> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const databasePath = join(directory, "opencode.db");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_archived INTEGER,
      agent TEXT,
      model TEXT
    );
  `);
  return { directory, databasePath, database };
}

async function collectIds(reader: OpenCodeSessionIndexReader, direction: "asc" | "desc"): Promise<readonly string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await reader.readPage({
      limit: 1,
      sortDirection: direction,
      ...(cursor === undefined ? {} : { cursor }),
    });
    assert.ok(page);
    ids.push(...page.entries.map((entry) => entry.id));
    cursor = page.nextCursor ?? undefined;
    if (page.nextCursor === null) break;
  } while (true);
  assert.equal(new Set(ids).size, ids.length);
  return ids;
}

function requestUrl(input: Parameters<FetchLike>[0]): URL {
  if (input instanceof URL) return input;
  if (typeof input === "string") return new URL(input);
  return new URL(input.url);
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}
