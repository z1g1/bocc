// The email list for /admin/email-list/ (admin only; the CALLER checks requireRole and,
// for the export and opt-out POSTs, checkOrigin). Parameterized SQL only.
//
//   listEmailList(db)                    -> [{ id, name, businessName, email, createdAt, dateAdded,
//                                              onLumaSince, onLumaBeforeLaunch }]
//   onLumaLabel(s) / onLumaCsv(s)          -> the On Luma state for the page / the CSV
//   csvCell(value) / toCsv(header, rows)   -> CSV text (RFC 4180, CRLF, formula-safe)
//   exportEmailList(actorUserId)           -> { csv, rowCount }  (audited, one transaction)
//   optOut(actorUserId, attendeeId)        -> { wasOptedIn }     (audited, one transaction)
//
// The Email list: ok_to_email = true and not a debug (test) attendee.
// dateAdded ("YYYY-MM-DD", GLOSSARY "Date added"): the Eastern day of the attendee's first
// non-debug check-in (checkin_date is already the Eastern day), otherwise the Eastern day
// their row was created (people imported from Airtable have no check-ins).
// On Luma (ADR 0014): onLumaSince is the Eastern date the app recorded them On Luma
// ("YYYY-MM-DD") or null; onLumaBeforeLaunch marks those on the list at launch.
// Neither = Not yet.

import { withAudit } from "./db.mjs";
import { NotFoundError, isUuid } from "./attendees.mjs";
import { shortDay } from "./format.mjs";

const EMAIL_LIST_SQL = `
  select a.id, a.name, a.business_name as "businessName", a.email, a.created_at as "createdAt",
         coalesce(
           (select min(c.checkin_date) from public.checkins c where c.attendee_id = a.id and c.debug = false),
           (a.created_at at time zone 'America/New_York')::date
         )::text as "dateAdded",
         to_char(a.on_luma_at at time zone 'America/New_York', 'YYYY-MM-DD') as "onLumaSince",
         a.on_luma_before_launch as "onLumaBeforeLaunch"
    from public.attendees a
   where a.ok_to_email = true and a.debug = false
   order by lower(a.name), a.email`;

export async function listEmailList(db) {
  const { rows } = await db.query(EMAIL_LIST_SQL);
  return rows;
}

/** "On Luma since Nov 30, 2026", "Before launch" or "Not yet". */
export function onLumaLabel({ onLumaSince, onLumaBeforeLaunch }) {
  if (onLumaSince) return `On Luma since ${shortDay(onLumaSince)}`;
  return onLumaBeforeLaunch ? "Before launch" : "Not yet";
}

/** The CSV on_luma cell: an ISO date, "before_launch" or empty. */
export function onLumaCsv({ onLumaSince, onLumaBeforeLaunch }) {
  if (onLumaSince) return onLumaSince;
  return onLumaBeforeLaunch ? "before_launch" : "";
}

// A spreadsheet treats a cell starting with = + - @ (or a tab / CR before one) as a
// formula (OWASP "CSV injection"). Such cells get a leading apostrophe, which Excel,
// Sheets and LibreOffice show as text.
const FORMULA_START = /^[=+\-@\t\r]/;

/** One CSV field: formula-guarded, then quoted when it holds , " CR or LF. */
export function csvCell(value) {
  let s = value == null ? "" : String(value);
  if (FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** @param {string[]} header @param {unknown[][]} rows */
export function toCsv(header, rows) {
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export const CSV_HEADER = Object.freeze(["email", "name", "business_name", "date_added", "on_luma"]);

/**
 * Build the CSV and write its audit row (who, when, how many rows) in ONE
 * transaction, so an export is never handed out unrecorded.
 * @param {string} actorUserId
 */
export async function exportEmailList(actorUserId) {
  const rows = await withAudit(
    actorUserId,
    async (client) => (await client.query(EMAIL_LIST_SQL)).rows,
    (rs) => ({ action: "email_list.export", targetTable: "attendees", details: { rowCount: rs.length } }),
  );
  return {
    csv: toCsv([...CSV_HEADER], rows.map((r) => [r.email, r.name, r.businessName, r.dateAdded, onLumaCsv(r)])),
    rowCount: rows.length,
  };
}

/**
 * ok_to_email -> false, with its audit row, in ONE transaction. Audited even when
 * the attendee had already opted out (the request still happened); details say which.
 * @param {string} actorUserId
 * @param {string} attendeeId
 */
export async function optOut(actorUserId, attendeeId) {
  if (!isUuid(attendeeId)) throw new NotFoundError("attendee not found");
  return withAudit(
    actorUserId,
    async (client) => {
      const { rows } = await client.query(
        "select ok_to_email from public.attendees where id = $1 for update", [attendeeId]);
      if (rows.length === 0) throw new NotFoundError("attendee not found");
      const res = await client.query("update public.attendees set ok_to_email = false where id = $1", [attendeeId]);
      if (res.rowCount !== 1) throw new Error("opt-out did not apply");
      return { wasOptedIn: rows[0].ok_to_email === true };
    },
    (r) => ({
      action: "attendee.opt_out",
      targetTable: "attendees",
      targetId: attendeeId,
      details: { before: { ok_to_email: r.wasOptedIn }, after: { ok_to_email: false } },
    }),
  );
}
