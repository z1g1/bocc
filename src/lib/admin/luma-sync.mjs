// Luma syncs (ADR 0014, spec #70): who is in each Event's sync, its displayed status, the
// oldest unfinished one for /admin/luma-sync/next/, and the two writes (Done, Error).
// Admin and email: the CALLER checks requireRole and, for writes, checkOrigin.
// Parameterized SQL only, as admin_app (SELECT/INSERT/UPDATE on luma_syncs; column
// UPDATE on attendees.on_luma_at; migration 20261205120000_luma_sync.sql).
//
// Reads (take `db`, the pool or a client, first; `opts` is { now, today, launch }, all
// optional: today defaults to the Eastern day of `now`, launch to lumaSyncLaunchDate()):
//   getLumaSync(db, date, opts)     -> LumaSync (below), for any date
//   findNextLumaSync(db, opts)      -> { state: "sync", sync: LumaSync }
//                                    | { state: "stand_down", today, holiday, message }
//
// Writes (each with its audit_log row in ONE transaction, via withAudit):
//   markDone(actor, date, { attendeeIds?, now?, today?, launch? })
//       -> { date, people, attendeeIds, before }
//       The sync becomes Done and everyone in its live list is On Luma as of `now`.
//       attendeeIds (optional): only those of them still in the list (the people the
//       page showed: the agent's /admin/luma-sync/next/ and the Admin event page both
//       send them); someone who joined since stays, so the sync shows To do.
//       Audit: luma_sync.done { people, attendeeIds, before }.
//   markError(actor, date, note, { now?, today?, launch? })
//       -> { date, note, people, before }   (the push, #74, goes out after this returns)
//       Audit: luma_sync.error { people, note, before }.
//   `before` is the stored status before the write (null: no row yet). The luma_syncs
//   row (and the events row it needs) is created by the first write.
//   Errors (all ValidationErrors from ./events.mjs, with .errors and .status): 400 (bad
//   date, Error without a note), NotFoundError 404 (no Event on that date, errors.date),
//   ConflictError 409 (a Cancelled Event, an Upcoming one, or one before launch).
//
// LumaSync: {
//   date, applies (an Event from launch up to any date: it has a Luma sync),
//   isEvent, cancelled, upcoming (after today), beforeLaunch,
//   stored: { status, note, updatedAt, updatedBy } | null,
//   status: displayedStatus() (null when !applies), statusLabel, unfinished,
//   stopAfterError: Error set within ERROR_STOP_HOURS of `now` (luma-sync-rules.mjs): the
//           page tells the agent to stop this run instead of retrying it,
//   note: the stored note (an Error's text; kept as history after Done),
//   people: [{ id, name, email }]  the live list: still to add, oldest check-in first
//   joined: [{ id, name, email, dateAdded, onLumaSince, onLumaBeforeLaunch }]
//           everyone who joined the Email list at this Event, On Luma or not (#75)
// }
//
// Who is in a sync (read live, like the streaks view): Attendees whose first non-debug
// Check-in is on the Event's date, on the Email list (ok_to_email, not debug) and not
// On Luma. An opt-out, or being marked On Luma, drops them off at once.
//
// An Event is an events row, or a Tuesday outside the holiday break without one
// (../holiday-weeks.mjs: a holiday Tuesday without a row is not an Event).

import { withAudit } from "./db.mjs";
import { CANCELLED, ConflictError, NotFoundError, ValidationError, parseDate, todayEastern } from "./events.mjs";
import { HOLIDAY_BREAK_LABEL, addDays, isHolidayWeek, isTuesday, meetingTuesdays } from "../holiday-weeks.mjs";
import { errorNoteProblem, erroredRecently, lumaSyncLaunchDate, lumaSyncStatus } from "./luma-sync-rules.mjs";

export { NotFoundError };

// The Email list Attendees who joined at the Event on ${d} (a SQL date expression).
const JOINED_AT = (d) => `a.ok_to_email and not a.debug
   and exists (select 1 from public.checkins c
                where c.attendee_id = a.id and c.checkin_date = ${d} and not c.debug)
   and not exists (select 1 from public.checkins c
                    where c.attendee_id = a.id and c.checkin_date < ${d} and not c.debug)`;
const NOT_ON_LUMA = "a.on_luma_at is null and not a.on_luma_before_launch";

const JOINED_SQL = `
  select a.id, a.name, a.email,
         to_char(a.on_luma_at at time zone 'America/New_York', 'YYYY-MM-DD') as "onLumaSince",
         a.on_luma_before_launch as "onLumaBeforeLaunch",
         (${NOT_ON_LUMA}) as "toAdd"
    from public.attendees a
   where ${JOINED_AT("$1::date")}
   order by (select min(c.checkin_at) from public.checkins c
              where c.attendee_id = a.id and c.checkin_date = $1::date and not c.debug), a.email`;

function resolveOpts({ now = new Date(), today, launch } = {}) {
  return { now, today: today ?? todayEastern(now), launch: launch ?? lumaSyncLaunchDate() };
}

/** The sync's shape from its parts (see the header). */
function shape({ date, eventStatus, hasRow, stored, people, joined, now, today, launch }) {
  const isEvent = eventStatus != null || (isTuesday(date) && !isHolidayWeek(date));
  const beforeLaunch = date < launch;
  const applies = isEvent && !beforeLaunch;
  const cancelled = eventStatus === CANCELLED;
  const { status, statusLabel, unfinished } = applies
    ? lumaSyncStatus({ stored: stored?.status ?? null, people: people.length, cancelled })
    : { status: null, statusLabel: null, unfinished: false };
  return {
    date, applies, isEvent, cancelled, upcoming: date > today, beforeLaunch,
    stored: hasRow ? stored : null,
    status, statusLabel, unfinished,
    stopAfterError: erroredRecently({ status, updatedAt: stored?.updatedAt }, now),
    note: stored?.note ?? null,
    people, joined,
  };
}

/**
 * One date's Luma sync, whatever the date (see the header's LumaSync).
 * @param {{ query: Function }} db
 * @param {string} date  YYYY-MM-DD
 * @param {{ now?: Date, today?: string, launch?: string }} [opts]
 */
export async function getLumaSync(db, date, opts) {
  if (!parseDate(date)) throw new Error("getLumaSync: date must be YYYY-MM-DD");
  const { now, today, launch } = resolveOpts(opts);
  const [{ rows: [row] }, { rows }] = await Promise.all([
    db.query(
      `select e.status as "eventStatus", s.event_date is not null as "hasRow", s.status, s.note,
              s.updated_at as "updatedAt", s.updated_by as "updatedBy"
         from (select $1::date as d) x
         left join public.events e on e.event_date = x.d
         left join public.luma_syncs s on s.event_date = x.d`, [date]),
    db.query(JOINED_SQL, [date]),
  ]);
  const joined = rows.map(({ toAdd, ...p }) => ({ ...p, dateAdded: date }));
  const people = rows.filter((p) => p.toAdd).map(({ id, name, email }) => ({ id, name, email }));
  return shape({
    date, eventStatus: row.eventStatus, hasRow: row.hasRow,
    stored: row.hasRow ? { status: row.status, note: row.note, updatedAt: row.updatedAt, updatedBy: row.updatedBy } : null,
    people, joined, now, today, launch,
  });
}

const STAND_DOWN = "Nothing to add, stand down.";

/**
 * The oldest Event, from launch up to and including today, whose displayed Luma sync is
 * unfinished (To do or Error); never an Upcoming or pre-launch Event. Nothing
 * unfinished: stand down. When today is in the holiday break, the message says so, and
 * says whether this week has an Event (a row saved on a holiday Tuesday) or none.
 * @param {{ query: Function }} db
 * @param {{ now?: Date, today?: string, launch?: string }} [opts]
 */
export async function findNextLumaSync(db, opts) {
  const { now, today, launch } = resolveOpts(opts);
  if (launch <= today) {
    const { rows: saved } = await db.query(
      `select event_date::text as date from public.events where event_date between $1::date and $2::date`, [launch, today]);
    const dates = new Set(saved.map((r) => r.date));
    for (const d of meetingTuesdays(launch, today)) dates.add(d);
    const { rows } = await db.query(
      `select x.d::text as date, e.status as "eventStatus", s.status as stored,
              (select count(*)::int from public.attendees a where ${JOINED_AT("x.d")} and ${NOT_ON_LUMA}) as people
         from unnest($1::date[]) as x(d)
         left join public.events e on e.event_date = x.d
         left join public.luma_syncs s on s.event_date = x.d
        order by x.d`, [[...dates]]);
    const first = rows.find((r) => lumaSyncStatus({
      stored: r.stored, people: r.people, cancelled: r.eventStatus === CANCELLED,
    }).unfinished);
    if (first) return { state: "sync", sync: await getLumaSync(db, first.date, { now, today, launch }) };
  }
  const holiday = isHolidayWeek(today);
  if (!holiday) return { state: "stand_down", today, holiday, message: STAND_DOWN };
  // This week's Tuesday (the week runs Tuesday to Monday): a saved row there is an Event
  // even in the break (the override), so don't say there is none.
  let tuesday = today;
  while (!isTuesday(tuesday)) tuesday = addDays(tuesday, -1);
  const { rows: [held] } = await db.query("select 1 from public.events where event_date = $1::date", [tuesday]);
  const why = held
    ? `but this week's Event (${tuesday}) has nothing to add.`
    : "so there is no Event this week.";
  return { state: "stand_down", today, holiday, message: `${STAND_DOWN} It's the holiday break (${HOLIDAY_BREAK_LABEL}), ${why}` };
}

/**
 * The checks both writes share, then the luma_syncs row locked FOR UPDATE (created, with
 * the events row it needs, on the first write), so two writes to one sync take turns.
 * Returns the stored status before this write (null: there was no row).
 */
async function lockSync(client, date, opts) {
  if (!parseDate(date)) throw new ValidationError({ date: "Pick a valid date (YYYY-MM-DD)." });
  const { today, launch } = opts;
  const { rows: [ev] } = await client.query("select status from public.events where event_date = $1::date", [date]);
  const facts = shape({ date, eventStatus: ev?.status ?? null, hasRow: false, stored: null, people: [], joined: [], today, launch });
  if (!facts.isEvent) throw new NotFoundError({ date: `There is no Event on ${date}.` });
  if (facts.beforeLaunch) throw new ConflictError({ date: `Events before ${launch} have no Luma sync.` });
  if (facts.upcoming) throw new ConflictError({ date: `The Event on ${date} hasn't happened yet.` });
  if (facts.cancelled) throw new ConflictError({ date: `The Event on ${date} was Cancelled: its Luma sync is Nothing to add.` });
  const lock = "select status from public.luma_syncs where event_date = $1::date for update";
  const { rows: [existing] } = await client.query(lock, [date]);
  if (existing) return { stored: existing.status };
  if (!ev) await client.query("insert into public.events (event_date) values ($1::date) on conflict do nothing", [date]);
  await client.query("insert into public.luma_syncs (event_date) values ($1::date) on conflict do nothing", [date]);
  await client.query(lock, [date]);
  return { stored: null };
}

/**
 * Mark a Luma sync Done (see the header).
 * @param {string} actorUserId
 * @param {string} date
 * @param {{ attendeeIds?: string[] | null, now?: Date, today?: string, launch?: string }} [opts]
 */
export async function markDone(actorUserId, date, opts = {}) {
  const resolved = resolveOpts(opts);
  const ids = opts.attendeeIds == null ? null : [...new Set(opts.attendeeIds)].filter((id) => typeof id === "string");
  return withAudit(actorUserId, async (client) => {
    const { stored } = await lockSync(client, date, resolved);
    const { rows } = await client.query(
      `update public.attendees a set on_luma_at = $2
        where ${JOINED_AT("$1::date")} and ${NOT_ON_LUMA}
          and ($3::text[] is null or a.id::text = any($3::text[]))
        returning a.id`, [date, resolved.now, ids]);
    await client.query(
      "update public.luma_syncs set status = 'done', updated_by = $2 where event_date = $1::date", [date, actorUserId]);
    return { date, people: rows.length, attendeeIds: rows.map((r) => r.id).sort(), before: stored };
  }, (r) => ({
    action: "luma_sync.done", targetTable: "luma_syncs", targetId: date,
    details: { people: r.people, attendeeIds: r.attendeeIds, before: r.before },
  }));
}

/**
 * Mark a Luma sync Error with the agent's note (see the header).
 * @param {string} actorUserId
 * @param {string} date
 * @param {unknown} note
 * @param {{ now?: Date, today?: string, launch?: string }} [opts]
 */
export async function markError(actorUserId, date, note, opts = {}) {
  const problem = errorNoteProblem(note);
  if (problem) throw new ValidationError({ note: problem });
  const text = /** @type {string} */ (note).trim();
  const resolved = resolveOpts(opts);
  return withAudit(actorUserId, async (client) => {
    const { stored } = await lockSync(client, date, resolved);
    const { rows: [{ people }] } = await client.query(
      `select count(*)::int as people from public.attendees a where ${JOINED_AT("$1::date")} and ${NOT_ON_LUMA}`, [date]);
    await client.query(
      "update public.luma_syncs set status = 'error', note = $2, updated_by = $3 where event_date = $1::date",
      [date, text, actorUserId]);
    return { date, note: text, people, before: stored };
  }, (r) => ({
    action: "luma_sync.error", targetTable: "luma_syncs", targetId: date,
    details: { people: r.people, note: r.note, before: r.before },
  }));
}
