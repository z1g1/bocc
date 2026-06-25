// Tests for the check-in store-mode ladder (airtable | dual | supabase) in
// utils/check-in.js. Each mode is loaded fresh via isolateModules so config
// reads the right CHECKIN_STORE; airtable / circle / supabase-store are mocked.

const AIRTABLE = '../netlify/functions/utils/airtable';
const CIRCLE = '../netlify/functions/utils/circle';
const SUPA = '../netlify/functions/utils/supabase-store';
const CHECKIN = '../netlify/functions/utils/check-in';

const validInput = (overrides = {}) => ({
    email: 'test@example.com',
    eventId: 'bocc',
    name: 'Test User',
    token: '550e8400-e29b-41d4-a716-446655440000',
    ...overrides,
});

/**
 * Load check-in.js under a given store mode with fresh mocks.
 * @returns {{checkInAttendee, airtable, circle, supa}}
 */
function loadWithStore(store) {
    let api;
    jest.isolateModules(() => {
        process.env.CHECKIN_STORE = store;
        process.env.SUPABASE_CHECKIN_WRITER_URL = 'postgres://checkin_writer@pooler/test';

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
        jest.doMock(SUPA, () => ({
            findOrCreateAttendee: jest.fn().mockResolvedValue({ id: 'supa_att', created: true }),
            insertCheckin: jest.fn().mockResolvedValue({ created: true, id: 'supa_chk' }),
            getStreak: jest.fn().mockResolvedValue({ currentStreak: 3, longestStreak: 5, isPersonalBest: false }),
        }));

        api = {
            checkInAttendee: require(CHECKIN).checkInAttendee,
            airtable: require(AIRTABLE),
            circle: require(CIRCLE),
            supa: require(SUPA),
        };
    });
    return api;
}

afterEach(() => {
    // Don't leak the mode to other test files sharing this worker.
    delete process.env.CHECKIN_STORE;
    delete process.env.SUPABASE_CHECKIN_WRITER_URL;
});

describe('store mode: airtable (default)', () => {
    test('writes only Airtable, no Supabase, streak null', async () => {
        const { checkInAttendee, airtable, supa, circle } = loadWithStore('airtable');
        const r = await checkInAttendee(validInput());

        expect(r.status).toBe('created');
        expect(r.streak).toBeNull();
        expect(airtable.createCheckinEntry).toHaveBeenCalled();
        expect(supa.findOrCreateAttendee).not.toHaveBeenCalled();
        expect(supa.getStreak).not.toHaveBeenCalled();
        expect(circle.ensureMember).toHaveBeenCalled();
    });
});

describe('store mode: dual (Airtable authoritative + Supabase shadow)', () => {
    test('writes both stores and returns the streak', async () => {
        const { checkInAttendee, airtable, supa } = loadWithStore('dual');
        const r = await checkInAttendee(validInput());

        expect(r.status).toBe('created');
        expect(airtable.createCheckinEntry).toHaveBeenCalled();      // authoritative
        expect(supa.insertCheckin).toHaveBeenCalled();               // shadow
        expect(supa.getStreak).toHaveBeenCalledWith('supa_att', 'bocc');
        expect(r.streak).toEqual({ currentStreak: 3, longestStreak: 5, isPersonalBest: false });
    });

    test('still created when the Supabase shadow write fails (non-blocking)', async () => {
        const { checkInAttendee, supa } = loadWithStore('dual');
        supa.insertCheckin.mockRejectedValueOnce(new Error('supabase down'));

        const r = await checkInAttendee(validInput());

        expect(r.status).toBe('created');
        expect(r.streak).toBeNull();                                 // no streak without a shadow id
        expect(supa.getStreak).not.toHaveBeenCalled();
    });

    test('Airtable duplicate short-circuits — no Supabase write', async () => {
        const { checkInAttendee, airtable, supa } = loadWithStore('dual');
        airtable.findExistingCheckin.mockResolvedValueOnce({
            get: (f) => (f === 'checkinDate' ? '2026-06-25T13:00:00.000Z' : undefined),
        });

        const r = await checkInAttendee(validInput());

        expect(r.status).toBe('duplicate');
        expect(supa.insertCheckin).not.toHaveBeenCalled();
        expect(supa.getStreak).not.toHaveBeenCalled();
    });

    test('debug check-in: shadow-writes for parity but no streak and no Circle', async () => {
        const { checkInAttendee, supa, circle } = loadWithStore('dual');
        const r = await checkInAttendee(validInput({ debug: '1' }));

        expect(r.status).toBe('created');
        expect(supa.insertCheckin).toHaveBeenCalled();               // parity
        expect(supa.getStreak).not.toHaveBeenCalled();               // debug never affects streaks
        expect(circle.ensureMember).not.toHaveBeenCalled();
        expect(r.streak).toBeNull();
    });
});

describe('store mode: supabase (authoritative)', () => {
    test('writes only Supabase, returns streak, no Airtable', async () => {
        const { checkInAttendee, airtable, supa } = loadWithStore('supabase');
        const r = await checkInAttendee(validInput());

        expect(r.status).toBe('created');
        expect(supa.insertCheckin).toHaveBeenCalled();
        expect(supa.getStreak).toHaveBeenCalledWith('supa_att', 'bocc');
        expect(r.streak.currentStreak).toBe(3);
        expect(airtable.createCheckinEntry).not.toHaveBeenCalled();
    });

    test('Supabase duplicate returns duplicate', async () => {
        const { checkInAttendee, supa } = loadWithStore('supabase');
        supa.insertCheckin.mockResolvedValueOnce({ created: false });

        const r = await checkInAttendee(validInput());

        expect(r.status).toBe('duplicate');
        expect(supa.getStreak).not.toHaveBeenCalled();
    });
});
