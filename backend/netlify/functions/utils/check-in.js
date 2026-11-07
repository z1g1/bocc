/**
 * Check-in use-case — the deep module behind the check-in HTTP handler.
 *
 * `checkInAttendee(rawInput)` owns the whole "check someone in" story:
 * validate → record the Check-in in Postgres → read the streak.
 * It returns a discriminated result for the three EXPECTED outcomes and lets
 * UNEXPECTED infrastructure failures from the store propagate (the handler maps
 * those to 500). See CONTEXT.md → "Check-in use-case" seam.
 *
 * Neon Postgres is the only place check-in data is written (ADR 0006).
 *
 * Result shape (discriminated on `status`):
 *   { status: 'invalid',   errors }                     ← validation failed
 *   { status: 'duplicate', checkinDate }                ← already checked in today
 *   { status: 'created',   streak, celebration }        ← check-in recorded
 *
 * `streak` is the attendee's streak for this event read from Postgres, or `null`. It is
 * BLOCKING-BUT-NON-FATAL: a streak failure (or a debug check-in) yields `null` and never
 * fails the check-in. `celebration` is the toast to show (utils/streak-celebration.js),
 * or `null` whenever `streak` is.
 *
 * Logging: never log attendee PII (email, name, phone) — only event ids and record ids.
 */

const pgStore = require('./pg-store');
const { validateCheckinInput } = require('./validation');
const { easternCheckinDate } = require('./eastern-week');
const { celebrationFor } = require('./streak-celebration');

/**
 * Record a check-in in Postgres (find-or-create attendee → insert with
 * DB-enforced same-day dedup). Returns the Postgres attendee id so the caller
 * can read the streak.
 * @returns {Promise<{status:'created'|'duplicate', checkinDate:string, attendeeId:string}>}
 */
const recordCheckinPostgres = async (s) => {
    const attendee = await pgStore.findOrCreateAttendee({
        email: s.email, name: s.name, phone: s.phone,
        businessName: s.businessName, okToEmail: s.okToEmail, debug: s.debug,
    });
    const checkinDate = easternCheckinDate(new Date());
    const res = await pgStore.insertCheckin({
        attendeeId: attendee.id, eventId: s.eventId, token: s.token,
        debug: s.debug, checkinDate,
    });
    return {
        status: res.created ? 'created' : 'duplicate',
        checkinDate,
        attendeeId: attendee.id,
    };
};

/**
 * Read the attendee's streak from Postgres. Non-blocking: never throws — returns
 * null on any failure. Never reads for debug check-ins (they don't affect streaks).
 * @returns {Promise<object|null>}
 */
const readStreakSafe = async (pgAttendeeId, eventId, debug) => {
    if (!pgAttendeeId || debug) return null;
    try {
        return await pgStore.getStreak(pgAttendeeId, eventId);
    } catch (error) {
        console.error('Streak read failed (non-blocking):', error.message);
        return null;
    }
};

/**
 * Check an attendee in to an event.
 *
 * @param {object} rawInput - the parsed request body (unvalidated)
 * @returns {Promise<object>} discriminated result (see module docstring)
 * @throws on unexpected infrastructure failure of the store
 */
const checkInAttendee = async (rawInput) => {
    const { isValid, errors, sanitized } = validateCheckinInput(rawInput);

    console.log('Check-in for eventId:', sanitized.eventId, 'debug:', sanitized.debug);

    if (!isValid) {
        console.log('Validation failed:', errors);
        return { status: 'invalid', errors };
    }

    // 1. Record in Postgres. Failure here propagates (→ 500).
    const result = await recordCheckinPostgres(sanitized);

    if (result.status === 'duplicate') {
        console.log('Duplicate check-in prevented for eventId:', sanitized.eventId);
        return { status: 'duplicate', checkinDate: result.checkinDate };
    }

    // 2. Streak + celebration. Blocking-but-non-fatal; never for debug.
    const streak = await readStreakSafe(result.attendeeId, sanitized.eventId, sanitized.debug);
    const celebration = celebrationFor(streak);

    return { status: 'created', streak, celebration };
};

module.exports = {
    checkInAttendee,
};
