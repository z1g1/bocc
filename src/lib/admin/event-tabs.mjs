// The tabs of /admin/events/YYYY-MM-DD/ (ADR 0012 decision 1). Pure, no database.
//
// The page is chosen by ?tab=info|social|post and rendered on the server, so the tabs
// work without JavaScript. With no tab, or an unknown one, the date decides: a future
// event opens Event Info (setup work), today or a past event opens Post Event (data
// collection). "Today" is the Eastern calendar day.

/** The tabs in page order: key -> label. */
export const TABS = Object.freeze({ info: "Event Info", social: "Social Posts", post: "Post Event" });

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
