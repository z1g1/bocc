-- Migration 0012 — linkedin_connections: each Admin's own LinkedIn connection (ADR 0012
-- decision 4, issue #23).
--
-- Applied by backend/scripts/migrate.js in ONE transaction; guarded so it also applies
-- on a vanilla Postgres (scripts/test-db.sh).
--
-- One row per user. The access token is never stored in plaintext: token_ciphertext is
-- AES-256-GCM under a key derived from LINKEDIN_TOKEN_KEY (Netlify env, never in the
-- database), laid out as [version][12-byte IV][16-byte tag][ciphertext] with the user id
-- as associated data (src/lib/linkedin/crypto.mjs). Reconnecting replaces the row;
-- Disconnect deletes it. Deleting the user deletes the connection.
--
-- Grants:
--   admin_app       SELECT, INSERT, UPDATE, DELETE
--   social_checker  nothing yet (the Thursday expiry alert, #24, adds a column grant)
--   site_reader, checkin_writer  nothing

create table public.linkedin_connections (
    user_id           text primary key references "auth"."user" ("id") on delete cascade,
    token_ciphertext  bytea not null check (octet_length(token_ciphertext) > 29),
    expires_at        timestamptz not null,
    member_urn        text not null check (member_urn ~ '^urn:li:person:[A-Za-z0-9_-]+$'),
    display_name      text not null check (char_length(display_name) between 1 and 200),
    scope             text not null default '' check (char_length(scope) <= 500),
    connected_at      timestamptz not null default now(),
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now()
);

comment on table public.linkedin_connections is
    'One LinkedIn OAuth connection per admin user (ADR 0012). token_ciphertext is AES-256-GCM, never plaintext.';

create trigger linkedin_connections_set_updated_at
    before update on public.linkedin_connections
    for each row execute function public.set_updated_at();

revoke all on public.linkedin_connections from public;
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'anon') then
        revoke all on public.linkedin_connections from anon;
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
        revoke all on public.linkedin_connections from authenticated;
    end if;
end $$;

grant select, insert, update, delete on public.linkedin_connections to admin_app;
