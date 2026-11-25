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

import { ValidationError, parseDate } from "./events.mjs";
import { formField } from "./form.mjs";
import { plainText } from "./headers.mjs";
import { markDone, markError } from "./luma-sync.mjs";
import { pushLumaSyncError } from "./luma-sync-alert.mjs";
import { peopleAre } from "./luma-sync-rules.mjs";

/** 303 See Other to the page's GET (post/redirect/get). */
const redirectAfterPost = (location) =>
  new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });

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
    return { response: plainText(400, "Bad Request") };
  }
  const action = formField(data, "action");
  const date = formField(data, "date");
  const values = { date, note: formField(data, "note") };
  try {
    if (action === "done") {
      const attendeeIds = data.getAll("attendeeId").filter((v) => typeof v === "string");
      const result = await markDone(userId, date, { ...opts, attendeeIds });
      return { result, response: redirectAfterPost(`${page}?notice=done&date=${date}&people=${result.people}`) };
    }
    if (action === "error") {
      const result = await markError(userId, date, values.note, opts);
      // After the commit. Never throws: a failed push is only logged.
      await pushLumaSyncError(result, ntfy);
      return { result, response: redirectAfterPost(`${page}?notice=error&date=${date}`) };
    }
    return { response: plainText(400, "Bad Request: unknown action") };
  } catch (err) {
    if (err instanceof ValidationError) return { status: err.status, errors: err.errors, posted: { action, values } };
    throw err;
  }
}

/** The notice after a redirect, or null. */
export function noticeText(params) {
  const date = parseDate(params.get("date"));
  if (!date) return null;
  switch (params.get("notice")) {
    case "done": {
      const people = Number(params.get("people"));
      const who = Number.isInteger(people) && people >= 0 ? `${peopleAre(people)} now On Luma` : "Saved";
      return `Marked the Luma sync for ${date} Done. ${who}.`;
    }
    case "error": return `Marked the Luma sync for ${date} Error.`;
    default: return null;
  }
}
