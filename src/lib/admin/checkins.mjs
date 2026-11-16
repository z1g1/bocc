// Check-in views for /admin/checkins/ (admin only; the CALLER checks requireRole).
// Read-only, as admin_app. Every function takes `db` (the pool or a client) first so
// tests can pass their own. Parameterized SQL only.
//
//   latestCheckinDate(db, { includeDebug })  -> "YYYY-MM-DD" | null
//   listCheckinDates(db, { includeDebug, limit }) -> [{ date, count }] newest first
//   listCheckins(db, { date, includeDebug }) -> [{ id, attendeeId, name, businessName,
//                                               email, eventId, checkinAt, debug, currentStreak }]
//
// Dates are the stored Eastern calendar day (checkins.checkin_date), returned as text so
// no JS Date / server timezone ever shifts them.

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** "YYYY-MM-DD" that is a real calendar date, else null. */
export function parseDate(value) {
  if (typeof value !== "string" || !DATE_RE.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value ? value : null;
}

/** The most recent day with a check-in: a real (non-debug) one unless includeDebug. */
export async function latestCheckinDate(db, { includeDebug = false } = {}) {
  const { rows } = await db.query(
    `select max(checkin_date)::text as d from public.checkins where ($1 or debug = false)`,
    [includeDebug],
  );
  return rows[0]?.d ?? null;
}

/** Days that have check-ins, newest first, for the date picker. */
export async function listCheckinDates(db, { includeDebug = false, limit = 104 } = {}) {
  const { rows } = await db.query(
    `select checkin_date::text as date, count(*)::int as count
       from public.checkins
      where ($1 or debug = false)
      group by checkin_date
      order by checkin_date desc
      limit $2`,
    [includeDebug, limit],
  );
  return rows;
}

/**
 * Check-ins on one Eastern day, earliest first. Test rows (checkin or attendee flagged
 * debug) are left out unless includeDebug. currentStreak comes from the streaks view
 * (debug check-ins never count there) and is null when the attendee has none.
 */
export async function listCheckins(db, { date, includeDebug = false }) {
  if (!parseDate(date)) throw new Error("listCheckins: date must be YYYY-MM-DD");
  const { rows } = await db.query(
    `select c.id,
            c.attendee_id   as "attendeeId",
            a.name,
            a.business_name as "businessName",
            a.email,
            c.event_id      as "eventId",
            c.checkin_at    as "checkinAt",
            (c.debug or a.debug) as debug,
            s.current_streak::int as "currentStreak"
       from public.checkins c
       join public.attendees a on a.id = c.attendee_id
       left join public.streaks s on s.attendee_id = c.attendee_id and s.event_id = c.event_id
      where c.checkin_date = $1::date
        and ($2 or (c.debug = false and a.debug = false))
      order by c.checkin_at, a.name`,
    [date, includeDebug],
  );
  return rows;
}
