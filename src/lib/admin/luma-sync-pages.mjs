// The form posts of /admin/luma-sync/next/ (ADR 0014; spec #70), kept out of the page so
// they can be tested and reused. The caller has checked the role (admin or email) and the
// Origin (checkOrigin).
//
//   handleLumaSyncPost(request, userId, page, opts?)
//       Fields: action ("done" | "error"), date, attendeeId (repeated: the people the page
//       listed; Done marks only those still in the list), note (Error).
//       Success: { response: 303 to `page`?notice=done|error&date=…[&people=n] } (post/
//       redirect/get), plus `result` (markDone's or markError's) for the caller.
//       Error also sends the ntfy push (luma-sync-alert.mjs, #74) after markError has
//       committed; a failed push is logged and never changes the response. Done never pushes.
//       Refused: { status, errors, posted: { action, values } } for the page to re-render.
//   noticeText(params) -> the message for ?notice=… after the redirect, or null

import { ValidationError } from "./events.mjs";
import { markDone, markError } from "./luma-sync.mjs";
import { pushLumaSyncError } from "./luma-sync-alert.mjs";

const plain = (status, text) =>
  new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

const see = (location) => new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });

/**
 * @param {Request} request
 * @param {string} userId
 * @param {string} page  e.g. "/admin/luma-sync/next/"
 * @param {{ now?: Date, today?: string, launch?: string,
 *           ntfy?: { env?: Record<string, string|undefined>, fetch?: typeof fetch, timeoutMs?: number } }} [options]
 *   ntfy: passed to pushLumaSyncError (tests inject env and fetch)
 */
export async function handleLumaSyncPost(request, userId, page, options = {}) {
  const { ntfy, ...opts } = options;
  let data;
  try {
    data = await request.formData();
  } catch {
    return { response: plain(400, "Bad Request") };
  }
  const str = (k) => (typeof data.get(k) === "string" ? /** @type {string} */ (data.get(k)) : "");
  const action = str("action");
  const date = str("date");
  const values = { date, note: str("note") };
  try {
    if (action === "done") {
      const attendeeIds = data.getAll("attendeeId").filter((v) => typeof v === "string");
      const result = await markDone(userId, date, { ...opts, attendeeIds });
      return { result, response: see(`${page}?notice=done&date=${date}&people=${result.people}`) };
    }
    if (action === "error") {
      const result = await markError(userId, date, values.note, opts);
      // After the commit. Never throws: a failed push is only logged.
      await pushLumaSyncError(result, ntfy);
      return { result, response: see(`${page}?notice=error&date=${date}`) };
    }
    return { response: plain(400, "Bad Request: unknown action") };
  } catch (err) {
    if (err instanceof ValidationError) return { status: err.status, errors: err.errors, posted: { action, values } };
    throw err;
  }
}

/** The notice after a redirect, or null. */
export function noticeText(params) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(params.get("date") ?? "") ? params.get("date") : null;
  if (!date) return null;
  switch (params.get("notice")) {
    case "done": {
      const n = Number(params.get("people"));
      const who = Number.isInteger(n) && n >= 0 ? `${n} ${n === 1 ? "person is" : "people are"} now On Luma` : "Saved";
      return `Marked the Luma sync for ${date} Done. ${who}.`;
    }
    case "error": return `Marked the Luma sync for ${date} Error.`;
    default: return null;
  }
}
