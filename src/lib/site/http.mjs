// Response headers for the public pages rendered on request (ADR 0009 decision 4):
// the /events/YYYY-MM-DD/ pages, /events/ and the sitemap.
//
// Netlify's CDN caches them; an admin save purges them by tag (src/lib/site/purge.mjs).
//   Netlify-CDN-Cache-Control  public, durable, max-age=<to the next Eastern midnight,
//                              at most a day>, stale-while-revalidate=3600
//     - the purge is the normal way a page changes; the max-age is the backstop
//     - expiring at midnight Eastern lets a page roll from upcoming to past (and the
//       "next event" link move on) without a save; a day bounds a missed purge
//     - stale-while-revalidate: a visitor in the first hour after expiry gets the old
//       copy at once while the CDN re-renders it, so a scaled-to-zero Neon wakes in the
//       background. After that hour the page renders while the visitor waits
//     - durable: one shared copy for every edge node, so most visits never reach the
//       function or Neon
//   Cache-Control  public, max-age=0, must-revalidate
//     - the browser asks the CDN each time (a cheap CDN hit), so a purge is seen on
//       the next load
//   Netlify-Cache-Tag  event-YYYY-MM-DD, or event-list for lists of dates
//
// Unknown but well-formed date: 404, CDN max-age 300 (no stale-while-revalidate) with
//   the date's tag. The admin's first save of that date purges the tag, so a new event
//   appears at once; the five minutes only bound how long a stray 404 lives.
// Malformed date: 404, no-store everywhere. It never reaches the database.
// Database down or SITE_DB_URL unset: 503, no-store everywhere, Retry-After: 60.
//
// netlify.toml's [[headers]] apply to static files only, not function responses, so
// the site-wide security headers are repeated here.

const TZ = "America/New_York";
export const SWR_SECONDS = 3600;
export const UNKNOWN_DATE_MAX_AGE = 300;
export const LIST_TAG = "event-list";
export const eventTag = (date) => `event-${date}`;

const SECURITY = { "X-Frame-Options": "SAMEORIGIN", "X-Content-Type-Options": "nosniff" };

/** Seconds from `now` to the next midnight in Buffalo, between 60 and 86400. */
export function secondsToEasternMidnight(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hourCycle: "h23", hour: "numeric", minute: "numeric", second: "numeric",
  }).formatToParts(now);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const elapsed = get("hour") * 3600 + get("minute") * 60 + get("second");
  // DST days are 23 or 25 hours long; an hour either way only shifts the backstop.
  return Math.min(86400, Math.max(60, 86400 - elapsed));
}

/**
 * @param {Headers} headers
 * @param {"cached"|"unknown-date"|"no-store"} mode
 * @param {{ tag?: string, now?: Date }} [opts]
 */
export function setPublicHeaders(headers, mode, { tag, now } = {}) {
  for (const [k, v] of Object.entries(SECURITY)) headers.set(k, v);
  if (mode === "no-store") {
    headers.set("Cache-Control", "no-store");
    headers.set("Netlify-CDN-Cache-Control", "no-store");
    headers.delete("Netlify-Cache-Tag");
    return headers;
  }
  headers.set("Cache-Control", "public, max-age=0, must-revalidate");
  headers.set("Netlify-CDN-Cache-Control", mode === "unknown-date"
    ? `public, durable, max-age=${UNKNOWN_DATE_MAX_AGE}`
    : `public, durable, max-age=${secondsToEasternMidnight(now)}, stale-while-revalidate=${SWR_SECONDS}`);
  if (tag) headers.set("Netlify-Cache-Tag", tag);
  return headers;
}

const redact = (text) =>
  String(text)
    .replace(/postgres(ql)?:\/\/\S+/gi, "<redacted-url>")
    .replace(/Bearer\s+\S+/gi, "Bearer <redacted>");

/** Log a public-site failure without secrets: error name, message and code only. */
export function logSiteFailure(where, err) {
  const e = /** @type {any} */ (err);
  const detail = e && typeof e === "object" ? `${e.name ?? "Error"}: ${e.message ?? ""}${e.code ? ` (${e.code})` : ""}` : String(err);
  console.error(`[site] ${where} failed: ${redact(detail)}`);
}
