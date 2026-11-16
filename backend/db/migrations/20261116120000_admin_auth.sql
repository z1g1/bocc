-- Migration 0005 — admin login, roles and audit log (ADR 0008, admin app plan Phase 2)
--
-- 1. Better Auth's tables in the `auth` schema
-- 2. public.user_roles: the ONLY place roles live (admin | social)
-- 3. public.audit_log: append-only; a trigger rejects UPDATE/DELETE/TRUNCATE
-- 4. the `admin_app` role (NOLOGIN; password set out of band) and exactly its grants
--
-- Applied by backend/scripts/migrate.js in ONE transaction, so nothing here may need
-- its own transaction (no CREATE INDEX CONCURRENTLY, no ALTER TYPE … ADD VALUE).
-- Guarded so it also applies on a vanilla Postgres (scripts/test-db.sh).
-- Phase 3+ tables (events, event_reports, event_links, event_media, social_posts,
-- social_post_channels) get their admin_app grants in their own migrations.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Better Auth schema. Generated with `npx auth@1.7.25 generate` against
--    src/lib/auth/auth.mjs (emailAndPassword, rateLimit storage "database", admin
--    plugin, passkey plugin, schemaName "auth"). Kept verbatim apart from line
--    breaks. The admin plugin's user.role/banned/… and session.impersonatedBy
--    columns are part of its schema; the app never reads `role` (roles are in
--    public.user_roles). Re-run the generator after a Better Auth upgrade and add
--    any difference as a NEW migration.
-- ─────────────────────────────────────────────────────────────────────────────
create schema if not exists "auth";

create table "auth"."user" (
    "id" text not null primary key, "name" text not null, "email" text not null unique,
    "emailVerified" boolean not null, "image" text,
    "createdAt" timestamptz default CURRENT_TIMESTAMP not null,
    "updatedAt" timestamptz default CURRENT_TIMESTAMP not null,
    "role" text, "banned" boolean, "banReason" text, "banExpires" timestamptz);

create table "auth"."session" (
    "id" text not null primary key, "expiresAt" timestamptz not null,
    "token" text not null unique,
    "createdAt" timestamptz default CURRENT_TIMESTAMP not null,
    "updatedAt" timestamptz not null, "ipAddress" text, "userAgent" text,
    "userId" text not null references "auth"."user" ("id") on delete cascade,
    "impersonatedBy" text);

create table "auth"."account" (
    "id" text not null primary key, "accountId" text not null, "providerId" text not null,
    "userId" text not null references "auth"."user" ("id") on delete cascade,
    "accessToken" text, "refreshToken" text, "idToken" text,
    "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz,
    "scope" text, "password" text,
    "createdAt" timestamptz default CURRENT_TIMESTAMP not null,
    "updatedAt" timestamptz not null);

create table "auth"."verification" (
    "id" text not null primary key, "identifier" text not null, "value" text not null,
    "expiresAt" timestamptz not null,
    "createdAt" timestamptz default CURRENT_TIMESTAMP not null,
    "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

create table "auth"."passkey" (
    "id" text not null primary key, "name" text, "publicKey" text not null,
    "userId" text not null references "auth"."user" ("id") on delete cascade,
    "credentialID" text not null, "counter" integer not null, "deviceType" text not null,
    "backedUp" boolean not null, "transports" text, "createdAt" timestamptz, "aaguid" text);

create table "auth"."rateLimit" (
    "id" text not null primary key, "key" text not null unique, "count" integer not null,
    "lastRequest" bigint not null);

create index "session_userId_idx" on "auth"."session" ("userId");
create index "account_userId_idx" on "auth"."account" ("userId");
create index "verification_identifier_idx" on "auth"."verification" ("identifier");
create index "passkey_userId_idx" on "auth"."passkey" ("userId");
create index "passkey_credentialID_idx" on "auth"."passkey" ("credentialID");

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Roles. A user with no row here sees nothing (ADR 0008 decision 4). A user may
--    hold both roles. Deleting a Better Auth user removes their roles.
-- ─────────────────────────────────────────────────────────────────────────────
create table public.user_roles (
    user_id    text        not null references "auth"."user" ("id") on delete cascade,
    role       text        not null check (role in ('admin', 'social')),
    created_at timestamptz not null default now(),
    primary key (user_id, role)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Audit log. Each admin change and its audit row are written in ONE transaction
--    (src/lib/admin/db.mjs withAudit). actor_user_id has no foreign key on purpose:
--    the history must outlive the account, and an ON DELETE action would be an UPDATE
--    or DELETE that the trigger below refuses. NULL actor = the operator's CLI.
-- ─────────────────────────────────────────────────────────────────────────────
create table public.audit_log (
    id            bigint      generated always as identity primary key,
    occurred_at   timestamptz not null default now(),
    actor_user_id text,
    action        text        not null,
    target_table  text,
    target_id     text,
    details       jsonb       not null default '{}'::jsonb
);

create index audit_log_occurred_at_idx on public.audit_log (occurred_at desc);
create index audit_log_target_idx      on public.audit_log (target_table, target_id);

-- Defense in depth on top of the grants: even a role that somehow had UPDATE/DELETE
-- (or the owner by mistake) can't rewrite history. Erasing rows needs the owner to
-- drop or disable this trigger deliberately.
create function public.audit_log_append_only() returns trigger
    language plpgsql
as $$
begin
    raise exception 'audit_log is append-only (% refused)', tg_op
        using errcode = 'insufficient_privilege';
end;
$$;

create trigger audit_log_no_update_delete
    before update or delete on public.audit_log
    for each row execute function public.audit_log_append_only();

create trigger audit_log_no_truncate
    before truncate on public.audit_log
    for each statement execute function public.audit_log_append_only();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. The admin_app role: the admin functions AND Better Auth (ADR 0008 decision 6).
--    Created NOLOGIN; the operator sets LOGIN + a password out of band, like
--    checkin_writer (docs/backend/NEON_PERMISSIONS.md).
-- ─────────────────────────────────────────────────────────────────────────────
do $$
begin
    if not exists (select 1 from pg_roles where rolname = 'admin_app') then
        create role admin_app nologin noinherit;
    end if;
end $$;

-- Nobody but the owner and admin_app reaches the new objects.
revoke all on schema "auth" from public;
revoke all on all tables in schema "auth" from public;
revoke all on public.user_roles, public.audit_log from public;
revoke all on function public.audit_log_append_only() from public;
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'anon') then
        revoke all on public.user_roles, public.audit_log from anon;
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
        revoke all on public.user_roles, public.audit_log from authenticated;
    end if;
end $$;

-- auth schema: Better Auth reads and writes all of its own tables. No DDL: schema
-- changes come from migrations run as the owner. (Tables added to `auth` later need
-- their own grant in that migration.)
grant usage on schema "auth" to admin_app;
grant select, insert, update, delete on all tables in schema "auth" to admin_app;

-- Attendee and check-in data: read, plus the four correctable attendee columns.
-- No INSERT, no DELETE, no other column.
grant usage on schema public to admin_app;
grant select on public.attendees, public.checkins,
                public.held_occurrences, public.streaks to admin_app;
grant update (ok_to_email, name, business_name, phone) on public.attendees to admin_app;

-- Roles: admins assign and remove them. No UPDATE (remove + add instead).
grant select, insert, delete on public.user_roles to admin_app;

-- Audit log: append and read only.
grant select, insert on public.audit_log to admin_app;
grant usage on sequence public.audit_log_id_seq to admin_app;

-- RLS is on for attendees and checkins (migration 0003). Rows aren't partitioned, so
-- admin_app sees every row; what it may do is limited by the grants above. There is
-- deliberately no INSERT or DELETE policy.
create policy admin_app_select on public.attendees
    for select to admin_app using (true);
create policy admin_app_update on public.attendees
    for update to admin_app using (true) with check (true);
create policy admin_app_select on public.checkins
    for select to admin_app using (true);
