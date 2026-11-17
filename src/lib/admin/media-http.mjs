// Shared plumbing for the /api/admin/media/* routes (ADR 0010). Every route is POST
// only, admin only and Origin-checked; this module adds the parts they all repeat:
// the storage switch (503 when media is off), JSON bodies and error mapping.
//
//   export const POST: APIRoute = (ctx) => mediaRoute(ctx, async ({ storage, user, request }) => …);
//   export const ALL: APIRoute = (ctx) => mediaRoute(ctx, …)   // -> 405 for other methods

import { requireRole } from "./roles.mjs";
import { checkOrigin } from "./csrf.mjs";
import { getStorage } from "./storage.mjs";
import { adminFailure } from "./log.mjs";
import { safeNext } from "./next.mjs";

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
 * Answer a gallery form post: a 303 back to the (admin-only) page it came from with
 * ?media=<notice>, or JSON when the request was JSON.
 * @param {Request} request
 * @param {FormData|null} form
 * @param {string} notice
 * @param {Record<string, unknown>} body
 */
export function formOrJson(request, form, notice, body) {
  if (!form) return json(200, body);
  const back = new URL(safeNext(String(form.get("return") ?? "/admin/")), "http://x");
  back.searchParams.set("media", notice);
  return new Response(null, { status: 303, headers: { location: `${back.pathname}${back.search}#event-media`, ...NO_STORE } });
}

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
