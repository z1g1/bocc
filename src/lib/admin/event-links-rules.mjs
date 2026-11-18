// Event listing rules (ADR 0009 decision 3, plan Phase 4): which URLs each platform
// accepts, the Luma embed id, and the readiness checklist. Pure functions, NO imports:
// the admin pages use them through src/lib/admin/event-links.mjs, and the one-time
// import (backend/scripts/import-event-links.js, CommonJS) loads this file with
// `await import()`, so both apply exactly the same rules.
//
// URLs (normaliseLinkUrl):
//   - https only. A bare host ("lu.ma/abc") gets https:// put in front, and http:// is
//     upgraded to https:// (all four platforms serve https). Any other scheme is refused.
//   - No user:password@, no port, no whitespace, at most 500 characters (the column's
//     CHECK). The host is lower-cased (by URL parsing); path and query are kept as given,
//     the #fragment is dropped.
//   - Hosts and paths, per platform (a host matches exactly, never as a suffix):
//       luma            luma.com, www.luma.com, lu.ma, www.lu.ma; a non-empty path
//       eventbrite      eventbrite.<tld> or www.eventbrite.<tld> for the TLDs in
//                       EVENTBRITE_TLDS (.com and its country sites); path /e/…
//       facebook_event  facebook.com, www./m./web.facebook.com with path /events/… or
//                       /share/… (share links); fb.me with a non-empty path
//       linkedin_event  linkedin.com, www.linkedin.com; path /events/…
//
// Luma embed id (normaliseLumaId): `evt-` then letters, digits, _ or -, at most 100
// characters in all (the column's CHECK). Blank = no id: allowed, but the readiness
// checklist then flags "no embed id". Only Luma stores an external_id.

/** Platforms in display order, with their labels. */
export const PLATFORMS = Object.freeze({
  luma: "Luma",
  eventbrite: "Eventbrite",
  facebook_event: "Facebook",
  linkedin_event: "LinkedIn",
});
export const PLATFORM_KEYS = Object.freeze(Object.keys(PLATFORMS));
export const URL_MAX = 500;

/** Eventbrite's .com and its country sites. */
export const EVENTBRITE_TLDS = Object.freeze([
  "com", "ca", "co.uk", "com.au", "co.nz", "ie", "de", "fr", "es", "it", "nl", "be", "at", "ch",
  "pt", "se", "dk", "fi", "com.mx", "com.br", "com.ar", "cl", "co", "com.pe", "sg", "hk",
]);

const withWww = (hosts) => hosts.flatMap((h) => [h, `www.${h}`]);
const nonEmptyPath = (p) => p.length > 1;
const RULES = {
  luma: {
    example: "https://luma.com/abc123",
    hosts: [{ hosts: withWww(["luma.com", "lu.ma"]), path: nonEmptyPath }],
  },
  eventbrite: {
    example: "https://www.eventbrite.com/e/123456789",
    hosts: [{ hosts: withWww(EVENTBRITE_TLDS.map((t) => `eventbrite.${t}`)), path: (p) => /^\/e\/[^/]/.test(p) }],
  },
  facebook_event: {
    example: "https://www.facebook.com/events/123456789",
    hosts: [
      { hosts: ["facebook.com", "www.facebook.com", "m.facebook.com", "web.facebook.com"], path: (p) => /^\/(events|share)\/[^/]/.test(p) },
      { hosts: ["fb.me"], path: nonEmptyPath },
    ],
  },
  linkedin_event: {
    example: "https://www.linkedin.com/events/123456789",
    hosts: [{ hosts: withWww(["linkedin.com"]), path: (p) => /^\/events\/[^/]/.test(p) }],
  },
};

/** The hosts a platform accepts (for help text and docs). */
export const acceptedHosts = (platform) => RULES[platform].hosts.flatMap((h) => h.hosts);

export const isPlatform = (p) => typeof p === "string" && Object.hasOwn(PLATFORMS, p);

/**
 * A pasted URL for `platform`, normalised; throws Error(message) if it isn't one.
 * @param {string} platform  one of PLATFORM_KEYS
 * @param {unknown} raw
 * @returns {string}
 */
export function normaliseLinkUrl(platform, raw) {
  if (!isPlatform(platform)) throw new Error("Unknown platform.");
  const rule = RULES[platform];
  const label = PLATFORMS[platform];
  let s = typeof raw === "string" ? raw.trim() : "";
  if (s === "") throw new Error(`Enter the ${label} URL.`);
  if (/\s/.test(s)) throw new Error("A URL can't contain spaces.");
  if (/^http:\/\//i.test(s)) s = `https://${s.slice(7)}`;
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s.replace(/^\/+/, "")}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`Not a URL. Paste the full link, like ${rule.example}`);
  }
  if (u.protocol !== "https:") throw new Error("Use an https:// link.");
  if (u.username || u.password || u.port) throw new Error("Paste the plain link (no login or port in it).");
  const host = u.hostname;
  const match = rule.hosts.find((h) => h.hosts.includes(host));
  if (!match) {
    throw new Error(`That isn't a link to ${label} (${host}). Accepted: ${acceptedHosts(platform).filter((h) => !h.startsWith("www.")).join(", ")}.`);
  }
  if (!match.path(u.pathname)) throw new Error(`That ${label} link doesn't point at an event, like ${rule.example}`);
  u.hash = "";
  const out = u.href;
  if (out.length > URL_MAX) throw new Error(`At most ${URL_MAX} characters.`);
  return out;
}

/**
 * The Luma embed id (`evt-…`), or null when blank; throws Error(message) if malformed.
 * @param {unknown} raw
 * @returns {string|null}
 */
export function normaliseLumaId(raw) {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (s === "") return null;
  if (!/^evt-[A-Za-z0-9_-]{1,96}$/.test(s)) throw new Error("The Luma event id looks like evt-AbC123… (from the event's embed code).");
  return s;
}

/**
 * The public page's rules (src/pages/events/[date].astro; keep in step): a date with an
 * events row has a page at /events/YYYY-MM-DD/ (a cancelled one shows a "cancelled"
 * notice instead of the RSVP); a date with no row is a 404. `exists: false` is how
 * getEvent() returns a date not saved yet.
 */
export const publicPageExists = (event) => event.exists !== false;
/** The full page with the Luma RSVP: saved and not cancelled. */
export const hasPublicPage = (event) => publicPageExists(event) && event.status !== "cancelled";
export const publicPath = (date) => `/events/${date}/`;

/**
 * Readiness checklist, calculated and never stored.
 * @param {{ date: string, status: string, exists?: boolean }} event
 * @param {Record<string, { url: string, externalId: string|null } | null | undefined>} links  by platform
 * @returns {{ listings: number, total: number, lumaId: boolean, publicPage: boolean, ready: boolean,
 *             items: Array<{ key: string, label: string, ok: boolean|null, note?: string, href?: string }> }}
 *   ok null = not checked yet (a later phase); href (the public page) only when it exists
 */
export function readiness(event, links = {}) {
  const items = PLATFORM_KEYS.map((p) => ({ key: p, label: `${PLATFORMS[p]} listing`, ok: Boolean(links[p]?.url) }));
  const listings = items.filter((i) => i.ok).length;
  const lumaId = Boolean(links.luma?.externalId);
  items.push({
    key: "luma_id", label: "Luma embed id", ok: lumaId,
    note: lumaId ? undefined : links.luma?.url ? "no embed id: the public page can't show the RSVP embed" : "add the Luma listing first",
  });
  const publicPage = hasPublicPage(event);
  items.push({
    key: "public_page", label: "public page", ok: publicPage,
    href: publicPageExists(event) ? publicPath(event.date) : undefined,
    note: !publicPageExists(event) ? "a 404 until the event is saved (any save creates it)"
      : event.status === "cancelled" ? "shows a cancelled notice, no RSVP" : undefined,
  });
  items.push({ key: "social", label: "social channels (Phase 5)", ok: null });
  return { listings, total: PLATFORM_KEYS.length, lumaId, publicPage, ready: listings === PLATFORM_KEYS.length && lumaId, items };
}
