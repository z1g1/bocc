-- Migration 0004 — streak celebration fields (ADR 0004 addendum)
--
-- Appends three columns to the recompute-on-read `streaks` view so the check-in response
-- can pick a Celebration (first visit / first streak / continued / restart / top streak):
--   previous_streak       length of the most recent run BEFORE the active one (null if none)
--   prior_longest_streak  longest run BEFORE the active one (null if none)
--   weeks_attended        total held occurrences attended for this event
--
-- "Active run" = the run ending at the event's latest held week (same definition as
-- current_streak). CREATE OR REPLACE VIEW may only APPEND columns, so the existing columns
-- keep their order and types; existing grants and security_invoker are preserved.
-- Backward compatible: code that selects the original columns is unaffected.

create or replace view public.streaks
    with (security_invoker = true)
as
with held as (
    select
        event_id,
        occurrence_week,
        row_number() over (partition by event_id order by occurrence_week) as occ_index,
        max(occurrence_week) over (partition by event_id)                  as latest_held_week
    from public.held_occurrences
),
attended as (
    select distinct
        attendee_id,
        event_id,
        (date_trunc('week', checkin_at at time zone 'America/New_York'))::date
            as occurrence_week
    from public.checkins
    where debug = false
),
attended_indexed as (
    select
        a.attendee_id,
        a.event_id,
        h.occ_index,
        h.occurrence_week,
        h.latest_held_week
    from attended a
    join held h
      on h.event_id        = a.event_id
     and h.occurrence_week = a.occurrence_week
),
runs as (
    select
        attendee_id,
        event_id,
        occurrence_week,
        latest_held_week,
        occ_index
            - row_number() over (partition by attendee_id, event_id order by occ_index)
            as grp
    from attended_indexed
),
run_summary as (
    select
        attendee_id,
        event_id,
        count(*)              as run_len,
        max(occurrence_week)  as run_end_week,
        max(latest_held_week) as latest_held_week
    from runs
    group by attendee_id, event_id, grp
),
last_seen as (
    select attendee_id, event_id, max(checkin_at) as last_checkin_at
    from public.checkins
    where debug = false
    group by attendee_id, event_id
)
select
    rs.attendee_id,
    rs.event_id,
    coalesce(
        max(rs.run_len) filter (where rs.run_end_week = rs.latest_held_week), 0
    ) as current_streak,
    max(rs.run_len) as longest_streak,
    (
        coalesce(max(rs.run_len) filter (where rs.run_end_week = rs.latest_held_week), 0)
            = max(rs.run_len)
        and max(rs.run_len) > 0
    ) as is_personal_best,
    max(rs.run_end_week) as last_occurrence_week,
    ls.last_checkin_at,
    -- appended by this migration ------------------------------------------------------
    (array_agg(rs.run_len order by rs.run_end_week desc)
        filter (where rs.run_end_week <> rs.latest_held_week))[1] as previous_streak,
    max(rs.run_len) filter (where rs.run_end_week <> rs.latest_held_week)
        as prior_longest_streak,
    sum(rs.run_len) as weeks_attended
from run_summary rs
join last_seen ls
  on ls.attendee_id = rs.attendee_id
 and ls.event_id    = rs.event_id
group by rs.attendee_id, rs.event_id, ls.last_checkin_at;

comment on view public.streaks is
    'Recompute-on-read streak projection per (attendee, event). current_streak is 0 when '
    'the attendee missed the most recent held occurrence. previous_streak / '
    'prior_longest_streak describe runs before the active one; weeks_attended is the total. '
    'See ADR 0004.';
