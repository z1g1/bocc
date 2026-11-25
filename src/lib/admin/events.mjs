// Events and their after-event reports for /admin/events/ (ADR 0009, plan Phase 3).
// Admin only: the CALLER checks requireRole(locals, "admin") and, for changes,
// checkOrigin. Parameterized SQL only, as admin_app (SELECT/INSERT/UPDATE on events
// and event_reports; migration 20261118120000_events_media.sql).
//
// Reads (take `db`, the pool or a client, first):
//   todayEastern(now)                         -> "YYYY-MM-DD", BOCC's calendar day
//   getEvent(db, date)                        -> event (a new `scheduled` one if no row yet)
//   checkinCount(db, date)                    -> number (debug check-ins/attendees excluded)
//   listUpcoming(db, { today, limit, status })  -> [event summary] soonest first
//   listPast(db, { today, limit, offset, missingOnly, status }) -> { rows, total }
//   reportMissingCount(db, { today })         -> number
//   statusCounts(db)                          -> { scheduled, reported, cancelled }, every saved event
//   parseStatusFilter(value)                  -> a STATUSES value, or null (the ?status= filter)
//
// Writes (each change and its audit_log row are ONE transaction, via withAudit; a save
// that changes nothing writes nothing and returns { changed: false }):
//   saveEvent(actor, date, input)      status + location, and the cancel fields when the
//                                      status is cancelled. Audit action: event.cancel when
//                                      the event is (or stays) cancelled with a changed
//                                      status or reason, event.uncancel when it leaves
//                                      cancelled, event.update otherwise.
//   submitReport(actor, date, input)   event_report.submit (new) / event_report.update (edit);
//                                      the event moves to `reported` in the same transaction
// The first save of any kind creates the events row (details.created = true): there is
// no separate "create event" step.
//
// Choices (plan Phase 3):
//   - A report is refused on a cancelled event (un-cancel first) and on a date after
//     today (Eastern); today itself is allowed, since the report is filed after the event.
//   - Cancelling is refused once a report exists (the event is Reported). Cancelling ahead
//     of time, or re-saving a cancelled event's reason/announced flag, is allowed.
//   - One form sets the Event status (scheduled, reported or cancelled; GLOSSARY.md) and
//     the location together. Cancelled needs a reason; leaving cancelled clears the cancel
//     fields in the same UPDATE, as the CHECKs require. `scheduled` and `cancelled` are
//     refused while a report exists. Reported means "its Event Report is in", so only
//     submitReport moves an event to `reported`: the form refuses a change to it (a
//     Reported event re-saved as `reported` is fine). A cancelled event that went ahead
//     goes back to Scheduled, then takes its report. ("Held" is not a status: it means the
//     event took place.)
//   - The check-in count is calculated here and never stored. It is not attendance: not
//     everyone checks in.
//   - Editing an imported report (source google_form/pre_form) makes it source = 'admin'
//     with submitted_by = the editor, so a re-run of the import never overwrites it.
//
// Errors for the caller to map: ValidationError (400; .errors is { field: message }),
// ConflictError (409; a refused state change, .errors likewise), NotFoundError (404; a
// ValidationError too, so the event page renders it like any refused save; social-plan.mjs
// and luma-sync.mjs throw it).

import { withAudit } from "./db.mjs";
import { parseDate } from "./checkins.mjs";
import { isHolidayWeek } from "../holiday-weeks.mjs";

export { parseDate };

export const SCHEDULED = "scheduled";
export const REPORTED = "reported";
export const CANCELLED = "cancelled";
export const STATUSES = Object.freeze([SCHEDULED, REPORTED, CANCELLED]);
/** Each status's label, in STATUSES order (the Status dropdown, badges and lists). */
export const STATUS_LABELS = Object.freeze({ scheduled: "Scheduled", reported: "Reported", cancelled: "Cancelled" });
export const LOCATIONS = Object.freeze({ lobby: "Lobby", food_hall: "Food hall", other: "Other" });
export const CANCEL_REASONS = Object.freeze({
  weather: "Weather",
  facility: "Facility (building closed, room unavailable)",
  other_event: "Another event in the space",
  other: "Other",
});
export const LIMITS = Object.freeze({
  locationOther: 200,
  cancelReasonOther: 500,
  notes: 4000,
  blingDetails: 1000,
  attendeeCount: 10000,
});

export class ValidationError extends Error {
  status = 400;
  /** @param {Record<string, string>} errors  field -> message */
  constructor(errors) {
    super(Object.values(errors).join("; "));
    this.errors = errors;
  }
}
export class ConflictError extends ValidationError {
  status = 409;
}
export class NotFoundError extends ValidationError {
  status = 404;
}

const TZ = "America/New_York";
const ymdFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });

/** BOCC's calendar day (Eastern) at `now`, as YYYY-MM-DD. Never the UTC date. */
export function todayEastern(now = new Date()) {
  return ymdFmt.format(now);
}

/**
 * The first meeting Tuesday on or after `today` (YYYY-MM-DD), for "Open next Tuesday"
 * links and social.mjs findNext. Tuesdays in the holiday break (../holiday-weeks.mjs,
 * December 22 to January 4) are skipped: from 2026-12-16 this is 2027-01-05. A saved
 * row on a holiday date (the override) is not this function's business: callers that
 * read rows count them themselves.
 */
export function nextTuesday(today) {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + ((2 - d.getUTCDay() + 7) % 7));
  while (isHolidayWeek(d.toISOString().slice(0, 10))) d.setUTCDate(d.getUTCDate() + 7);
  return d.toISOString().slice(0, 10);
}

// ── Reads ────────────────────────────────────────────────────────────────────

// Real check-ins on the day: a debug check-in, or any check-in by a debug attendee,
// is a test row (the same rule as /admin/checkins/).
const CHECKIN_COUNT_SQL = (dateExpr) => `(
  select count(distinct c.attendee_id)::int
    from public.checkins c
    join public.attendees a on a.id = c.attendee_id
   where c.checkin_date = ${dateExpr} and not c.debug and not a.debug)`;

const EVENT_COLUMNS = `
  e.event_date::text      as date,
  e.status,
  e.location,
  e.location_other        as "locationOther",
  e.cancel_reason         as "cancelReason",
  e.cancel_reason_other   as "cancelReasonOther",
  e.cancel_announced      as "cancelAnnounced",
  e.updated_at            as "updatedAt"`;

const REPORT_COLUMNS = `
  r.event_date is not null as "hasReport",
  r.attendee_count      as "attendeeCount",
  r.notes,
  r.bling_given           as "blingGiven",
  r.bling_details         as "blingDetails",
  r.source                as "reportSource",
  r.updated_at            as "reportUpdatedAt",
  u.name                  as "reportBy"`;

/** Real (non-debug) people checked in on `date`. Not attendance. */
export async function checkinCount(db, date) {
  if (!parseDate(date)) throw new Error("checkinCount: date must be YYYY-MM-DD");
  const { rows } = await db.query(`select ${CHECKIN_COUNT_SQL("$1::date")} as n`, [date]);
  return rows[0].n;
}

/**
 * One event with its report and calculated check-in count. With no events row yet it
 * is returned as a new scheduled event (exists: false); the first save creates it.
 */
export async function getEvent(db, date) {
  if (!parseDate(date)) throw new Error("getEvent: date must be YYYY-MM-DD");
  const { rows } = await db.query(
    `select ${EVENT_COLUMNS}, ${REPORT_COLUMNS}
       from public.events e
       left join public.event_reports r on r.event_date = e.event_date
       left join auth."user" u on u.id = r.submitted_by
      where e.event_date = $1::date`,
    [date],
  );
  const row = rows[0];
  const count = await checkinCount(db, date);
  if (!row) {
    return {
      date, exists: false, status: SCHEDULED, location: null, locationOther: null,
      cancelReason: null, cancelReasonOther: null, cancelAnnounced: false, updatedAt: null,
      report: null, checkinCount: count,
    };
  }
  return { ...shape(row), exists: true, checkinCount: count };
}

function shape(row) {
  const { hasReport, attendeeCount, notes, blingGiven, blingDetails, reportSource, reportUpdatedAt, reportBy, ...event } = row;
  return {
    ...event,
    report: hasReport
      ? { attendeeCount, notes, blingGiven, blingDetails, source: reportSource, updatedAt: reportUpdatedAt, by: reportBy ?? null }
      : null,
  };
}

const SUMMARY_SQL = `
  select ${EVENT_COLUMNS}, ${REPORT_COLUMNS}, ${CHECKIN_COUNT_SQL("e.event_date")} as "checkinCount"
    from public.events e
    left join public.event_reports r on r.event_date = e.event_date
    left join auth."user" u on u.id = r.submitted_by`;

/** The ?status= filter: one of STATUSES, anything else (or nothing) is no filter. */
export const parseStatusFilter = (value) => (STATUSES.includes(value) ? value : null);

/** Events on or after `today` (Eastern), soonest first; `status` (one of STATUSES) filters. */
export async function listUpcoming(db, { today = todayEastern(), limit = 20, status = null } = {}) {
  const { rows } = await db.query(
    `${SUMMARY_SQL} where e.event_date >= $1::date and ($3::text is null or e.status = $3)
      order by e.event_date limit $2`, [today, limit, parseStatusFilter(status)]);
  return rows.map(summary(today));
}

/**
 * Events before `today`, newest first; missingOnly keeps the "report missing" ones and
 * `status` (one of STATUSES) keeps that status.
 */
export async function listPast(db, { today = todayEastern(), limit = 25, offset = 0, missingOnly = false, status = null } = {}) {
  const where = `e.event_date < $1::date and ($2::boolean is false or e.status = 'scheduled')
    and ($3::text is null or e.status = $3)`;
  const filter = [today, missingOnly, parseStatusFilter(status)];
  const [{ rows }, { rows: [{ n }] }] = await Promise.all([
    db.query(`${SUMMARY_SQL} where ${where} order by e.event_date desc limit $4 offset $5`,
      [...filter, limit, offset]),
    db.query(`select count(*)::int as n from public.events e where ${where}`, filter),
  ]);
  return { rows: rows.map(summary(today)), total: n };
}

/** Every saved event (past and upcoming) counted by status, each STATUSES key present. */
export async function statusCounts(db) {
  const { rows } = await db.query("select status, count(*)::int as n from public.events group by status");
  const counts = Object.fromEntries(STATUSES.map((st) => [st, 0]));
  for (const { status, n } of rows) if (status in counts) counts[status] = n;
  return counts;
}

/** Past dates (before today, Eastern) still `scheduled`: the report was never filed. */
export async function reportMissingCount(db, { today = todayEastern() } = {}) {
  const { rows } = await db.query(
    `select count(*)::int as n from public.events where status = 'scheduled' and event_date < $1::date`, [today]);
  return rows[0].n;
}

const summary = (today) => (row) => {
  const { checkinCount: count, ...rest } = row;
  const ev = shape(rest);
  return { ...ev, checkinCount: count, reportMissing: isReportMissing(ev, today) };
};

/** A date before today (Eastern) still `scheduled`. */
export const isReportMissing = (event, today = todayEastern()) =>
  event.status === SCHEDULED && event.date < today;

// ── Validation ───────────────────────────────────────────────────────────────

const str = (v) => (typeof v === "string" ? v : "");
/** Trim, normalise line endings, drop NULs; "" -> null. */
const text = (v) => {
  const t = str(v).replace(/\r\n?/g, "\n").replace(/\u0000/g, "").trim();
  return t === "" ? null : t;
};
const oneLine = (v) => {
  const t = text(v);
  return t === null ? null : t.replace(/\s+/g, " ");
};

/** Location fields: "" (not set), lobby, food_hall, or other + text. */
function validateLocation(input, errors) {
  const location = str(input?.location).trim() || null;
  let locationOther = null;
  if (location !== null && !(location in LOCATIONS)) {
    errors.location = "Choose a location from the list.";
  } else if (location === "other") {
    locationOther = oneLine(input?.locationOther);
    if (locationOther === null) errors.locationOther = "Say where the event was.";
    else if (locationOther.length > LIMITS.locationOther) errors.locationOther = `At most ${LIMITS.locationOther} characters.`;
  }
  return { location, locationOther };
}

/**
 * @returns {{ status: "scheduled"|"reported"|"cancelled"|null, location, locationOther,
 *   cancel: { reason, reasonOther, announced } | null }}  status null = keep; cancel only
 *   when the status is cancelled (the cancel fields are ignored otherwise)
 */
export function validateEventInput(input) {
  const errors = {};
  const rawStatus = str(input?.status).trim();
  let status = null;
  if (rawStatus !== "") {
    if (STATUSES.includes(rawStatus)) status = rawStatus;
    else errors.status = "Choose Scheduled, Reported or Cancelled.";
  }
  const loc = validateLocation(input, errors);
  const cancel = status === CANCELLED ? validateCancel(input, errors) : null;
  if (Object.keys(errors).length) throw new ValidationError(errors);
  return { status, ...loc, cancel };
}

function validateCancel(input, errors) {
  const reason = str(input?.cancelReason).trim();
  let reasonOther = null;
  if (!(reason in CANCEL_REASONS)) {
    errors.cancelReason = "Choose why the event was cancelled.";
  } else if (reason === "other") {
    reasonOther = oneLine(input?.cancelReasonOther);
    if (reasonOther === null) errors.cancelReasonOther = "Say why the event was cancelled.";
    else if (reasonOther.length > LIMITS.cancelReasonOther) errors.cancelReasonOther = `At most ${LIMITS.cancelReasonOther} characters.`;
  }
  const announced = ["on", "true", "1", "yes"].includes(str(input?.cancelAnnounced).trim().toLowerCase());
  return { reason, reasonOther, announced };
}

/**
 * Admin report: Attendee count and Bling given are required (the database allows
 * NULL only for old imported rows). Bling details only when Bling was given.
 */
export function validateReportInput(input) {
  const errors = {};
  const rawCount = str(input?.attendeeCount).trim();
  let attendeeCount = null;
  if (rawCount === "") errors.attendeeCount = "Enter the Attendee count: how many people were in the room.";
  else if (!/^\d{1,6}$/.test(rawCount) || Number(rawCount) > LIMITS.attendeeCount) {
    errors.attendeeCount = "Enter a whole number (0 or more).";
  } else attendeeCount = Number(rawCount);

  const rawBling = str(input?.blingGiven).trim().toLowerCase();
  let blingGiven = null;
  if (rawBling === "yes") blingGiven = true;
  else if (rawBling === "no") blingGiven = false;
  else errors.blingGiven = "Say whether Bring a Friend Bling was given out.";

  const notes = text(input?.notes);
  if (notes !== null && notes.length > LIMITS.notes) errors.notes = `Notes can be at most ${LIMITS.notes} characters.`;

  let blingDetails = text(input?.blingDetails);
  if (blingDetails !== null && blingDetails.length > LIMITS.blingDetails) {
    errors.blingDetails = `At most ${LIMITS.blingDetails} characters.`;
  } else if (blingDetails !== null && blingGiven === false) {
    errors.blingDetails = "Leave Bling details empty when no Bling was given (or choose Yes).";
  }
  if (blingGiven !== true) blingDetails = null;

  if (Object.keys(errors).length) throw new ValidationError(errors);
  return { attendeeCount, notes, blingGiven, blingDetails };
}

/** The date in the URL must be a real ISO date; reports also refuse future dates. */
function checkDate(date) {
  if (!parseDate(date)) throw new ValidationError({ date: "Not a date (YYYY-MM-DD)." });
}

// ── Writes ───────────────────────────────────────────────────────────────────

const NOOP = Symbol("noop");

/**
 * Make sure the events row exists and lock it for this transaction.
 * @returns {Promise<{ created: boolean, row: object }>}
 */
async function lockEvent(client, date) {
  const ins = await client.query(
    `insert into public.events (event_date) values ($1::date) on conflict (event_date) do nothing returning event_date`, [date]);
  const { rows } = await client.query(
    `select status, location, location_other, cancel_reason, cancel_reason_other, cancel_announced
       from public.events where event_date = $1::date for update`, [date]);
  return { created: ins.rowCount === 1, row: rows[0] };
}

async function hasReport(client, date) {
  const { rowCount } = await client.query(`select 1 from public.event_reports where event_date = $1::date`, [date]);
  return rowCount === 1;
}

/** Keys whose values differ, as { before, after } holding only those keys. */
function diff(before, after) {
  const b = {}, a = {};
  for (const k of Object.keys(after)) {
    if ((before[k] ?? null) !== (after[k] ?? null)) { b[k] = before[k] ?? null; a[k] = after[k] ?? null; }
  }
  return { before: b, after: a, changed: Object.keys(a) };
}

/**
 * Run `fn(client)` in withAudit; fn returns { action, details } for the audit row, or
 * throws NOOP to roll back and write nothing.
 */
async function audited(actorUserId, date, table, fn) {
  try {
    await withAudit(actorUserId, fn, (r) => ({
      action: r.action, targetTable: table, targetId: date, details: r.details,
    }));
    return { changed: true };
  } catch (err) {
    if (err === NOOP) return { changed: false };
    throw err;
  }
}

const CANCEL_FIELDS = ["cancel_reason", "cancel_reason_other", "cancel_announced"];
const REPORTED_BY_REPORT = "An event becomes Reported when its Event Report is saved. File the Event Report on the Post Event tab.";

/**
 * Status (scheduled, reported or cancelled), location and, for cancelled, the reason and
 * announced flag: one UPDATE. Creates the event on its first save.
 * A change to `reported` is refused: only saving an Event Report sets it (submitReport).
 * `scheduled` and `cancelled` are refused once a report exists (the event is Reported).
 * (A future date can't be Reported either: submitReport refuses it.)
 */
export async function saveEvent(actorUserId, date, input) {
  checkDate(date);
  const v = validateEventInput(input);
  return audited(actorUserId, date, "events", async (client) => {
    const { created, row } = await lockEvent(client, date);
    const status = v.status ?? row.status;
    // Reported means its Event Report is in (GLOSSARY.md): only submitReport sets it.
    if (status === REPORTED && row.status !== REPORTED) {
      throw new ConflictError({ status: REPORTED_BY_REPORT });
    }
    // A report means it is Reported: no way back to scheduled, and no cancelling. (A
    // cancelled event can't have a report, so only a change of status needs the check.)
    if (status !== row.status && status !== REPORTED && (await hasReport(client, date))) {
      throw new ConflictError({
        status: status === CANCELLED
          ? "This event has an Event Report, so it is Reported and can't be cancelled."
          : "This event has an Event Report, so it is Reported.",
      });
    }
    // Cancel fields: the posted ones when cancelling, kept when a cancelled event is
    // saved without a status, cleared otherwise.
    const cancel = status !== CANCELLED
      ? { cancel_reason: null, cancel_reason_other: null, cancel_announced: false }
      : v.cancel
        ? { cancel_reason: v.cancel.reason, cancel_reason_other: v.cancel.reasonOther, cancel_announced: v.cancel.announced }
        : { cancel_reason: row.cancel_reason, cancel_reason_other: row.cancel_reason_other, cancel_announced: row.cancel_announced };
    const after = { status, location: v.location, location_other: v.locationOther, ...cancel };
    const d = diff(row, after);
    if (!created && d.changed.length === 0) throw NOOP;
    await client.query(
      `update public.events
          set status = $2, location = $3, location_other = $4,
              cancel_reason = $5, cancel_reason_other = $6, cancel_announced = $7
        where event_date = $1::date`,
      [date, status, v.location, v.locationOther, cancel.cancel_reason, cancel.cancel_reason_other, cancel.cancel_announced]);
    const action = row.status === CANCELLED && status !== CANCELLED ? "event.uncancel"
      : status === CANCELLED && (created || d.changed.some((k) => k === "status" || CANCEL_FIELDS.includes(k))) ? "event.cancel"
      : "event.update";
    return { action, details: { created, before: d.before, after: d.after } };
  });
}

/**
 * Submit or edit the report; the event moves to `reported` in the same transaction.
 * @param {{ today?: string }} [opts]  "today" (Eastern) for the future-date check; tests pass it
 */
export async function submitReport(actorUserId, date, input, { today = todayEastern() } = {}) {
  checkDate(date);
  const v = validateReportInput(input);
  if (date > today) throw new ConflictError({ date: "That date hasn't happened yet. File the report on or after the day." });
  return audited(actorUserId, date, "event_reports", async (client) => {
    const { created, row } = await lockEvent(client, date);
    if (row.status === CANCELLED) {
      throw new ConflictError({ date: "This event is cancelled. If it went ahead, set its status back to Scheduled (Event Info tab), then file the report." });
    }
    const { rows } = await client.query(
      `select attendee_count, notes, bling_given, bling_details, source, submitted_by
         from public.event_reports where event_date = $1::date for update`, [date]);
    const existing = rows[0] ?? null;
    const after = {
      attendee_count: v.attendeeCount, notes: v.notes, bling_given: v.blingGiven, bling_details: v.blingDetails,
    };
    if (existing) {
      const d = diff(existing, { ...after, source: "admin" });
      if (d.changed.length === 0 && row.status === REPORTED) throw NOOP;
      await client.query(
        `update public.event_reports
            set attendee_count = $2, notes = $3, bling_given = $4, bling_details = $5,
                source = 'admin', submitted_by = $6
          where event_date = $1::date`,
        [date, v.attendeeCount, v.notes, v.blingGiven, v.blingDetails, actorUserId]);
      await setReported(client, date, row.status);
      return {
        action: "event_report.update",
        details: { eventStatus: { before: row.status, after: REPORTED }, before: d.before, after: d.after },
      };
    }
    await client.query(
      `insert into public.event_reports
         (event_date, attendee_count, notes, bling_given, bling_details, submitted_by, source)
       values ($1::date, $2, $3, $4, $5, $6, 'admin')`,
      [date, v.attendeeCount, v.notes, v.blingGiven, v.blingDetails, actorUserId]);
    await setReported(client, date, row.status);
    return {
      action: "event_report.submit",
      details: { created, eventStatus: { before: row.status, after: REPORTED }, after },
    };
  });
}

async function setReported(client, date, current) {
  if (current !== REPORTED) {
    await client.query(`update public.events set status = 'reported' where event_date = $1::date`, [date]);
  }
}
