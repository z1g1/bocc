// Which image an event uses (ADR 0012 decision 3). Pure, no imports: the database side
// is src/lib/admin/event-image.mjs.
//
// Resolution order:
//   1. uploaded    the event's own `event_image` row (at most one ready per event)
//   2. referenced  a publicly usable `event_photo` (Photo from Event) the event points at (ticket #21 adds
//                  the reference; until then the caller passes none)
//   3. default     the square BOCC logo, with a checked-in 16:9 version: the logo at
//                  full height on the "Just the Beans" background (ticket #40)
//
// The resolved image has the same shape whatever its source, so consumers (the Event
// Image section, the Social Post cover, the LinkedIn image upload) don't branch on it:
//   { source, mediaId, eventDate, original, display, thumb, cover, coverOutdated }
// where each file is either { key, contentType } (an object in the private bucket:
// sign it with storage.presignGet, or read it with storage.getObject) or
// { path, contentType, width, height } (a checked-in file under public/, same origin).
//
// `original` is the square/original image (for Luma), `cover` the 16:9 copy (for the
// listings entered by hand, and LinkedIn). A referenced photo picked before it had a
// cover copy has `cover: null`: whoever picks it must make one (it is never silently
// swapped for the logo's). `coverOutdated`: the cover was made under the old
// centre-crop rule and is being remade in the browser (migration 20261202120000); it
// is still shown, but not sent to LinkedIn.

/** @typedef {{ key: string, contentType: string }} StoredFile */
/** @typedef {{ path: string, contentType: string, width: number, height: number }} AssetFile */
/**
 * @typedef {{ source: "uploaded"|"referenced"|"default", mediaId: string|null, eventDate: string|null,
 *   original: StoredFile|AssetFile, display: StoredFile|AssetFile, thumb: StoredFile|AssetFile,
 *   cover: StoredFile|AssetFile|null, coverOutdated: boolean }} EventImage
 */

const SQUARE_LOGO = Object.freeze({
  path: "/assets/images/brand/bocc-logo-square.png", contentType: "image/png", width: 2000, height: 2000,
});
const WIDE_LOGO = Object.freeze({
  path: "/assets/images/brand/bocc-logo-wide-16x9.png", contentType: "image/png", width: 1920, height: 1080,
});

/** @type {Readonly<EventImage>} */
export const DEFAULT_EVENT_IMAGE = Object.freeze({
  source: "default", mediaId: null, eventDate: null,
  original: SQUARE_LOGO, display: SQUARE_LOGO, thumb: SQUARE_LOGO, cover: WIDE_LOGO, coverOutdated: false,
});

const COPY = "image/jpeg";

/**
 * @param {{ id: string, eventDate: string, status: string, originalKey: string, displayKey: string,
 *   thumbKey: string, coverKey?: string|null, coverOutdated?: boolean, contentType: string }} row  an event_media row (camelCase)
 * @param {"uploaded"|"referenced"} source
 * @returns {EventImage}
 */
function fromRow(row, source) {
  return {
    source,
    mediaId: row.id,
    eventDate: row.eventDate,
    original: { key: row.originalKey, contentType: row.contentType },
    display: { key: row.displayKey, contentType: COPY },
    thumb: { key: row.thumbKey, contentType: COPY },
    cover: row.coverKey ? { key: row.coverKey, contentType: COPY } : null,
    coverOutdated: Boolean(row.coverKey && row.coverOutdated),
  };
}

/**
 * Why a Photo from Event can't be deleted: it is the Event Image of these events.
 * @param {string[]} eventDates  YYYY-MM-DD, at least one
 */
export function inUseMessage(eventDates) {
  const list = eventDates.length === 1 ? eventDates[0]
    : `${eventDates.slice(0, -1).join(", ")} and ${eventDates.at(-1)}`;
  const those = eventDates.length === 1 ? "that event" : "those events";
  return `This photo is the Event Image for ${list}, so it wasn't deleted. Pick another image for ${those} first.`;
}

const isReady = (row) => Boolean(row) && row.status === "ready";

/**
 * @param {{ uploaded?: object|null, referenced?: object|null }} [rows]  event_media rows, or null
 * @returns {EventImage}
 */
export function resolveEventImage({ uploaded = null, referenced = null } = {}) {
  if (isReady(uploaded)) return fromRow(/** @type {any} */ (uploaded), "uploaded");
  if (isReady(referenced)) return fromRow(/** @type {any} */ (referenced), "referenced");
  return DEFAULT_EVENT_IMAGE;
}
