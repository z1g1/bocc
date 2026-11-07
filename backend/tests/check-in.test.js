// Direct unit tests for the check-in use-case (utils/check-in.js).
// The Postgres store is mocked; validation runs for real (the use-case owns it).

jest.mock('../netlify/functions/utils/pg-store', () => ({
    findOrCreateAttendee: jest.fn(),
    insertCheckin: jest.fn(),
    getStreak: jest.fn(),
}));

const { checkInAttendee } = require('../netlify/functions/utils/check-in');
const pg = require('../netlify/functions/utils/pg-store');

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

describe('checkInAttendee use-case', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        pg.findOrCreateAttendee.mockResolvedValue({ id: 'pg_att', created: true });
        pg.insertCheckin.mockResolvedValue({ created: true, id: 'pg_chk' });
        pg.getStreak.mockResolvedValue({ ...STREAK });
    });

    test('returns invalid for bad input without touching the store', async () => {
        const result = await checkInAttendee({ email: 'not-an-email', eventId: 'bocc' });

        expect(result.status).toBe('invalid');
        expect(result.errors).toContain('Invalid email format');
        expect(pg.findOrCreateAttendee).not.toHaveBeenCalled();
    });

    test('records the check-in in Postgres and returns streak + celebration', async () => {
        const result = await checkInAttendee(validInput());

        expect(result).toEqual({
            status: 'created',
            streak: STREAK,
            celebration: { kind: 'continued', currentStreak: 3, previousStreak: 2 },
        });
        expect(pg.findOrCreateAttendee).toHaveBeenCalledWith(expect.objectContaining({
            email: 'test@example.com', name: 'Test User', debug: false,
        }));
        expect(pg.insertCheckin).toHaveBeenCalledWith(expect.objectContaining({
            attendeeId: 'pg_att', eventId: 'bocc', debug: false,
            checkinDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        }));
        expect(pg.getStreak).toHaveBeenCalledWith('pg_att', 'bocc');
    });

    test('first check-in ever gets the first_visit celebration', async () => {
        pg.getStreak.mockResolvedValueOnce({
            ...STREAK, currentStreak: 1, longestStreak: 1, previousStreak: null,
            priorLongestStreak: null, weeksAttended: 1,
        });

        const result = await checkInAttendee(validInput());

        expect(result.celebration).toEqual({ kind: 'first_visit', currentStreak: 1, previousStreak: null });
    });

    test('returns duplicate when already checked in today, with no streak read', async () => {
        pg.insertCheckin.mockResolvedValueOnce({ created: false });

        const result = await checkInAttendee(validInput());

        expect(result.status).toBe('duplicate');
        expect(result.checkinDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(result.celebration).toBeUndefined();
        expect(pg.getStreak).not.toHaveBeenCalled();
    });

    test('still created when the streak read fails (non-fatal), no celebration', async () => {
        pg.getStreak.mockRejectedValueOnce(new Error('view timeout'));

        const result = await checkInAttendee(validInput());

        expect(result.status).toBe('created');
        expect(result.streak).toBeNull();
        expect(result.celebration).toBeNull();
    });

    test('debug check-in: recorded but no streak and no celebration', async () => {
        const result = await checkInAttendee(validInput({ debug: '1' }));

        expect(result.status).toBe('created');
        expect(pg.insertCheckin).toHaveBeenCalledWith(expect.objectContaining({ debug: true }));
        expect(pg.getStreak).not.toHaveBeenCalled(); // debug never affects streaks
        expect(result.streak).toBeNull();
        expect(result.celebration).toBeNull();
    });

    test('a Postgres write failure propagates (handler maps to 500)', async () => {
        pg.insertCheckin.mockRejectedValueOnce(new Error('connection refused'));

        await expect(checkInAttendee(validInput())).rejects.toThrow('connection refused');
    });
});
