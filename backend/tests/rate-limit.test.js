// Unit tests for the per-IP check-in rate limiter (utils/rate-limit.js, issue #67).
// The limiter's storage is a fake that honours the store contract the Postgres
// adapter implements: record an attempt for (clientKey, windowStart) only when fewer
// than `limit` are already recorded there, and say whether it did. The real SQL is
// covered by tests/admin/checkin-rate-limit.test.mjs against a throwaway Postgres.

const { createRateLimiter, rateLimitedMessage } = require('../netlify/functions/utils/rate-limit');

const fakeStore = () => {
    const counts = new Map();
    const store = {
        calls: [],
        async recordAttemptUnderLimit({ clientKey, windowStart, limit }) {
            store.calls.push({ clientKey, windowStart, limit });
            const k = `${clientKey}|${windowStart.toISOString()}`;
            const n = counts.get(k) || 0;
            if (n >= limit) return false;
            counts.set(k, n + 1);
            return true;
        },
    };
    return store;
};

const T0 = Date.parse('2026-11-24T13:00:00Z'); // a Tuesday, 8:00 Eastern

const setup = ({ limit = 3, windowSeconds = 3600, store = fakeStore(), log } = {}) => {
    let now = T0;
    const logger = log || { error: jest.fn(), warn: jest.fn() };
    const limiter = createRateLimiter({ store, limit, windowSeconds, now: () => now, log: logger });
    return { limiter, store, logger, advance: (ms) => { now += ms; } };
};

describe('check-in rate limiter', () => {
    test('allows attempts under the limit', async () => {
        const { limiter } = setup({ limit: 3 });
        expect((await limiter.check('203.0.113.7')).allowed).toBe(true);
        expect((await limiter.check('203.0.113.7')).allowed).toBe(true);
    });

    test('allows the attempt that reaches the limit, refuses the next', async () => {
        const { limiter } = setup({ limit: 3 });
        for (let i = 0; i < 3; i++) {
            expect((await limiter.check('203.0.113.7')).allowed).toBe(true);
        }
        const over = await limiter.check('203.0.113.7');
        expect(over.allowed).toBe(false);
    });

    test('says how long until the window resets when refusing', async () => {
        const { limiter, advance } = setup({ limit: 1, windowSeconds: 3600 });
        advance(20 * 60 * 1000); // 8:20 Eastern, 40 minutes left in the hour's window
        await limiter.check('203.0.113.7');
        const over = await limiter.check('203.0.113.7');
        expect(over).toEqual({ allowed: false, retryAfterSeconds: 2400 });
    });

    test('counts each client IP separately', async () => {
        const { limiter } = setup({ limit: 1 });
        expect((await limiter.check('203.0.113.7')).allowed).toBe(true);
        expect((await limiter.check('203.0.113.7')).allowed).toBe(false);
        expect((await limiter.check('198.51.100.20')).allowed).toBe(true);
    });

    test('allows again once the window passes', async () => {
        const { limiter, advance } = setup({ limit: 2, windowSeconds: 600 });
        await limiter.check('203.0.113.7');
        await limiter.check('203.0.113.7');
        expect((await limiter.check('203.0.113.7')).allowed).toBe(false);

        advance(10 * 60 * 1000);
        expect((await limiter.check('203.0.113.7')).allowed).toBe(true);
    });

    test('never hands the raw IP to the store', async () => {
        const { limiter, store } = setup();
        await limiter.check('203.0.113.7');
        const [{ clientKey }] = store.calls;
        expect(clientKey).not.toContain('203.0.113.7');
        expect(clientKey).toMatch(/^[0-9a-f]{64}$/);
    });

    test('allows the check-in and logs without the IP when the store fails', async () => {
        const store = { recordAttemptUnderLimit: jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED')) };
        const { limiter, logger } = setup({ store });

        const result = await limiter.check('203.0.113.7');

        expect(result.allowed).toBe(true);
        expect(logger.error).toHaveBeenCalled();
        const logged = JSON.stringify(logger.error.mock.calls);
        expect(logged).toContain('ECONNREFUSED');
        expect(logged).not.toContain('203.0.113.7');
    });

    test('allows the check-in without touching the store when there is no client IP', async () => {
        const { limiter, store, logger } = setup();
        expect((await limiter.check(undefined)).allowed).toBe(true);
        expect((await limiter.check('')).allowed).toBe(true);
        expect(store.calls).toHaveLength(0);
        expect(logger.warn).toHaveBeenCalled();
    });
});

describe('rateLimitedMessage', () => {
    test('says how many minutes are left in the window, rounded up', () => {
        expect(rateLimitedMessage(1800)).toBe('Too many check-in attempts. Please try again in about 30 minutes.');
        expect(rateLimitedMessage(3599)).toBe('Too many check-in attempts. Please try again in about 60 minutes.');
        expect(rateLimitedMessage(61)).toBe('Too many check-in attempts. Please try again in about 2 minutes.');
    });

    test('under a minute left reads as one minute, singular', () => {
        expect(rateLimitedMessage(1)).toBe('Too many check-in attempts. Please try again in about 1 minute.');
        expect(rateLimitedMessage(60)).toBe('Too many check-in attempts. Please try again in about 1 minute.');
    });
});
