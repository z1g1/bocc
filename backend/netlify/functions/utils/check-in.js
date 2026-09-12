/**
 * Check-in use-case — the deep module behind the check-in HTTP handler.
 *
 * `checkInAttendee(rawInput)` owns the whole "check someone in" story:
 * validate → record the Check-in in the configured store → (streak) → Circle sync.
 * It returns a discriminated result for the three EXPECTED outcomes and lets
 * UNEXPECTED infrastructure failures from the store propagate (the handler maps
 * those to 500). See CONTEXT.md → "Check-in use-case" seam.
 *
 * STORE MODES (config.checkin.store — ADR 0005):
 *   'postgres' : Neon Postgres (default).
 *   'airtable' : legacy Airtable-only path, kept for rollback only.
 *
 * Result shape (discriminated on `status`):
 *   { status: 'invalid',   errors }                                  ← validation failed
 *   { status: 'duplicate', checkinDate }                             ← already checked in today
 *   { status: 'created',   circleSynced, streak, celebration }       ← check-in recorded
 *
 * `streak` is the attendee's streak for this event read from Postgres, or `null`. It is
 * BLOCKING-BUT-NON-FATAL: a streak failure (or Airtable mode, or a debug check-in) yields
 * `null` and never fails the check-in. `celebration` is the toast to show
 * (utils/streak-celebration.js), or `null` whenever `streak` is. `circleSynced` is
 * observability-only (see below).
 *
 * Logging: never log attendee PII (email, name, phone) — only event ids and record ids.
 */

const { fetchAttendeeByEmail, createAttendee, createCheckinEntry, findExistingCheckin } = require('./airtable');
const pgStore = require('./pg-store');
const { validateCheckinInput } = require('./validation');
const { ensureMember, incrementCheckinCount } = require('./circle');
const { easternCheckinDate } = require('./eastern-week');
const { celebrationFor } = require('./streak-celebration');
const config = require('./config');

/**
 * Invite the attendee to the Circle.so community and bump their check-in
 * counter. Non-blocking: any failure here is logged but never fails the
 * check-in.
 *
 * @returns {Promise<boolean>} whether the member was ensured in Circle
 */
const syncCheckinToCircle = async (email, name) => {
    console.log('Inviting attendee to Circle.so');

    try {
        const member = await ensureMember(email, name);
        console.log('Successfully ensured Circle member:', member.id);

        try {
            await incrementCheckinCount(member.id);
            console.log('Successfully incremented check-in count for Circle member:', member.id);
        } catch (counterError) {
            console.error('Failed to increment check-in count (non-blocking):', counterError.message);
            if (counterError.response) {
                console.error('Counter update response status:', counterError.response.status);
                console.error('Counter update response data:', JSON.stringify(counterError.response.data));
            }
        }

        return true;
    } catch (error) {
        console.error('Failed to invite to Circle.so (non-blocking):', error.message);
        if (error.response) {
            console.error('Circle API response status:', error.response.status);
            console.error('Circle API response data:', JSON.stringify(error.response.data));
        }
        return false;
    }
};

/**
 * Record a check-in in Airtable (find-or-create attendee → dedup → create).
 * @returns {Promise<{status:'created'|'duplicate', checkinDate?:string, attendeeId:string}>}
 */
const recordCheckinAirtable = async (s) => {
    let attendee = await fetchAttendeeByEmail(s.email);
    if (!attendee) {
        console.log('Creating new Airtable attendee');
        attendee = await createAttendee(s.email, s.name, s.phone, s.businessName, s.okToEmail, s.debug);
    } else {
        console.log('Found existing Airtable attendee:', attendee.id);
    }

    const existing = await findExistingCheckin(attendee.id, s.eventId, s.token);
    if (existing) {
        return { status: 'duplicate', checkinDate: existing.get('checkinDate'), attendeeId: attendee.id };
    }

    await createCheckinEntry(attendee.id, s.eventId, s.debug, s.token);
    return { status: 'created', attendeeId: attendee.id };
};

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

    const usePostgres = config.checkin.store === 'postgres';

    // 1. Record in the store. Failure here propagates (→ 500).
    const result = usePostgres
        ? await recordCheckinPostgres(sanitized)
        : await recordCheckinAirtable(sanitized);

    if (result.status === 'duplicate') {
        console.log('Duplicate check-in prevented for eventId:', sanitized.eventId);
        return { status: 'duplicate', checkinDate: result.checkinDate };
    }

    // 2. Streak + celebration. Blocking-but-non-fatal; never for debug.
    const streak = usePostgres
        ? await readStreakSafe(result.attendeeId, sanitized.eventId, sanitized.debug)
        : null;
    const celebration = celebrationFor(streak);

    // 3. Circle sync (non-blocking). Skipped for debug check-ins.
    let circleSynced = false;
    if (!sanitized.debug) {
        circleSynced = await syncCheckinToCircle(sanitized.email, sanitized.name);
    } else {
        console.log('Skipping Circle invitation for debug check-in');
    }

    return { status: 'created', circleSynced, streak, celebration };
};

module.exports = {
    checkInAttendee,
};
