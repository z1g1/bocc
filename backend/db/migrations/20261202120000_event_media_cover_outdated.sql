-- Migration 0020 — remake every 16:9 version under the new rule (ticket #40, parent #18)
--
-- The 16:9 version of an Event Image (event_media.cover_key, migration 0013) used to be
-- a centre crop. It is now the image at full height, centred on the "Just the Beans"
-- background, never cropped. Every 16:9 version already made (an uploaded Event Image,
-- or a Photo from Event given one when picked, migration 0016) is marked outdated here.
--
-- cover_outdated: true while the 16:9 version at cover_key was made under the old rule.
-- The browser remakes it (the event page does it on open; /admin/media/covers/ does all
-- of them) and PUTs the new file to the SAME key, so a posted LinkedIn event's recorded
-- image ref (linkedin_events.image_ref) is unchanged and shows no drift. Completing the
-- remake (src/lib/admin/media.mjs completeCover, audited `media.cover` with remade:
-- true) clears the flag. New rows default to false: their version is made by the new
-- rule. While the flag is set the version is still shown, but not sent to LinkedIn
-- (src/lib/admin/event-image.mjs loadCoverBytes).
--
-- Grants: none new. admin_app has table-level SELECT/INSERT/UPDATE on event_media, which
-- covers the new column; social_checker's column grant is unchanged.

alter table public.event_media add column cover_outdated boolean not null default false;

alter table public.event_media add constraint event_media_cover_outdated_ck
    check (not cover_outdated or cover_key is not null);

update public.event_media set cover_outdated = true where cover_key is not null;
