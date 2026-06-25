// Unit tests for the Supabase check-in store (utils/supabase-store.js).
// `pg` is virtual-mocked (it isn't a test dependency); we assert the SQL the
// store issues and how it maps results — same spirit as the airtable/circle mocks.

// The Supabase path needs a connection string at first connect; set a dummy one
// (config reads env at import; the mocked Pool never really connects).
process.env.SUPABASE_CHECKIN_WRITER_URL = 'postgres://checkin_writer@pooler/test';
// Dummy CA so getSslConfig() passes; pg.Pool is mocked, so it's never used for TLS.
process.env.SUPABASE_CA_CERT = '-----BEGIN CERTIFICATE-----\nMIIDUMMY\n-----END CERTIFICATE-----';

const mockQuery = jest.fn();
jest.mock(
  'pg',
  () => ({ Pool: jest.fn(() => ({ query: mockQuery })) }),
  { virtual: true }
);

const store = require('../netlify/functions/utils/supabase-store');

describe('supabase-store', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  describe('findOrCreateAttendee', () => {
    test('returns the inserted id when the attendee is new', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'uuid-new' }] });

      const result = await store.findOrCreateAttendee({
        email: 'a@x.com', name: 'A', okToEmail: true, debug: false,
      });

      expect(result).toEqual({ id: 'uuid-new', created: true });
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockQuery.mock.calls[0][0]).toMatch(/insert into attendees/i);
      expect(mockQuery.mock.calls[0][0]).toMatch(/on conflict \(email\) do nothing/i);
    });

    test('reads back the existing id on email conflict (no overwrite)', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })                 // insert hit conflict
        .mockResolvedValueOnce({ rows: [{ id: 'uuid-old' }] }); // select existing

      const result = await store.findOrCreateAttendee({ email: 'a@x.com', name: 'A' });

      expect(result).toEqual({ id: 'uuid-old', created: false });
      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(mockQuery.mock.calls[1][0]).toMatch(/select id from attendees where email/i);
    });
  });

  describe('insertCheckin', () => {
    test('created:true when a row is inserted', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'c1', checkin_at: '2026-01-06T12:30:00Z' }] });

      const result = await store.insertCheckin({
        attendeeId: 'uuid-1', eventId: 'bocc', token: 'T', debug: false, checkinDate: '2026-01-06',
      });

      expect(result.created).toBe(true);
      expect(result.id).toBe('c1');
      expect(mockQuery.mock.calls[0][0]).toMatch(/insert into checkins/i);
      expect(mockQuery.mock.calls[0][0]).toMatch(/on conflict do nothing/i);
    });

    test('created:false on same-day duplicate (conflict, no row)', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await store.insertCheckin({
        attendeeId: 'uuid-1', eventId: 'bocc', token: 'T', debug: false, checkinDate: '2026-01-06',
      });

      expect(result).toEqual({ created: false });
    });
  });

  describe('getStreak', () => {
    test('maps the streaks view row to typed fields', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ current_streak: '4', longest_streak: '4', is_personal_best: true }],
      });

      const result = await store.getStreak('uuid-1', 'bocc');

      expect(result).toEqual({ currentStreak: 4, longestStreak: 4, isPersonalBest: true });
      expect(mockQuery.mock.calls[0][0]).toMatch(/from\s+streaks/i);
    });

    test('returns a zeroed shape when no streak row exists yet', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await store.getStreak('uuid-1', 'bocc');

      expect(result).toEqual({ currentStreak: 0, longestStreak: 0, isPersonalBest: false });
    });
  });
});
