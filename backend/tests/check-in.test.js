// Direct unit tests for the check-in use-case (utils/check-in.js).
// Airtable and Circle are mocked; validation runs for real (the use-case owns it).

jest.mock('../netlify/functions/utils/airtable', () => ({
    fetchAttendeeByEmail: jest.fn(),
    createAttendee: jest.fn(),
    createCheckinEntry: jest.fn(),
    findExistingCheckin: jest.fn(),
}));

jest.mock('../netlify/functions/utils/circle', () => ({
    ensureMember: jest.fn(),
    incrementCheckinCount: jest.fn(),
}));

const { checkInAttendee } = require('../netlify/functions/utils/check-in');
const airtable = require('../netlify/functions/utils/airtable');
const circle = require('../netlify/functions/utils/circle');

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
        airtable.fetchAttendeeByEmail.mockResolvedValue(null);
        airtable.findExistingCheckin.mockResolvedValue(null);
        airtable.createAttendee.mockResolvedValue({ id: 'rec_new' });
        airtable.createCheckinEntry.mockResolvedValue({ id: 'checkin_1' });
        circle.ensureMember.mockResolvedValue({ id: 'circle123' });
        circle.incrementCheckinCount.mockResolvedValue({});
    });

    test('returns invalid for bad input without touching Airtable', async () => {
        const result = await checkInAttendee({ email: 'not-an-email', eventId: 'bocc' });

        expect(result.status).toBe('invalid');
        expect(result.errors).toContain('Invalid email format');
        expect(airtable.fetchAttendeeByEmail).not.toHaveBeenCalled();
    });

    test('creates a new attendee and check-in, syncing to Circle', async () => {
        const result = await checkInAttendee(validInput());

        expect(result.status).toBe('created');
        expect(result.circleSynced).toBe(true);
        expect(airtable.createAttendee).toHaveBeenCalled();
        expect(airtable.createCheckinEntry).toHaveBeenCalledWith('rec_new', 'bocc', false, expect.any(String));
        expect(circle.ensureMember).toHaveBeenCalledWith('test@example.com', 'Test User');
        expect(circle.incrementCheckinCount).toHaveBeenCalledWith('circle123');
    });

    test('reuses an existing attendee instead of creating one', async () => {
        airtable.fetchAttendeeByEmail.mockResolvedValue({ id: 'rec_existing' });

        const result = await checkInAttendee(validInput());

        expect(result.status).toBe('created');
        expect(airtable.createAttendee).not.toHaveBeenCalled();
        expect(airtable.createCheckinEntry).toHaveBeenCalledWith('rec_existing', 'bocc', false, expect.any(String));
    });

    test('returns duplicate when already checked in today (no check-in or sync)', async () => {
        airtable.fetchAttendeeByEmail.mockResolvedValue({ id: 'rec_existing' });
        airtable.findExistingCheckin.mockResolvedValue({
            get: (field) => (field === 'checkinDate' ? '2026-06-23T13:00:00.000Z' : undefined),
        });

        const result = await checkInAttendee(validInput());

        expect(result.status).toBe('duplicate');
        expect(result.checkinDate).toBe('2026-06-23T13:00:00.000Z');
        expect(airtable.createCheckinEntry).not.toHaveBeenCalled();
        expect(circle.ensureMember).not.toHaveBeenCalled();
    });

    test('skips Circle sync for debug check-ins', async () => {
        const result = await checkInAttendee(validInput({ debug: '1' }));

        expect(result.status).toBe('created');
        expect(result.circleSynced).toBe(false);
        expect(circle.ensureMember).not.toHaveBeenCalled();
        expect(airtable.createCheckinEntry).toHaveBeenCalledWith(expect.any(String), 'bocc', true, expect.any(String));
    });

    test('still created when Circle ensureMember fails (non-blocking)', async () => {
        circle.ensureMember.mockRejectedValue(new Error('circle down'));

        const result = await checkInAttendee(validInput());

        expect(result.status).toBe('created');
        expect(result.circleSynced).toBe(false);
    });

    test('circleSynced stays true when only the counter increment fails', async () => {
        circle.incrementCheckinCount.mockRejectedValue(new Error('field missing'));

        const result = await checkInAttendee(validInput());

        expect(result.status).toBe('created');
        expect(result.circleSynced).toBe(true);
    });

    test('propagates unexpected infrastructure errors to the caller', async () => {
        airtable.fetchAttendeeByEmail.mockRejectedValue(new Error('Airtable unavailable'));

        await expect(checkInAttendee(validInput())).rejects.toThrow('Airtable unavailable');
    });
});
