// The Event Image, database side (ADR 0012 decision 3). Admin only; the CALLER checks
// requireRole(locals, "admin") and checkOrigin, and that storage is configured.
// Parameterized SQL only. The rules (resolution order, the logo default) are in
// event-image-rules.mjs.
//
//   getEventImage(db, date)                 -> the resolved EventImage (never null)
//   clearEventImage(actor, storage, date)   -> { changed, eventDate, mediaId, leftovers }
//       deletes the event's ready event_image row (audited `event_image.clear`, with
//       its keys) FIRST, then its four objects (as deleteMedia). The event then uses
//       the BOCC logo. Nothing to clear: { changed: false }, no audit row. A picked
//       photo is only un-referenced (details.referenced: true): the photo stays.
//   load16x9Bytes(image, { storage, readAsset })  -> { contentType, bytes }
//       the 16:9 Event Image's bytes on the server, for the LinkedIn image upload;
//       refused while it is outdated (being remade, ticket #40)
//   listPickablePhotos(db, date)            -> the picker (ticket #21): ready, publicly
//       usable Photos from Event of the PICK_EVENTS most recent events with photos, on
//       or before `date`, newest event first
//   pickEventImage(actor, storage, date, mediaId) -> { changed, eventDate, mediaId,
//       needs16x9, replaced, leftovers }
//       points the event at one of those photos (events.event_image_media_id: a
//       reference, not a copy), audited `event_image.pick`. An uploaded Event Image is
//       deleted in the same transaction (its objects after the commit), so the pick
//       shows. needs16x9: the photo has no 16:9 Event Image yet, or one made under the
//       old centre-crop rule (image_16x9_outdated, ticket #40); the browser makes a new one
//       (src/lib/admin/media.mjs startImage16x9 / completeImage16x9).
//
// Setting and changing are the ordinary media upload with kind `event_image`
// (src/lib/admin/media.mjs startUpload / completeUpload): the browser makes the
// display and thumbnail copies and the 16:9 Event Image; completeUpload replaces the current image
// in one transaction and audits `event_image.set` ({ eventDate, mediaId, replaced }).
//
// A picked photo (ticket #21) is the `referenced` row; resolveEventImage ranks it after
// an upload. Only one of the two is ever set: a pick deletes the upload, and an upload
// (completeUpload) or a clear drops the reference.

import { withAudit } from "./db.mjs";
import { ValidationError, isUuid } from "./attendees.mjs";
import { isIsoDate } from "./storage.mjs";
import { deleteObjects, rowKeys } from "./media.mjs";
import { DEFAULT_EVENT_IMAGE, resolveEventImage } from "./event-image-rules.mjs";
import { readPublicAsset } from "./public-asset.mjs";

export { DEFAULT_EVENT_IMAGE, resolveEventImage };

const COLUMNS = `
  id, event_date::text as "eventDate", kind, status, original_key as "originalKey",
  display_key as "displayKey", thumb_key as "thumbKey", image_16x9_key as "image16x9Key", image_16x9_outdated as "image16x9Outdated",
  content_type as "contentType"`;

const checkDate = (date) => { if (!isIsoDate(date)) throw new ValidationError(["date must be YYYY-MM-DD"]); };

/**
 * @param {{ query: Function }} db
 * @param {string} date  YYYY-MM-DD
 * @returns {Promise<import("./event-image-rules.mjs").EventImage>}
 */
export async function getEventImage(db, date) {
  checkDate(date);
  const [uploaded, referenced] = await Promise.all([
    db.query(
      `select ${COLUMNS} from public.event_media
        where event_date = $1 and kind = 'event_image' and status = 'ready'`, [date]),
    db.query(
      `select ${COLUMNS} from public.event_media
        where id = (select event_image_media_id from public.events where event_date = $1)`, [date]),
  ]);
  return resolveEventImage({ uploaded: uploaded.rows[0] ?? null, referenced: referenced.rows[0] ?? null });
}

/** "About the last 8 events": how many recent events with photos the picker offers. */
export const PICK_EVENTS = 8;

// The pickable photos for $1: ready, publicly usable Photos from Event of the PICK_EVENTS
// most recent event dates (with such photos) on or before $1.
const PICKABLE = `
  with recent as (
    select distinct event_date from public.event_media
     where kind = 'event_photo' and status = 'ready' and publicly_usable and event_date <= $1
     order by event_date desc limit ${PICK_EVENTS})
  select ${COLUMNS} from public.event_media join recent using (event_date)
   where kind = 'event_photo' and status = 'ready' and publicly_usable`;

/**
 * The picker's photos for one event, newest event first, then in upload order.
 * @param {{ query: Function }} db
 * @param {string} date
 * @returns {Promise<Array<{ id: string, eventDate: string, originalKey: string, displayKey: string,
 *   thumbKey: string, image16x9Key: string|null, image16x9Outdated: boolean, contentType: string }>>}
 */
export async function listPickablePhotos(db, date) {
  checkDate(date);
  const { rows } = await db.query(`${PICKABLE} order by event_date desc, created_at, id`, [date]);
  return rows.map(({ kind, status, ...r }) => r);
}

/**
 * @param {string} actorUserId
 * @param {import("./storage.mjs").Storage | null} storage  deletes a replaced upload's objects
 * @param {string} date
 * @param {string} mediaId
 * @param {{ log?: (msg: string) => void }} [opts]
 */
export async function pickEventImage(actorUserId, storage, date, mediaId, { log } = {}) {
  checkDate(date);
  const notOffered = () => new ValidationError(["That photo can't be picked: choose one of the recent Photos from Event shown."]);
  if (!isUuid(mediaId)) throw notOffered();
  let unchanged = null;
  const result = await withAudit(actorUserId, async (client) => {
    await client.query("insert into public.events (event_date) values ($1) on conflict (event_date) do nothing", [date]);
    const { rows: [ev] } = await client.query(
      "select event_image_media_id as ref from public.events where event_date = $1 for update", [date]);
    const { rows: [photo] } = await client.query(`${PICKABLE} and id = $2`, [date, mediaId]);
    if (!photo) throw notOffered();
    const { rows: old } = await client.query(
      `delete from public.event_media
        where event_date = $1 and kind = 'event_image' and status = 'ready'
        returning id, original_key, display_key, thumb_key, image_16x9_key`, [date]);
    const replaced = old[0] ?? null;
    // Throwing rolls back and skips the audit row: nothing changed.
    if (!replaced && ev.ref === mediaId) { unchanged = photo; throw NOTHING; }
    await client.query("update public.events set event_image_media_id = $2 where event_date = $1", [date, mediaId]);
    return { photo, previous: ev.ref ?? null, replaced };
  }, (r) => ({
    action: "event_image.pick", targetTable: "event_media", targetId: mediaId,
    details: { eventDate: date, mediaId, photoDate: r.photo.eventDate, previous: r.previous, replaced: r.replaced?.id ?? null },
  })).catch((err) => { if (err === NOTHING) return null; throw err; });
  if (!result) {
    return { changed: false, eventDate: date, mediaId, needs16x9: needs16x9(unchanged), replaced: null, leftovers: [] };
  }
  const { photo, replaced } = result;
  let leftovers = [];
  if (replaced) {
    leftovers = storage
      ? await deleteObjects(storage, `event image ${replaced.id} (replaced by the photo ${mediaId})`, rowKeys(replaced), log)
      : rowKeys(replaced);
  }
  return { changed: true, eventDate: date, mediaId, needs16x9: needs16x9(photo), replaced: replaced?.id ?? null, leftovers };
}

/** A photo needs a (new) 16:9 Event Image: none yet, or one made under the old crop rule. */
const needs16x9 = (photo) => !photo.image16x9Key || Boolean(photo.image16x9Outdated);

/** Thrown inside a transaction to roll it back when nothing would change (no audit row). */
const NOTHING = Symbol("nothing");

/**
 * @param {string} actorUserId
 * @param {import("./storage.mjs").Storage} storage
 * @param {string} date
 * @param {{ log?: (msg: string) => void }} [opts]
 */
export async function clearEventImage(actorUserId, storage, date, { log } = {}) {
  checkDate(date);
  let row;
  try {
    row = await withAudit(actorUserId, async (client) => {
      await client.query("select 1 from public.events where event_date = $1 for update", [date]);
      const { rows } = await client.query(
        `delete from public.event_media
          where event_date = $1 and kind = 'event_image' and status = 'ready'
          returning id, original_key, display_key, thumb_key, image_16x9_key`, [date]);
      if (rows.length) return rows[0];
      // No upload: a picked photo, if any, is only un-referenced.
      const { rows: [ev] } = await client.query(
        "select event_image_media_id as id from public.events where event_date = $1", [date]);
      // Throwing rolls back and skips the audit row: nothing changed.
      if (!ev?.id) throw NOTHING;
      await client.query("update public.events set event_image_media_id = null where event_date = $1", [date]);
      return { id: ev.id, referenced: true };
    }, (r) => ({
      action: "event_image.clear", targetTable: "event_media", targetId: r.id,
      details: r.referenced
        ? { eventDate: date, mediaId: r.id, referenced: true, keys: [] }
        : { eventDate: date, mediaId: r.id, keys: rowKeys(r) },
    }));
  } catch (err) {
    if (err === NOTHING) return { changed: false, eventDate: date, mediaId: null, leftovers: [] };
    throw err;
  }
  const leftovers = await deleteObjects(storage, `event image clear ${row.id}`, rowKeys(row), log);
  return { changed: true, eventDate: date, mediaId: row.id, leftovers };
}

/**
 * The 16:9 Event Image's bytes on the server: a stored copy through a header-signed GET,
 * the logo's wide version through `readAsset` (by default readPublicAsset: public/ on
 * disk, else fetched from the site's own origin, since the Netlify function bundle
 * has no public/).
 * @param {import("./event-image-rules.mjs").EventImage} image
 * @param {{ storage?: import("./storage.mjs").Storage | null, readAsset?: (path: string) => Promise<Buffer> }} deps
 * @returns {Promise<{ contentType: string, bytes: Buffer }>}
 */
export async function load16x9Bytes(image, { storage, readAsset = readPublicAsset } = {}) {
  const wide = image.image16x9;
  if (!wide) throw new Error("event image: this image has no 16:9 Event Image yet");
  if (image.image16x9Outdated) throw new Error("event image: the 16:9 Event Image is being remade (open the event page)");
  if ("path" in wide) return { contentType: wide.contentType, bytes: Buffer.from(await readAsset(wide.path)) };
  if (!storage) throw new Error("event image: storage is not configured");
  const got = await storage.getObject({ key: wide.key });
  if (!got) throw new Error(`event image: the 16:9 Event Image ${wide.key} is missing from the bucket`);
  return { contentType: wide.contentType, bytes: got.bytes };
}
