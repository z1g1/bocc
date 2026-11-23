const { checkInAttendee } = require('./utils/check-in');
const config = require('./utils/config');
const pgStore = require('./utils/pg-store');
const { createRateLimiter, rateLimitedMessage } = require('./utils/rate-limit');
const { isHoneypotFilled } = require('./utils/validation');

// Per-IP rate limit (issue #67, ADR 0013). Fails open: see utils/rate-limit.js.
const rateLimiter = createRateLimiter({ store: pgStore, ...config.checkinRateLimit });

// CORS configuration — centralized in config (env-overridable, defaults to '*').
const ALLOWED_ORIGIN = config.http.allowedOrigin;

// The reply to a successful check-in. The honeypot reply uses it too, so a caught bot
// gets exactly what a real check-in gets. streak/celebration feed the frontend toast;
// null when unavailable (debug check-in, a non-fatal failure, or a caught bot).
const successResponse = (headers, { streak = null, celebration = null } = {}) => ({
    statusCode: 200,
    headers,
    body: JSON.stringify({ message: 'Check-in successful', streak, celebration }),
});

exports.handler = async (event) => {
    // Never log the raw event: it carries attendee PII in the body and short-lived
    // Netlify tokens (purge/log/blobs) in the payload. Method + request id only.
    const requestId = (event.headers && event.headers['x-nf-request-id']) || 'n/a';
    console.log('Check-in request:', event.httpMethod, 'request id:', requestId);

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

    // Rate limit every POST before parsing it. The IP is the one Netlify reports
    // (x-nf-client-connection-ip), which the client can't set; never X-Forwarded-For.
    const clientIp = event.headers && event.headers['x-nf-client-connection-ip'];
    const limit = await rateLimiter.check(clientIp);
    if (!limit.allowed) {
        console.log('Check-in rate limited, request id:', requestId);
        return {
            statusCode: 429,
            headers: { ...headers, 'Retry-After': String(limit.retryAfterSeconds) },
            body: JSON.stringify({ message: rateLimitedMessage(limit.retryAfterSeconds) }),
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

    // Server-side honeypot: real people never see the hidden `website` field, so a
    // filled one is a bot. Write nothing, but answer exactly as a successful check-in
    // does so the bot can't tell it was caught. Log event id + request id only (no PII).
    if (isHoneypotFilled(requestBody)) {
        console.warn('Honeypot caught check-in, event id:', String(requestBody.eventId).slice(0, 64),
            'request id:', requestId);
        return successResponse(headers);
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
                return successResponse(headers, {
                    streak: result.streak || null,
                    celebration: result.celebration || null,
                });

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
