// The Luma sync's pure rules (ADR 0014, spec #70): its statuses, the displayed status,
// the launch date, the Luma people page and the Error note check. No database, no
// imports from the admin data layer, so unit tests and any page can use them.
//
//   LUMA_SYNC_STATUSES, LUMA_SYNC_STATUS_LABELS   todo | nothing_to_add | done | error
//   displayedStatus({ stored, people, cancelled }) -> the status to show and act on
//   isUnfinished(status)                           -> To do or Error (what /next hands out)
//   lumaSyncStatus({ stored, people, cancelled })  -> { status, statusLabel, unfinished }: both of the above
//   lumaSyncLaunchDate(env)                        -> "YYYY-MM-DD", the first Event with a sync
//   LUMA_PEOPLE_URL                                the Luma calendar's people page
//   NOTE_MAX, errorNoteProblem(note)               -> null when the trimmed note is fine, else the message
//   emailLine(people)                              -> "a@x.com b@y.com" (Luma's Add people input)
//   ERROR_STOP_HOURS, erroredRecently(s, now)      -> stop the run: an Error set in the last 12 hours

export const LUMA_SYNC_STATUSES = Object.freeze(["todo", "nothing_to_add", "done", "error"]);

/** GLOSSARY "Luma sync status". */
export const LUMA_SYNC_STATUS_LABELS = Object.freeze({
  todo: "To do",
  nothing_to_add: "Nothing to add",
  done: "Done",
  error: "Error",
});

/** Where the Chrome task adds people (ADR 0014). A code constant, not a setting. */
export const LUMA_PEOPLE_URL = "https://luma.com/calendar/manage/cal-v2LiFTJpdPAP6rW/people";

/**
 * The first Event that has a Luma sync. Events before it never get one (spec #70,
 * story 36): the launch backfill marked everyone on the Email list at release On Luma
 * "before launch", so an Event between this date and the release shows Nothing to add.
 * `LUMA_SYNC_LAUNCH_DATE` (YYYY-MM-DD) overrides it, for the HTTP tests and a rehearsal.
 */
export const LUMA_SYNC_LAUNCH_DATE = "2026-12-01";

/** @param {Record<string, string | undefined>} [env] */
export function lumaSyncLaunchDate(env = process.env) {
  const v = env.LUMA_SYNC_LAUNCH_DATE;
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : LUMA_SYNC_LAUNCH_DATE;
}

/** luma_syncs.note's limit (its CHECK). */
export const NOTE_MAX = 2000;

/**
 * The displayed Luma sync status (spec #70, "Status rules"):
 *   - a Cancelled Event is always Nothing to add;
 *   - Error stays Error until someone sets Done;
 *   - anyone still to add makes it To do, even over a stored Done (a late joiner) or
 *     Nothing to add;
 *   - a stored Done with nobody left is Done;
 *   - otherwise (no row, or To do with nobody to add) Nothing to add.
 * @param {{ stored?: string | null, people: number, cancelled?: boolean }} s
 * @returns {"todo" | "nothing_to_add" | "done" | "error"}
 */
export function displayedStatus({ stored = null, people, cancelled = false }) {
  if (cancelled) return "nothing_to_add";
  if (stored === "error") return "error";
  if (people > 0) return "todo";
  if (stored === "done") return "done";
  return "nothing_to_add";
}

/** To do or Error: what /admin/luma-sync/next/ hands out. */
export const isUnfinished = (status) => status === "todo" || status === "error";

/**
 * The displayed status with its label and whether it is unfinished, from the stored
 * status, the number of people still to add and whether the Event was Cancelled. The
 * one place luma-sync.mjs turns those three into a status (getLumaSync, findNextLumaSync).
 * @param {{ stored?: string | null, people: number, cancelled?: boolean }} s
 * @returns {{ status: "todo" | "nothing_to_add" | "done" | "error", statusLabel: string, unfinished: boolean }}
 */
export function lumaSyncStatus(s) {
  const status = displayedStatus(s);
  return { status, statusLabel: LUMA_SYNC_STATUS_LABELS[status], unfinished: isUnfinished(status) };
}

/**
 * What is wrong with an Error note (required, at most NOTE_MAX characters once
 * trimmed), or null when it is fine.
 * @param {unknown} note
 * @returns {string | null}
 */
export function errorNoteProblem(note) {
  const s = typeof note === "string" ? note.trim() : "";
  if (s === "") return "Write what went wrong, for example the emails missing from Luma.";
  if (s.length > NOTE_MAX) return `Keep the note to ${NOTE_MAX} characters.`;
  return null;
}

/** All the emails, separated by single spaces (Luma's Add people input takes that). */
export const emailLine = (people) => people.map((p) => p.email).join(" ");

/**
 * How long after an Error is set /admin/luma-sync/next/ tells the agent to stop rather
 * than retry it. Longer than one run, much shorter than the week between runs: the run
 * that set it stops however it reloads the page, and the next run retries (spec story 17).
 */
export const ERROR_STOP_HOURS = 12;

/**
 * Was this sync set to Error within ERROR_STOP_HOURS of `now`? A time slightly in the
 * future (the database's clock a little ahead of the app's) counts as recent.
 * @param {{ status: string | null, updatedAt?: Date | string | null }} s  displayed status, stored updated_at
 * @param {Date} now
 */
export function erroredRecently({ status, updatedAt = null }, now) {
  if (status !== "error" || updatedAt == null) return false;
  return now.getTime() - new Date(updatedAt).getTime() < ERROR_STOP_HOURS * 3_600_000;
}
