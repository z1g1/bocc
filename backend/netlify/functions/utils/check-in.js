/**
 * Check-in use-case — the deep module behind the check-in HTTP handler.
 *
 * `checkInAttendee(rawInput)` owns the whole "check someone in" story:
 * validate → find-or-create Attendee → dedup → record Check-in → Circle sync.
 * It returns a discriminated result for the three EXPECTED outcomes and lets
 * UNEXPECTED infrastructure failures propagate (the handler maps those to 500).
 *
 * The handler is a thin HTTP adapter over this module. See CONTEXT.md →
 * "Check-in use-case" seam.
 *
 * Result shape (discriminated on `status`):
 *   { status: 'invalid',   errors }              ← validation failed
 *   { status: 'duplicate', checkinDate }         ← already checked in today
 *   { status: 'created',   circleSynced }        ← check-in recorded
 *
 * `circleSynced` means "the attendee is now a Circle member": true if
 * ensureMember succeeded (even if the secondary counter increment failed, which
 * is non-blocking), false for debug check-ins or if ensureMember threw. It is
 * for observability/testing only and is never surfaced in the HTTP response.
 */

const { fetchAttendeeByEmail, createAttendee, createCheckinEntry, findExistingCheckin } = require('./airtable');
const { validateCheckinInput } = require('./validation');
const { ensureMember, incrementCheckinCount } = require('./circle');

/**
 * Invite the attendee to the Circle.so community and bump their check-in
 * counter. Non-blocking: any failure here is logged but never fails the
 * check-in. Error-shape inspection (error.response.*) is preserved as-is and
 * will be normalized in candidate 03 (Circle transport).
 *
 * @returns {Promise<boolean>} whether the member was ensured in Circle
 */
const syncCheckinToCircle = async (email, name) => {
    console.log('Inviting attendee to Circle.so:', email);

    try {
        // Ensure member exists in Circle
        const member = await ensureMember(email, name);
        console.log('Successfully ensured Circle member:', member.id || member.email);

        // Increment check-in counter
        try {
            await incrementCheckinCount(member.id);
            console.log('Successfully incremented check-in count for Circle member:', member.id);
        } catch (counterError) {
            // Log counter error but don't fail (custom field might not exist yet)
            console.error('Failed to increment check-in count (non-blocking):', counterError.message);
            if (counterError.response) {
                console.error('Counter update response status:', counterError.response.status);
                console.error('Counter update response data:', JSON.stringify(counterError.response.data));
            }
        }

        return true;
    } catch (error) {
        // Log error but don't fail the check-in
        console.error('Failed to invite to Circle.so (non-blocking):', error.message);
        if (error.response) {
            console.error('Circle API response status:', error.response.status);
            console.error('Circle API response data:', JSON.stringify(error.response.data));
        }
        return false;
    }
};

/**
 * Check an attendee in to an event.
 *
 * @param {object} rawInput - the parsed request body (unvalidated)
 * @returns {Promise<object>} discriminated result (see module docstring)
 * @throws on unexpected infrastructure failures (e.g. Airtable unavailable)
 */
const checkInAttendee = async (rawInput) => {
    // Validate and sanitize all inputs
    const { isValid, errors, sanitized } = validateCheckinInput(rawInput);

    console.log('Parsed email:', sanitized.email);
    console.log('Parsed eventId:', sanitized.eventId);
    console.log('Parsed debug:', sanitized.debug);
    console.log('Parsed token:', sanitized.token);

    if (!isValid) {
        console.log('Validation failed:', errors);
        return { status: 'invalid', errors };
    }

    // Find or create the attendee
    console.log('Fetching attendee by email:', sanitized.email);
    let attendee = await fetchAttendeeByEmail(sanitized.email);

    if (!attendee) {
        console.log('Creating new attendee:', sanitized.email);
        attendee = await createAttendee(
            sanitized.email,
            sanitized.name,
            sanitized.phone,
            sanitized.businessName,
            sanitized.okToEmail,
            sanitized.debug
        );
        console.log('Created new attendee:', attendee.id);
    } else {
        console.log('Found existing attendee:', attendee.id);
    }

    // Check for duplicate check-in on the same day
    console.log('Checking for existing check-in today:', attendee.id, sanitized.eventId, sanitized.token);
    const existingCheckin = await findExistingCheckin(attendee.id, sanitized.eventId, sanitized.token);

    if (existingCheckin) {
        console.log('Duplicate check-in prevented:', sanitized.email, sanitized.eventId);
        return { status: 'duplicate', checkinDate: existingCheckin.get('checkinDate') };
    }

    // Create the check-in entry
    console.log('Creating check-in for attendee:', attendee.id);
    await createCheckinEntry(attendee.id, sanitized.eventId, sanitized.debug, sanitized.token);
    console.log('Created check-in successfully');

    // Invite to Circle.so community + increment counter (non-blocking).
    // Skipped for debug check-ins. (sanitized.debug is a boolean.)
    let circleSynced = false;
    if (!sanitized.debug) {
        circleSynced = await syncCheckinToCircle(sanitized.email, sanitized.name);
    } else {
        console.log('Skipping Circle invitation for debug check-in');
    }

    return { status: 'created', circleSynced };
};

module.exports = {
    checkInAttendee,
};
