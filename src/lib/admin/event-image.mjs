// The Event Image, database side (ADR 0012 decision 3). Admin only; the CALLER checks
// requireRole(locals, "admin") and checkOrigin, and that storage is configured.
// Parameterized SQL only. The rules (resolution order, the logo default) are in
// event-image-rules.mjs.
//
//   getEventImage(db, date)                 -> the resolved EventImage (never null)
//   clearEventImage(actor, storage, date)   -> { changed, eventDate, mediaId, leftovers }
//       deletes the event's ready event_image row (audited `event_image.clear`, with
//       its keys) FIRST, then its four objects (as deleteMedia). The event then uses
//       the BOCC logo. Nothing to clear: { changed: false }, no audit row.
//   loadCoverBytes(image, { storage, readAsset })  -> { contentType, bytes }
//       the 16:9 cover's bytes on the server, for the LinkedIn image upload
//
// Setting and changing are the ordinary media upload with kind `event_image`
// (src/lib/admin/media.mjs startUpload / completeUpload): the browser makes the
// display, thumbnail and 16:9 cover copies; completeUpload replaces the current image
// in one transaction and audits `event_image.set` ({ eventDate, mediaId, replaced }).
//
// Ticket #21 (pick a Photo from Event by reference) adds the `referenced` row to
// getEventImage; resolveEventImage already ranks it after an upload.

import { readFile } from "node:fs/promises";
import { withAudit } from "./db.mjs";
import { ValidationError } from "./attendees.mjs";
import { isIsoDate } from "./storage.mjs";
import { deleteObjects, rowKeys } from "./media.mjs";
import { DEFAULT_EVENT_IMAGE, resolveEventImage } from "./event-image-rules.mjs";

export { DEFAULT_EVENT_IMAGE, resolveEventImage };

const COLUMNS = `
  id, event_date::text as "eventDate", kind, status, original_key as "originalKey",
  display_key as "displayKey", thumb_key as "thumbKey", cover_key as "coverKey", content_type as "contentType"`;

const checkDate = (date) => { if (!isIsoDate(date)) throw new ValidationError(["date must be YYYY-MM-DD"]); };

/**
 * @param {{ query: Function }} db
 * @param {string} date  YYYY-MM-DD
 * @returns {Promise<import("./event-image-rules.mjs").EventImage>}
 */
export async function getEventImage(db, date) {
  checkDate(date);
  const { rows } = await db.query(
    `select ${COLUMNS} from public.event_media
      where event_date = $1 and kind = 'event_image' and status = 'ready'`, [date]);
  return resolveEventImage({ uploaded: rows[0] ?? null });
}

/**
 * @param {string} actorUserId
 * @param {import("./storage.mjs").Storage} storage
 * @param {string} date
 * @param {{ log?: (msg: string) => void }} [opts]
 */
export async function clearEventImage(actorUserId, storage, date, { log } = {}) {
  checkDate(date);
  const NOTHING = Symbol("nothing");
  let row;
  try {
    row = await withAudit(actorUserId, async (client) => {
      await client.query("select 1 from public.events where event_date = $1 for update", [date]);
      const { rows } = await client.query(
        `delete from public.event_media
          where event_date = $1 and kind = 'event_image' and status = 'ready'
          returning id, original_key, display_key, thumb_key, cover_key`, [date]);
      // Throwing rolls back and skips the audit row: nothing changed.
      if (!rows.length) throw NOTHING;
      return rows[0];
    }, (r) => ({
      action: "event_image.clear", targetTable: "event_media", targetId: r.id,
      details: { eventDate: date, mediaId: r.id, keys: rowKeys(r) },
    }));
  } catch (err) {
    if (err === NOTHING) return { changed: false, eventDate: date, mediaId: null, leftovers: [] };
    throw err;
  }
  const leftovers = await deleteObjects(storage, `event image clear ${row.id}`, rowKeys(row), log);
  return { changed: true, eventDate: date, mediaId: row.id, leftovers };
}

/** The checked-in default files, read from public/ (where they are in the repo). */
const readPublicFile = (path) => readFile(new URL(`../../../public${path}`, import.meta.url));

/**
 * The 16:9 cover's bytes on the server: a stored copy through a header-signed GET,
 * the logo's wide version through `readAsset` (by default from public/ on disk; on
 * Netlify the function bundle may not include public/, so the LinkedIn upload should
 * pass a readAsset that fetches it from the site, or bundle the file).
 * @param {import("./event-image-rules.mjs").EventImage} image
 * @param {{ storage?: import("./storage.mjs").Storage | null, readAsset?: (path: string) => Promise<Buffer> }} deps
 * @returns {Promise<{ contentType: string, bytes: Buffer }>}
 */
export async function loadCoverBytes(image, { storage, readAsset = readPublicFile } = {}) {
  const cover = image.cover;
  if (!cover) throw new Error("event image: this image has no 16:9 cover yet");
  if ("path" in cover) return { contentType: cover.contentType, bytes: Buffer.from(await readAsset(cover.path)) };
  if (!storage) throw new Error("event image: storage is not configured");
  const got = await storage.getObject({ key: cover.key });
  if (!got) throw new Error(`event image: the cover ${cover.key} is missing from the bucket`);
  return { contentType: cover.contentType, bytes: got.bytes };
}
