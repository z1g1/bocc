// The admin app's stylesheet and its two error pages (403 "Not allowed", 404 "Out of
// Coffee"), shared by src/layouts/Admin.astro and by code that answers without Astro
// rendering a page: the middleware's guard (src/lib/admin/guard.mjs) and its error
// theming (src/middleware.ts). No database, no session lookups, and no imports but
// the import-free section nav (./nav.mjs): an error page must render even when
// everything else is failing.
//
// CSP (src/lib/admin/headers.mjs): no script at all; the CSS is an inline <style>,
// which style-src 'self' 'unsafe-inline' allows (the admin layout's own styles are
// inlined the same way). The pages say nothing about the URL that was asked for (so
// the section nav marks no current item).

import { sectionNavHtml } from "./nav.mjs";

/** The admin layout's global CSS (Admin.astro inlines it in <head>). */
export const ADMIN_CSS = `  :root { color-scheme: light dark; --fg: #161616; --bg: #fafaf7; --muted: #5c5c5c; --accent: #8a4b14; --line: #d9d6cf; --err: #b00020; --warn: #8a6100; }
  @media (prefers-color-scheme: dark) { :root { --fg: #eeeeea; --bg: #161616; --muted: #a8a8a3; --accent: #f0a35e; --line: #3a3a37; --err: #ff6b81; --warn: #e3b341; } }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--fg); background: var(--bg); }
  .bar { display: flex; flex-wrap: wrap; gap: 0.5rem 1.5rem; align-items: center; justify-content: space-between; padding: 0.75rem 1rem; border-bottom: 1px solid var(--line); }
  .brand { font-weight: 700; color: var(--fg); text-decoration: none; }
  nav { display: flex; gap: 1rem; align-items: center; }
  nav form { margin: 0; }
  nav.sections { display: block; border-bottom: 1px solid var(--line); }
  nav.sections ul { display: flex; flex-wrap: wrap; gap: 0.25rem 1.25rem; margin: 0; padding: 0.4rem 1rem; list-style: none; }
  nav.sections a { display: inline-block; padding: 0.3rem 0; text-decoration: none; }
  nav.sections a:hover { text-decoration: underline; }
  nav.sections a[aria-current="page"] { color: var(--fg); font-weight: 600; box-shadow: inset 0 -2px var(--accent); }
  main { max-width: 40rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; }
  footer { max-width: 40rem; margin: 0 auto; padding: 0 1rem 2rem; color: var(--muted); font-size: 0.875rem; }
  a { color: var(--accent); }
  h1 { font-size: 1.5rem; margin: 0 0 1rem; }
  label { display: block; margin: 0.75rem 0 0.25rem; font-weight: 600; }
  input { width: 100%; padding: 0.6rem; font: inherit; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: inherit; }
  button { margin-top: 1rem; padding: 0.6rem 1rem; font: inherit; font-weight: 600; border: 0; border-radius: 6px; background: var(--accent); color: var(--bg); cursor: pointer; }
  button.secondary { background: transparent; color: var(--accent); border: 1px solid var(--accent); }
  button.link { margin: 0; padding: 0; background: none; color: var(--accent); font-weight: 400; text-decoration: underline; }
  button:disabled { opacity: 0.6; cursor: wait; }
  .error { color: var(--err); min-height: 1.5em; }
  .muted { color: var(--muted); }
  ul.plain { list-style: none; padding: 0; }
  ul.plain li { padding: 0.5rem 0; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; gap: 1rem; align-items: center; }
  ul.plain li button { margin: 0; }
  /* Data views (checkins, streaks, email list, attendees) */
  main.wide { max-width: 72rem; }
  .scroll { overflow-x: auto; }
  table.data { width: 100%; border-collapse: collapse; font-size: 0.9375rem; }
  table.data th, table.data td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  table.data th { font-weight: 600; white-space: nowrap; }
  table.data .num { text-align: right; font-variant-numeric: tabular-nums; }
  table.data tr.debug { color: var(--muted); }
  .tag { margin-left: 0.4rem; padding: 0 0.35rem; border: 1px solid var(--line); border-radius: 4px; font-size: 0.75rem; color: var(--muted); }
  .filters { display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; align-items: end; margin-bottom: 1rem; }
  .filters label { margin: 0; }
  .filters input:not([type=checkbox]), .filters select { width: auto; min-width: 14rem; }
  .filters button { margin: 0; }
  label.check { font-weight: 400; display: flex; gap: 0.4rem; align-items: center; }
  label.check input { width: auto; }
  select { padding: 0.6rem; font: inherit; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: inherit; }
  form.inline { margin: 0; }
  button.small { margin: 0; padding: 0.2rem 0.6rem; font-size: 0.875rem; }
  form.narrow { max-width: 32rem; }
  .notice { padding: 0.5rem 0.75rem; border-left: 3px solid var(--accent); }
  dl.facts { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; }
  dl.facts dt { font-weight: 600; }
  dl.facts dd { margin: 0; }
`;

// Error-page extras (the cup icon and the centred message).
const ERROR_CSS = `
  .oops { text-align: center; padding-top: 2rem; }
  .oops svg { color: var(--accent); }
  .oops .code { font: 600 0.75rem/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); }
  .oops h1 { font-size: 1.75rem; margin: 0.5rem 0 0.75rem; }
  .oops .actions { display: flex; flex-wrap: wrap; gap: 0.75rem 1.5rem; justify-content: center; align-items: center; margin-top: 1.5rem; }
  .oops .actions form { margin: 0; }
  .oops .actions button { margin: 0; }
`;

// The site's "coffee" icon (src/components/Icon.astro). The 404 cup has no steam.
const CUP = '<path d="M17 8h1a4 4 0 1 1 0 8h-1"/><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z"/>';
const STEAM = '<line x1="6" y1="2" x2="6" y2="4"/><line x1="10" y1="2" x2="10" y2="4"/><line x1="14" y1="2" x2="14" y2="4"/>';
const icon = (paths) =>
  `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const SIGN_OUT = '<form method="post" action="/logout"><button type="submit" class="link">Sign out</button></form>';

const PAGES = {
  403: {
    title: "Not allowed",
    icon: icon(CUP + STEAM),
    heading: "Not allowed",
    body: (admin) => admin
      ? "This account doesn't have access to that page."
      : "This account doesn't have access to the BOCC admin. Ask an admin if you think it should.",
  },
  404: {
    title: "Out of coffee",
    icon: icon(CUP),
    heading: "This page is out of coffee",
    body: () => "We looked everywhere, but there's nothing brewing at this address.",
  },
};

/**
 * The HTML of an admin error page.
 * @param {403|404} status
 * @param {{ user?: { email?: string } | null, roles?: string[] }} [who]
 *   the signed-in user and their roles, if known. With at least one role the page links
 *   to /admin/ and shows the nav and the section links those roles allow (the same as
 *   every admin page's); without, only "Sign out".
 * @returns {string}
 */
export function errorPageHtml(status, { user = null, roles = [] } = {}) {
  const page = PAGES[status];
  if (!page) throw new Error(`errorPageHtml: no page for ${status}`);
  const admin = Boolean(user) && roles.length > 0;
  const brand = admin ? '<a class="brand" href="/admin/">BOCC admin</a>' : '<span class="brand">BOCC admin</span>';
  const nav = admin
    ? `<nav><a href="/admin/">Home</a><a href="/admin/account/">Account</a>${SIGN_OUT}</nav>`
    : user ? `<nav>${SIGN_OUT}</nav>` : "";
  const actions = [
    admin && '<a href="/admin/">Back to the admin home</a>',
    user && SIGN_OUT.replace('class="link"', 'class="secondary"'),
    !user && '<a href="/login/">Sign in</a>',
  ].filter(Boolean).join("");
  const footer = user?.email ? `<footer>Signed in as ${escapeHtml(user.email)}</footer>` : "";
  return `<!DOCTYPE html>
<html lang="en-US">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex, nofollow">
    <meta name="referrer" content="same-origin">
    <title>${page.title} · BOCC admin</title>
    <link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48">
    <style>${ADMIN_CSS}${ERROR_CSS}</style>
  </head>
  <body>
    <header class="bar">${brand}${nav}</header>
    ${admin ? sectionNavHtml(roles) : ""}
    <main>
      <section class="oops">
        ${page.icon}
        <p class="code">Error ${status}</p>
        <h1>${page.heading}</h1>
        <p>${page.body(admin)}</p>
        <div class="actions">${actions}</div>
      </section>
    </main>
    ${footer}
  </body>
</html>
`;
}

/**
 * An admin error page as a Response (the caller adds the private headers).
 * @param {403|404} status
 * @param {{ user?: { email?: string } | null, roles?: string[] }} [who]
 */
export function errorPageResponse(status, who) {
  return new Response(errorPageHtml(status, who), {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
