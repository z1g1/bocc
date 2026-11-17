-- Migration 0006 — events, event reports and event media (ADR 0009, ADR 0010; admin app
-- plan Phase 3). event_links, social_posts and social_post_channels come in Phases 4/5.
--
-- Applied by backend/scripts/migrate.js in ONE transaction. Guarded so it also applies
-- on a vanilla Postgres (scripts/test-db.sh): gen_random_uuid() is core since PG 13.
--
-- Enumerations are text + CHECK, not enum types, matching user_roles.role: changing
-- a CHECK is a drop/add inside one transaction, while ALTER TYPE … ADD VALUE can't
-- have its new value used in the transaction that adds it (migrate.js runs each file
-- in one), and an enum value can never be removed.
--
-- updated_at is kept by a trigger (public.set_updated_at), so no code path can forget it.
--
-- No RLS, like user_roles and audit_log (migration 0005): rows aren't partitioned
-- between users, so the grants below are the whole policy. (RLS on attendees and
-- checkins dates from the Supabase era; see migration 0003.)

-- ─────────────────────────────────────────────────────────────────────────────
-- updated_at trigger function, shared by the three tables
-- ─────────────────────────────────────────────────────────────────────────────
create function public.set_updated_at() returns trigger
    language plpgsql
as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- events: one row per event day. A past date still `scheduled` is "report missing".
-- No Tuesday check: a few real events fell on other days.
-- ─────────────────────────────────────────────────────────────────────────────
create table public.events (
    event_date          date        primary key,
    status              text        not null default 'scheduled'
                                    check (status in ('scheduled', 'held', 'cancelled')),
    location            text        check (location in ('lobby', 'food_hall', 'other')),
    location_other      text,
    cancel_reason       text        check (cancel_reason in ('weather', 'facility', 'other_event', 'other')),
    cancel_reason_other text,
    cancel_announced    boolean     not null default false,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),

    -- Free text for `other` location: required (non-blank) iff location = 'other'.
    constraint events_location_other_ck check (
        case when location = 'other' then coalesce(btrim(location_other), '') <> ''
             else location_other is null end),
    -- Cancel fields only on a cancelled event, and a cancelled event has a reason.
    -- Un-cancelling means clearing all three in the same UPDATE.
    constraint events_cancel_fields_ck check (
        case when status = 'cancelled' then cancel_reason is not null
             else cancel_reason is null and cancel_reason_other is null and not cancel_announced end),
    -- Free text for `other` reason: required (non-blank) iff cancel_reason = 'other'.
    constraint events_cancel_reason_other_ck check (
        case when cancel_reason = 'other' then coalesce(btrim(cancel_reason_other), '') <> ''
             else cancel_reason_other is null end)
);

create trigger events_set_updated_at
    before update on public.events
    for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- event_reports: one per held event; replaces the Google Form. Submitting one moves
-- the event to `held` (app side, same transaction). The check-in count is calculated,
-- never stored.
--   source       admin        written in the admin by a signed-in user
--                google_form  imported from the Form's CSV (rows with a timestamp)
--                pre_form     imported from the CSV's older rows (no timestamp)
--   submitted_by NULL for imported rows (the Form's email column is not stored), and
--                set NULL if the account is later deleted.
--   gives_asks_count, bling_given  NULL = not recorded (older imported rows). The admin
--                form always requires both; that is enforced in the app, not here.
-- ─────────────────────────────────────────────────────────────────────────────
create table public.event_reports (
    event_date       date        primary key references public.events (event_date),
    gives_asks_count integer     check (gives_asks_count >= 0),
    notes            text,
    bling_given      boolean,
    bling_details    text,
    submitted_by     text        references "auth"."user" ("id") on delete set null,
    source           text        not null default 'admin'
                                 check (source in ('admin', 'google_form', 'pre_form')),
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),

    -- No Bling details on a report that says no Bling was given.
    constraint event_reports_bling_details_ck check (bling_details is null or bling_given is not false)
);

create trigger event_reports_set_updated_at
    before update on public.event_reports
    for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- event_media: one row per uploaded photo or video, in the private bucket (ADR 0010).
-- Keys are built by the server (src/lib/admin/storage.mjs mediaKey), never from a
-- filename:  events/<event_date>/<id>/{original,display,thumb}.<ext>
--   original_key  the untouched upload (the archive)
--   display_key   1600px JPEG (photos only)
--   thumb_key     400px JPEG (photos only)
--   content_type, size_bytes  of the original
--   status        pending (row made, URLs handed out) → ready (objects confirmed)
-- ─────────────────────────────────────────────────────────────────────────────
create table public.event_media (
    id              uuid        primary key default gen_random_uuid(),
    event_date      date        not null references public.events (event_date),
    kind            text        not null check (kind in ('signin_board', 'social_photo', 'promo_video')),
    original_key    text        not null unique,
    display_key     text        unique,
    thumb_key       text        unique,
    content_type    text        not null,
    size_bytes      bigint      not null check (size_bytes > 0),
    publicly_usable boolean     not null default false,
    status          text        not null default 'pending' check (status in ('pending', 'ready')),
    uploaded_by     text        references "auth"."user" ("id") on delete set null,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),

    -- Photos have all three copies; a video has only its original.
    constraint event_media_variants_ck check (
        case when kind = 'promo_video' then display_key is null and thumb_key is null
             else display_key is not null and thumb_key is not null end),
    -- Photos are JPEG or PNG (the picker's accept list; HEIC is refused, ADR 0010).
    constraint event_media_content_type_ck check (
        case when kind = 'promo_video' then content_type in ('video/mp4', 'video/quicktime')
             else content_type in ('image/jpeg', 'image/png') end),
    -- "OK to use publicly" only means something for social photos. Sign-in board
    -- photos show handwritten names and are never public.
    constraint event_media_publicly_usable_ck check (kind = 'social_photo' or not publicly_usable)
);

create index event_media_event_date_idx on public.event_media (event_date);

create trigger event_media_set_updated_at
    before update on public.event_media
    for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- Grants (ADR 0008 decision 6). Nobody but the owner and admin_app reaches these
-- tables; checkin_writer gets nothing.
-- ─────────────────────────────────────────────────────────────────────────────
revoke all on public.events, public.event_reports, public.event_media from public;
revoke all on function public.set_updated_at() from public;
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'anon') then
        revoke all on public.events, public.event_reports, public.event_media from anon;
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
        revoke all on public.events, public.event_reports, public.event_media from authenticated;
    end if;
end $$;

grant select, insert, update on public.events, public.event_reports, public.event_media to admin_app;
-- DELETE only on media (removing a photo also deletes its objects, app side).
grant delete on public.event_media to admin_app;
