-- Migration — Held counts Reported Events, never Cancelled Events (ticket #52, parent #49)
--
-- GLOSSARY.md: an Event is Held when it took place, known from at least one real Check-in
-- or an Event Report. A Cancelled Event, or a week with no Event, was never held. Until now
-- held_occurrences only knew check-ins (migration 0002), so a Cancelled week with a few
-- check-ins counted as Held and a Reported week with none didn't. The events table is now
-- the authoritative schedule for Reported and Cancelled Events (ADR 0004 amendment).
--
-- New rule, per ISO-Monday week (America/New_York):
--   Held = (weeks with a non-debug check-in, per event_id)
--          UNION (weeks of a Reported Event, under the series' check-in event id 'bocc')
--          MINUS (weeks of a Cancelled Event, for 'bocc')
-- The events table has one row per event day and no event id: every row belongs to the
-- BOCC series, whose check-in form posts eventId 'bocc'. Other event ids keep the
-- check-in-only rule. Debug check-ins still count toward nothing.
--
-- Agreed consequence: a Reported Event with no check-ins breaks the Streak of every
-- Attendee who didn't check in (it is now a Held week they missed).
--
-- 'held' is matched beside 'reported' only as a belt: migration 20261203130000 already
-- rewrites it. Drop it from the list with the contract migration (#60).
--
-- CREATE OR REPLACE keeps the two columns, security_invoker, the grants and the
-- dependent streaks view, whose columns are unchanged.
--
-- Grants: under security_invoker the querying role needs SELECT on what the view reads.
-- admin_app already reads events. checkin_writer gets SELECT on event_date and status
-- only, so it can read held_occurrences and streaks and nothing else about events.

create or replace view public.held_occurrences
    with (security_invoker = true)
as
with weeks as (
    select
        event_id,
        (date_trunc('week', checkin_at at time zone 'America/New_York'))::date
            as occurrence_week
    from public.checkins
    where debug = false
    union
    select
        'bocc'::text,
        (date_trunc('week', event_date))::date
    from public.events
    where status in ('reported', 'held')  -- 'held': DEPRECATED, see above
)
select w.event_id, w.occurrence_week
from weeks w
where not (
    w.event_id = 'bocc'
    and exists (
        select 1
        from public.events e
        where e.status = 'cancelled'
          and (date_trunc('week', e.event_date))::date = w.occurrence_week
    )
);

comment on view public.held_occurrences is
    'The Held weeks per event (ISO Monday, America/New_York): a non-debug check-in, or for '
    'the bocc series a Reported Event, and never a Cancelled Event. See ADR 0004 and '
    'migration 20261203190000.';

grant select (event_date, status) on public.events to checkin_writer;
