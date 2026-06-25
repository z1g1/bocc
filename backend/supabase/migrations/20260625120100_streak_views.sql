-- Migration 0002 — streak views (ADR 0004)
--
-- Streaks are a RECOMPUTE-ON-READ projection over check-in history: no maintained
-- counter, no drift. The same views power the live celebration, the one-time backport
-- (just run the query over imported history), and later reminder targeting.
--
-- security_invoker = true: the views run with the PRIVILEGES & RLS of the *querying*
-- role, not the (privileged) view owner — this avoids the Supabase "views bypass RLS"
-- footgun. Combined with migration 0003, the public anon role can read nothing.

-- ─────────────────────────────────────────────────────────────────────────────
-- Occurrence calendar: the HELD weeks per event. "Held" = >=1 non-debug check-in in
-- that ISO-Monday week (America/New_York). A snow-day (zero check-ins) simply never
-- appears here, which is exactly why cancellations bridge a streak instead of breaking
-- it. This view is the seam a future authoritative schedule (Google Sheets) replaces.
-- ─────────────────────────────────────────────────────────────────────────────
create view public.held_occurrences
    with (security_invoker = true)
as
select
    event_id,
    (date_trunc('week', checkin_at at time zone 'America/New_York'))::date
        as occurrence_week
from public.checkins
where debug = false
group by
    event_id,
    (date_trunc('week', checkin_at at time zone 'America/New_York'))::date;

-- ─────────────────────────────────────────────────────────────────────────────
-- Streaks: gaps-and-islands over HELD occurrences (NOT raw calendar weeks), per
-- (attendee, event). Consecutiveness is measured on a DENSE index of held weeks, so
-- a cancelled week is absent from the index and the streak bridges it automatically.
-- ─────────────────────────────────────────────────────────────────────────────
create view public.streaks
    with (security_invoker = true)
as
with held as (
    -- dense per-event index over held weeks (1,2,3…), plus the event's latest held week
    select
        event_id,
        occurrence_week,
        row_number() over (partition by event_id order by occurrence_week) as occ_index,
        max(occurrence_week) over (partition by event_id)                  as latest_held_week
    from public.held_occurrences
),
attended as (
    -- the weeks each attendee actually showed up (deduped to one row per week)
    select distinct
        attendee_id,
        event_id,
        (date_trunc('week', checkin_at at time zone 'America/New_York'))::date
            as occurrence_week
    from public.checkins
    where debug = false
),
attended_indexed as (
    -- attach the held-week index to each attended week (every attended week is held)
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
    -- gaps-and-islands: consecutive occ_index values share a constant group key
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
    -- current streak = length of the run ending at the event's most recent HELD week;
    -- 0 if the attendee missed that week (their streak is no longer active).
    coalesce(
        max(rs.run_len) filter (where rs.run_end_week = rs.latest_held_week), 0
    ) as current_streak,
    max(rs.run_len) as longest_streak,
    -- personal best = currently sitting at your longest-ever run (and it's active)
    (
        coalesce(max(rs.run_len) filter (where rs.run_end_week = rs.latest_held_week), 0)
            = max(rs.run_len)
        and max(rs.run_len) > 0
    ) as is_personal_best,
    max(rs.run_end_week) as last_occurrence_week,
    ls.last_checkin_at
from run_summary rs
join last_seen ls
  on ls.attendee_id = rs.attendee_id
 and ls.event_id    = rs.event_id
group by rs.attendee_id, rs.event_id, ls.last_checkin_at;

comment on view public.streaks is
    'Recompute-on-read streak projection per (attendee, event). current_streak is 0 when '
    'the attendee missed the most recent held occurrence. See ADR 0004.';
