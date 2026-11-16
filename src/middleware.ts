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
//   - no role:     403 and nothing rendered
//   - otherwise:   Astro.locals.user / .session / .roles are set. Each route then
//                  calls requireRole(locals, …) from src/lib/admin/roles.mjs.
// Private paths (the above plus /api/auth/*, /login/, /logout) get noindex,
// no-store and the admin CSP (src/lib/admin/headers.mjs).
import { defineMiddleware } from "astro:middleware";
import { guardRequest, isPrivatePath, isProtectedPath } from "./lib/admin/guard.mjs";
import { withPrivateHeaders } from "./lib/admin/headers.mjs";

export const onRequest = defineMiddleware(async (ctx, next) => {
  const path = ctx.url.pathname;
  if (ctx.isPrerendered || !isPrivatePath(path)) return next();

  const dev = import.meta.env.DEV;
  let setCookies: string[] = [];

  if (isProtectedPath(path)) {
    const result = await guardRequest(ctx.url, ctx.request.headers);
    setCookies = result.setCookies;
    if (result.response) return withPrivateHeaders(result.response, { setCookies, dev });
    ctx.locals.user = result.user;
    ctx.locals.session = result.session;
    ctx.locals.roles = result.roles;
  }

  const response = await next();
  return withPrivateHeaders(response, { setCookies, dev });
});
