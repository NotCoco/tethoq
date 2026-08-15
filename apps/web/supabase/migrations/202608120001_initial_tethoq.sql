begin;

create extension if not exists pgcrypto with schema extensions;

create type public.workspace_role as enum ('owner', 'member');
create type public.computer_platform as enum ('windows', 'macos', 'linux', 'other');
create type public.device_platform as enum ('ios', 'android', 'web', 'other');
create type public.enrollment_kind as enum (
  'computer_enrollment',
  'device_enrollment',
  'direct_pairing'
);
create type public.enrollment_event_type as enum (
  'challenge_created',
  'challenge_attempt_failed',
  'challenge_consumed',
  'challenge_revoked',
  'computer_enrolled',
  'computer_revoked',
  'device_enrolled',
  'device_revoked'
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (display_name is null or char_length(display_name) between 1 and 100),
  avatar_url text check (avatar_url is null or char_length(avatar_url) <= 2048),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 100),
  created_by uuid references auth.users (id) on delete set null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspaces_archive_time check (archived_at is null or archived_at >= created_at)
);

create table public.workspace_memberships (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.workspace_role not null default 'member',
  invited_by uuid references auth.users (id) on delete set null default auth.uid(),
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id),
  constraint workspace_memberships_revocation_time check (
    revoked_at is null or revoked_at >= created_at
  )
);

create table public.computers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 100),
  platform public.computer_platform not null,
  bridge_version text check (bridge_version is null or char_length(bridge_version) <= 64),
  identity_public_key bytea not null check (octet_length(identity_public_key) = 32),
  enrolled_by uuid references auth.users (id) on delete set null,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id),
  unique (workspace_id, identity_public_key),
  constraint computers_last_seen_time check (last_seen_at is null or last_seen_at >= created_at),
  constraint computers_revocation_time check (revoked_at is null or revoked_at >= created_at)
);

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  name text not null check (char_length(btrim(name)) between 1 and 100),
  platform public.device_platform not null,
  app_version text check (app_version is null or char_length(app_version) <= 64),
  identity_public_key bytea not null check (octet_length(identity_public_key) = 32),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id),
  unique (workspace_id, identity_public_key),
  constraint devices_last_seen_time check (last_seen_at is null or last_seen_at >= created_at),
  constraint devices_revocation_time check (revoked_at is null or revoked_at >= created_at)
);

create table public.enrollment_challenges (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  kind public.enrollment_kind not null,
  requested_by uuid references auth.users (id) on delete set null,
  computer_id uuid,
  device_id uuid,
  secret_hash bytea not null unique check (octet_length(secret_hash) = 32),
  verification_code_hash text check (
    verification_code_hash is null
    or char_length(verification_code_hash) between 40 and 255
  ),
  attempt_count smallint not null default 0,
  max_attempts smallint not null default 6,
  expires_at timestamptz not null default (now() + interval '5 minutes'),
  consumed_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (computer_id, workspace_id)
    references public.computers (id, workspace_id) on delete restrict,
  foreign key (device_id, workspace_id)
    references public.devices (id, workspace_id) on delete restrict,
  constraint enrollment_challenges_attempts check (
    max_attempts between 1 and 20
    and attempt_count between 0 and max_attempts
  ),
  constraint enrollment_challenges_short_lived check (
    expires_at > created_at
    and expires_at <= created_at + interval '15 minutes'
  ),
  constraint enrollment_challenges_terminal_state check (
    not (consumed_at is not null and revoked_at is not null)
    and (consumed_at is null or consumed_at between created_at and expires_at)
    and (revoked_at is null or revoked_at >= created_at)
  ),
  constraint enrollment_challenges_target_shape check (
    (kind = 'computer_enrollment' and device_id is null)
    or (kind = 'device_enrollment' and computer_id is null)
    or (kind = 'direct_pairing' and computer_id is not null)
  ),
  constraint enrollment_challenges_consumed_target check (
    consumed_at is null
    or (kind = 'computer_enrollment' and computer_id is not null)
    or (kind in ('device_enrollment', 'direct_pairing') and device_id is not null)
  )
);

comment on column public.enrollment_challenges.secret_hash is
  'Exactly 32 bytes: a SHA-256 digest of a server-generated high-entropy secret. Never the secret itself.';
comment on column public.enrollment_challenges.verification_code_hash is
  'A salted slow password hash (for example bcrypt or Argon2id) of the optional human verification code.';

create table public.enrollment_audit_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  event_type public.enrollment_event_type not null,
  actor_user_id uuid,
  challenge_id uuid,
  computer_id uuid,
  device_id uuid,
  details jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  foreign key (challenge_id, workspace_id)
    references public.enrollment_challenges (id, workspace_id) on delete restrict,
  foreign key (computer_id, workspace_id)
    references public.computers (id, workspace_id) on delete restrict,
  foreign key (device_id, workspace_id)
    references public.devices (id, workspace_id) on delete restrict,
  constraint enrollment_audit_details_object check (jsonb_typeof(details) = 'object'),
  constraint enrollment_audit_no_secrets check (
    not (details ?| array[
      'secret', 'secret_hash', 'token', 'pairing_code', 'verification_code',
      'verification_code_hash'
    ])
  )
);

create index workspace_memberships_active_user_idx
  on public.workspace_memberships (user_id, workspace_id)
  where revoked_at is null;
create index computers_active_workspace_idx
  on public.computers (workspace_id, last_seen_at desc)
  where revoked_at is null;
create index devices_active_workspace_idx
  on public.devices (workspace_id, last_seen_at desc)
  where revoked_at is null;
create index devices_active_user_idx
  on public.devices (user_id, workspace_id)
  where revoked_at is null and user_id is not null;
create index enrollment_challenges_active_idx
  on public.enrollment_challenges (workspace_id, expires_at)
  where consumed_at is null and revoked_at is null;
create index enrollment_challenges_computer_idx
  on public.enrollment_challenges (computer_id)
  where computer_id is not null;
create index enrollment_challenges_device_idx
  on public.enrollment_challenges (device_id)
  where device_id is not null;
create index enrollment_audit_workspace_time_idx
  on public.enrollment_audit_events (workspace_id, occurred_at desc);
create index enrollment_audit_challenge_idx
  on public.enrollment_audit_events (challenge_id, occurred_at desc)
  where challenge_id is not null;

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := statement_timestamp();
  return new;
end;
$$;

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();
create trigger workspaces_set_updated_at
before update on public.workspaces
for each row execute function public.set_updated_at();
create trigger workspace_memberships_set_updated_at
before update on public.workspace_memberships
for each row execute function public.set_updated_at();
create trigger computers_set_updated_at
before update on public.computers
for each row execute function public.set_updated_at();
create trigger devices_set_updated_at
before update on public.devices
for each row execute function public.set_updated_at();
create trigger enrollment_challenges_set_updated_at
before update on public.enrollment_challenges
for each row execute function public.set_updated_at();

create function public.enforce_irreversible_revocation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'A revocation cannot be cleared or changed';
  end if;

  if old.revoked_at is null and new.revoked_at is not null then
    new.revoked_by := coalesce(new.revoked_by, auth.uid());
  end if;

  return new;
end;
$$;

create trigger workspace_memberships_irreversible_revocation
before update on public.workspace_memberships
for each row execute function public.enforce_irreversible_revocation();
create trigger computers_irreversible_revocation
before update on public.computers
for each row execute function public.enforce_irreversible_revocation();
create trigger devices_irreversible_revocation
before update on public.devices
for each row execute function public.enforce_irreversible_revocation();
create trigger enrollment_challenges_irreversible_revocation
before update on public.enrollment_challenges
for each row execute function public.enforce_irreversible_revocation();

create function public.enforce_challenge_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.workspace_id is distinct from new.workspace_id
    or old.kind is distinct from new.kind
    or old.requested_by is distinct from new.requested_by
    or old.secret_hash is distinct from new.secret_hash
    or old.verification_code_hash is distinct from new.verification_code_hash
    or old.expires_at is distinct from new.expires_at
    or old.max_attempts is distinct from new.max_attempts then
    raise exception 'Enrollment challenge identity and credential fields are immutable';
  end if;

  if old.consumed_at is not null then
    raise exception 'A consumed enrollment challenge is immutable';
  end if;

  if new.attempt_count < old.attempt_count then
    raise exception 'Enrollment challenge attempt count cannot decrease';
  end if;

  if old.consumed_at is null and new.consumed_at is not null
    and statement_timestamp() > old.expires_at then
    raise exception 'An expired enrollment challenge cannot be consumed';
  end if;

  return new;
end;
$$;

create trigger enrollment_challenges_enforce_transition
before update on public.enrollment_challenges
for each row execute function public.enforce_challenge_transition();

create function public.prevent_enrollment_audit_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Enrollment audit events are append-only';
end;
$$;

create trigger enrollment_audit_events_append_only
before update or delete on public.enrollment_audit_events
for each row execute function public.prevent_enrollment_audit_mutation();

create function public.audit_computer_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.enrollment_audit_events (
      workspace_id, event_type, actor_user_id, computer_id
    ) values (
      new.workspace_id, 'computer_enrolled', auth.uid(), new.id
    );
  elsif old.revoked_at is null and new.revoked_at is not null then
    insert into public.enrollment_audit_events (
      workspace_id, event_type, actor_user_id, computer_id
    ) values (
      new.workspace_id, 'computer_revoked', coalesce(new.revoked_by, auth.uid()), new.id
    );
  end if;

  return new;
end;
$$;

create function public.audit_device_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.enrollment_audit_events (
      workspace_id, event_type, actor_user_id, device_id
    ) values (
      new.workspace_id, 'device_enrolled', auth.uid(), new.id
    );
  elsif old.revoked_at is null and new.revoked_at is not null then
    insert into public.enrollment_audit_events (
      workspace_id, event_type, actor_user_id, device_id
    ) values (
      new.workspace_id, 'device_revoked', coalesce(new.revoked_by, auth.uid()), new.id
    );
  end if;

  return new;
end;
$$;

create function public.audit_challenge_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.enrollment_audit_events (
      workspace_id, event_type, actor_user_id, challenge_id, computer_id, device_id
    ) values (
      new.workspace_id, 'challenge_created', auth.uid(), new.id, new.computer_id, new.device_id
    );
  elsif old.consumed_at is null and new.consumed_at is not null then
    insert into public.enrollment_audit_events (
      workspace_id, event_type, actor_user_id, challenge_id, computer_id, device_id
    ) values (
      new.workspace_id, 'challenge_consumed', auth.uid(), new.id, new.computer_id, new.device_id
    );
  elsif old.revoked_at is null and new.revoked_at is not null then
    insert into public.enrollment_audit_events (
      workspace_id, event_type, actor_user_id, challenge_id, computer_id, device_id
    ) values (
      new.workspace_id, 'challenge_revoked', coalesce(new.revoked_by, auth.uid()),
      new.id, new.computer_id, new.device_id
    );
  elsif new.attempt_count > old.attempt_count then
    insert into public.enrollment_audit_events (
      workspace_id, event_type, actor_user_id, challenge_id, computer_id, device_id, details
    ) values (
      new.workspace_id, 'challenge_attempt_failed', auth.uid(), new.id,
      new.computer_id, new.device_id, jsonb_build_object('attempt_count', new.attempt_count)
    );
  end if;

  return new;
end;
$$;

create trigger computers_write_audit
after insert or update on public.computers
for each row execute function public.audit_computer_change();
create trigger devices_write_audit
after insert or update on public.devices
for each row execute function public.audit_device_change();
create trigger enrollment_challenges_write_audit
after insert or update on public.enrollment_challenges
for each row execute function public.audit_challenge_change();

create function public.is_workspace_member(target_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_memberships as membership
    where membership.workspace_id = target_workspace_id
      and membership.user_id = auth.uid()
      and membership.revoked_at is null
  );
$$;

create function public.is_workspace_owner(target_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_memberships as membership
    where membership.workspace_id = target_workspace_id
      and membership.user_id = auth.uid()
      and membership.role = 'owner'
      and membership.revoked_at is null
  );
$$;

create function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  personal_workspace_id uuid := gen_random_uuid();
  profile_name text;
  profile_avatar text;
begin
  profile_name := nullif(left(btrim(coalesce(
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'name',
    ''
  )), 100), '');
  profile_avatar := nullif(left(btrim(coalesce(
    new.raw_user_meta_data ->> 'avatar_url',
    ''
  )), 2048), '');

  insert into public.profiles (id, display_name, avatar_url)
  values (new.id, profile_name, profile_avatar);

  insert into public.workspaces (id, name, created_by)
  values (personal_workspace_id, 'Personal workspace', new.id);

  insert into public.workspace_memberships (workspace_id, user_id, role, invited_by)
  values (personal_workspace_id, new.id, 'owner', new.id);

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_auth_user();

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_memberships enable row level security;
alter table public.computers enable row level security;
alter table public.devices enable row level security;
alter table public.enrollment_challenges enable row level security;
alter table public.enrollment_audit_events enable row level security;

alter table public.profiles force row level security;
alter table public.workspaces force row level security;
alter table public.workspace_memberships force row level security;
alter table public.computers force row level security;
alter table public.devices force row level security;
alter table public.enrollment_challenges force row level security;
alter table public.enrollment_audit_events force row level security;

create policy profiles_select_self
on public.profiles for select
to authenticated
using (id = auth.uid());

create policy profiles_update_self
on public.profiles for update
to authenticated
using (id = auth.uid())
with check (id = auth.uid());

create policy workspaces_select_members
on public.workspaces for select
to authenticated
using (public.is_workspace_member(id));

create policy workspaces_update_owners
on public.workspaces for update
to authenticated
using (public.is_workspace_owner(id))
with check (public.is_workspace_owner(id));

create policy workspace_memberships_select_members
on public.workspace_memberships for select
to authenticated
using (public.is_workspace_member(workspace_id));

create policy workspace_memberships_insert_owners
on public.workspace_memberships for insert
to authenticated
with check (public.is_workspace_owner(workspace_id));

create policy workspace_memberships_update_owners
on public.workspace_memberships for update
to authenticated
using (public.is_workspace_owner(workspace_id))
with check (public.is_workspace_owner(workspace_id));

create policy computers_select_members
on public.computers for select
to authenticated
using (public.is_workspace_member(workspace_id));

create policy computers_revoke_owners
on public.computers for update
to authenticated
using (public.is_workspace_owner(workspace_id))
with check (public.is_workspace_owner(workspace_id) and revoked_at is not null);

create policy devices_select_members
on public.devices for select
to authenticated
using (public.is_workspace_member(workspace_id));

create policy devices_revoke_owner_or_self
on public.devices for update
to authenticated
using (
  public.is_workspace_owner(workspace_id)
  or (user_id = auth.uid() and public.is_workspace_member(workspace_id))
)
with check (
  revoked_at is not null
  and (
    public.is_workspace_owner(workspace_id)
    or (user_id = auth.uid() and public.is_workspace_member(workspace_id))
  )
);

create policy enrollment_challenges_select_members
on public.enrollment_challenges for select
to authenticated
using (public.is_workspace_member(workspace_id));

create policy enrollment_audit_select_owners
on public.enrollment_audit_events for select
to authenticated
using (public.is_workspace_owner(workspace_id));

revoke create on schema public from public;
grant usage on schema public to anon, authenticated, service_role;

revoke all privileges on table public.profiles from public, anon, authenticated;
revoke all privileges on table public.workspaces from public, anon, authenticated;
revoke all privileges on table public.workspace_memberships from public, anon, authenticated;
revoke all privileges on table public.computers from public, anon, authenticated;
revoke all privileges on table public.devices from public, anon, authenticated;
revoke all privileges on table public.enrollment_challenges from public, anon, authenticated;
revoke all privileges on table public.enrollment_audit_events from public, anon, authenticated;

grant select on table public.profiles to authenticated;
grant update (display_name, avatar_url) on table public.profiles to authenticated;
grant select on table public.workspaces to authenticated;
grant update (name) on table public.workspaces to authenticated;
grant select on table public.workspace_memberships to authenticated;
grant insert (workspace_id, user_id, role), update (role, revoked_at)
  on table public.workspace_memberships to authenticated;
grant select on table public.computers to authenticated;
grant update (revoked_at) on table public.computers to authenticated;
grant select on table public.devices to authenticated;
grant update (revoked_at) on table public.devices to authenticated;
grant select (
  id, workspace_id, kind, requested_by, computer_id, device_id,
  attempt_count, max_attempts, expires_at, consumed_at, revoked_at,
  created_at, updated_at
) on table public.enrollment_challenges to authenticated;
grant select on table public.enrollment_audit_events to authenticated;

grant all privileges on table public.profiles to service_role;
grant all privileges on table public.workspaces to service_role;
grant all privileges on table public.workspace_memberships to service_role;
grant all privileges on table public.computers to service_role;
grant all privileges on table public.devices to service_role;
grant all privileges on table public.enrollment_challenges to service_role;
grant select, insert on table public.enrollment_audit_events to service_role;
revoke update, delete, truncate on table public.enrollment_audit_events from service_role;

revoke all on function public.set_updated_at() from public, anon, authenticated;
revoke all on function public.enforce_irreversible_revocation() from public, anon, authenticated;
revoke all on function public.enforce_challenge_transition() from public, anon, authenticated;
revoke all on function public.prevent_enrollment_audit_mutation() from public, anon, authenticated;
revoke all on function public.audit_computer_change() from public, anon, authenticated;
revoke all on function public.audit_device_change() from public, anon, authenticated;
revoke all on function public.audit_challenge_change() from public, anon, authenticated;
revoke all on function public.handle_new_auth_user() from public, anon, authenticated;
revoke all on function public.is_workspace_member(uuid) from public, anon;
revoke all on function public.is_workspace_owner(uuid) from public, anon;
grant execute on function public.is_workspace_member(uuid) to authenticated, service_role;
grant execute on function public.is_workspace_owner(uuid) to authenticated, service_role;

commit;
