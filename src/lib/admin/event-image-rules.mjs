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
// Image section, the Social plan cover, the LinkedIn image upload) don't branch on it:
//   { source, mediaId, eventDate, original, display, thumb, image16x9, image16x9Outdated }
// where each file is either { key, contentType } (an object in the private bucket:
// sign it with storage.presignGet, or read it with storage.getObject) or
// { path, contentType, width, height } (a checked-in file under public/, same origin).
//
// `original` is the square/original image (for Luma), `image16x9` the 16:9 Event Image
// (for the listings entered by hand, and LinkedIn). A referenced photo picked before it
// had one has `image16x9: null`: whoever picks it must make one (it is never silently
// swapped for the logo's). `image16x9Outdated`: the 16:9 Event Image was made under the
// old centre-crop rule and is being remade in the browser (migration 20261202120000);
// it is still shown, but not sent to LinkedIn. In object storage the 16:9 Event Image
// keeps its key …/cover.jpg (keys are opaque, never renamed).

/** @typedef {{ key: string, contentType: string }} StoredFile */
/** @typedef {{ path: string, contentType: string, width: number, height: number }} AssetFile */
/**
 * @typedef {{ source: "uploaded"|"referenced"|"default", mediaId: string|null, eventDate: string|null,
 *   original: StoredFile|AssetFile, display: StoredFile|AssetFile, thumb: StoredFile|AssetFile,
 *   image16x9: StoredFile|AssetFile|null, image16x9Outdated: boolean }} EventImage
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
  original: SQUARE_LOGO, display: SQUARE_LOGO, thumb: SQUARE_LOGO, image16x9: WIDE_LOGO, image16x9Outdated: false,
});

const COPY = "image/jpeg";

/**
 * @param {{ id: string, eventDate: string, status: string, originalKey: string, displayKey: string,
 *   thumbKey: string, image16x9Key?: string|null, image16x9Outdated?: boolean, contentType: string }} row  an event_media row (camelCase)
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
    image16x9: row.image16x9Key ? { key: row.image16x9Key, contentType: COPY } : null,
    image16x9Outdated: Boolean(row.image16x9Key && row.image16x9Outdated),
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
