const { checkInAttendee } = require('./utils/check-in');
const config = require('./utils/config');

// CORS configuration — centralized in config (env-overridable, defaults to '*').
const ALLOWED_ORIGIN = config.http.allowedOrigin;

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

    try {
        const result = await checkInAttendee(requestBody);

        switch (result.status) {
            case 'invalid':
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({ message: result.errors[0], errors: result.errors }),
                };

            case 'duplicate':
                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({
                        message: 'Already checked in for this event today',
                        alreadyCheckedIn: true,
                        checkinDate: result.checkinDate
                    }),
                };

            case 'created':
                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({
                        message: 'Check-in successful',
                        // Streak for the frontend celebration; null when unavailable
                        // (Airtable-only mode, debug check-in, or a non-fatal failure).
                        streak: result.streak || null
                    }),
                };

            default:
                // Unknown status — treat as an unexpected failure.
                throw new Error(`Unexpected check-in result status: ${result.status}`);
        }
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
