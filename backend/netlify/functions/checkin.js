const { fetchAttendeeByEmail, createAttendee, createCheckinEntry, findExistingCheckin } = require('./utils/airtable');
const { validateCheckinInput } = require('./utils/validation');
const { ensureMember, incrementCheckinCount } = require('./utils/circle');

// CORS configuration - use environment variable for production security
// Set ALLOWED_ORIGIN in Netlify environment variables to your frontend domain
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

exports.handler = async (event) => {
    console.log('Received event:', event);

    const headers = {
        'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
    };

    if (event.httpMethod === 'OPTIONS') {
        console.log('Handling CORS preflight request');
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ message: 'CORS preflight response' }),
        };
    }

    // Parse request body with error handling
    let requestBody;
    try {
        requestBody = JSON.parse(event.body || '{}');
    } catch (parseError) {
        console.error('Failed to parse request body:', parseError.message);
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ message: 'Invalid request body' }),
        };
    }

    // Validate and sanitize all inputs
    const { isValid, errors, sanitized } = validateCheckinInput(requestBody);

    console.log('Parsed email:', sanitized.email);
    console.log('Parsed eventId:', sanitized.eventId);
    console.log('Parsed debug:', sanitized.debug);
    console.log('Parsed token:', sanitized.token);

    if (!isValid) {
        console.log('Validation failed:', errors);
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ message: errors[0], errors }),
        };
    }

    try {
        // Check if the attendee exists (fetch or create)
        console.log('Fetching attendee by email:', sanitized.email);
        let attendee = await fetchAttendeeByEmail(sanitized.email);

        if (!attendee) {
            // Create a new attendee
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
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    message: 'Already checked in for this event today',
                    alreadyCheckedIn: true,
                    checkinDate: existingCheckin.get('checkinDate')
                }),
            };
        }

        // Create the check-in entry
        console.log('Creating check-in for attendee:', attendee.id);
        await createCheckinEntry(attendee.id, sanitized.eventId, sanitized.debug, sanitized.token);
        console.log('Created check-in successfully');

        // Invite attendee to Circle.so community and increment check-in counter
        // Only for non-debug check-ins
        if (!sanitized.debug || sanitized.debug === '0') {
            console.log('Inviting attendee to Circle.so:', sanitized.email);

            try {
                // Ensure member exists in Circle
                const member = await ensureMember(sanitized.email, sanitized.name);
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
            } catch (error) {
                // Log error but don't fail the check-in
                console.error('Failed to invite to Circle.so (non-blocking):', error.message);
                if (error.response) {
                    console.error('Circle API response status:', error.response.status);
                    console.error('Circle API response data:', JSON.stringify(error.response.data));
                }
            }
        } else {
            console.log('Skipping Circle invitation for debug check-in');
        }

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ message: 'Check-in successful' }),
        };
    } catch (error) {
        // Log full error details server-side for debugging
        console.error('Error during check-in process:', error);
        console.error('Error stack:', error.stack);

        // Return generic error message to client (Issue #7: sanitize error responses)
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ message: 'An error occurred while processing your request' }),
        };
    }
};
