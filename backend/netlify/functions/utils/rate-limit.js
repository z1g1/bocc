/**
 * Per-IP rate limit for the check-in endpoint (issue #67, ADR 0013).
 *
 * A fixed window per client IP: at most `limit` check-in attempts from one IP in each
 * `windowSeconds` window (windows are aligned to the Unix epoch, so a 3600 s window is
 * a clock hour). Every POST counts, valid or not, before anything else runs.
 *
 * `limiter.check(clientIp)` → `{ allowed: true }` or
 *                             `{ allowed: false, retryAfterSeconds }`.
 * It never throws. If the store fails (database unreachable, say) or there is no
 * client IP, the attempt is ALLOWED: the limiter only exists to stop scripted floods,
 * and it must never be the reason a real attendee can't check in.
 *
 * The store never sees the raw IP, only its SHA-256 (`clientKey`). Logs carry neither.
 *
 * Store contract (implemented by pg-store.recordAttemptUnderLimit):
 *   recordAttemptUnderLimit({ clientKey, windowStart: Date, limit })
 *     → true when fewer than `limit` attempts were recorded for (clientKey, windowStart)
 *       and this one was recorded; false when the window is already full (nothing written).
 */

const crypto = require('crypto');

const hashIp = (ip) => crypto.createHash('sha256').update(ip).digest('hex');

const createRateLimiter = ({ store, limit, windowSeconds, now = () => Date.now(), log = console }) => {
    const windowMs = windowSeconds * 1000;

    const check = async (clientIp) => {
        if (!clientIp) {
            log.warn('[rate-limit] no client IP on the request; not rate limited');
            return { allowed: true };
        }

        const t = now();
        const windowStartMs = Math.floor(t / windowMs) * windowMs;

        try {
            const recorded = await store.recordAttemptUnderLimit({
                clientKey: hashIp(clientIp),
                windowStart: new Date(windowStartMs),
                limit,
            });
            if (recorded) return { allowed: true };
            return {
                allowed: false,
                retryAfterSeconds: Math.max(1, Math.ceil((windowStartMs + windowMs - t) / 1000)),
            };
        } catch (error) {
            // Fail open. Message only: never the IP or the request body.
            log.error('[rate-limit] limiter failed, allowing the check-in:', error.message);
            return { allowed: true };
        }
    };

    return { check };
};

// The 429 message, honest about how long is left in the window (minutes, rounded up).
const rateLimitedMessage = (retryAfterSeconds) => {
    const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
    return `Too many check-in attempts. Please try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`;
};

module.exports = { createRateLimiter, rateLimitedMessage };
