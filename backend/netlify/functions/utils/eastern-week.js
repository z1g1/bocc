/**
 * Eastern-time date helper — pure, dependency-free.
 *
 * The check-in store needs the calendar day a check-in happened **in Buffalo's
 * timezone** (America/New_York), for same-day dedup. This MUST share the timezone
 * basis the Postgres streak views use to bucket weeks
 * (`date_trunc('week', checkin_at AT TIME ZONE 'America/New_York')`), so that dedup
 * and streak counting agree about which day/week a check-in belongs to. See ADR 0004.
 *
 * Uses the built-in Intl timezone database — no dependency, DST-correct.
 */

const EASTERN = 'America/New_York';

// en-CA formats as ISO-like "YYYY-MM-DD", which is exactly the shape Postgres
// wants for a `date` column.
const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: EASTERN,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * The calendar day (in Eastern time) of an instant, as 'YYYY-MM-DD'.
 *
 * @param {Date} [date=new Date()] - the instant to bucket (defaults to now)
 * @returns {string} e.g. '2026-01-06'
 */
const easternCheckinDate = (date = new Date()) => dayFormatter.format(date);

module.exports = { easternCheckinDate, EASTERN };
