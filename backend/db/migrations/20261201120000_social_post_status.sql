-- Migration 0019 — the Social Post status (ticket #39, parent #18)
--
-- Applied by backend/scripts/migrate.js in ONE transaction; plain SQL, so it also
-- applies on a vanilla Postgres (scripts/test-db.sh).
--
-- social_posts.status replaces the `ready` flag. It is the summary of the whole post
-- (the per-channel statuses in social_post_channels stay as they are):
--   todo    To do              being prepared; the Chrome tasks ignore it (the default)
--   ready   Ready for Posting  the work order is offered to the Chrome tasks (Admin)
--   posted  Posted             every channel scheduled or live: set by the social role's
--                              channel updates, or by an Admin
--   error   Error              a channel failed: set by the social role's channel
--                              updates, or by an Admin
-- (src/lib/admin/social-rules.mjs POST_STATUSES; ADR 0011, amended for #39.)
--
-- Existing rows: ready -> 'ready', not ready -> 'todo'. The rule that a ready post has
-- its video and its caption (social_posts_ready_ck) carries over to 'ready'.
--
-- Grants: admin_app keeps table-level SELECT, INSERT, UPDATE on social_posts and
-- social_checker table-level SELECT (migrations 20261122120000 and 20261123120000);
-- both cover the new column. Restated here so the column's access is explicit.

alter table public.social_posts
    add column status text not null default 'todo'
        constraint social_posts_status_ck check (status in ('todo', 'ready', 'posted', 'error'));

-- Without the updated_at trigger: the post's content doesn't change.
alter table public.social_posts disable trigger social_posts_set_updated_at;
update public.social_posts set status = case when ready then 'ready' else 'todo' end;
alter table public.social_posts enable trigger social_posts_set_updated_at;

alter table public.social_posts drop constraint social_posts_ready_ck;
alter table public.social_posts drop column ready;

alter table public.social_posts
    add constraint social_posts_status_ready_ck
        check (status <> 'ready' or (video_media_id is not null and base_caption is not null));

grant select, insert, update on public.social_posts to admin_app;
grant select on public.social_posts to social_checker;
