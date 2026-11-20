// Event listing rules (ADR 0009 decision 3, plan Phase 4): which URLs each platform
// accepts, the Luma embed id, and the Readiness section. Pure functions, NO imports:
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
// characters in all (the column's CHECK). Blank = no id: allowed (the public page then
// can't show the RSVP embed; not a readiness item since #42). Only Luma stores an external_id.

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

/** The Online Event Listings readiness counts: the four listings and the public page. */
export const LISTINGS_TOTAL = PLATFORM_KEYS.length + 1;
/**
 * The listings count for the lists' tag and the Readiness section: `platformsListed`
 * (how many of the four platforms have a listing) plus the public page when it has the RSVP.
 * @param {{ status: string, exists?: boolean }} event
 * @param {number} platformsListed
 */
export const listingsDone = (event, platformsListed) => platformsListed + (hasPublicPage(event) ? 1 : 0);

// Channel statuses that count as done. The source is social-rules.mjs
// POSTED_CHANNEL_STATUSES; this module takes no imports (see the header), so keep in step.
const CHANNEL_DONE = ["scheduled", "live"];

/**
 * The Readiness section (#42), calculated and never stored: two bullets.
 *
 *   Online Event Listings x/5 (Default Cover Image | Custom Cover Image)
 *     x counts the Luma, Eventbrite, Facebook and LinkedIn listings and the public page.
 *     The brackets follow the Event Image's source: "default" (the BOCC logo) or custom
 *     (uploaded, or a Photo from Event); no brackets when the caller passes no image.
 *     Under it: the parts still missing, then the LinkedIn lines (event posted, out of
 *     date, cancel due), each pointing at the LinkedIn section on the Event Info tab
 *     (the posted line links the LinkedIn event itself).
 *   Social Posts: <status>
 *     The Social Post status label (To do, Ready for Posting, Posted, Error), or "not set
 *     up yet". Under it: the problems that keep it from the Chrome tasks (not once
 *     Posted), then one line per channel. Ticked only when Posted, or Ready for Posting
 *     with no problems; Error and To do never are.
 *
 * @param {{ date: string, status: string, exists?: boolean }} event
 * @param {Record<string, { url: string, externalId: string|null } | null | undefined>} links  by platform
 * @param {null | { exists: boolean, status: string, statusLabel: string,
 *          problems: Array<{ message: string }>, channels: Array<{ channel: string, label: string, status: string|null }> }} [social]
 *   the social work order (src/lib/admin/social.mjs getWorkOrder); null/omitted = none yet
 * @param {{ eventImage?: { source: "uploaded"|"referenced"|"default" },
 *   linkedIn?: { eventUrl?: string|null, drift: null | { message: string, href: string },
 *     cancel: null | { due: boolean, message: string, href: string } } }} [extra]
 *   eventImage: the resolved Event Image (src/lib/admin/event-image-rules.mjs);
 *   linkedIn: src/lib/linkedin/rules.mjs linkedInFollowUp (#25/#27). "LinkedIn event posted"
 *   is not listed for a cancelled event (the cancel line covers it).
 * @typedef {{ key: string, label: string, ok: boolean, caution?: true, note?: string, href?: string }} Item
 *   href: a link (the public page only when it exists; the LinkedIn lines)
 *   caution: done, with a caveat in the note (shown ⚠, not ✓): the LinkedIn event was made
 *   outside the app (a LinkedIn listing URL but no posted ledger row)
 * @returns {{ ready: boolean,
 *   listings: { done: number, total: number, cover: string|null, label: string, ok: boolean, publicHref?: string, parts: Item[], items: Item[] },
 *   social: { exists: boolean, status: string|null, label: string, ok: boolean, scheduled: number, total: number, items: Item[] } }}
 *   parts: the five counted; items: what the page lists under the bullet.
 */
export function readiness(event, links = {}, social = null, { eventImage, linkedIn } = {}) {
  const parts = PLATFORM_KEYS.map((p) => ({ key: p, label: `${PLATFORMS[p]} listing`, ok: Boolean(links[p]?.url) }));
  parts.push({
    key: "public_page", label: "public page", ok: hasPublicPage(event),
    href: publicPageExists(event) ? publicPath(event.date) : undefined,
    note: !publicPageExists(event) ? "a 404 until the event is saved (any save creates it)"
      : event.status === "cancelled" ? "shows a cancelled notice, no RSVP" : undefined,
  });
  const done = parts.filter((i) => i.ok).length;
  const cover = !eventImage ? null : eventImage.source === "default" ? "Default Cover Image" : "Custom Cover Image";
  const items = parts.filter((i) => !i.ok);
  if (linkedIn && event.status !== "cancelled") {
    const listed = links.linkedin_event?.url;
    items.push(linkedIn.eventUrl
      ? { key: "linkedin_posted", label: "LinkedIn event posted", ok: true, href: linkedIn.eventUrl }
      // Made outside the app (by hand, or the bocc-linkedin-event skill) and pasted into the
      // listings: posted, but the app has no ledger row, so no drift or cancel follow-up.
      : listed
        ? { key: "linkedin_posted", label: "LinkedIn event posted", ok: true, caution: true, href: listed,
            note: "created manually outside the app, so location, Event Image and cancel changes aren't tracked" }
        : { key: "linkedin_posted", label: "LinkedIn event posted", ok: false, note: "not posted yet (LinkedIn event, Event Info tab)" });
  }
  if (linkedIn?.drift) items.push({ key: "linkedin_drift", label: linkedIn.drift.message, ok: false, href: linkedIn.drift.href });
  if (linkedIn?.cancel?.due) items.push({ key: "linkedin_cancel", label: linkedIn.cancel.message, ok: false, href: linkedIn.cancel.href });

  const exists = Boolean(social?.exists);
  const channels = exists ? social.channels ?? [] : [];
  const status = exists ? social.status : null;
  const socialItems = [];
  if (exists && status !== "posted") {
    for (const [n, p] of (social.problems ?? []).entries()) socialItems.push({ key: `social_problem_${n}`, label: p.message, ok: false });
  }
  for (const c of channels) {
    const cs = c.status ?? "pending";
    socialItems.push({ key: `social_${c.channel}`, label: `${c.label}: ${cs}`, ok: CHANNEL_DONE.includes(cs) });
  }
  return {
    ready: done === LISTINGS_TOTAL,
    listings: {
      done, total: LISTINGS_TOTAL, cover,
      label: `Online Event Listings ${done}/${LISTINGS_TOTAL}${cover ? ` (${cover})` : ""}`,
      ok: done === LISTINGS_TOTAL && !items.some((i) => !i.ok),
      // The public page, linked from the bullet once it exists (even when it is done).
      publicHref: parts.at(-1).href,
      parts, items,
    },
    social: {
      exists, status,
      label: `Social Posts: ${exists ? social.statusLabel : "not set up yet"}`,
      // A tick only for Posted, or Ready for Posting with no problems (never Error or To do).
      ok: status === "posted" || (status === "ready" && social.problems.length === 0),
      scheduled: channels.filter((c) => CHANNEL_DONE.includes(c.status)).length,
      total: channels.length,
      items: socialItems,
    },
  };
}
