-- Migration 0023 — Photo from Event: the kind value 'social_photo' becomes 'event_photo'
-- (ticket #54, parent #49; GLOSSARY.md "Photo from Event"; ADR 0010 amendment 2026-12-03)
--
-- Applied by backend/scripts/migrate.js in ONE transaction; plain SQL, so it also applies
-- on a vanilla Postgres (scripts/test-db.sh).
--
-- The VALUE half that migration 20261203120000_glossary_rename_expand.sql left to this
-- ticket (see its "VALUES" note). That migration already made the kind CHECKs accept both
-- values, including the publicly-usable rule (only a Photo from Event may be publicly
-- usable; a Sign-in board photo never is) and the 16:9 copy rule. This file:
--   1. backfills every 'social_photo' row to 'event_photo' (updated_at trigger disabled:
--      no content changes), and
--   2. adds a BEFORE INSERT OR UPDATE trigger that rewrites a 'social_photo' write to
--      'event_photo', for the code live before the deploy (CI runs this a few minutes
--      first) and for a stale admin tab, whose static browser JS still posts the old kind
--      (the server also normalises it, src/lib/admin/media.mjs).
-- During that window, the old code's queries that FILTER on 'social_photo' (the pickers,
-- the 16:9 remake) match nothing; they come back with the new code minutes later.
--
-- CONTRACT LATER (#60): drop the trigger and its function, and tighten the CHECKs to
-- 'event_photo' only.

alter table public.event_media disable trigger event_media_set_updated_at;
update public.event_media set kind = 'event_photo' where kind = 'social_photo';
alter table public.event_media enable trigger event_media_set_updated_at;

create function public.event_media_event_photo_compat() returns trigger
    language plpgsql
as $$
begin
    if new.kind = 'social_photo' then
        new.kind := 'event_photo';
    end if;
    return new;
end;
$$;
comment on function public.event_media_event_photo_compat() is
    'DEPRECATED (migration 20261203150000): rewrites the old kind social_photo to event_photo. Dropped by the contract migration.';
revoke all on function public.event_media_event_photo_compat() from public;

create trigger event_media_event_photo_compat
    before insert or update of kind on public.event_media
    for each row execute function public.event_media_event_photo_compat();
