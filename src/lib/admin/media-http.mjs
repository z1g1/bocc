// Shared plumbing for the /api/admin/media/* routes (ADR 0010). Every route is POST
// only, admin only and Origin-checked; this module adds the parts they all repeat:
// the storage switch (503 when media is off), JSON bodies and error mapping.
//
//   export const POST: APIRoute = (ctx) => mediaRoute(ctx, async ({ storage, user, request }) => …);
//   export const ALL: APIRoute = (ctx) => mediaRoute(ctx, …)   // -> 405 for other methods

import { requireRole } from "./roles.mjs";
import { checkOrigin } from "./csrf.mjs";
import { getStorage, isIsoDate } from "./storage.mjs";
import { adminFailure } from "./log.mjs";

export const STORAGE_OFF_MESSAGE = "Photo storage is not set up on this site, so photos can't be uploaded or changed.";
const MAX_JSON_BYTES = 4096;

const NO_STORE = { "cache-control": "no-store" };
export const json = (status, body) => Response.json(body, { status, headers: NO_STORE });

/** True when the request body is JSON (fetch from admin-media.js), not a form post. */
export const isJsonRequest = (request) => (request.headers.get("content-type") ?? "").split(";")[0].trim() === "application/json";

/**
 * Run `handler` for an admin, Origin-checked POST with storage configured. Maps
 * ValidationError -> 400, NotFoundError -> 404, anything else -> a logged 500.
 * @param {{ locals: any, request: Request }} ctx
 * @param {(args: { storage: import("./storage.mjs").Storage, user: { id: string }, request: Request }) => Promise<Response>} handler
 * @param {{ getStorage?: typeof getStorage }} [deps]
 */
export async function mediaRoute({ locals, request }, handler, deps = {}) {
  const denied = requireRole(locals, "admin") ?? checkOrigin(request);
  if (denied) return denied;
  const { storage } = (deps.getStorage ?? getStorage)();
  if (!storage) return json(503, { error: STORAGE_OFF_MESSAGE });
  try {
    return await handler({ storage, user: locals.user, request });
  } catch (err) {
    const e = /** @type {any} */ (err);
    if (e?.status === 400) return json(400, { error: "Invalid request", errors: e.errors ?? [e.message] });
    // A refused delete (media.mjs InUseError: the photo is an Event Image).
    if (e?.status === 409) return json(409, { error: e.message, errors: e.errors ?? [e.message], eventDates: e.eventDates });
    if (e?.status === 404) return json(404, { error: "Photo not found" });
    return adminFailure("api/admin/media", err);
  }
}

/** Parse a small JSON body; throws a 400 ValidationError-shaped error. */
export async function readJson(request) {
  const bad = (msg) => Object.assign(new Error(msg), { status: 400, errors: [msg] });
  if (!isJsonRequest(request)) throw bad("content-type must be application/json");
  const text = await request.text();
  if (text.length > MAX_JSON_BYTES) throw bad("body too large");
  try {
    return text === "" ? {} : JSON.parse(text);
  } catch {
    throw bad("body is not valid JSON");
  }
}

/**
 * Answer a gallery form post: a 303 to the photo's own event page, on the tab that
 * shows it (/admin/events/<date>/?tab=post&media=<notice>#event-media; a promo video:
 * ?tab=social…#social, ADR 0012), or JSON when the request was JSON. The
 * target is built from the row's event_date, never from a client-supplied value, so it
 * can't be turned into an open redirect (e.g. "/admin/..//evil.example" normalising to
 * a protocol-relative "//evil.example").
 * @param {FormData|null} form
 * @param {string} eventDate  YYYY-MM-DD, from the database row
 * @param {string} notice
 * @param {Record<string, unknown>} body
 * @param {"event-media"|"social"|"event-image"} [anchor]  the section to land on
 *   (social: the promo video, on Social Posts; event-image: the Event Image, on Event Info)
 * @param {Record<string, string>} [extra]  more query parameters (values are URL-encoded)
 */
export function formOrJson(form, eventDate, notice, body, anchor = "event-media", extra = {}) {
  if (!form) return json(200, body);
  if (!isIsoDate(eventDate)) throw new Error("formOrJson: eventDate must be YYYY-MM-DD");
  if (!Object.hasOwn(ANCHOR_TABS, anchor)) throw new Error("formOrJson: unknown anchor");
  const tab = ANCHOR_TABS[anchor];
  const more = Object.entries(extra).map(([k, v]) => `&${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("");
  const location = `/admin/events/${eventDate}/?tab=${tab}&media=${encodeURIComponent(notice)}${more}#${anchor}`;
  return new Response(null, { status: 303, headers: { location, ...NO_STORE } });
}

/** The event page tab each redirect anchor lives on (ADR 0012 decision 1). */
const ANCHOR_TABS = Object.freeze({ "event-media": "post", social: "social", "event-image": "info" });

/** Read the body of a gallery action: a form post, or JSON from the upload script. */
export async function readFormOrJson(request) {
  if (isJsonRequest(request)) return { form: null, data: await readJson(request) };
  let form;
  try {
    form = await request.formData();
  } catch {
    throw Object.assign(new Error("bad form body"), { status: 400, errors: ["bad form body"] });
  }
  return { form, data: Object.fromEntries(form) };
}

/** 405 for any method but POST (the routes export ALL as well as POST). */
export const methodNotAllowed = ({ locals }) =>
  requireRole(locals, "admin") ?? new Response("Method Not Allowed", { status: 405, headers: { allow: "POST", ...NO_STORE } });
