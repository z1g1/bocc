-- Migration 0011 — the social_checker role for the Thursday social check (ADR 0011
-- decision 5, amended 2026-11-18; admin app plan Phase 5).
--
-- Applied by backend/scripts/migrate.js in ONE transaction; guarded so it also applies
-- on a vanilla Postgres (scripts/test-db.sh).
--
-- The Netlify scheduled function backend/netlify/functions/social-check.mjs reads the
-- next Tuesday's work order (src/lib/social-alert/run.mjs) and pushes an alert through
-- ntfy when a channel isn't scheduled yet. It only reads, so it gets its own read-only
-- role instead of admin_app's credential (which can write events, media and auth):
--
--   social_checker  NEW, NOLOGIN NOINHERIT; the operator sets LOGIN + a password out of
--                   band, like admin_app and site_reader. Its URL is SOCIAL_CHECK_DB_URL.
--     USAGE on schema public
--     SELECT on events, event_links, social_posts, social_post_channels
--     SELECT (id, event_date, kind, status) on event_media: enough to tell whether the
--                   attached promo video is ready; never the object keys, sizes or uploader
--   Nothing else: no attendees, check-ins, reports, audit_log, user_roles or auth, and
--   no INSERT/UPDATE/DELETE anywhere.

do $$
begin
    if not exists (select 1 from pg_roles where rolname = 'social_checker') then
        create role social_checker nologin noinherit;
    end if;
end $$;

grant usage on schema public to social_checker;
grant select on public.events, public.event_links, public.social_posts, public.social_post_channels to social_checker;
grant select (id, event_date, kind, status) on public.event_media to social_checker;
