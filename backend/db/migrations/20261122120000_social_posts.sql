-- Migration 0010 — the weekly social work order: social_posts and social_post_channels
-- (ADR 0011 decision 1; admin app plan Phase 5).
--
-- Applied by backend/scripts/migrate.js in ONE transaction; guarded so it also applies
-- on a vanilla Postgres (scripts/test-db.sh). Text + CHECK, not enum types, like
-- migration 0006. updated_at is kept by public.set_updated_at (migration 0006).
--
-- social_posts: one per event, created by the first save of the "Social post" section
-- on /admin/events/YYYY-MM-DD/ (src/lib/admin/social.mjs), together with its five
-- channel rows. The final caption and first comment of each channel are calculated in
-- code (src/lib/admin/social-rules.mjs) from base_caption, extra_hashtags and the
-- event's Luma listing; they are not stored unless an admin overrides them.
--   video_media_id  the promo video (event_media, kind promo_video, status ready). The
--                   FK is on (event_date, video_media_id), so the video always belongs
--                   to the same event; kind and status are checked in code. Deleting
--                   the video (src/lib/admin/media.mjs deleteMedia) clears it here
--                   and un-readies the post in the same transaction.
--   extra_hashtags  added to TikTok's default hashtags; normalised in code ("#Word").
--   publish_at      set on creation to Monday 7:00 AM America/New_York before the event.
--   ready           the work order is offered to the Chrome tasks only when true; the
--                   app also requires a Luma listing, which a CHECK can't see.
--
-- social_post_channels: one per (event, channel).
--   caption, first_comment  NULL = use the code default. A non-NULL value is the whole
--                   final text for that channel, not an addition.
--   status          pending -> scheduled -> live | failed (written by the social role's
--                   pages, Phase 5 part B).
--
-- Grants:
--   admin_app    SELECT, INSERT, UPDATE on both. No DELETE: a post is never removed
--                (un-ready it instead), and its channel rows live as long as it does.
--   site_reader  nothing. checkin_writer nothing.

-- (event_date, id) is already unique since id is; the FK below needs it declared.
alter table public.event_media
    add constraint event_media_event_date_id_key unique (event_date, id);

create table public.social_posts (
    event_date      date        primary key references public.events (event_date),
    video_media_id  uuid,
    cover_note      text        check (cover_note is null or (btrim(cover_note) <> '' and length(cover_note) <= 500)),
    base_caption    text        check (base_caption is null or (btrim(base_caption) <> '' and length(base_caption) <= 2000)),
    extra_hashtags  text[]      not null default '{}'
                                check (cardinality(extra_hashtags) <= 10
                                       and array_position(extra_hashtags, null) is null),
    publish_at      timestamptz not null,
    ready           boolean     not null default false,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),

    constraint social_posts_video_fk foreign key (event_date, video_media_id)
        references public.event_media (event_date, id),
    -- A ready post has its video and its caption (the Luma link is checked in code).
    constraint social_posts_ready_ck check (not ready or (video_media_id is not null and base_caption is not null))
);

create index social_posts_video_media_id_idx on public.social_posts (video_media_id);

create trigger social_posts_set_updated_at
    before update on public.social_posts
    for each row execute function public.set_updated_at();

create table public.social_post_channels (
    event_date        date        not null references public.social_posts (event_date),
    channel           text        not null
                                  check (channel in ('facebook', 'instagram', 'threads', 'tiktok', 'linkedin_page')),
    caption           text        check (caption is null or (btrim(caption) <> '' and length(caption) <= 5000)),
    first_comment     text        check (first_comment is null or (btrim(first_comment) <> '' and length(first_comment) <= 1000)),
    status            text        not null default 'pending'
                                  check (status in ('pending', 'scheduled', 'live', 'failed')),
    post_url          text        check (post_url is null or (post_url ~ '^https://[^\s]+$' and length(post_url) <= 500)),
    verified_at       timestamptz,
    comment_posted_at timestamptz,
    notes             text        check (notes is null or length(notes) <= 2000),
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now(),
    primary key (event_date, channel)
);

create trigger social_post_channels_set_updated_at
    before update on public.social_post_channels
    for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- Grants (ADR 0008 decision 6)
-- ─────────────────────────────────────────────────────────────────────────────
revoke all on public.social_posts, public.social_post_channels from public;
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'anon') then
        revoke all on public.social_posts, public.social_post_channels from anon;
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
        revoke all on public.social_posts, public.social_post_channels from authenticated;
    end if;
end $$;

grant select, insert, update on public.social_posts, public.social_post_channels to admin_app;
