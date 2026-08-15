import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  resolve(here, "../supabase/migrations/202608120001_initial_tethoq.sql"),
  "utf8",
);

const publicTables = [
  "profiles",
  "workspaces",
  "workspace_memberships",
  "computers",
  "devices",
  "enrollment_challenges",
  "enrollment_audit_events",
];

test("every public table enables and forces row-level security", () => {
  for (const table of publicTables) {
    assert.match(
      migration,
      new RegExp(`alter table public\\.${table} enable row level security;`, "i"),
    );
    assert.match(
      migration,
      new RegExp(`alter table public\\.${table} force row level security;`, "i"),
    );
  }
});

test("workspace policies use non-recursive auth.uid scoped helpers", () => {
  for (const helper of ["is_workspace_member", "is_workspace_owner"]) {
    assert.match(
      migration,
      new RegExp(
        `create function public\\.${helper}\\(target_workspace_id uuid\\)[\\s\\S]*?security definer[\\s\\S]*?set search_path = ''[\\s\\S]*?membership\\.user_id = auth\\.uid\\(\\)`,
        "i",
      ),
    );
  }
  assert.match(migration, /create policy workspaces_select_members/i);
  assert.match(migration, /create policy computers_revoke_owners/i);
  assert.match(migration, /create policy devices_revoke_owner_or_self/i);
});

test("enrollment stores digests instead of raw pairing credentials", () => {
  assert.match(migration, /secret_hash bytea not null unique check \(octet_length\(secret_hash\) = 32\)/i);
  assert.match(migration, /verification_code_hash text check/i);
  assert.doesNotMatch(migration, /\b(?:secret|token|pairing_code|verification_code)\s+(?:text|bytea)\b/i);
  assert.match(migration, /expires_at <= created_at \+ interval '15 minutes'/i);
  assert.match(migration, /An expired enrollment challenge cannot be consumed/i);

  const challengeGrant = migration.match(
    /grant select \(([\s\S]*?)\) on table public\.enrollment_challenges to authenticated;/i,
  );
  assert.ok(challengeGrant, "expected a column-scoped challenge SELECT grant");
  assert.doesNotMatch(challengeGrant[1], /secret_hash|verification_code_hash/i);
});

test("audit events are append-only and clients cannot write them", () => {
  assert.match(
    migration,
    /create trigger enrollment_audit_events_append_only\s+before update or delete/i,
  );
  assert.match(
    migration,
    /revoke all privileges on table public\.enrollment_audit_events from public, anon, authenticated;/i,
  );
  assert.match(
    migration,
    /grant select, insert on table public\.enrollment_audit_events to service_role;/i,
  );
  assert.match(
    migration,
    /revoke update, delete, truncate on table public\.enrollment_audit_events from service_role;/i,
  );
  assert.doesNotMatch(
    migration,
    /grant\s+(?:insert|update|delete|truncate)[^;]*enrollment_audit_events[^;]*authenticated/i,
  );
});

test("new auth users receive a profile and personal owner workspace", () => {
  assert.match(migration, /create trigger on_auth_user_created\s+after insert on auth\.users/i);
  assert.match(migration, /insert into public\.profiles/i);
  assert.match(migration, /insert into public\.workspaces/i);
  assert.match(migration, /insert into public\.workspace_memberships/i);
  assert.match(migration, /values \(personal_workspace_id, new\.id, 'owner', new\.id\)/i);
});

test("client mutation grants are column-scoped and enrollment remains server-mediated", () => {
  assert.match(migration, /grant update \(revoked_at\) on table public\.computers to authenticated;/i);
  assert.match(migration, /grant update \(revoked_at\) on table public\.devices to authenticated;/i);
  assert.doesNotMatch(migration, /grant\s+insert[^;]*public\.computers[^;]*authenticated/i);
  assert.doesNotMatch(migration, /grant\s+insert[^;]*public\.devices[^;]*authenticated/i);
  assert.doesNotMatch(migration, /grant\s+(?:insert|update|delete)[^;]*public\.enrollment_challenges[^;]*authenticated/i);
});
