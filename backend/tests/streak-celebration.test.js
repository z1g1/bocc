// Unit tests for the pure celebration decision (utils/streak-celebration.js).

const { celebrationFor } = require('../netlify/functions/utils/streak-celebration');

const streak = (overrides = {}) => ({
    currentStreak: 1,
    longestStreak: 1,
    isPersonalBest: true,
    previousStreak: null,
    priorLongestStreak: null,
    weeksAttended: 1,
    eventTopStreak: 6,
    eventTopHolders: 1,
    ...overrides,
});

describe('celebrationFor', () => {
    test('returns null when there is no streak', () => {
        expect(celebrationFor(null)).toBeNull();
        expect(celebrationFor(undefined)).toBeNull();
    });

    test('returns null for the zeroed no-row shape', () => {
        expect(celebrationFor(streak({ currentStreak: 0, weeksAttended: 0 }))).toBeNull();
    });

    test('first_visit on the very first check-in', () => {
        expect(celebrationFor(streak())).toEqual({ kind: 'first_visit', currentStreak: 1, previousStreak: null });
    });

    test('first_visit wins even if they are technically the event top', () => {
        expect(celebrationFor(streak({ eventTopStreak: 1 })).kind).toBe('first_visit');
    });

    test('first_streak at 2 weeks with no earlier run of 2+', () => {
        const c = celebrationFor(streak({ currentStreak: 2, weeksAttended: 3, previousStreak: 1, priorLongestStreak: 1 }));
        expect(c).toEqual({ kind: 'first_streak', currentStreak: 2, previousStreak: 1 });
    });

    test('continued (not first_streak) at 2 weeks when an earlier run reached 2+', () => {
        const c = celebrationFor(streak({ currentStreak: 2, weeksAttended: 6, previousStreak: 3, priorLongestStreak: 3 }));
        expect(c.kind).toBe('continued');
    });

    test('continued for 3+ weeks below the event top', () => {
        expect(celebrationFor(streak({ currentStreak: 4, weeksAttended: 4, eventTopStreak: 6 })).kind).toBe('continued');
    });

    test('top_streak when sole holder of the longest active streak', () => {
        const c = celebrationFor(streak({ currentStreak: 6, weeksAttended: 8, eventTopStreak: 6, eventTopHolders: 1 }));
        expect(c).toEqual({ kind: 'top_streak', currentStreak: 6, previousStreak: null });
    });

    test('top_streak beats first_streak', () => {
        const c = celebrationFor(streak({ currentStreak: 2, weeksAttended: 2, eventTopStreak: 2, eventTopHolders: 1 }));
        expect(c.kind).toBe('top_streak');
    });

    test('first_streak beats tied_top', () => {
        const c = celebrationFor(streak({ currentStreak: 2, weeksAttended: 2, eventTopStreak: 2, eventTopHolders: 3 }));
        expect(c.kind).toBe('first_streak');
    });

    test('tied_top when sharing the longest active streak', () => {
        const c = celebrationFor(streak({ currentStreak: 5, weeksAttended: 7, eventTopStreak: 5, eventTopHolders: 2 }));
        expect(c.kind).toBe('tied_top');
    });

    test('a 1-week streak is never top/tied even if 1 is the event max', () => {
        const c = celebrationFor(streak({ currentStreak: 1, weeksAttended: 4, previousStreak: 2, eventTopStreak: 1, eventTopHolders: 9 }));
        expect(c.kind).toBe('restart');
    });

    test('restart carries the previous streak length', () => {
        expect(celebrationFor(streak({ currentStreak: 1, weeksAttended: 5, previousStreak: 3, priorLongestStreak: 4 })))
            .toEqual({ kind: 'restart', currentStreak: 1, previousStreak: 3 });
    });

    test('restart after a previous 1-week run', () => {
        expect(celebrationFor(streak({ currentStreak: 1, weeksAttended: 2, previousStreak: 1 })))
            .toEqual({ kind: 'restart', currentStreak: 1, previousStreak: 1 });
    });

    test('coerces numeric strings from Postgres bigint columns', () => {
        const c = celebrationFor(streak({ currentStreak: '3', weeksAttended: '3', eventTopStreak: '3', eventTopHolders: '1' }));
        expect(c).toEqual({ kind: 'top_streak', currentStreak: 3, previousStreak: null });
    });
});
