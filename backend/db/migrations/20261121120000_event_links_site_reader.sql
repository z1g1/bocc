-- Migration 0009 — event_links and the site_reader role (ADR 0009 decisions 3 and 4;
-- admin app plan Phase 4).
--
-- Applied by backend/scripts/migrate.js in ONE transaction; guarded so it also applies
-- on a vanilla Postgres (scripts/test-db.sh).
--
-- event_links: one listing per (event, platform). All four platforms are expected
-- every week; the admin event page's readiness checklist is calculated from these rows.
-- `external_id` holds the platform's own id where the site needs it: for Luma the
-- `evt-…` id the RSVP embed is built from (what luma_events.yml calls `id`).
-- Text + CHECK, not an enum type, like the Phase 3 tables (see migration 0006).
--
-- Grants:
--   admin_app    SELECT, INSERT, UPDATE, DELETE. DELETE is new for this table
--                (ADR 0008 decision 6 lists DELETE only on event_media; amended
--                2026-11-18: removing a wrong listing is a normal edit, and the
--                audit row in the same transaction records what was removed).
--   site_reader  NEW role for the public /events/YYYY-MM-DD pages rendered on request
--                (ADR 0009 decision 4): SELECT on events and event_links only. It never
--                sees reports, media, attendees, check-ins or auth. Created NOLOGIN;
--                the operator sets LOGIN + a password out of band, like admin_app.
--                Kept apart from admin_app so public traffic never holds the admin's
--                credentials.

create table public.event_links (
    event_date   date        not null references public.events (event_date),
    platform     text        not null
                             check (platform in ('luma', 'eventbrite', 'facebook_event', 'linkedin_event')),
    url          text        not null check (url ~ '^https://[^\s]+$' and length(url) <= 500),
    external_id  text        check (external_id is null or (external_id ~ '^[A-Za-z0-9_-]{1,100}$')),
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now(),
    primary key (event_date, platform)
);

create trigger event_links_set_updated_at
    before update on public.event_links
    for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- Roles and grants
-- ─────────────────────────────────────────────────────────────────────────────
do $$
begin
    if not exists (select 1 from pg_roles where rolname = 'site_reader') then
        create role site_reader nologin noinherit;
    end if;
end $$;

revoke all on public.event_links from public;
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'anon') then
        revoke all on public.event_links from anon;
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
        revoke all on public.event_links from authenticated;
    end if;
end $$;

grant select, insert, update, delete on public.event_links to admin_app;

grant usage on schema public to site_reader;
grant select on public.events, public.event_links to site_reader;
