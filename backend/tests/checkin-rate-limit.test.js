// The check-in handler with the per-IP rate limit (issue #67). The Postgres store is
// mocked; recordAttemptUnderLimit stands in for the counter (true = under the limit).

jest.mock('../netlify/functions/utils/pg-store', () => ({
    findOrCreateAttendee: jest.fn(),
    insertCheckin: jest.fn(),
    getStreak: jest.fn(),
    recordAttemptUnderLimit: jest.fn(),
}));

const crypto = require('crypto');
const { handler } = require('../netlify/functions/checkin');
const pg = require('../netlify/functions/utils/pg-store');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

const post = (body, headers = {}) => ({
    httpMethod: 'POST',
    headers: { 'x-nf-client-connection-ip': '203.0.113.7', ...headers },
    body: JSON.stringify(body),
});

const validBody = {
    email: 'test@example.com',
    name: 'Test User',
    eventId: 'bocc',
    token: '550e8400-e29b-41d4-a716-446655440000',
    debug: '1',
};

describe('check-in rate limit', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        pg.findOrCreateAttendee.mockResolvedValue({ id: 'att123' });
        pg.insertCheckin.mockResolvedValue({ created: true });
        pg.getStreak.mockResolvedValue(null);
        pg.recordAttemptUnderLimit.mockResolvedValue(true);
    });

    test('over the limit: 429 with a friendly message, and nothing is written', async () => {
        pg.recordAttemptUnderLimit.mockResolvedValue(false);

        const res = await handler(post(validBody));

        expect(res.statusCode).toBe(429);
        const retryAfter = Number(res.headers['Retry-After']);
        expect(retryAfter).toBeGreaterThan(0);
        // The message names the minutes left in the window, matching Retry-After.
        const minutes = Number(JSON.parse(res.body).message.match(/about (\d+) minutes?\./)[1]);
        expect(minutes).toBe(Math.ceil(retryAfter / 60));
        expect(pg.findOrCreateAttendee).not.toHaveBeenCalled();
        expect(pg.insertCheckin).not.toHaveBeenCalled();
    });

    test('under the limit: the check-in goes through as before', async () => {
        const res = await handler(post(validBody));

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).message).toBe('Check-in successful');
        expect(pg.insertCheckin).toHaveBeenCalledTimes(1);
    });

    test('invalid bodies count too, and are refused with 429 before parsing', async () => {
        pg.recordAttemptUnderLimit.mockResolvedValue(false);
        const res = await handler({ ...post({}), body: 'not json' });
        expect(res.statusCode).toBe(429);
    });

    test('limits on the IP Netlify reports, not a header the client can set', async () => {
        await handler(post(validBody, {
            'x-forwarded-for': '198.51.100.1',
            'client-ip': '198.51.100.2',
            'x-real-ip': '198.51.100.3',
        }));

        expect(pg.recordAttemptUnderLimit).toHaveBeenCalledTimes(1);
        expect(pg.recordAttemptUnderLimit.mock.calls[0][0].clientKey).toBe(sha256('203.0.113.7'));
    });

    test('the limiter failing lets the check-in through', async () => {
        pg.recordAttemptUnderLimit.mockRejectedValue(new Error('connection terminated'));
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});

        const res = await handler(post(validBody));

        expect(res.statusCode).toBe(200);
        expect(pg.insertCheckin).toHaveBeenCalledTimes(1);
        const logged = JSON.stringify(spy.mock.calls);
        expect(logged).not.toContain('203.0.113.7');
        expect(logged).not.toContain('test@example.com');
        spy.mockRestore();
    });

    test('CORS preflight is not counted', async () => {
        await handler({ httpMethod: 'OPTIONS', headers: { 'x-nf-client-connection-ip': '203.0.113.7' } });
        expect(pg.recordAttemptUnderLimit).not.toHaveBeenCalled();
    });
});
