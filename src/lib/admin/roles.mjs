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

// Every role but admin is also fenced in one level up: src/lib/admin/guard.mjs answers
// 403 for any /admin/* or /api/admin/* path outside the user's roles' allowlists
// (ROLE_PATHS) before the route runs (ADR 0008/0011: the account the Chrome tasks use
// must never reach personal data). A user holding several roles reaches the union of
// their allowlists; admin reaches everything and has no entry.
//
// To add a role's pages:
//   1. Name the role in ROLES (and in the public.user_roles CHECK, by a new migration).
//   2. Give it an allowlist in ROLE_PATHS: BASE_PATHS plus its own page and API
//      prefixes. A role with no entry reaches nothing.
//   3. Give it nav links in ROLE_LINKS (src/lib/admin/nav.mjs).
//   4. Each of its pages and API routes names the role in its requireRole().
// A new page for an existing role goes in that role's allowlist AND names the role in
// its requireRole().

// The email role (ADR 0014, the Luma sync Chrome task) has no ROLE_PATHS entry yet: until its
// pages land, mayReach() refuses it everywhere, like a role with an empty allowlist.

/** Every role public.user_roles accepts (its CHECK constraint). */
export const ROLES = Object.freeze(["admin", "social", "email"]);

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

/**
 * The paths every non-admin role may reach: the admin home, the user's own account
 * page and /api/admin/me. Each role's allowlist starts with these.
 */
export const BASE_PATHS = Object.freeze([
  /^\/admin\/?$/,
  /^\/admin\/account\/?$/,
  /^\/api\/admin\/me\/?$/,
]);

/**
 * The social role's allowlist: the base paths plus the social work order pages and
 * their JSON API. Everything else (events, attendees, check-ins, streaks, the email
 * list, users, media) is refused by the guard whatever the route itself says.
 */
export const SOCIAL_PATHS = Object.freeze([
  ...BASE_PATHS,
  /^\/admin\/social(\/|$)/,
  /^\/api\/admin\/social(\/|$)/,
]);

/**
 * Each non-admin role's path allowlist. See "To add a role's pages" above.
 * @type {Readonly<Record<string, ReadonlyArray<RegExp>>>}
 */
export const ROLE_PATHS = Object.freeze({
  social: SOCIAL_PATHS,
});

/**
 * May a user holding `roles` reach the protected `path` at all? admin: everything;
 * any other role: its ROLE_PATHS allowlist, and several roles the union of theirs;
 * no role (or a role with no allowlist, like email for now): nothing. The route's
 * requireRole() still runs.
 * @param {string[]} roles
 * @param {string} path  a URL pathname
 * @param {Readonly<Record<string, ReadonlyArray<RegExp>>>} [rolePaths]  tests pass their own
 */
export function mayReach(roles = [], path = "", rolePaths = ROLE_PATHS) {
  if (roles.includes("admin")) return true;
  return roles.some((role) =>
    Object.hasOwn(rolePaths, role) && rolePaths[role].some((r) => r.test(path)));
}
