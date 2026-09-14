/**
 * Postgres (Neon) check-in store — the storage adapter behind the check-in
 * use-case. See ADR 0003 / ADR 0004 / ADR 0005 and docs/backend/NEON_PERMISSIONS.md.
 *
 * This module is the Postgres counterpart of `utils/airtable.js`. It owns the
 * three operations the use-case needs:
 *   - findOrCreateAttendee  (idempotent, by lowercased email)
 *   - insertCheckin         (DB-enforced same-day dedup via ON CONFLICT)
 *   - getStreak             (reads the recompute-on-read `streaks` view)
 *
 * It connects as the least-privilege `checkin_writer` role (never the owner), via
 * Neon's pooled endpoint. A single small pool is reused for the function-process
 * lifetime (cold-start once), mirroring the Bot-JWT memoization pattern in
 * circle-http.js.
 */

const { Pool } = require('pg');
const config = require('./config');
const { toPgConfig } = require('./db-ssl');

let pool;

/**
 * Lazily build the connection pool. Config already fails fast when postgres mode
 * has no URL; this guard covers callers in airtable rollback mode.
 */
const getPool = () => {
  if (!pool) {
    if (!config.db.connectionString) {
      throw new Error(
        '[pg-store] CHECKIN_DB_URL is not set; cannot reach Postgres. ' +
        'See docs/backend/NEON_PERMISSIONS.md.'
      );
    }
    pool = new Pool(toPgConfig(config.db.connectionString, { max: config.db.poolMax }));
  }
  return pool;
};

const query = (text, params) => getPool().query(text, params);

/**
 * Find or create an attendee by email. The email is expected already lowercased
 * by validation (the natural key). On a returning attendee we deliberately do
 * NOT overwrite their stored details — same rule as the Airtable path.
 *
 * @returns {Promise<{id: string, created: boolean}>}
 */
const findOrCreateAttendee = async ({ email, name, phone, businessName, okToEmail, debug }) => {
  const inserted = await query(
    `insert into attendees (email, name, phone, business_name, ok_to_email, debug)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (email) do nothing
     returning id`,
    [email, name, phone || null, businessName || null, !!okToEmail, !!debug]
  );

  if (inserted.rows.length > 0) {
    return { id: inserted.rows[0].id, created: true };
  }

  // Already existed — read it back. Race-safe because (email) is unique.
  const existing = await query('select id from attendees where email = $1', [email]);
  return { id: existing.rows[0].id, created: false };
};

/**
 * Insert a check-in, relying on the DB unique index for same-day dedup. A
 * conflict (already checked in today for this event) returns { created: false }
 * — the use-case maps that to the "duplicate" outcome.
 *
 * @returns {Promise<{created: boolean, id?: string, checkinAt?: string}>}
 */
const insertCheckin = async ({ attendeeId, eventId, token, debug, checkinDate }) => {
  const result = await query(
    `insert into checkins (attendee_id, event_id, token, debug, checkin_date)
     values ($1, $2, $3, $4, $5)
     on conflict do nothing
     returning id, checkin_at`,
    [attendeeId, eventId, token || null, !!debug, checkinDate]
  );

  if (result.rows.length === 0) {
    return { created: false };
  }
  return { created: true, id: result.rows[0].id, checkinAt: result.rows[0].checkin_at };
};

const toNullableCount = (value) => (value === null || value === undefined ? null : Number(value));

/**
 * Read an attendee's streak for an event from the `streaks` view, plus the event's
 * standing (the longest active streak and how many attendees hold it) for the
 * celebration. Returns a zeroed shape when the view has no row yet. Callers treat
 * this as non-fatal — a failure here must never fail a check-in.
 *
 * @returns {Promise<{currentStreak: number, longestStreak: number, isPersonalBest: boolean,
 *   previousStreak: number|null, priorLongestStreak: number|null, weeksAttended: number,
 *   eventTopStreak: number, eventTopHolders: number}>}
 */
const getStreak = async (attendeeId, eventId) => {
  const result = await query(
    `with event_streaks as (
       select attendee_id, current_streak, longest_streak, is_personal_best,
              previous_streak, prior_longest_streak, weeks_attended
       from streaks
       where event_id = $2
     ),
     top as (
       select max(current_streak) as top_streak from event_streaks
     )
     select s.current_streak, s.longest_streak, s.is_personal_best,
            s.previous_streak, s.prior_longest_streak, s.weeks_attended,
            top.top_streak,
            (select count(*) from event_streaks e where e.current_streak = top.top_streak) as top_holders
     from event_streaks s
     cross join top
     where s.attendee_id = $1`,
    [attendeeId, eventId]
  );

  if (result.rows.length === 0) {
    return {
      currentStreak: 0, longestStreak: 0, isPersonalBest: false,
      previousStreak: null, priorLongestStreak: null, weeksAttended: 0,
      eventTopStreak: 0, eventTopHolders: 0,
    };
  }
  const row = result.rows[0];
  return {
    currentStreak: Number(row.current_streak),
    longestStreak: Number(row.longest_streak),
    isPersonalBest: row.is_personal_best === true,
    previousStreak: toNullableCount(row.previous_streak),
    priorLongestStreak: toNullableCount(row.prior_longest_streak),
    weeksAttended: Number(row.weeks_attended),
    eventTopStreak: Number(row.top_streak),
    eventTopHolders: Number(row.top_holders),
  };
};

module.exports = {
  findOrCreateAttendee,
  insertCheckin,
  getStreak,
  // exposed for tests / graceful shutdown
  _getPool: getPool,
};
