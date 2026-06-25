/**
 * Check-in use-case — the deep module behind the check-in HTTP handler.
 *
 * `checkInAttendee(rawInput)` owns the whole "check someone in" story:
 * validate → record the Check-in in the configured store → (streak) → Circle sync.
 * It returns a discriminated result for the three EXPECTED outcomes and lets
 * UNEXPECTED infrastructure failures from the AUTHORITATIVE store propagate (the
 * handler maps those to 500). See CONTEXT.md → "Check-in use-case" seam.
 *
 * STORE MODES (config.checkin.store — the migration ladder, ADR 0003):
 *   'airtable' : Airtable only (current production behavior).
 *   'dual'     : Airtable is AUTHORITATIVE (decides created/duplicate); Supabase
 *                gets a NON-BLOCKING shadow write and powers the streak. The
 *                one-week verification mode.
 *   'supabase' : Supabase is authoritative; Airtable is not written.
 *
 * Result shape (discriminated on `status`):
 *   { status: 'invalid',   errors }                        ← validation failed
 *   { status: 'duplicate', checkinDate }                   ← already checked in today
 *   { status: 'created',   circleSynced, streak }          ← check-in recorded
 *
 * `streak` is the attendee's streak for this event ({ currentStreak, longestStreak,
 * isPersonalBest }) read from Supabase, or `null`. It is BLOCKING-BUT-NON-FATAL:
 * a streak failure (or Airtable-only mode, or a debug check-in) yields `null` and
 * never fails the check-in. `circleSynced` is observability-only (see below).
 */

const { fetchAttendeeByEmail, createAttendee, createCheckinEntry, findExistingCheckin } = require('./airtable');
const supabaseStore = require('./supabase-store');
const { validateCheckinInput } = require('./validation');
const { ensureMember, incrementCheckinCount } = require('./circle');
const { easternCheckinDate } = require('./eastern-week');
const config = require('./config');

/**
 * Invite the attendee to the Circle.so community and bump their check-in
 * counter. Non-blocking: any failure here is logged but never fails the
 * check-in.
 *
 * @returns {Promise<boolean>} whether the member was ensured in Circle
 */
const syncCheckinToCircle = async (email, name) => {
    console.log('Inviting attendee to Circle.so:', email);

    try {
        const member = await ensureMember(email, name);
        console.log('Successfully ensured Circle member:', member.id || member.email);

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
        console.log('Creating new Airtable attendee:', s.email);
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
 * Record a check-in in Supabase (find-or-create attendee → insert with
 * DB-enforced same-day dedup). Returns the Supabase attendee id so the caller
 * can read the streak.
 * @returns {Promise<{status:'created'|'duplicate', checkinDate:string, attendeeId:string}>}
 */
const recordCheckinSupabase = async (s) => {
    const attendee = await supabaseStore.findOrCreateAttendee({
        email: s.email, name: s.name, phone: s.phone,
        businessName: s.businessName, okToEmail: s.okToEmail, debug: s.debug,
    });
    const checkinDate = easternCheckinDate(new Date());
    const res = await supabaseStore.insertCheckin({
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
 * Read the attendee's streak from Supabase. Non-blocking: never throws — returns
 * null on any failure. Never reads for debug check-ins (they don't affect streaks).
 * @returns {Promise<object|null>}
 */
const readStreakSafe = async (supabaseAttendeeId, eventId, debug) => {
    if (!supabaseAttendeeId || debug) return null;
    try {
        return await supabaseStore.getStreak(supabaseAttendeeId, eventId);
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
 * @throws on unexpected infrastructure failure of the AUTHORITATIVE store
 */
const checkInAttendee = async (rawInput) => {
    const { isValid, errors, sanitized } = validateCheckinInput(rawInput);

    console.log('Parsed email:', sanitized.email);
    console.log('Parsed eventId:', sanitized.eventId);
    console.log('Parsed debug:', sanitized.debug);

    if (!isValid) {
        console.log('Validation failed:', errors);
        return { status: 'invalid', errors };
    }

    const store = config.checkin.store;

    // 1. Record in the AUTHORITATIVE store. Failure here propagates (→ 500).
    const primaryFlow = store === 'supabase' ? recordCheckinSupabase : recordCheckinAirtable;
    const result = await primaryFlow(sanitized);

    if (result.status === 'duplicate') {
        console.log('Duplicate check-in prevented:', sanitized.email, sanitized.eventId);
        return { status: 'duplicate', checkinDate: result.checkinDate };
    }

    // 2. Dual-write: shadow the check-in into Supabase. NON-BLOCKING — a failure
    //    here must never fail a check-in the authoritative store already accepted.
    let supabaseAttendeeId = store === 'supabase' ? result.attendeeId : null;
    if (store === 'dual') {
        try {
            const shadow = await recordCheckinSupabase(sanitized);
            supabaseAttendeeId = shadow.attendeeId;
            console.log('Supabase shadow write ok:', shadow.status);
        } catch (error) {
            console.error('Supabase shadow write failed (non-blocking):', error.message);
        }
    }

    // 3. Streak for the celebration. Blocking-but-non-fatal; never for debug.
    const streak = await readStreakSafe(supabaseAttendeeId, sanitized.eventId, sanitized.debug);

    // 4. Circle sync (non-blocking). Skipped for debug check-ins.
    let circleSynced = false;
    if (!sanitized.debug) {
        circleSynced = await syncCheckinToCircle(sanitized.email, sanitized.name);
    } else {
        console.log('Skipping Circle invitation for debug check-in');
    }

    return { status: 'created', circleSynced, streak };
};

module.exports = {
    checkInAttendee,
};
