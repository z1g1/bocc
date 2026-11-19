-- Migration 0015 — the Social Post cover image (ticket #22, parent #18)
--
-- social_posts.cover_media_id: an override for the promo video's cover image. NULL (the
-- default) means the cover is the event's Event Image (src/lib/admin/event-image.mjs
-- getEventImage: uploaded, referenced photo, or the BOCC logo), resolved in code
-- (src/lib/admin/social-rules.mjs resolveSocialCover). A non-NULL value points at a
-- ready, publicly usable `social_photo` (checked in code, src/lib/admin/social.mjs
-- setCover), of this or an earlier event, so unlike the video it is NOT tied to the
-- same event_date.
--
-- ON DELETE SET NULL: deleting the photo (media.mjs deleteMedia, audited as
-- media.delete) returns the cover to the Event Image. The video stays required for
-- `ready` (social_posts_ready_ck unchanged); the cover never blocks it.
--
-- Grants: none new. admin_app has table-level SELECT/INSERT/UPDATE on social_posts and
-- social_checker table-level SELECT, both of which cover the new column.

alter table public.social_posts
    add column cover_media_id uuid references public.event_media (id) on delete set null;

create index social_posts_cover_media_id_idx on public.social_posts (cover_media_id);
