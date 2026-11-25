// The admin app's section links, in one place: the admin home lists them (with their
// notes), and every admin page shows them as the section nav under the top bar
// (src/layouts/Admin.astro), as does the themed 403/404 page for a user with a role
// (src/lib/admin/error-page.mjs). No imports, no database: the error page must render
// even when everything else is failing.
//
// Links are keyed by role in ROLE_LINKS. A user sees the union of their roles' links,
// with no duplicates; admin sees every role's links. Data views add their link to
// ADMIN_LINKS. The social role must never be shown a link to attendee, check-in,
// streak, email-list or audit data (ADR 0008); its work order pages (Phase 5) go in
// SOCIAL_LINKS, the email role's (the Luma sync) in EMAIL_LINKS.
//
// To add a role's pages: give the role its own frozen list here and an entry in
// ROLE_LINKS (the map's order is the nav's order), and an allowlist in
// src/lib/admin/roles.mjs ROLE_PATHS that covers every link. Showing a link is not
// access control: the guard (ROLE_PATHS) and every route's requireRole() are.

/** @typedef {{ href: string, label: string, note?: string }} NavLink */

/** @type {ReadonlyArray<NavLink>} Admin only. */
export const ADMIN_LINKS = Object.freeze([
  { href: "/admin/events/", label: "Events", note: "reports, cancellations, photos" },
  { href: "/admin/checkins/", label: "Check-ins", note: "the latest event by default" },
  { href: "/admin/streaks/", label: "Active streaks" },
  { href: "/admin/email-list/", label: "Email list", note: "CSV export and opt-out" },
  { href: "/admin/attendees/", label: "Attendees", note: "find and correct name, business, phone" },
  { href: "/admin/users/", label: "Users", note: "create logins, reset passwords, roles" },
]);

/** @type {ReadonlyArray<NavLink>} The social role's pages (admins see them too). */
export const SOCIAL_LINKS = Object.freeze([
  { href: "/admin/social/next/", label: "Social: schedule", note: "the next post's work order (Wednesday)" },
  { href: "/admin/social/verify/", label: "Social: verify", note: "confirm posts are live, first comments (Monday)" },
]);

/** @type {ReadonlyArray<NavLink>} The email role's pages (admins see them too). Only Luma sync. */
export const EMAIL_LINKS = Object.freeze([
  { href: "/admin/luma-sync/next/", label: "Luma sync", note: "add new Email-list people to Luma (Tuesday)" },
]);

/**
 * Each role's section links. Admin sees them all.
 * @type {Readonly<Record<string, ReadonlyArray<NavLink>>>}
 */
export const ROLE_LINKS = Object.freeze({
  admin: ADMIN_LINKS,
  social: SOCIAL_LINKS,
  email: EMAIL_LINKS,
});

/**
 * The section links a user's roles allow: the union of their roles' links in
 * ROLE_LINKS order, each href once; admin gets every role's links; no role nothing.
 * @param {string[]} roles
 * @param {Readonly<Record<string, ReadonlyArray<NavLink>>>} [links]  tests pass their own;
 *   roles they leave out keep their ROLE_LINKS entry
 * @returns {NavLink[]}
 */
export function navLinksFor(roles = [], links = {}) {
  const map = { ...ROLE_LINKS, ...links };
  const isAdmin = roles.includes("admin");
  const out = [];
  const seen = new Set();
  for (const [role, list] of Object.entries(map)) {
    if (!isAdmin && !roles.includes(role)) continue;
    for (const l of list) {
      if (seen.has(l.href)) continue;
      seen.add(l.href);
      out.push(l);
    }
  }
  return out;
}

/**
 * The link for the section `path` is in, by path prefix (the longest match wins), or
 * null. "/admin/events/2026-11-24/" is in "/admin/events/".
 * @param {string | null | undefined} path
 * @param {NavLink[]} links
 * @returns {string | null} its href
 */
export function currentHref(path, links) {
  if (!path) return null;
  const p = path.endsWith("/") ? path : `${path}/`;
  let best = null;
  for (const l of links) {
    if (p.startsWith(l.href) && (!best || l.href.length > best.length)) best = l.href;
  }
  return best;
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/**
 * The section nav's HTML, or "" when the roles allow no links. Static markup, no
 * script: it wraps on a narrow screen (ADMIN_CSS `.sections`).
 * @param {string[]} roles
 * @param {string | null} [path]  the current path, to mark its section aria-current="page"
 * @param {Parameters<typeof navLinksFor>[1]} [links]
 * @returns {string}
 */
export function sectionNavHtml(roles, path = null, links) {
  const list = navLinksFor(roles, links);
  if (list.length === 0) return "";
  const current = currentHref(path, list);
  const items = list.map((l) =>
    `<li><a href="${escapeHtml(l.href)}"${l.href === current ? ' aria-current="page"' : ""}>${escapeHtml(l.label)}</a></li>`);
  return `<nav class="sections" aria-label="Admin sections"><ul>${items.join("")}</ul></nav>`;
}
