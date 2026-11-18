// Server-side gate for the admin app (ADR 0008).
//
// Every other path (the whole public site, prerendered at build time, and the
// check-in page) returns `next()` straight away: no auth module, no database.
//
// /admin/* and /api/admin/*:
//   - loads the Better Auth session from the shared instance (src/lib/auth/auth.mjs,
//     imported lazily through guard.mjs -> session.mjs, so the static build needs no
//     secrets) and the user's roles from public.user_roles
//   - no session:  pages redirect to /login/?next=…, APIs get 401
//   - no role:     403; pages get the static "Not allowed" page, nothing of the app
//   - social only: 403 outside its allowlist (src/lib/admin/roles.mjs SOCIAL_PATHS)
//   - otherwise:   Astro.locals.user / .session / .roles are set. Each route then
//                  calls requireRole(locals, …) from src/lib/admin/roles.mjs.
// A page route (not /api/) that answers a GET with a plain-text 403 or 404 (from
// requireRole, or a route's own "not found") gets the themed "Not allowed" or "Out of
// Coffee" page instead, same status (src/lib/admin/error-page.mjs: static, no script,
// no database). APIs keep their plain JSON/text bodies.
// Private paths (the above plus /api/auth/*, /login/, /logout) get noindex,
// no-store and the admin CSP (src/lib/admin/headers.mjs).
//
// Telemetry (src/lib/telemetry.mjs, docs/backend/OBSERVABILITY.md): every on-demand
// request (not prerendered pages) runs in one span named "<METHOD> <route pattern>",
// e.g. "GET /events/[date]". The Netlify runtime makes no server span of its own (it
// only continues the incoming trace context), so this is the function's top span and
// the db/purge/storage spans nest under it. Attributes: method, route, status, and the
// role names when signed in (never the user id or email). 5xx marks it ERROR. One
// "request" log line per request carries the same fields plus duration_ms and the db
// counters (the metrics, since Netlify takes no OTLP metrics). With tracing off it is
// the same code path minus the span.
import { defineMiddleware } from "astro:middleware";
import type { APIContext, MiddlewareNext } from "astro";
import { guardRequest, isPrivatePath, isProtectedPath } from "./lib/admin/guard.mjs";
import { withPrivateHeaders } from "./lib/admin/headers.mjs";
import { storageOrigin } from "./lib/admin/storage.mjs";
import { adminFailure } from "./lib/admin/log.mjs";
import { errorPageResponse } from "./lib/admin/error-page.mjs";
import { log, metrics, span } from "./lib/telemetry.mjs";

const THEMED = new Set([403, 404]);

/** Swap a page route's plain-text 403/404 for the themed admin page. */
function themeErrors(ctx: { url: URL; request: Request; locals: App.Locals }, response: Response): Response {
  if (!THEMED.has(response.status)) return response;
  if (/^\/api\//.test(ctx.url.pathname)) return response;
  if (ctx.request.method !== "GET" && ctx.request.method !== "HEAD") return response;
  if (/^text\/html/i.test(response.headers.get("content-type") ?? "")) return response;
  const { user = null, roles = [] } = ctx.locals as { user?: { email?: string } | null; roles?: string[] };
  return errorPageResponse(response.status as 403 | 404, { user, roles });
}

export const onRequest = defineMiddleware((ctx, next) => {
  if (ctx.isPrerendered) return next();
  const method = ctx.request.method;
  const route = ctx.routePattern || "unknown";
  const started = performance.now();
  return span(`${method} ${route}`, { "http.request.method": method, "http.route": route }, async (h) => {
    let status = 500;
    try {
      const response = await gate(ctx, next);
      status = response.status;
      return response;
    } finally {
      const roles = ((ctx.locals as { roles?: string[] }).roles ?? []).join(",");
      const attrs = { "http.response.status_code": status, ...(roles ? { "enduser.role": roles } : {}) };
      h.setAttributes(attrs);
      if (status >= 500) h.setError(`HTTP ${status}`);
      log(status >= 500 ? "error" : "info", "request", {
        method, route, status, ...(roles ? { role: roles } : {}),
        duration_ms: Math.round(performance.now() - started), ...metrics(),
      });
    }
  });
});

/** The admin gate (see the top of this file). */
async function gate(ctx: APIContext, next: MiddlewareNext): Promise<Response> {
  const path = ctx.url.pathname;
  if (!isPrivatePath(path)) return next();

  const dev = import.meta.env.DEV;
  const mediaOrigin = storageOrigin(); // null when media storage isn't configured
  let setCookies: string[] = [];

  if (isProtectedPath(path)) {
    let result;
    try {
      result = await guardRequest(ctx.url, ctx.request.headers);
    } catch (err) {
      return withPrivateHeaders(adminFailure("middleware", err), { setCookies, dev, mediaOrigin });
    }
    setCookies = result.setCookies;
    if (result.response) return withPrivateHeaders(result.response, { setCookies, dev, mediaOrigin });
    ctx.locals.user = result.user;
    ctx.locals.session = result.session;
    ctx.locals.roles = result.roles;
  }

  const response = isProtectedPath(path) ? themeErrors(ctx, await next()) : await next();
  return withPrivateHeaders(response, { setCookies, dev, mediaOrigin });
}
