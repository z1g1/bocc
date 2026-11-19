-- Migration 0012 — the Event Image (ADR 0012 decision 3, ticket #20)
--
-- One image per event for every Online Event Listing of the week. It is a new
-- event_media kind, `event_image`, in the same private bucket with presigned links:
--   original_key  the uploaded PNG/JPEG (the square/original, for Luma)
--   display_key   1600px JPEG, thumb_key 400px JPEG (as photos)
--   cover_key     NEW: a 16:9 centre-crop JPEG made in the browser
--                 (events/<date>/<id>/cover.jpg), for the listings entered by hand and
--                 LinkedIn. Also allowed on social_photo, so a photo picked as an
--                 Event Image by reference (ticket #21) can be given one.
--
-- At most one READY event_image per event (a partial unique index). Pending rows are
-- uploads in progress: a replacement is uploaded alongside the current image, and on
-- complete the old row is deleted and the new one marked ready in one transaction
-- (src/lib/admin/media.mjs completeUpload).
--
-- An event_image is never publicly usable (event_media_publicly_usable_ck, unchanged):
-- that flag means "covered by the photo waiver", which is about social photos.
--
-- Grants: none new. admin_app already has SELECT/INSERT/UPDATE/DELETE on event_media
-- (table-level, so the new column is covered); social_checker's column grant
-- (id, event_date, kind, status) is unchanged and does not include cover_key.
--
-- A CHECK can't be altered in place: drop and re-add, in this one transaction
-- (migrate.js runs each file in one). The kind CHECK was declared inline, so Postgres
-- named it event_media_kind_check. Existing rows all satisfy the new rules.

alter table public.event_media add column cover_key text unique;

alter table public.event_media drop constraint event_media_kind_check;
alter table public.event_media add constraint event_media_kind_check
    check (kind in ('signin_board', 'social_photo', 'promo_video', 'event_image'));

-- The Event Image always has its cover; only it and social photos may have one.
alter table public.event_media add constraint event_media_cover_ck check (
    case when kind = 'event_image'  then cover_key is not null
         when kind = 'social_photo' then true
         else                            cover_key is null end);

create unique index event_media_one_event_image_idx
    on public.event_media (event_date)
    where kind = 'event_image' and status = 'ready';
