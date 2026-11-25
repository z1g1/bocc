// BOCC's fixed holiday break: no meeting on any Tuesday from December 22 through
// January 4 inclusive (the Christmas and New Year weeks), every year. Those Tuesdays
// are not events. Nobody cancels them and no `events` rows are made for them.
//
// THE OVERRIDE: an `events` row that someone deliberately saved for a holiday date
// (the admin event page opened directly) is respected. A `scheduled` row on a
// holiday date is a real event, everywhere. A cancelled one stays cancelled. So the
// break only decides what a Tuesday WITHOUT a row means: in a normal week it is an
// event (scheduled, nothing set up yet); in a holiday week it does not exist.
//
// Used by src/lib/admin (events.mjs nextTuesday, social-plan.mjs findNext, luma-sync.mjs),
// the Thursday check (src/lib/social-alert/) and the public /events/<date>/ page.
// meetingTuesdays(from, to) walks the Tuesdays without a row that are events (the
// callers add their saved rows themselves, which is the override). Pure, no imports:
// the Netlify function bundler (esbuild) follows the relative import like any other.

/** The break, inclusive at both ends. It wraps the new year (from > to). */
export const HOLIDAY_BREAK = Object.freeze({
  from: Object.freeze({ month: 12, day: 22 }),
  to: Object.freeze({ month: 1, day: 4 }),
});

/**
 * Whether `date` falls in the holiday break (any year). Says nothing about rows: the
 * caller applies the override (a saved row wins).
 * @param {string} date  YYYY-MM-DD
 * @returns {boolean}
 */
export function isHolidayWeek(date) {
  const m = typeof date === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) : null;
  if (!m) throw new Error("isHolidayWeek: date must be YYYY-MM-DD");
  const md = Number(m[2]) * 100 + Number(m[3]);
  const start = HOLIDAY_BREAK.from.month * 100 + HOLIDAY_BREAK.from.day;
  const end = HOLIDAY_BREAK.to.month * 100 + HOLIDAY_BREAK.to.day;
  return start <= end ? md >= start && md <= end : md >= start || md <= end;
}

/**
 * The calendar day `n` days after `date` (negative: before), as YYYY-MM-DD.
 * @param {string} date  YYYY-MM-DD
 * @param {number} n
 */
export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** @param {string} date  YYYY-MM-DD */
export const isTuesday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay() === 2;

/**
 * Every Tuesday from `from` to `to` (both YYYY-MM-DD, inclusive) outside the holiday
 * break: the weeks that are events even without a row. `from` need not be a Tuesday.
 * @param {string} from
 * @param {string} to
 * @returns {string[]}
 */
export function meetingTuesdays(from, to) {
  let d = from;
  while (!isTuesday(d)) d = addDays(d, 1);
  const out = [];
  for (; d <= to; d = addDays(d, 7)) if (!isHolidayWeek(d)) out.push(d);
  return out;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "December 22 to January 4", for messages and logs. */
export const HOLIDAY_BREAK_LABEL =
  `${MONTHS[HOLIDAY_BREAK.from.month - 1]} ${HOLIDAY_BREAK.from.day} to ${MONTHS[HOLIDAY_BREAK.to.month - 1]} ${HOLIDAY_BREAK.to.day}`;
