-- Migration 0007 — HEIC/HEIF originals for imported sign-in board photos (ADR 0010
-- decision 4, amended 2026-11-17; Zack's decision of 2026-11-17).
--
-- The one-time import of the old sign-in board photos (scripts/signin-photos/import.mjs)
-- keeps each photo's untouched original, and 44 of the 45 are iPhone HEIC files. So a
-- `signin_board` ORIGINAL may now be image/heic or image/heif as well as JPEG/PNG.
-- content_type and size_bytes describe the original only; display_key and thumb_key
-- are still always JPEGs (the import and the browser both make them).
--
-- Browser uploads still refuse HEIC (ADR 0010 decision 3): the API accepts only
-- image/jpeg and image/png, so this widens what the database ALLOWS, not what the
-- admin accepts. social_photo stays JPEG/PNG, promo_video stays MP4/QuickTime.
--
-- A CHECK can't be altered in place: drop and re-add it, in this one transaction
-- (migrate.js runs each file in one). Existing rows all satisfy the new, wider rule.

alter table public.event_media drop constraint event_media_content_type_ck;

alter table public.event_media add constraint event_media_content_type_ck check (
    case when kind = 'promo_video'  then content_type in ('video/mp4', 'video/quicktime')
         when kind = 'signin_board' then content_type in ('image/jpeg', 'image/png', 'image/heic', 'image/heif')
         else                            content_type in ('image/jpeg', 'image/png') end);
