-- Migration 0021 — the glossary's names in the schema: EXPAND (ticket #50, parent #49)
--
-- Applied by backend/scripts/migrate.js in ONE transaction; plain SQL, so it also applies
-- on a vanilla Postgres (scripts/test-db.sh). GLOSSARY.md holds the words.
--
--   Today                                  After
--   events.status value 'held'             'reported'      (CHECK accepts both; see VALUES)
--   event_reports.gives_asks_count         attendee_count
--   event_media.kind value 'social_photo'  'event_photo'   (CHECK accepts both; see VALUES)
--   event_media.cover_key                  image_16x9_key
--   event_media.cover_outdated             image_16x9_outdated
--   table social_posts                     social_plans
--     .cover_media_id                        .thumbnail_media_id
--     .cover_note                            .thumbnail_timecode
--   table social_post_channels             social_media_posts (its status is the Post status)
--   table linkedin_connections             linkedin_authentications
--
-- Constraints, indexes and triggers on these tables are renamed to match (step 6). Grants
-- follow a renamed table or column, so every role keeps exactly the privileges it had.
-- Object storage keys (…/cover.jpg) are NOT renamed: they are opaque paths in the private
-- bucket. linkedin_events and events.event_image_media_id already match the glossary.
--
-- EXPAND ONLY. CI runs this a few minutes before the code that uses the new names
-- deploys (docs/backend/DEPLOYS.md), so the code live in between must keep working. The
-- compatibility pieces, all marked DEPRECATED:
--   - Views under the old table names (social_posts, social_post_channels,
--     linkedin_connections), exposing the old column names. Each is a plain single-table
--     view, so Postgres makes it updatable (INSERT, UPDATE, DELETE, ON CONFLICT, FOR
--     UPDATE all pass through, base-table defaults and triggers apply), with the same
--     grants per role as its table. security_invoker, except linkedin_connections (see
--     step 5). linkedin_connections also exposes the
--     row's xmax, which the old connect code reads in RETURNING.
--   - Old-named shadow columns on the tables that keep their names: event_reports.
--     gives_asks_count, event_media.cover_key and event_media.cover_outdated. A BEFORE
--     trigger keeps each equal to its new column, whichever one a statement writes.
--   - The status and kind CHECKs accept both the old and the new value.
--   - social_posts.ready (deprecated by migration 20261201120000, dropped by #44) is
--     carried through the rename: it stays on social_plans and in the social_posts view.
-- CONTRACT LATER (follow-up to #49, after production runs the new code): drop the views,
-- the shadow columns, the compat triggers and their functions, and tighten the CHECKs to
-- the new values only. If #44 hasn't run by then, drop `ready` in the same migration.
-- See docs/backend/NEON_PERMISSIONS.md "Contract later: the glossary rename".
--
-- VALUES: the backfill of existing rows ('held' -> 'reported', 'social_photo' ->
-- 'event_photo') and the trigger that rewrites an old-value write are NOT in this file.
-- Unlike a name, a value can't be aliased: once rows say 'reported', every query of the
-- old code that filters or branches on 'held' (the events list and report flow, the Event
-- Image and Thumbnail pickers, the 16:9 remake) silently stops matching. So the value
-- switch ships with the code that reads the new value, as its own migration: the Event
-- status ticket (#51) for 'reported', the Photo from Event ticket (#54) for 'event_photo'.
-- Each backfills (updated_at trigger disabled) and adds a BEFORE INSERT OR UPDATE trigger
-- mapping the old value to the new one, for the old code still live until the deploy.
-- Both land in the same release as this file, so production sees the same end state.
--
-- The LinkedIn token's AES-GCM associated data stays the literal "linkedin_connections:
-- <user id>" (src/lib/linkedin/crypto.mjs), so existing tokens still decrypt.
--
-- Backfills run with the updated_at triggers disabled: no content changes.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. events.status: 'reported' allowed beside 'held' (see VALUES above)
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.events drop constraint events_status_check;
alter table public.events add constraint events_status_check
    check (status in ('scheduled', 'reported', 'cancelled', 'held'));  -- 'held': DEPRECATED

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. event_reports.gives_asks_count -> attendee_count (+ old-named shadow column)
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.event_reports rename column gives_asks_count to attendee_count;
alter table public.event_reports add column gives_asks_count integer;
comment on column public.event_reports.gives_asks_count is
    'DEPRECATED (migration 20261203120000): a copy of attendee_count kept by a trigger for the old code. Dropped by the contract migration.';

alter table public.event_reports disable trigger event_reports_set_updated_at;
update public.event_reports set gives_asks_count = attendee_count;
alter table public.event_reports enable trigger event_reports_set_updated_at;

create function public.event_reports_glossary_compat() returns trigger
    language plpgsql
as $$
begin
    if tg_op = 'INSERT' then
        new.attendee_count := coalesce(new.attendee_count, new.gives_asks_count);
    elsif new.gives_asks_count is distinct from old.gives_asks_count
          and new.attendee_count is not distinct from old.attendee_count then
        new.attendee_count := new.gives_asks_count;
    end if;
    new.gives_asks_count := new.attendee_count;
    return new;
end;
$$;
comment on function public.event_reports_glossary_compat() is
    'DEPRECATED (migration 20261203120000): keeps gives_asks_count equal to attendee_count. Dropped by the contract migration.';

create trigger event_reports_glossary_compat
    before insert or update on public.event_reports
    for each row execute function public.event_reports_glossary_compat();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. event_media: kind 'event_photo' allowed beside 'social_photo'; cover_key -> image_16x9_key;
--    cover_outdated -> image_16x9_outdated (+ old-named shadow columns)
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.event_media rename column cover_key to image_16x9_key;
alter table public.event_media rename column cover_outdated to image_16x9_outdated;
alter table public.event_media add column cover_key text;
alter table public.event_media add column cover_outdated boolean not null default false;
comment on column public.event_media.cover_key is
    'DEPRECATED (migration 20261203120000): a copy of image_16x9_key kept by a trigger for the old code. Dropped by the contract migration.';
comment on column public.event_media.cover_outdated is
    'DEPRECATED (migration 20261203120000): a copy of image_16x9_outdated kept by a trigger for the old code. Dropped by the contract migration.';

-- The CHECKs that name a kind accept both photo values.
alter table public.event_media drop constraint event_media_kind_check;
alter table public.event_media add constraint event_media_kind_check
    check (kind in ('signin_board', 'event_photo', 'promo_video', 'event_image', 'social_photo'));  -- 'social_photo': DEPRECATED
alter table public.event_media drop constraint event_media_publicly_usable_ck;
alter table public.event_media add constraint event_media_publicly_usable_ck
    check (kind in ('event_photo', 'social_photo') or not publicly_usable);
alter table public.event_media drop constraint event_media_cover_ck;
alter table public.event_media add constraint event_media_image_16x9_ck check (
    case when kind = 'event_image'                    then image_16x9_key is not null
         when kind in ('event_photo', 'social_photo') then true
         else                                              image_16x9_key is null end);

alter table public.event_media disable trigger event_media_set_updated_at;
update public.event_media set cover_key = image_16x9_key, cover_outdated = image_16x9_outdated;
alter table public.event_media enable trigger event_media_set_updated_at;

create function public.event_media_glossary_compat() returns trigger
    language plpgsql
as $$
begin
    if tg_op = 'INSERT' then
        new.image_16x9_key := coalesce(new.image_16x9_key, new.cover_key);
        new.image_16x9_outdated := new.image_16x9_outdated or coalesce(new.cover_outdated, false);
    else
        if new.cover_key is distinct from old.cover_key
           and new.image_16x9_key is not distinct from old.image_16x9_key then
            new.image_16x9_key := new.cover_key;
        end if;
        if new.cover_outdated is distinct from old.cover_outdated
           and new.image_16x9_outdated is not distinct from old.image_16x9_outdated then
            new.image_16x9_outdated := new.cover_outdated;
        end if;
    end if;
    new.cover_key := new.image_16x9_key;
    new.cover_outdated := new.image_16x9_outdated;
    return new;
end;
$$;
comment on function public.event_media_glossary_compat() is
    'DEPRECATED (migration 20261203120000): keeps cover_key/cover_outdated equal to image_16x9_key/image_16x9_outdated. Dropped by the contract migration.';

create trigger event_media_glossary_compat
    before insert or update on public.event_media
    for each row execute function public.event_media_glossary_compat();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Table renames (grants, foreign keys and triggers follow the table)
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.social_posts rename to social_plans;
alter table public.social_plans rename column cover_media_id to thumbnail_media_id;
alter table public.social_plans rename column cover_note to thumbnail_timecode;
alter table public.social_post_channels rename to social_media_posts;
alter table public.linkedin_connections rename to linkedin_authentications;

comment on table public.social_plans is
    'One Social plan per Event (GLOSSARY.md; ADR 0011). status is the Plan status.';
comment on table public.social_media_posts is
    'One social media post per (Event, Channel) of a Social plan (GLOSSARY.md; ADR 0011). status is the Post status.';
comment on table public.linkedin_authentications is
    'One LinkedIn authentication per Admin (ADR 0012). token_ciphertext is AES-256-GCM, never plaintext; its associated data is still "linkedin_connections:<user id>".';

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Compatibility views under the old table names (same column order as the old tables)
-- ─────────────────────────────────────────────────────────────────────────────
create view public.social_posts with (security_invoker = true) as
    select event_date, video_media_id, thumbnail_timecode as cover_note, base_caption,
           extra_hashtags, publish_at, ready, created_at, updated_at,
           thumbnail_media_id as cover_media_id, status
      from public.social_plans;

create view public.social_post_channels with (security_invoker = true) as
    select event_date, channel, caption, first_comment, status, post_url, verified_at,
           comment_posted_at, notes, created_at, updated_at
      from public.social_media_posts;

-- NOT security_invoker: an invoker view needs the caller to read EVERY column it selects
-- from the table, and social_checker may read only user_id, expires_at and display_name.
-- So this view runs with its owner's rights, and its grants below (the same as the
-- table's, column grant included) are the whole check.
create view public.linkedin_connections with (security_invoker = false) as
    select user_id, token_ciphertext, expires_at, member_urn, display_name, scope,
           connected_at, created_at, updated_at, xmax
      from public.linkedin_authentications;

comment on view public.social_posts is
    'DEPRECATED (migration 20261203120000): the old name of social_plans, for the code live before the deploy. Dropped by the contract migration.';
comment on view public.social_post_channels is
    'DEPRECATED (migration 20261203120000): the old name of social_media_posts, for the code live before the deploy. Dropped by the contract migration.';
comment on view public.linkedin_connections is
    'DEPRECATED (migration 20261203120000): the old name of linkedin_authentications, for the code live before the deploy. Dropped by the contract migration.';

revoke all on public.social_posts, public.social_post_channels, public.linkedin_connections from public;
grant select, insert, update on public.social_posts, public.social_post_channels to admin_app;
grant select on public.social_posts, public.social_post_channels to social_checker;
grant select, insert, update, delete on public.linkedin_connections to admin_app;
grant select (user_id, expires_at, display_name) on public.linkedin_connections to social_checker;

revoke all on function public.event_reports_glossary_compat(), public.event_media_glossary_compat() from public;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Rename constraints, indexes and triggers to the new table and column names
-- ─────────────────────────────────────────────────────────────────────────────
create function pg_temp.glossary_name(old text) returns text
    language sql immutable
as $$
    select replace(replace(replace(replace(replace(replace(replace(replace(old,
        'social_post_channels', 'social_media_posts'),
        'social_posts',         'social_plans'),
        'linkedin_connections', 'linkedin_authentications'),
        'cover_media_id',       'thumbnail_media_id'),
        'cover_note',           'thumbnail_timecode'),
        'cover_outdated',       'image_16x9_outdated'),
        'cover_key',            'image_16x9_key'),
        'gives_asks_count',     'attendee_count')
$$;

do $$
declare
    tables regclass[] := array['public.social_plans', 'public.social_media_posts',
        'public.linkedin_authentications', 'public.event_media', 'public.event_reports']::regclass[];
    r record;
begin
    -- Renaming a primary key or unique constraint renames its index too.
    for r in select conrelid::regclass as tbl, conname from pg_constraint
              where conrelid = any (tables) and conname <> pg_temp.glossary_name(conname) loop
        execute format('alter table %s rename constraint %I to %I', r.tbl, r.conname, pg_temp.glossary_name(r.conname));
    end loop;
    for r in select i.relname from pg_index x join pg_class i on i.oid = x.indexrelid
              where x.indrelid = any (tables) and i.relname <> pg_temp.glossary_name(i.relname) loop
        execute format('alter index public.%I rename to %I', r.relname, pg_temp.glossary_name(r.relname));
    end loop;
    for r in select tgrelid::regclass as tbl, tgname from pg_trigger
              where tgrelid = any (tables) and not tgisinternal and tgname <> pg_temp.glossary_name(tgname) loop
        execute format('alter trigger %I on %s rename to %I', r.tgname, r.tbl, pg_temp.glossary_name(r.tgname));
    end loop;
end $$;
