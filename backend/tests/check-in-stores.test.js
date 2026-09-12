// Tests for the check-in store modes (postgres | airtable) in utils/check-in.js.
// Each mode is loaded fresh via isolateModules so config reads the right
// CHECKIN_STORE; airtable / circle / pg-store are mocked.

const AIRTABLE = '../netlify/functions/utils/airtable';
const CIRCLE = '../netlify/functions/utils/circle';
const PG = '../netlify/functions/utils/pg-store';
const CHECKIN = '../netlify/functions/utils/check-in';

const STREAK = {
    currentStreak: 3, longestStreak: 5, isPersonalBest: false,
    previousStreak: 2, priorLongestStreak: 5, weeksAttended: 9,
    eventTopStreak: 4, eventTopHolders: 1,
};

const validInput = (overrides = {}) => ({
    email: 'test@example.com',
    eventId: 'bocc',
    name: 'Test User',
    token: '550e8400-e29b-41d4-a716-446655440000',
    ...overrides,
});

/**
 * Load check-in.js under a given store mode with fresh mocks.
 * @returns {{checkInAttendee, airtable, circle, pg}}
 */
function loadWithStore(store) {
    let api;
    jest.isolateModules(() => {
        // config reads env at import and fail-fasts on postgres mode with no URL.
        // Set the env, let the FRESH config (required transitively below) capture
        // it synchronously, then restore immediately — so CHECKIN_STORE never
        // persists past this synchronous block into another suite sharing this
        // worker (the env mutation is the whole point of isolating here).
        const prevStore = process.env.CHECKIN_STORE;
        const prevUrl = process.env.CHECKIN_DB_URL;
        process.env.CHECKIN_STORE = store;
        process.env.CHECKIN_DB_URL = 'postgres://checkin_writer@pooler/test';

        jest.doMock(AIRTABLE, () => ({
            fetchAttendeeByEmail: jest.fn().mockResolvedValue(null),
            createAttendee: jest.fn().mockResolvedValue({ id: 'air_att' }),
            createCheckinEntry: jest.fn().mockResolvedValue({ id: 'air_chk' }),
            findExistingCheckin: jest.fn().mockResolvedValue(null),
        }));
        jest.doMock(CIRCLE, () => ({
            ensureMember: jest.fn().mockResolvedValue({ id: 'circle1' }),
            incrementCheckinCount: jest.fn().mockResolvedValue({}),
        }));
        jest.doMock(PG, () => ({
            findOrCreateAttendee: jest.fn().mockResolvedValue({ id: 'pg_att', created: true }),
            insertCheckin: jest.fn().mockResolvedValue({ created: true, id: 'pg_chk' }),
            getStreak: jest.fn().mockResolvedValue({ ...STREAK }),
        }));

        api = {
            checkInAttendee: require(CHECKIN).checkInAttendee, // imports config NOW, reading the env above
            airtable: require(AIRTABLE),
            circle: require(CIRCLE),
            pg: require(PG),
        };

        // Restore so no other suite in this worker ever sees these.
        if (prevStore === undefined) delete process.env.CHECKIN_STORE; else process.env.CHECKIN_STORE = prevStore;
        if (prevUrl === undefined) delete process.env.CHECKIN_DB_URL; else process.env.CHECKIN_DB_URL = prevUrl;
    });
    return api;
}

describe('store mode: postgres (default)', () => {
    test('writes only Postgres, returns streak + celebration, no Airtable', async () => {
        const { checkInAttendee, airtable, pg, circle } = loadWithStore('postgres');
        const r = await checkInAttendee(validInput());

        expect(r.status).toBe('created');
        expect(pg.insertCheckin).toHaveBeenCalled();
        expect(pg.getStreak).toHaveBeenCalledWith('pg_att', 'bocc');
        expect(r.streak).toEqual(STREAK);
        expect(r.celebration).toEqual({ kind: 'continued', currentStreak: 3, previousStreak: 2 });
        expect(airtable.fetchAttendeeByEmail).not.toHaveBeenCalled();
        expect(airtable.createCheckinEntry).not.toHaveBeenCalled();
        expect(circle.ensureMember).toHaveBeenCalled();
    });

    test('first check-in ever gets the first_visit celebration', async () => {
        const { checkInAttendee, pg } = loadWithStore('postgres');
        pg.getStreak.mockResolvedValueOnce({
            ...STREAK, currentStreak: 1, longestStreak: 1, previousStreak: null,
            priorLongestStreak: null, weeksAttended: 1,
        });

        const r = await checkInAttendee(validInput());

        expect(r.celebration).toEqual({ kind: 'first_visit', currentStreak: 1, previousStreak: null });
    });

    test('Postgres duplicate returns duplicate, no streak, no celebration, no Circle', async () => {
        const { checkInAttendee, pg, circle } = loadWithStore('postgres');
        pg.insertCheckin.mockResolvedValueOnce({ created: false });

        const r = await checkInAttendee(validInput());

        expect(r.status).toBe('duplicate');
        expect(r.checkinDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(r.celebration).toBeUndefined();
        expect(pg.getStreak).not.toHaveBeenCalled();
        expect(circle.ensureMember).not.toHaveBeenCalled();
    });

    test('still created when the streak read fails (non-fatal), no celebration', async () => {
        const { checkInAttendee, pg } = loadWithStore('postgres');
        pg.getStreak.mockRejectedValueOnce(new Error('view timeout'));

        const r = await checkInAttendee(validInput());

        expect(r.status).toBe('created');
        expect(r.streak).toBeNull();
        expect(r.celebration).toBeNull();
    });

    test('a Postgres write failure propagates (handler maps to 500)', async () => {
        const { checkInAttendee, pg } = loadWithStore('postgres');
        pg.insertCheckin.mockRejectedValueOnce(new Error('connection refused'));

        await expect(checkInAttendee(validInput())).rejects.toThrow('connection refused');
    });

    test('debug check-in: recorded but no streak, no celebration and no Circle', async () => {
        const { checkInAttendee, pg, circle } = loadWithStore('postgres');
        const r = await checkInAttendee(validInput({ debug: '1' }));

        expect(r.status).toBe('created');
        expect(pg.insertCheckin).toHaveBeenCalled();
        expect(pg.getStreak).not.toHaveBeenCalled();                 // debug never affects streaks
        expect(circle.ensureMember).not.toHaveBeenCalled();
        expect(r.streak).toBeNull();
        expect(r.celebration).toBeNull();
    });
});

describe('store mode: airtable (legacy rollback)', () => {
    test('writes only Airtable, no Postgres, streak and celebration null', async () => {
        const { checkInAttendee, airtable, pg, circle } = loadWithStore('airtable');
        const r = await checkInAttendee(validInput());

        expect(r.status).toBe('created');
        expect(r.streak).toBeNull();
        expect(r.celebration).toBeNull();
        expect(airtable.createCheckinEntry).toHaveBeenCalled();
        expect(pg.findOrCreateAttendee).not.toHaveBeenCalled();
        expect(pg.getStreak).not.toHaveBeenCalled();
        expect(circle.ensureMember).toHaveBeenCalled();
    });
});
