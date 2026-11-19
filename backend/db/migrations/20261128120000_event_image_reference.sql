-- Migration 0016 — the Event Image picked from a Photo from Event (ADR 0012 decision 3, ticket #21)
--
-- Instead of uploading, an Admin can pick a publicly usable Photo from Event of a recent
-- event as this event's Event Image. The event then REFERENCES that photo (no copy):
--   events.event_image_media_id  -> event_media(id), null = no picked photo
-- Resolution (src/lib/admin/event-image-rules.mjs): an uploaded event_image row wins,
-- then this reference, then the BOCC logo. The app keeps at most one of the first two:
-- picking deletes an uploaded image, and an upload or a clear drops the reference.
--
-- The photo's 16:9 cover copy is event_media.cover_key (migration 0013 already allows it
-- on a social_photo); one is made in the browser when a photo without one is picked.
--
-- The foreign key has no ON DELETE action, so deleting a referenced photo is refused by
-- the database too; src/lib/admin/media.mjs deleteMedia checks first and names the
-- events that use it. That the referenced row is a ready, publicly usable social_photo
-- is checked by the app on pick (a CHECK can't look at another table).
--
-- Grants: none new. admin_app has table-level SELECT/INSERT/UPDATE on events, so the new
-- column is covered. site_reader and social_checker read events table-wide and so see an
-- opaque uuid, which they don't use.

alter table public.events
    add column event_image_media_id uuid references public.event_media (id);

create index events_event_image_media_id_idx on public.events (event_image_media_id)
    where event_image_media_id is not null;
