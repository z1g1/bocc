-- Migration 0001 — check-in core schema (attendees, checkins)
-- Foundation for ADR 0003 (Supabase transactional store) + ADR 0004 (streak model).
--
-- Conventions:
--   * email is stored LOWERCASED/normalised by the application layer (the natural key).
--   * a legacy_airtable_id column preserves provenance for the one-time backfill.
--   * the streak "week bucket" is NOT stored here — it is derived in the streak views
--     (timezone() is STABLE, not IMMUTABLE, so it cannot back a generated column).

create table public.attendees (
    id                 uuid primary key default gen_random_uuid(),
    email              text        not null,
    name               text        not null,
    phone              text,
    business_name      text,
    ok_to_email        boolean     not null default false,
    debug              boolean     not null default false,
    legacy_airtable_id text,
    created_at         timestamptz not null default now()
);

-- Email is the natural key; the app normalises to lowercase before every write.
create unique index attendees_email_key on public.attendees (email);
create unique index attendees_legacy_airtable_id_key
    on public.attendees (legacy_airtable_id)
    where legacy_airtable_id is not null;

create table public.checkins (
    id                 uuid        primary key default gen_random_uuid(),
    attendee_id        uuid        not null references public.attendees (id),
    event_id           text        not null,
    token              text,
    checkin_at         timestamptz not null default now(),
    -- Eastern calendar day of the check-in, computed by the app at write time and
    -- used for same-day dedup. Stored (not generated) — see header note on IMMUTABLE.
    checkin_date       date        not null,
    debug              boolean     not null default false,
    legacy_airtable_id text,
    created_at         timestamptz not null default now()
);

create index checkins_attendee_event_idx on public.checkins (attendee_id, event_id);
create index checkins_event_idx          on public.checkins (event_id);

-- Same-day dedup, now DB-ENFORCED (replaces the app-only findExistingCheckin, which
-- raced). token is reused week-to-week, so the effective key is (attendee, event, day);
-- coalesce stops a null token from defeating uniqueness. The check-in writer inserts
-- with ON CONFLICT DO NOTHING and treats "no row returned" as a duplicate.
create unique index checkins_dedup_key
    on public.checkins (attendee_id, event_id, (coalesce(token, '')), checkin_date);

create unique index checkins_legacy_airtable_id_key
    on public.checkins (legacy_airtable_id)
    where legacy_airtable_id is not null;
