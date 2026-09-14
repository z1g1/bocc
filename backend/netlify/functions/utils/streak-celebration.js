/**
 * Streak celebration — pure decision of which toast (if any) an attendee sees after a
 * successful check-in. No I/O; the check-in use-case feeds it the Streak read from
 * Postgres (utils/pg-store.js getStreak) and returns the result to the frontend, which
 * owns the copy and emoji. See CONTEXT.md → "Celebration".
 *
 * Priority (first match wins):
 *   first_visit   weeksAttended = 1
 *   top_streak    currentStreak ≥ 2, equals the event's longest active streak, sole holder
 *   first_streak  currentStreak = 2 and no earlier run reached 2
 *   tied_top      currentStreak ≥ 2, equals the event's longest active streak, 2+ holders
 *   continued     currentStreak ≥ 2
 *   restart       currentStreak = 1 after attending before
 */

const toInt = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
};

/**
 * @param {object|null} streak - getStreak() shape, or null when unavailable
 * @returns {{kind: string, currentStreak: number, previousStreak: number|null}|null}
 */
const celebrationFor = (streak) => {
    if (!streak) return null;

    const current = toInt(streak.currentStreak);
    const weeks = toInt(streak.weeksAttended);
    if (current < 1 || weeks < 1) return null;

    const previous = streak.previousStreak == null ? null : toInt(streak.previousStreak);
    const priorLongest = toInt(streak.priorLongestStreak);
    const isEventTop = current >= 2 && current === toInt(streak.eventTopStreak);
    const topHolders = toInt(streak.eventTopHolders);

    const result = (kind) => ({ kind, currentStreak: current, previousStreak: previous });

    if (weeks === 1) return result('first_visit');
    if (isEventTop && topHolders <= 1) return result('top_streak');
    if (current === 2 && priorLongest < 2) return result('first_streak');
    if (isEventTop) return result('tied_top');
    if (current >= 2) return result('continued');
    return result('restart');
};

module.exports = { celebrationFor };
