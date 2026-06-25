/**
 * Supabase (Postgres) check-in store — the storage adapter behind the check-in
 * use-case for the post-migration world. See ADR 0003 / ADR 0004 and
 * docs/backend/SUPABASE_PERMISSIONS.md.
 *
 * This module is the Postgres counterpart of `utils/airtable.js`. It owns the
 * three operations the use-case needs:
 *   - findOrCreateAttendee  (idempotent, by lowercased email)
 *   - insertCheckin         (DB-enforced same-day dedup via ON CONFLICT)
 *   - getStreak             (reads the recompute-on-read `streaks` view)
 *
 * It connects as the least-privilege `checkin_writer` role (NOT service_role),
 * via the Supabase transaction pooler. A single small pool is reused for the
 * function-process lifetime (cold-start once), mirroring the Bot-JWT memoization
 * pattern in circle-http.js.
 */

const { Pool } = require('pg');
const config = require('./config');
const { getSslConfig } = require('./supabase-ssl');

let pool;

/**
 * Lazily build the connection pool. Throws a clear error if the connection
 * string is unset — the Supabase path is opt-in until cutover (Phase 1), so
 * config does not make it a required boot secret.
 */
const getPool = () => {
  if (!pool) {
    if (!config.supabase.connectionString) {
      throw new Error(
        '[supabase-store] SUPABASE_CHECKIN_WRITER_URL is not set; cannot reach Postgres. ' +
        'See docs/backend/SUPABASE_PERMISSIONS.md.'
      );
    }
    pool = new Pool({
      connectionString: config.supabase.connectionString,
      max: config.supabase.poolMax,
      ssl: getSslConfig(),
    });
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

/**
 * Read an attendee's streak for an event from the `streaks` view. Returns a
 * zeroed shape when the view has no row yet (e.g. their very first check-in is
 * still being committed in another path). Callers treat this as non-fatal — a
 * failure here must never fail a check-in.
 *
 * @returns {Promise<{currentStreak: number, longestStreak: number, isPersonalBest: boolean}>}
 */
const getStreak = async (attendeeId, eventId) => {
  const result = await query(
    `select current_streak, longest_streak, is_personal_best
     from streaks
     where attendee_id = $1 and event_id = $2`,
    [attendeeId, eventId]
  );

  if (result.rows.length === 0) {
    return { currentStreak: 0, longestStreak: 0, isPersonalBest: false };
  }
  const row = result.rows[0];
  return {
    currentStreak: Number(row.current_streak),
    longestStreak: Number(row.longest_streak),
    isPersonalBest: row.is_personal_best === true,
  };
};

module.exports = {
  findOrCreateAttendee,
  insertCheckin,
  getStreak,
  // exposed for tests / graceful shutdown
  _getPool: getPool,
};
