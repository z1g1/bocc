// Role checks for admin routes (ADR 0008 decision 4). No database code: the
// middleware (src/middleware.ts) has already loaded `locals.user` and `locals.roles`
// from public.user_roles for every /admin/* and /api/admin/* request, and refused
// anyone without a session or without any role.
//
// EVERY admin page and API route still calls requireRole() itself, naming the roles
// it admits. There is no hierarchy: list "admin" explicitly wherever admins belong.
//
//   ---                                     // a page
//   import { requireRole } from "../../lib/admin/roles.mjs";
//   export const prerender = false;
//   const denied = requireRole(Astro.locals, "admin");
//   if (denied) return denied;
//   ---
//
//   export const GET: APIRoute = async ({ locals }) => {   // an API route
//     const denied = requireRole(locals, "admin", "social");
//     if (denied) return denied;
//     …
//   };

/** Every role public.user_roles accepts (its CHECK constraint). */
export const ROLES = Object.freeze(["admin", "social"]);

/**
 * @param {{ roles?: string[] }} locals
 * @param {...string} roles
 * @returns {boolean} true if the user holds at least one of `roles`
 */
export function hasRole(locals, ...roles) {
  const held = locals?.roles ?? [];
  return roles.some((r) => held.includes(r));
}

/**
 * @param {{ user?: object|null, roles?: string[] }} locals
 * @param {...string} roles  admitted roles (at least one)
 * @returns {Response|null} null when allowed; otherwise a 401/403 to return as is
 */
export function requireRole(locals, ...roles) {
  if (roles.length === 0) throw new Error("requireRole needs at least one role");
  for (const r of roles) {
    if (!ROLES.includes(r)) throw new Error(`requireRole: unknown role "${r}"`);
  }
  if (!locals?.user) return plain(401, "Unauthorized");
  if (!hasRole(locals, ...roles)) return plain(403, "Forbidden");
  return null;
}

const plain = (status, text) =>
  new Response(text, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
