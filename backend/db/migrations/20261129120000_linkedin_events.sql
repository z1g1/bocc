-- Migration 0017 — linkedin_events: the LinkedIn event ledger (ADR 0012, issues #25/#26).
--
-- Applied by backend/scripts/migrate.js in ONE transaction; guarded so it also applies
-- on a vanilla Postgres (scripts/test-db.sh).
--
-- One ACTIVE row per event date records what the app sent to LinkedIn, so a double
-- click, a second tab or a crash mid-call can never create two events:
--   pending   committed BEFORE the create call: something may exist on LinkedIn
--   created   the event exists (linkedin_event_id, event_url); the post isn't out yet
--   posted    the member post is out too (post_urn, post_url)
--   retired   an Admin checked LinkedIn after a stuck `pending` and found nothing
--             ("allow retry", #26). The row stays as history and frees the date.
-- admin_app has no DELETE (spec #18 "Schema"), so allow-retry RETIRES the row instead
-- of deleting it: uniqueness on event_date is a partial unique index over the rows
-- that aren't retired. Status only moves forward (pending -> created -> posted, or
-- pending -> retired), enforced by a trigger, and event_date never changes.
--
-- What was sent, for drift detection (a later ticket): name, commentary, location
-- (null = not set, which uses the lobby wording) and the cover (image_source and
-- image_ref: the cover's object key or checked-in path; image_media_id when it was an
-- event_media row). image_source/image_ref are null only for rows imported from the
-- CLI's ledger (#28), which didn't record the image.
--
-- created_by: who pressed Create live event. cancelled_on_linkedin_at/_by: the Admin
-- ticked "Done on LinkedIn" after the event was cancelled (posted rows only).
--
-- Grants:
--   admin_app       SELECT, INSERT, UPDATE (no DELETE, no TRUNCATE)
--   site_reader, checkin_writer, social_checker  nothing

create table public.linkedin_events (
    id                       uuid        primary key default gen_random_uuid(),
    event_date               date        not null references public.events (event_date),
    status                   text        not null check (status in ('pending', 'created', 'posted', 'retired')),
    name                     text        not null check (char_length(name) between 1 and 200),
    commentary               text        not null check (char_length(commentary) between 1 and 3000),
    location                 text        check (location in ('lobby', 'food_hall')),
    image_source             text        check (image_source in ('uploaded', 'referenced', 'default')),
    image_ref                text        check (char_length(image_ref) between 1 and 500),
    image_media_id           uuid        references public.event_media (id) on delete set null,
    image_asset_urn          text        check (image_asset_urn ~ '^urn:li:digitalmediaAsset:[A-Za-z0-9_-]+$'),
    linkedin_event_id        text        check (linkedin_event_id ~ '^[0-9]{1,30}$'),
    event_url                text        check (event_url ~ '^https://www\.linkedin\.com/events/[A-Za-z0-9-]+/$'),
    post_urn                 text        check (post_urn ~ '^urn:li:(ugcPost|share):[0-9]+$'),
    post_url                 text        check (post_url ~ '^https://www\.linkedin\.com/feed/update/urn:li:(ugcPost|share):[0-9]+/$'),
    created_by               text        references "auth"."user" ("id") on delete set null,
    attempted_at             timestamptz not null default now(),
    event_created_at         timestamptz,
    posted_at                timestamptz,
    retired_at               timestamptz,
    retired_by               text        references "auth"."user" ("id") on delete set null,
    cancelled_on_linkedin_at timestamptz,
    cancelled_on_linkedin_by text        references "auth"."user" ("id") on delete set null,
    created_at               timestamptz not null default now(),
    updated_at               timestamptz not null default now(),

    -- The fields each status needs, and only those.
    constraint linkedin_events_status_fields_ck check (
        case status
            when 'pending' then linkedin_event_id is null and event_url is null and event_created_at is null
                                and post_urn is null and post_url is null and posted_at is null and retired_at is null
            when 'created' then linkedin_event_id is not null and event_url is not null and event_created_at is not null
                                and post_urn is null and post_url is null and posted_at is null and retired_at is null
            when 'posted'  then linkedin_event_id is not null and event_url is not null and event_created_at is not null
                                and post_urn is not null and post_url is not null and posted_at is not null and retired_at is null
            when 'retired' then linkedin_event_id is null and event_url is null and post_urn is null and retired_at is not null
        end),
    -- "Done on LinkedIn" only makes sense for an event that was published.
    constraint linkedin_events_cancelled_ack_ck check (cancelled_on_linkedin_at is null or status = 'posted')
);

comment on table public.linkedin_events is
    'The LinkedIn event ledger (ADR 0012): one active (not retired) row per event_date; status only moves forward.';

-- One active row per date. Retired rows are history and don't count.
create unique index linkedin_events_event_date_active_key
    on public.linkedin_events (event_date) where status <> 'retired';

create trigger linkedin_events_set_updated_at
    before update on public.linkedin_events
    for each row execute function public.set_updated_at();

create function public.linkedin_events_guard() returns trigger
    language plpgsql as $$
begin
    if new.event_date <> old.event_date then
        raise exception 'linkedin_events: event_date can''t change';
    end if;
    if new.status <> old.status and not (
           (old.status = 'pending' and new.status in ('created', 'retired'))
        or (old.status = 'created' and new.status = 'posted')) then
        raise exception 'linkedin_events: status can''t move from % to %', old.status, new.status;
    end if;
    return new;
end $$;

create trigger linkedin_events_guard
    before update on public.linkedin_events
    for each row execute function public.linkedin_events_guard();

revoke all on public.linkedin_events from public;
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'anon') then
        revoke all on public.linkedin_events from anon;
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
        revoke all on public.linkedin_events from authenticated;
    end if;
end $$;

grant select, insert, update on public.linkedin_events to admin_app;
