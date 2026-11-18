// The server-side gate for /admin/* and /api/admin/*, kept apart from
// src/middleware.ts so it can be tested without Astro. No database imports at the top:
// path checks run for every request, and the database is only touched for the
// protected prefixes. Browser code must not import this file (its lazy import of
// session.mjs would drag pg into the bundle); use next.mjs.

import { safeNext } from "./next.mjs";
import { errorPageResponse } from "./error-page.mjs";
import { mayReach } from "./roles.mjs";

export { safeNext };

const PROTECTED = /^\/(admin|api\/admin)(\/|$)/;
const API = /^\/api\//;
// Pages and endpoints that must never be indexed or cached.
const PRIVATE = /^\/(admin|api\/admin|api\/auth|login|logout)(\/|$)/;

export const isProtectedPath = (path) => PROTECTED.test(path);
export const isPrivatePath = (path) => PRIVATE.test(path);

/**
 * Decide what happens to a protected request.
 * @param {URL} url
 * @param {Headers} headers
 * @param {(headers: Headers) => Promise<{ user: object|null, session: object|null, roles: string[], setCookies: string[] }>} [load]
 *   defaults to src/lib/admin/session.mjs loadAdminContext (tests pass a fake)
 * @returns {Promise<{ response: Response, setCookies: string[] } |
 *                   { response: null, user: object, session: object, roles: string[], setCookies: string[] }>}
 */
export async function guardRequest(url, headers, load) {
  if (!load) ({ loadAdminContext: load } = await import("./session.mjs"));
  const ctx = await load(headers);
  const isApi = API.test(url.pathname);

  if (!ctx.user) {
    const response = isApi
      ? Response.json({ error: "unauthorized" }, { status: 401 })
      : new Response(null, {
          status: 302,
          headers: { location: `/login/?next=${encodeURIComponent(safeNext(url.pathname + url.search))}` },
        });
    return { response, setCookies: ctx.setCookies };
  }
  if (ctx.roles.length === 0) {
    // Signed in but no role: show nothing of the app (ADR 0008 decision 4). Pages get
    // the static "Not allowed" page (src/lib/admin/error-page.mjs): no nav, nothing
    // about the URL, only "Sign out".
    const response = isApi
      ? Response.json({ error: "forbidden" }, { status: 403 })
      : errorPageResponse(403, { user: ctx.user, roles: [] });
    return { response, setCookies: ctx.setCookies };
  }
  if (!mayReach(ctx.roles, url.pathname)) {
    // The social role outside its allowlist (roles.mjs SOCIAL_PATHS): refused here,
    // before the route runs, whatever the route's own requireRole() would say.
    const response = isApi
      ? Response.json({ error: "forbidden" }, { status: 403 })
      : errorPageResponse(403, { user: ctx.user, roles: ctx.roles });
    return { response, setCookies: ctx.setCookies };
  }
  return { response: null, user: ctx.user, session: ctx.session, roles: ctx.roles, setCookies: ctx.setCookies };
}
