// Unit tests for the Eastern-time date helper (utils/eastern-week.js).
// Pure, no DB. Locks the timezone behaviour that dedup + streak bucketing rely on.

const { easternCheckinDate } = require('../netlify/functions/utils/eastern-week');

describe('easternCheckinDate', () => {
  test('a Tuesday morning check-in lands on that Tuesday', () => {
    // 2026-01-06 12:30 UTC = 07:30 EST, still Jan 6 in Buffalo
    expect(easternCheckinDate(new Date('2026-01-06T12:30:00Z'))).toBe('2026-01-06');
  });

  test('late-night UTC stays on the prior Eastern day (winter / EST, UTC-5)', () => {
    // 2026-01-07 02:00 UTC = 2026-01-06 21:00 EST → still Jan 6
    expect(easternCheckinDate(new Date('2026-01-07T02:00:00Z'))).toBe('2026-01-06');
  });

  test('rolls to the next Eastern day after local midnight (winter)', () => {
    // 2026-01-07 05:30 UTC = 2026-01-07 00:30 EST → Jan 7
    expect(easternCheckinDate(new Date('2026-01-07T05:30:00Z'))).toBe('2026-01-07');
  });

  test('handles DST correctly (summer / EDT, UTC-4)', () => {
    // 2026-07-07 03:00 UTC = 2026-07-06 23:00 EDT → still Jul 6
    expect(easternCheckinDate(new Date('2026-07-07T03:00:00Z'))).toBe('2026-07-06');
    // 2026-07-07 04:30 UTC = 2026-07-07 00:30 EDT → Jul 7
    expect(easternCheckinDate(new Date('2026-07-07T04:30:00Z'))).toBe('2026-07-07');
  });

  test('returns an ISO YYYY-MM-DD string by default (now)', () => {
    expect(easternCheckinDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
