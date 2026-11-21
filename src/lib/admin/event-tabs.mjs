// The tabs of /admin/events/YYYY-MM-DD/ (ADR 0012 decision 1). Pure, no database.
//
// The page is chosen by ?tab=info|social|post and rendered on the server, so the tabs
// work without JavaScript. With no tab, or an unknown one, the date decides: a future
// event opens Event Info (setup work), today or a past event opens Post Event (data
// collection). "Today" is the Eastern calendar day.

/** The tabs in page order: key -> label. */
export const TABS = Object.freeze({ info: "Event Info", social: "Social plan", post: "Post Event" });

const ymdEastern = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
});

/**
 * @param {string|null|undefined} requested  the ?tab value
 * @param {string} date  the event date, YYYY-MM-DD
 * @param {Date} [now]
 * @returns {"info"|"social"|"post"}
 */
export function pickTab(requested, date, now = new Date()) {
  if (typeof requested === "string" && Object.hasOwn(TABS, requested)) return /** @type {any} */ (requested);
  return date > ymdEastern.format(now) ? "info" : "post";
}

/** The tab each of the page's form actions lives on: its post/redirect/get returns there. */
export const ACTION_TABS = Object.freeze({
  save: "info", link: "info", unlink: "info",
  social_plan: "social", social_video: "social", social_thumbnail: "social", social_media_post: "social",
  linkedin_create: "info", linkedin_publish: "info", linkedin_allow_retry: "info",
  linkedin_cancel_done: "info",
  report: "post",
});

/** The tab each media route's redirect anchor lives on (src/lib/admin/media-http.mjs). */
export const ANCHOR_TABS = Object.freeze({ "event-media": "post", social: "social", "event-image": "info" });

/** The LinkedIn section's tab: the OAuth return and the LinkedIn actions land there. */
export const LINKEDIN_TAB = ACTION_TABS.linkedin_create;
