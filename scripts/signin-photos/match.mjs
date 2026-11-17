// Matching rules for the one-time sign-in board photo import (ADR 0010 decision 4,
// amended 2026-11-17). Pure: no files, database or network, so the rules are unit
// tested (tests/admin/media-import-unit.test.mjs).
//
// A photo's event date comes from:
//   1. its file name, MM-DD-YYYY[-NN].<ext> (M and D may be one digit), else
//   2. its EXIF capture date (local wall time): the most recent known event on or
//      before it, within 6 days (a weekly club: an older one is a different week),
//      else the most recent Tuesday on or before it.
// A row is UNCERTAIN, and must be confirmed in the override file before --apply, when:
//   - the file-name date and the capture date are more than 1 day apart
//   - the matched date is not an existing events row (or events weren't checked)
//   - the capture date is more than 2 days after the matched date
//   - more than one photo matches the same date (allowed, but listed)
//   - the file-name date is not a Tuesday
//   - there is no date at all

const DAY_MS = 86400000;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const EVENT_LOOKBACK_DAYS = 6;

/** True for a real calendar date written YYYY-MM-DD. */
export function isIsoDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const toMs = (iso) => Date.parse(`${iso}T00:00:00Z`);
const fromMs = (ms) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (iso, n) => fromMs(toMs(iso) + n * DAY_MS);
/** Whole days from a to b (b - a). */
export const daysBetween = (a, b) => Math.round((toMs(b) - toMs(a)) / DAY_MS);
export const weekday = (iso) => WEEKDAYS[new Date(toMs(iso)).getUTCDay()];
export const isTuesday = (iso) => new Date(toMs(iso)).getUTCDay() === 2;

/** The most recent Tuesday on or before `iso`. */
export function tuesdayOnOrBefore(iso) {
  const dow = new Date(toMs(iso)).getUTCDay();
  return addDays(iso, -((dow - 2 + 7) % 7));
}

/** "12-3-2024.HEIC" / "10-29-2024-02.HEIC" -> "2024-12-03" / "2024-10-29"; else null. */
export function filenameDate(name) {
  const m = /^(\d{1,2})-(\d{1,2})-(\d{4})(?:-\d{1,3})?\.[A-Za-z0-9]+$/.exec(name);
  if (!m) return null;
  const iso = `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return isIsoDate(iso) ? iso : null;
}

/** "2024-12-03T08:55:46" -> "2024-12-03"; null stays null. */
export const captureDay = (capture) => (typeof capture === "string" && isIsoDate(capture.slice(0, 10)) ? capture.slice(0, 10) : null);

/**
 * @param {Array<{ name: string, sha256?: string, capture: string|null }>} photos
 * @param {{ eventDates?: Iterable<string> | null }} [opts]
 *   eventDates: existing events rows; null/undefined = not checked (every row flagged)
 * @returns {Array<{ name: string, sha256?: string, capture: string|null, filenameDate: string|null,
 *   matched: string|null, reason: string, flags: string[], uncertain: boolean }>}
 */
export function matchPhotos(photos, { eventDates = null } = {}) {
  const events = eventDates ? [...new Set(eventDates)].filter(isIsoDate).sort() : null;
  const known = events ? new Set(events) : null;

  const rows = photos.map((p) => {
    const fileDay = filenameDate(p.name);
    const capDay = captureDay(p.capture);
    const flags = [];
    let matched = null;
    let reason;

    if (fileDay) {
      matched = fileDay;
      reason = "file name";
      if (!isTuesday(fileDay)) flags.push(`file-name date is a ${weekday(fileDay)}`);
      if (!capDay) flags.push("no capture date to cross-check");
      else {
        const gap = daysBetween(fileDay, capDay);
        if (Math.abs(gap) > 1) flags.push(`file name and capture date differ by ${Math.abs(gap)} days`);
      }
    } else if (capDay) {
      const floor = addDays(capDay, -EVENT_LOOKBACK_DAYS);
      const event = events ? events.filter((d) => d <= capDay && d >= floor).at(-1) : undefined;
      if (event) {
        matched = event;
        reason = "capture date: event on or before";
      } else {
        matched = tuesdayOnOrBefore(capDay);
        reason = "capture date: Tuesday on or before";
      }
    } else {
      reason = "no date in file name or EXIF";
      flags.push("no date: needs an override");
    }

    if (matched) {
      if (!known) flags.push("events not checked");
      else if (!known.has(matched)) flags.push("no events row for this date");
      if (capDay && daysBetween(matched, capDay) > 2) flags.push(`taken ${daysBetween(matched, capDay)} days after the event`);
    }
    return { name: p.name, sha256: p.sha256, capture: p.capture ?? null, filenameDate: fileDay, matched, reason, flags };
  });

  const perDate = new Map();
  for (const r of rows) if (r.matched) perDate.set(r.matched, (perDate.get(r.matched) ?? 0) + 1);
  for (const r of rows) {
    const n = r.matched ? perDate.get(r.matched) : 0;
    if (n > 1) r.flags.push(`${n} photos for this date`);
  }
  return rows.map((r) => ({ ...r, uncertain: r.flags.length > 0 }));
}

/**
 * Parse the confirm/override file: one `filename,YYYY-MM-DD` or `filename,skip` per
 * line; blank lines and lines starting with # are ignored. A file name may contain
 * spaces (the LAST comma separates the value).
 * @param {string} text
 * @returns {Map<string, string>}  name -> date | "skip"
 */
export function parseOverrides(text) {
  const out = new Map();
  const errors = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) return;
    const at = t.lastIndexOf(",");
    const name = at > 0 ? t.slice(0, at).trim() : "";
    const value = at > 0 ? t.slice(at + 1).trim() : "";
    if (!name || !(value === "skip" || isIsoDate(value))) errors.push(`line ${i + 1}: expected "filename,YYYY-MM-DD" or "filename,skip"`);
    else if (out.has(name)) errors.push(`line ${i + 1}: ${name} listed twice`);
    else out.set(name, value);
  });
  if (errors.length) throw new Error(`override file:\n  ${errors.join("\n  ")}`);
  return out;
}

/**
 * Apply the confirmed overrides. Every uncertain row must be listed (a date, possibly
 * the same one, confirms it; `skip` leaves the photo out), and every listed name must
 * be a photo in the import.
 * @param {ReturnType<typeof matchPhotos>} rows
 * @param {Map<string, string>} overrides
 * @returns {{ plan: Array<{ name: string, sha256?: string, date: string, overridden: boolean }>, skipped: string[] }}
 */
export function resolvePlan(rows, overrides) {
  const names = new Set(rows.map((r) => r.name));
  const unknown = [...overrides.keys()].filter((n) => !names.has(n));
  const unconfirmed = rows.filter((r) => r.uncertain && !overrides.has(r.name)).map((r) => r.name);
  const problems = [];
  if (unknown.length) problems.push(`not in the import: ${unknown.join(", ")}`);
  if (unconfirmed.length) problems.push(`uncertain and not confirmed: ${unconfirmed.join(", ")}`);
  if (problems.length) throw new Error(`refusing to apply:\n  ${problems.join("\n  ")}`);

  const plan = [];
  const skipped = [];
  for (const r of rows) {
    const o = overrides.get(r.name);
    if (o === "skip") skipped.push(r.name);
    else plan.push({ name: r.name, sha256: r.sha256, date: o ?? r.matched, overridden: o !== undefined && o !== r.matched });
  }
  return { plan, skipped };
}

/**
 * A stable event_media id for one source file: derived from its SHA-256, so a re-run
 * finds the row (and its object keys) it made before. Formatted as a UUID (version 8,
 * "custom", RFC 9562), lowercase as mediaKey requires.
 * @param {string} sha256hex
 */
export function importId(sha256hex) {
  if (!/^[0-9a-f]{64}$/.test(sha256hex)) throw new Error("importId: need a lowercase sha256 hex digest");
  const h = sha256hex.slice(0, 32).split("");
  h[12] = "8"; // version 8
  h[16] = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16); // RFC 4122 variant
  const s = h.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** The dry-run table, as plain text. */
export function formatTable(rows) {
  const head = ["file", "capture", "matched", "reason", "flags"];
  const body = rows.map((r) => [
    `${r.uncertain ? "? " : "  "}${r.name}`,
    r.capture ? r.capture.replace("T", " ") : "-",
    r.matched ?? "-",
    r.reason,
    r.flags.join("; ") || "",
  ]);
  const widths = head.map((h, i) => Math.max(h.length + (i === 0 ? 2 : 0), ...body.map((b) => b[i].length)));
  const line = (cells) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join("  ").trimEnd();
  return [line(["  " + head[0], ...head.slice(1)]), ...body.map(line)].join("\n");
}
