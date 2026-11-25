// The Luma sync's pure rules (ADR 0014, spec #70): its statuses, the displayed status,
// the launch date, the Luma people page and the Error note check. No database, no
// imports from the admin data layer, so unit tests and any page can use them.
//
//   LUMA_SYNC_STATUSES, LUMA_SYNC_STATUS_LABELS   todo | nothing_to_add | done | error
//   displayedStatus({ stored, people, cancelled }) -> the status to show and act on
//   isUnfinished(status)                           -> To do or Error (what /next hands out)
//   lumaSyncLaunchDate(env)                        -> "YYYY-MM-DD", the first Event with a sync
//   LUMA_PEOPLE_URL                                the Luma calendar's people page
//   NOTE_MAX, errorNoteProblem(note)               -> null when the trimmed note is fine, else the message
//   emailLine(people)                              -> "a@x.com b@y.com" (Luma's Add people input)

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
