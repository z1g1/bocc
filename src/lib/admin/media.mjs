// Event photos and the weekly promo video (ADR 0010): the data side of phone uploads,
// the gallery and deletes. Admin only; the CALLER checks requireRole(locals, "admin") and checkOrigin, and
// that storage is configured (getStorage()). Parameterized SQL only.
//
// Upload flow (the browser makes the 1600px display copy and the 400px thumbnail):
//   startUpload(actor, storage, input)   -> { id, eventDate, uploads: { original, display, thumb } }
//       validates, creates the events row if missing (status `scheduled`), inserts the
//       event_media row `pending` with server-built keys, audits `media.upload`, all in
//       ONE transaction; then hands back three presigned PUTs (Content-Type and
//       Content-Length signed, so each URL takes exactly the declared file)
//   completeUpload(actor, storage, id)   -> { status: "ready" } | { status: "pending", problems }
//       HEADs all three objects, checks type and size against what was signed, and
//       only then moves pending -> ready (audited `media.ready`)
//   deleteMedia(actor, storage, id)      -> { eventDate, leftovers }
//       deletes the row (audited `media.delete`, with the keys) FIRST, then the three
//       objects. A failed object delete leaves an orphan in the private bucket, which
//       is logged with its key; the reverse order could leave a row pointing at
//       nothing, which the gallery would show as broken.
//   listEventMedia(db, date)             -> { ready, pending } for the gallery
//   listStalePending(db, { date? })      pending rows older than STALE_PENDING_HOURS
//
// publicly_usable is not a choice: every social photo is covered by the photo waiver
// posted at the event, so a social_photo row is always created true, and a
// signin_board row always false (the CHECK on event_media agrees), whatever the client
// sends (ADR 0010 decision 2, amended 2026-11-18). Phase 5 reads the column.
//
// Promo videos (kind promo_video, plan Phase 5) use the same flow with ONE file: the
// browser declares only `original` (video/mp4 or video/quicktime, up to LIMITS.video),
// gets one presigned PUT, and completeUpload checks only that object. Nothing is made
// in the browser (no copies, no thumbnail). The social post picks one ready video
// (src/lib/admin/social.mjs setVideo); deleteMedia of that video clears it from the
// post and un-readies the post, in the same transaction as the delete.
//
// What was signed for the display copy and thumbnail (their sizes) is not in
// event_media, which only describes the original; completeUpload reads it back from
// the `media.upload` audit row written in the same transaction as the row.

import { randomUUID } from "node:crypto";
import { pool, withAudit, writeAudit } from "./db.mjs";
import { inUseMessage } from "./event-image-rules.mjs";
import { NotFoundError, ValidationError, isUuid } from "./attendees.mjs";
import { extForContentType, isIsoDate, mediaKey } from "./storage.mjs";

export { NotFoundError, ValidationError };

export const PHOTO_KINDS = Object.freeze(["signin_board", "social_photo"]);
export const VIDEO_KIND = "promo_video";
/** The week's one image (ADR 0012 decision 3): see src/lib/admin/event-image.mjs. */
export const EVENT_IMAGE_KIND = "event_image";
export const UPLOAD_KINDS = Object.freeze([...PHOTO_KINDS, VIDEO_KIND, EVENT_IMAGE_KIND]);
export const ORIGINAL_TYPES = Object.freeze(["image/jpeg", "image/png"]);
export const VIDEO_TYPES = Object.freeze(["video/mp4", "video/quicktime"]);
export const COPY_TYPE = "image/jpeg";

// Caps on the declared sizes. The original is the phone's own file: a 48 MP iPhone
// photo converted to JPEG on pick is about 8–15 MB, a big PNG screenshot a few MB.
// 25 MB leaves room without letting one upload eat the 5 GB free tier. The copies are
// browser-made 1600px / 400px JPEGs (typically ~0.5 MB / ~40 KB). The weekly promo
// video is an edited 1080x1920 export of about 4–5 MB (ADR 0010); 100 MB allows a raw
// phone clip of a minute or so without letting one upload eat the free tier.
// Keep in step with public/js/admin-media-lib.js (a test checks they agree).
export const LIMITS = Object.freeze({
  original: 25 * 1024 * 1024,
  display: 5 * 1024 * 1024,
  thumb: 1024 * 1024,
  cover: 5 * 1024 * 1024,
  video: 100 * 1024 * 1024,
});

// The Event Image's original: smaller cap than a photo (it is a designed image, not a
// phone photo), and big enough for the 16:9 cover. Its dimensions are measured in the
// browser and declared (the server never reads the bytes), so the minimum is checked
// here only as a guard against a buggy client. Keep in step with admin-media-lib.js.
export const EVENT_IMAGE = Object.freeze({ maxBytes: 8 * 1024 * 1024, minWidth: 480, minHeight: 270 });

// Presigned PUTs last 15 minutes, not the storage default of 5: the three files go up
// one after another from a phone, and S3 checks expiry when a request starts.
export const PUT_EXPIRES = 900;
export const STALE_PENDING_HOURS = 24;
/** Uploads are for real event days: not before the club's records start, not over a year ahead. */
export const EARLIEST_DATE = "2024-01-01";

const VARIANTS = /** @type {const} */ (["original", "display", "thumb"]);
/** The objects a row of this kind has. */
const variantsFor = (kind) => (kind === VIDEO_KIND ? /** @type {const} */ (["original"])
  : kind === EVENT_IMAGE_KIND ? /** @type {const} */ ([...VARIANTS, "cover"]) : VARIANTS);

const isSize = (n, max) => Number.isSafeInteger(n) && n > 0 && n <= max;
const plusDays = (d, days) => new Date(d.getTime() + days * 86400000).toISOString().slice(0, 10);

/**
 * Validate the JSON body of POST /api/admin/media/uploads.
 * @param {unknown} input
 * @param {{ today?: Date }} [opts]
 * @returns {{ ok: true, values: { eventDate: string, kind: string, publiclyUsable: boolean,
 *   original: { contentType: string, size: number }, display?: { size: number }, thumb?: { size: number } } }
 *   | { ok: false, errors: string[] }}  display/thumb only for photos
 */
export function validateUploadRequest(input, { today = new Date() } = {}) {
  const errors = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, errors: ["body must be a JSON object"] };
  const b = /** @type {Record<string, any>} */ (input);

  if (!isIsoDate(b.eventDate)) errors.push("eventDate must be a date, YYYY-MM-DD");
  else if (b.eventDate < EARLIEST_DATE || b.eventDate > plusDays(today, 366)) errors.push("eventDate is out of range");

  if (!UPLOAD_KINDS.includes(b.kind)) errors.push(`kind must be one of ${UPLOAD_KINDS.join(", ")}`);
  const video = b.kind === VIDEO_KIND;
  const eventImage = b.kind === EVENT_IMAGE_KIND;

  // Not the client's choice (see the top of this file): any publiclyUsable sent is ignored.
  const publiclyUsable = b.kind === "social_photo";

  const o = b.original;
  const types = video ? VIDEO_TYPES : ORIGINAL_TYPES;
  const max = video ? LIMITS.video : eventImage ? EVENT_IMAGE.maxBytes : LIMITS.original;
  if (!o || typeof o !== "object") errors.push("original is required");
  else {
    if (!types.includes(o.contentType)) errors.push(`original.contentType must be ${types.join(" or ")}`);
    if (!isSize(o.size, max)) errors.push(`original.size must be 1 to ${max} bytes`);
    if (eventImage && !(Number.isSafeInteger(o.width) && Number.isSafeInteger(o.height)
      && o.width >= EVENT_IMAGE.minWidth && o.height >= EVENT_IMAGE.minHeight)) {
      errors.push(`original.width and original.height must be at least ${EVENT_IMAGE.minWidth}x${EVENT_IMAGE.minHeight}`);
    }
  }
  if (video) {
    for (const v of ["display", "thumb"]) if (b[v] !== undefined) errors.push(`${v} is not used for a video`);
  } else {
    const copies = /** @type {Array<"display"|"thumb"|"cover">} */ (eventImage ? ["display", "thumb", "cover"] : ["display", "thumb"]);
    if (!eventImage && b.cover !== undefined) errors.push("cover is only for the Event Image");
    for (const v of copies) {
      const c = b[v];
      if (!c || typeof c !== "object") errors.push(`${v} is required`);
      else {
        if (c.contentType !== undefined && c.contentType !== COPY_TYPE) errors.push(`${v}.contentType must be ${COPY_TYPE}`);
        if (!isSize(c.size, LIMITS[v])) errors.push(`${v}.size must be 1 to ${LIMITS[v]} bytes`);
      }
    }
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    values: {
      eventDate: b.eventDate,
      kind: b.kind,
      publiclyUsable,
      original: { contentType: o.contentType, size: o.size },
      ...(eventImage ? { original: { contentType: o.contentType, size: o.size, width: o.width, height: o.height } } : {}),
      ...(video ? {} : { display: { size: b.display.size }, thumb: { size: b.thumb.size } }),
      ...(eventImage ? { cover: { size: b.cover.size } } : {}),
    },
  };
}

/** The keys for a row (a video has only its original); the user's filename never reaches them. */
export function keysFor(eventDate, id, originalType, kind = "signin_board") {
  const ext = /** @type {"jpg"|"png"|"mp4"|"mov"} */ (extForContentType(originalType));
  const original = mediaKey(eventDate, id, "original", ext);
  if (kind === VIDEO_KIND) return { original, display: null, thumb: null, cover: null };
  return {
    original,
    display: mediaKey(eventDate, id, "display", "jpg"),
    thumb: mediaKey(eventDate, id, "thumb", "jpg"),
    cover: kind === EVENT_IMAGE_KIND ? mediaKey(eventDate, id, "cover", "jpg") : null,
  };
}

/**
 * @param {string} actorUserId
 * @param {import("./storage.mjs").Storage} storage
 * @param {unknown} input
 */
export async function startUpload(actorUserId, storage, input, { today = new Date() } = {}) {
  const v = validateUploadRequest(input, { today });
  if (!v.ok) throw new ValidationError(v.errors);
  const { eventDate, kind, publiclyUsable, original, display, thumb, cover } = v.values;
  const id = randomUUID();
  const keys = keysFor(eventDate, id, original.contentType, kind);
  // An Event Image's declared dimensions are kept with what was signed (audit only).
  const signed = kind === VIDEO_KIND
    ? { original: { contentType: original.contentType, size: original.size } }
    : {
      original: { contentType: original.contentType, size: original.size,
        ...(kind === EVENT_IMAGE_KIND ? { width: original.width, height: original.height } : {}) },
      display: { contentType: COPY_TYPE, size: display.size },
      thumb: { contentType: COPY_TYPE, size: thumb.size },
      ...(kind === EVENT_IMAGE_KIND ? { cover: { contentType: COPY_TYPE, size: cover.size } } : {}),
    };
  // Sign first (no I/O): a signing error then leaves nothing behind.
  const uploads = Object.fromEntries(variantsFor(kind).map((variant) => {
    const p = storage.presignPut({
      key: keys[variant], contentType: signed[variant].contentType, contentLength: signed[variant].size, expiresIn: PUT_EXPIRES,
    });
    return [variant, { method: p.method, url: p.url, headers: p.headers }];
  }));

  const { eventCreated } = await withAudit(actorUserId, async (client) => {
    // The FK needs the event; the first upload for a date creates it as `scheduled`.
    const ev = await client.query(
      "insert into public.events (event_date) values ($1) on conflict (event_date) do nothing", [eventDate]);
    await client.query(
      `insert into public.event_media
         (id, event_date, kind, original_key, display_key, thumb_key, cover_key, content_type, size_bytes,
          publicly_usable, status, uploaded_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11)`,
      [id, eventDate, kind, keys.original, keys.display, keys.thumb, keys.cover, original.contentType, original.size,
        publiclyUsable, actorUserId],
    );
    return { eventCreated: ev.rowCount === 1 };
  }, (r) => ({
    action: "media.upload",
    targetTable: "event_media",
    targetId: id,
    details: { eventDate, kind, publiclyUsable, eventCreated: r.eventCreated, signed },
  }));

  return { id, eventDate, eventCreated, expiresInSeconds: PUT_EXPIRES, uploads };
}

const MEDIA_COLUMNS = `
  id, event_date::text as "eventDate", kind, original_key as "originalKey", display_key as "displayKey",
  thumb_key as "thumbKey", cover_key as "coverKey", content_type as "contentType", size_bytes::int8 as "sizeBytes",
  publicly_usable as "publiclyUsable", status, uploaded_by as "uploadedBy", created_at as "createdAt"`;

async function getRow(db, id) {
  if (!isUuid(id)) throw new NotFoundError("media not found");
  const { rows } = await db.query(`select ${MEDIA_COLUMNS} from public.event_media where id = $1`, [id]);
  if (!rows.length) throw new NotFoundError("media not found");
  const r = rows[0];
  return { ...r, sizeBytes: Number(r.sizeBytes) };
}

/**
 * Confirm the objects landed as signed (three; one for a video; four for an Event
 * Image, with its cover), then pending -> ready. An Event Image replaces the event's
 * current one in the same transaction (audited `event_image.set` with `replaced`),
 * and the old one's objects are deleted after the commit.
 * @param {string} actorUserId
 * @param {import("./storage.mjs").Storage} storage
 * @param {string} id
 * @param {{ db: { query: Function }, log?: (msg: string) => void }} deps  the pool (reads outside the write transaction)
 * @returns {Promise<{ id: string, status: "ready" } | { id: string, status: "pending", problems: string[] }>}
 */
export async function completeUpload(actorUserId, storage, id, { db, log }) {
  const row = await getRow(db, id);
  if (row.status === "ready") return { id, status: "ready" };

  const { rows: audit } = await db.query(
    `select details from public.audit_log
      where action = 'media.upload' and target_table = 'event_media' and target_id = $1
      order by id limit 1`, [id]);
  const signed = audit[0]?.details?.signed ?? {};
  const expected = {
    original: { contentType: row.contentType, size: row.sizeBytes },
    display: { contentType: COPY_TYPE, size: signed.display?.size },
    thumb: { contentType: COPY_TYPE, size: signed.thumb?.size },
    cover: { contentType: COPY_TYPE, size: signed.cover?.size },
  };
  const keys = { original: row.originalKey, display: row.displayKey, thumb: row.thumbKey, cover: row.coverKey };

  const variants = variantsFor(row.kind);
  const heads = await Promise.all(variants.map((v) => storage.headObject({ key: keys[v] })));
  const problems = [];
  variants.forEach((v, i) => {
    const h = heads[i];
    if (!h) return problems.push(`${v}: not uploaded`);
    const type = (h.contentType ?? "").split(";")[0].trim().toLowerCase();
    if (type !== expected[v].contentType) problems.push(`${v}: content type ${type || "missing"}, expected ${expected[v].contentType}`);
    const max = row.kind === VIDEO_KIND ? LIMITS.video : LIMITS[v];
    const sizeOk = expected[v].size === undefined ? h.contentLength > 0 && h.contentLength <= max : h.contentLength === expected[v].size;
    if (!sizeOk) problems.push(`${v}: ${h.contentLength} bytes, expected ${expected[v].size ?? `1 to ${max}`}`);
  });
  if (problems.length) return { id, status: "pending", problems };

  const eventImage = row.kind === EVENT_IMAGE_KIND;
  const { updated, replaced } = await withAudit(actorUserId, async (client) => {
    let replaced = null;
    if (eventImage) {
      // The new Event Image takes over: lock the event (two completes for the same
      // date run one after the other), then drop the current one. Its objects go
      // after the commit, as in deleteMedia.
      await client.query("select 1 from public.events where event_date = $1 for update", [row.eventDate]);
      const { rows: old } = await client.query(
        `delete from public.event_media
          where event_date = $1 and kind = 'event_image' and status = 'ready' and id <> $2
          returning id, original_key, display_key, thumb_key, cover_key`, [row.eventDate, id]);
      replaced = old[0] ?? null;
    }
    const r = await client.query(
      "update public.event_media set status = 'ready' where id = $1 and status = 'pending'", [id]);
    if (eventImage && r.rowCount === 1) {
      // The upload also takes over from a picked photo (ticket #21): drop the reference.
      const { rows: unpicked } = await client.query(
        `update public.events e set event_image_media_id = null
           from public.events old
          where e.event_date = $1 and old.event_date = e.event_date and e.event_image_media_id is not null
          returning old.event_image_media_id as id`, [row.eventDate]);
      await writeAudit(client, actorUserId, {
        action: "event_image.set", targetTable: "event_media", targetId: id,
        details: {
          eventDate: row.eventDate, mediaId: id, replaced: replaced?.id ?? null,
          ...(unpicked.length ? { unpicked: unpicked[0].id } : {}),
        },
      });
    }
    return { updated: r.rowCount, replaced };
  }, { action: "media.ready", targetTable: "event_media", targetId: id, details: { eventDate: row.eventDate, kind: row.kind } });
  if (replaced) {
    await deleteObjects(storage, `event image ${replaced.id} (replaced by ${id})`, rowKeys(replaced), log);
  }
  if (updated !== 1) {
    // Raced with another complete (now ready: fine) or a delete (gone: 404).
    const again = await getRow(db, id);
    return { id, status: again.status === "ready" ? "ready" : "pending", ...(again.status === "ready" ? {} : { problems: ["state changed, try again"] }) };
  }
  return { id, status: "ready" };
}

/**
 * Delete the row (audited, with its keys), then its objects. Never throws for an
 * object that couldn't be deleted: it is returned in `leftovers` and logged.
 * @param {string} actorUserId
 * @param {import("./storage.mjs").Storage} storage
 * @param {string} id
 * @param {{ log?: (msg: string) => void }} [opts]
 */
export async function deleteMedia(actorUserId, storage, id, { log = (m) => console.error(m) } = {}) {
  if (!isUuid(id)) throw new NotFoundError("media not found");
  const row = await withAudit(actorUserId, async (client) => {
    // A photo picked as an event's Event Image (events.event_image_media_id, ticket
    // #21) is refused, naming the events; the FK would refuse it too, without names.
    const { rows: users } = await client.query(
      `select e.event_date::text as d, m.event_date::text as "photoDate"
         from public.events e join public.event_media m on m.id = e.event_image_media_id
        where e.event_image_media_id = $1 order by e.event_date for share of e`, [id]);
    if (users.length) throw new InUseError(users.map((u) => u.d), users[0].photoDate);
    // A promo video may be a social post's video: clear it there first (the FK would
    // refuse the delete), and un-ready the post, which needs a video (its CHECK).
    const { rows: detached } = await client.query(
      `update public.social_posts set video_media_id = null, ready = false
        where video_media_id = $1
        returning event_date::text as "eventDate"`, [id]);
    const { rows } = await client.query(
      `delete from public.event_media where id = $1
       returning event_date::text as "eventDate", kind, status, original_key, display_key, thumb_key, cover_key`, [id]);
    if (!rows.length) throw new NotFoundError("media not found");
    return { ...rows[0], detachedFromSocialPost: detached.length > 0 };
  }, (r) => ({
    action: "media.delete", targetTable: "event_media", targetId: id,
    details: {
      eventDate: r.eventDate, kind: r.kind, status: r.status, keys: rowKeys(r),
      ...(r.detachedFromSocialPost ? { detachedFromSocialPost: true } : {}),
    },
  }));

  // A social photo's cover is at a known key: also delete it when a cover upload was
  // started but never completed (deleting a missing object is not an error).
  const keys = rowKeys(row);
  const coverKey = row.kind === "social_photo" ? mediaKey(row.eventDate, id, "cover", "jpg") : null;
  if (coverKey && !keys.includes(coverKey)) keys.push(coverKey);
  const leftovers = await deleteObjects(storage, `media delete ${id}`, keys, log);
  return { id, eventDate: row.eventDate, kind: row.kind, leftovers };
}

/** deleteMedia refused: the photo is the Event Image of these events (409). */
export class InUseError extends Error {
  status = 409;
  /**
   * @param {string[]} eventDates  the events that use the photo
   * @param {string} photoDate     the photo's own event (where its gallery is)
   */
  constructor(eventDates, photoDate) {
    super(inUseMessage(eventDates));
    this.eventDates = eventDates;
    this.photoDate = photoDate;
    this.errors = [this.message];
  }
}

// ─── A Photo from Event's 16:9 cover (ticket #21) ───────────────────────────
// A photo picked as an Event Image needs a 16:9 cover copy. The browser makes it
// (a centre crop of the display copy, as for an uploaded Event Image) and PUTs it:
//   startCover(actor, storage, id, { size })  -> { id, eventDate, key, expiresInSeconds, upload }
//       a ready social_photo without a cover: one presigned PUT for
//       events/<date>/<id>/cover.jpg (type and size signed), audited
//       `media.cover_upload` with what was signed
//   completeCover(actor, storage, id, { db }) -> { status: "ready", coverKey } | { status: "pending", problems }
//       HEADs the object, checks it against what was signed, then sets cover_key
//       (audited `media.cover`)

/**
 * @param {string} actorUserId
 * @param {import("./storage.mjs").Storage} storage
 * @param {string} id
 * @param {unknown} input  { size }
 */
export async function startCover(actorUserId, storage, id, input) {
  const size = /** @type {any} */ (input)?.size;
  const row = await getRow(pool, id);
  const errors = [];
  if (row.kind !== "social_photo" || row.status !== "ready") errors.push("only a ready Photo from Event can be given a 16:9 cover");
  else if (row.coverKey) errors.push("this photo already has a 16:9 cover");
  if (!isSize(size, LIMITS.cover)) errors.push(`size must be 1 to ${LIMITS.cover} bytes`);
  if (errors.length) throw new ValidationError(errors);
  const key = mediaKey(row.eventDate, id, "cover", "jpg");
  const p = storage.presignPut({ key, contentType: COPY_TYPE, contentLength: size, expiresIn: PUT_EXPIRES });
  await withAudit(actorUserId, async () => {}, {
    action: "media.cover_upload", targetTable: "event_media", targetId: id,
    details: { eventDate: row.eventDate, key, signed: { contentType: COPY_TYPE, size } },
  });
  return { id, eventDate: row.eventDate, key, expiresInSeconds: PUT_EXPIRES, upload: { method: p.method, url: p.url, headers: p.headers } };
}

/**
 * @param {string} actorUserId
 * @param {import("./storage.mjs").Storage} storage
 * @param {string} id
 * @param {{ db: { query: Function } }} deps
 * @returns {Promise<{ id: string, status: "ready", coverKey: string } | { id: string, status: "pending", problems: string[] }>}
 */
export async function completeCover(actorUserId, storage, id, { db }) {
  const row = await getRow(db, id);
  if (row.coverKey) return { id, status: "ready", coverKey: row.coverKey };
  const { rows: audit } = await db.query(
    `select details from public.audit_log
      where action = 'media.cover_upload' and target_table = 'event_media' and target_id = $1
      order by id desc limit 1`, [id]);
  const started = audit[0]?.details;
  if (!started) return { id, status: "pending", problems: ["cover: not started"] };
  const h = await storage.headObject({ key: started.key });
  const problems = [];
  if (!h) problems.push("cover: not uploaded");
  else {
    const type = (h.contentType ?? "").split(";")[0].trim().toLowerCase();
    if (type !== COPY_TYPE) problems.push(`cover: content type ${type || "missing"}, expected ${COPY_TYPE}`);
    if (h.contentLength !== started.signed.size) problems.push(`cover: ${h.contentLength} bytes, expected ${started.signed.size}`);
  }
  if (problems.length) return { id, status: "pending", problems };
  const raced = Symbol("raced");
  const updated = await withAudit(actorUserId, async (client) => {
    const r = await client.query(
      "update public.event_media set cover_key = $2 where id = $1 and cover_key is null and kind = 'social_photo'", [id, started.key]);
    // Nothing changed (a race with another complete, or a delete): roll back, no audit row.
    if (r.rowCount !== 1) throw raced;
    return true;
  }, { action: "media.cover", targetTable: "event_media", targetId: id, details: { eventDate: row.eventDate, key: started.key } })
    .catch((err) => { if (err === raced) return false; throw err; });
  if (!updated) {
    const again = await getRow(db, id);
    return again.coverKey ? { id, status: "ready", coverKey: again.coverKey } : { id, status: "pending", problems: ["state changed, try again"] };
  }
  return { id, status: "ready", coverKey: started.key };
}

/** A deleted row's object keys (snake_case, from `returning`). */
export const rowKeys = (r) => [r.original_key, r.display_key, r.thumb_key, r.cover_key].filter(Boolean);

/**
 * Delete objects whose row is already gone. Never throws: the keys that couldn't be
 * deleted are logged (an orphan in the private bucket) and returned.
 * @returns {Promise<string[]>} leftovers
 */
export async function deleteObjects(storage, what, keys, log = (m) => console.error(m)) {
  const results = await Promise.allSettled(keys.map((key) => storage.deleteObject({ key })));
  const leftovers = keys.filter((_, i) => results[i].status === "rejected");
  if (leftovers.length) {
    log(`[admin] ${what}: row deleted, but these objects are still in the bucket: ${leftovers.join(", ")}`);
  }
  return leftovers;
}

/**
 * The gallery for one date: ready media, and pending rows (an upload in progress, or
 * one that never finished), oldest first.
 * @param {{ query: Function }} db
 * @param {string} date
 */
export async function listEventMedia(db, date) {
  if (!isIsoDate(date)) throw new ValidationError(["date must be YYYY-MM-DD"]);
  const { rows } = await db.query(
    `select ${MEDIA_COLUMNS},
            created_at < now() - make_interval(hours => $2) as stale
       from public.event_media
      where event_date = $1 and kind in ('signin_board', 'social_photo')
      order by created_at, id`, [date, STALE_PENDING_HOURS]);
  const all = rows.map((r) => ({ ...r, sizeBytes: Number(r.sizeBytes) }));
  return { ready: all.filter((r) => r.status === "ready"), pending: all.filter((r) => r.status === "pending") };
}

/**
 * The promo videos for one date (the social post section): ready ones, newest first,
 * and pending ones (in progress or abandoned; `stale` past STALE_PENDING_HOURS).
 * @param {{ query: Function }} db
 * @param {string} date
 */
export async function listPromoVideos(db, date) {
  if (!isIsoDate(date)) throw new ValidationError(["date must be YYYY-MM-DD"]);
  const { rows } = await db.query(
    `select ${MEDIA_COLUMNS},
            created_at < now() - make_interval(hours => $2) as stale
       from public.event_media
      where event_date = $1 and kind = 'promo_video'
      order by created_at desc, id`, [date, STALE_PENDING_HOURS]);
  const all = rows.map((r) => ({ ...r, sizeBytes: Number(r.sizeBytes) }));
  return { ready: all.filter((r) => r.status === "ready"), pending: all.filter((r) => r.status === "pending") };
}

/**
 * Pending rows older than STALE_PENDING_HOURS (abandoned uploads), optionally for one
 * date. No cron: the event page lists its own, and an admin deletes them.
 * @param {{ query: Function }} db
 * @param {{ date?: string }} [opts]
 */
export async function listStalePending(db, { date } = {}) {
  if (date !== undefined && !isIsoDate(date)) throw new ValidationError(["date must be YYYY-MM-DD"]);
  const { rows } = await db.query(
    `select ${MEDIA_COLUMNS} from public.event_media
      where status = 'pending' and created_at < now() - make_interval(hours => $1)
        and ($2::date is null or event_date = $2::date)
      order by created_at, id`, [STALE_PENDING_HOURS, date ?? null]);
  return rows.map((r) => ({ ...r, sizeBytes: Number(r.sizeBytes) }));
}
