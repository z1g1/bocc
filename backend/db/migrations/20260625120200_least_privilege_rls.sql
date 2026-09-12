-- Migration 0003 — least-privilege access + RLS (ADR 0003)
--
-- The check-in Netlify function reaches Postgres as a SCOPED role (`checkin_writer`),
-- NEVER as service_role (which bypasses RLS and is the "full admin key" our security
-- policy forbids). RLS denies Supabase's public PostgREST roles (anon/authenticated)
-- entirely, so even a leaked anon key can read/write nothing. See
-- docs/backend/SUPABASE_PERMISSIONS.md for the connection + key handling.

-- 1. Enable RLS and revoke Supabase's default public grants (defense in depth).
--    The anon/authenticated roles are created by Supabase; guard so this migration
--    also applies on a vanilla Postgres (local test / CI) where they don't exist.
alter table public.attendees enable row level security;
alter table public.checkins  enable row level security;

do $$
begin
    if exists (select 1 from pg_roles where rolname = 'anon') then
        revoke all on public.attendees, public.checkins,
                       public.held_occurrences, public.streaks from anon;
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
        revoke all on public.attendees, public.checkins,
                       public.held_occurrences, public.streaks from authenticated;
    end if;
end $$;

-- 2. The scoped role. Created NOLOGIN; the operator enables exactly ONE access path
--    out-of-band (kept out of version control) — see SUPABASE_PERMISSIONS.md:
--      (a) direct Postgres via the Supabase pooler:  ALTER ROLE checkin_writer LOGIN PASSWORD '…';
--      (b) PostgREST/supabase-js with a custom-role JWT: the grant below lets the
--          authenticator switch into checkin_writer.
do $$
begin
    if not exists (select 1 from pg_roles where rolname = 'checkin_writer') then
        create role checkin_writer nologin noinherit;
    end if;
end $$;

-- Lets PostgREST's authenticator switch into checkin_writer (path b). Guarded for
-- vanilla Postgres where the Supabase authenticator role is absent.
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'authenticator') then
        grant checkin_writer to authenticator;
    end if;
end $$;

grant usage on schema public to checkin_writer;

-- 3. EXACTLY the privileges the check-in flow needs — no DELETE, no UPDATE, no DDL,
--    no access to any other schema. (Add UPDATE on attendees only if you later let a
--    returning attendee change their consent/details.)
grant select, insert on public.attendees        to checkin_writer;
grant select, insert on public.checkins          to checkin_writer;
grant select         on public.held_occurrences  to checkin_writer;
grant select         on public.streaks           to checkin_writer;

-- 4. RLS policies for checkin_writer. The data is NOT row-partitioned — streak math
--    must read across all attendees to know which weeks were held — so row access is
--    full; least-privilege is enforced at the OPERATION level by the grants in step 3.
create policy checkin_writer_rw on public.attendees
    for all to checkin_writer using (true) with check (true);
create policy checkin_writer_rw on public.checkins
    for all to checkin_writer using (true) with check (true);
