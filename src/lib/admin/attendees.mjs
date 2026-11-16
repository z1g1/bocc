// Attendee lookups and corrections for /admin/attendees/ (admin only; the CALLER
// checks requireRole and, for changes, checkOrigin). Parameterized SQL only.
//
// admin_app may UPDATE only ok_to_email, name, business_name and phone on attendees
// (migration 20261116120000_admin_auth.sql). Corrections here touch name,
// business_name and phone; ok_to_email (opt-out) lives in email-list.mjs.
//
//   isUuid(value)                                -> boolean
//   searchAttendees(db, { q, includeDebug, limit }) -> [{ id, name, businessName, email, okToEmail, debug, lastCheckinDate }]
//   getAttendee(db, id)                          -> attendee | null
//   recentCheckins(db, id, { limit })            -> [{ checkinDate, checkinAt, eventId, debug }]
//   attendeeStreaks(db, id)                      -> [{ eventId, currentStreak, longestStreak, weeksAttended }]
//   validateCorrection(input)                    -> { ok, errors, values }
//   correctAttendee(actorUserId, id, input)      -> { changed: string[] }  (audited, one transaction)
//
// Errors thrown for the caller to map: NotFoundError (404), ValidationError (400).

import { withAudit } from "./db.mjs";

export class NotFoundError extends Error {
  status = 404;
}
export class ValidationError extends Error {
  status = 400;
  /** @param {string[]} errors */
  constructor(errors) {
    super(errors.join("; "));
    this.errors = errors;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => typeof v === "string" && UUID_RE.test(v);

const ATTENDEE_COLUMNS = `
  a.id, a.name, a.business_name as "businessName", a.email, a.phone,
  a.ok_to_email as "okToEmail", a.debug, a.created_at as "createdAt"`;

/** Find attendees by name, email or business (case-insensitive substring). */
export async function searchAttendees(db, { q = "", includeDebug = false, limit = 100 } = {}) {
  const term = String(q ?? "").trim().slice(0, 100);
  const pattern = term === "" ? null : `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const { rows } = await db.query(
    `select ${ATTENDEE_COLUMNS},
            (select max(c.checkin_date)::text from public.checkins c
              where c.attendee_id = a.id) as "lastCheckinDate"
       from public.attendees a
      where ($1 or a.debug = false)
        and ($2::text is null or a.name ilike $2 or a.email ilike $2 or a.business_name ilike $2)
      order by "lastCheckinDate" desc nulls last, a.name
      limit $3`,
    [includeDebug, pattern, limit],
  );
  return rows;
}

export async function getAttendee(db, id) {
  if (!isUuid(id)) return null;
  const { rows } = await db.query(`select ${ATTENDEE_COLUMNS} from public.attendees a where a.id = $1`, [id]);
  return rows[0] ?? null;
}

export async function recentCheckins(db, id, { limit = 20 } = {}) {
  if (!isUuid(id)) return [];
  const { rows } = await db.query(
    `select checkin_date::text as "checkinDate", checkin_at as "checkinAt", event_id as "eventId", debug
       from public.checkins where attendee_id = $1
      order by checkin_at desc limit $2`,
    [id, limit],
  );
  return rows;
}

export async function attendeeStreaks(db, id) {
  if (!isUuid(id)) return [];
  const { rows } = await db.query(
    `select event_id as "eventId", current_streak::int as "currentStreak",
            longest_streak::int as "longestStreak", weeks_attended::int as "weeksAttended"
       from public.streaks where attendee_id = $1 order by event_id`,
    [id],
  );
  return rows;
}

// ── Validation ───────────────────────────────────────────────────────────────
// sanitizeText and isValidPhone mirror backend/netlify/functions/utils/validation.js
// (the check-in form's rules), so a corrected value is one the form could have
// stored. They are copied, not imported, because that file is CommonJS outside the
// Astro bundle; tests/admin/views-unit.test.mjs checks the two stay in step.

export function sanitizeText(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/javascript:/gi, "")
    .replace(/on\w+\s*=/gi, "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isValidPhone(phone) {
  if (!phone || phone === "") return true;
  if (typeof phone !== "string") return false;
  const digitsOnly = phone.replace(/[\s\-\(\)\.\+]/g, "");
  if (!/^\d{7,15}$/.test(digitsOnly)) return false;
  return /^[\d\s\-\(\)\.\+]+$/.test(phone);
}

export const LIMITS = Object.freeze({ name: 200, businessName: 200, phone: 40 });

/**
 * @param {{ name?: unknown, businessName?: unknown, phone?: unknown }} input
 * @returns {{ ok: boolean, errors: string[], values: { name: string, businessName: string|null, phone: string|null } }}
 *   Empty business/phone become null, as the check-in writer stores them.
 */
export function validateCorrection(input) {
  const errors = [];
  const raw = (v) => (typeof v === "string" ? v : "");
  const name = sanitizeText(raw(input?.name));
  const businessName = sanitizeText(raw(input?.businessName));
  const phoneRaw = raw(input?.phone).trim();

  if (name === "") errors.push("Name is required");
  if (name.length > LIMITS.name) errors.push(`Name must be at most ${LIMITS.name} characters`);
  if (businessName.length > LIMITS.businessName) errors.push(`Business must be at most ${LIMITS.businessName} characters`);
  if (phoneRaw.length > LIMITS.phone || !isValidPhone(phoneRaw)) errors.push("Invalid phone number format");
  const phone = sanitizeText(phoneRaw);

  return {
    ok: errors.length === 0,
    errors,
    values: { name, businessName: businessName || null, phone: phone || null },
  };
}

const FIELDS = /** @type {const} */ ([
  ["name", "name"],
  ["businessName", "business_name"],
  ["phone", "phone"],
]);

class NoChange extends Error {}

/**
 * Correct name / business / phone. The row is locked, compared, updated and audited
 * (details.before / details.after hold only the fields that changed) in ONE
 * transaction. No change -> nothing is written and `changed` is empty.
 * @param {string} actorUserId
 * @param {string} id
 * @param {{ name?: unknown, businessName?: unknown, phone?: unknown }} input
 */
export async function correctAttendee(actorUserId, id, input) {
  if (!isUuid(id)) throw new NotFoundError("attendee not found");
  const v = validateCorrection(input);
  if (!v.ok) throw new ValidationError(v.errors);

  const before = {};
  const after = {};
  try {
    await withAudit(actorUserId, async (client) => {
      const { rows } = await client.query(
        `select name, business_name, phone from public.attendees where id = $1 for update`, [id]);
      if (rows.length === 0) throw new NotFoundError("attendee not found");
      const sets = [];
      const params = [id];
      for (const [key, col] of FIELDS) {
        if (rows[0][col] !== v.values[key]) {
          before[col] = rows[0][col];
          after[col] = v.values[key];
          params.push(v.values[key]);
          sets.push(`${col} = $${params.length}`); // column names come from FIELDS only
        }
      }
      if (sets.length === 0) throw new NoChange();
      const res = await client.query(`update public.attendees set ${sets.join(", ")} where id = $1`, params);
      if (res.rowCount !== 1) throw new Error("attendee update did not apply");
    }, () => ({ action: "attendee.update", targetTable: "attendees", targetId: id, details: { before, after } }));
  } catch (err) {
    if (err instanceof NoChange) return { changed: [] };
    throw err;
  }
  return { changed: Object.keys(after) };
}
