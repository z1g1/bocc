// Event photos (ADR 0010): the data side of phone uploads, the gallery and deletes.
// Admin only; the CALLER checks requireRole(locals, "admin") and checkOrigin, and
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
//   setPubliclyUsable(actor, id, value)  social photos only (the CHECK agrees)
//   listEventMedia(db, date)             -> { ready, pending } for the gallery
//   listStalePending(db, { date? })      pending rows older than STALE_PENDING_HOURS
//
// What was signed for the display copy and thumbnail (their sizes) is not in
// event_media, which only describes the original; completeUpload reads it back from
// the `media.upload` audit row written in the same transaction as the row.

import { randomUUID } from "node:crypto";
import { withAudit } from "./db.mjs";
import { NotFoundError, ValidationError, isUuid } from "./attendees.mjs";
import { extForContentType, isIsoDate, mediaKey } from "./storage.mjs";

export { NotFoundError, ValidationError };

export const PHOTO_KINDS = Object.freeze(["signin_board", "social_photo"]);
export const ORIGINAL_TYPES = Object.freeze(["image/jpeg", "image/png"]);
export const COPY_TYPE = "image/jpeg";

// Caps on the declared sizes. The original is the phone's own file: a 48 MP iPhone
// photo converted to JPEG on pick is about 8–15 MB, a big PNG screenshot a few MB.
// 25 MB leaves room without letting one upload eat the 5 GB free tier. The copies are
// browser-made 1600px / 400px JPEGs (typically ~0.5 MB / ~40 KB).
// Keep in step with public/js/admin-media-lib.js (a test checks they agree).
export const LIMITS = Object.freeze({
  original: 25 * 1024 * 1024,
  display: 5 * 1024 * 1024,
  thumb: 1024 * 1024,
});

// Presigned PUTs last 15 minutes, not the storage default of 5: the three files go up
// one after another from a phone, and S3 checks expiry when a request starts.
export const PUT_EXPIRES = 900;
export const STALE_PENDING_HOURS = 24;
/** Uploads are for real event days: not before the club's records start, not over a year ahead. */
export const EARLIEST_DATE = "2024-01-01";

const VARIANTS = /** @type {const} */ (["original", "display", "thumb"]);

const isSize = (n, max) => Number.isSafeInteger(n) && n > 0 && n <= max;
const plusDays = (d, days) => new Date(d.getTime() + days * 86400000).toISOString().slice(0, 10);

/**
 * Validate the JSON body of POST /api/admin/media/uploads.
 * @param {unknown} input
 * @param {{ today?: Date }} [opts]
 * @returns {{ ok: true, values: { eventDate: string, kind: string, publiclyUsable: boolean,
 *   original: { contentType: string, size: number }, display: { size: number }, thumb: { size: number } } }
 *   | { ok: false, errors: string[] }}
 */
export function validateUploadRequest(input, { today = new Date() } = {}) {
  const errors = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, errors: ["body must be a JSON object"] };
  const b = /** @type {Record<string, any>} */ (input);

  if (!isIsoDate(b.eventDate)) errors.push("eventDate must be a date, YYYY-MM-DD");
  else if (b.eventDate < EARLIEST_DATE || b.eventDate > plusDays(today, 366)) errors.push("eventDate is out of range");

  if (!PHOTO_KINDS.includes(b.kind)) errors.push(`kind must be one of ${PHOTO_KINDS.join(", ")}`);

  const publiclyUsable = b.publiclyUsable === undefined ? false : b.publiclyUsable;
  if (typeof publiclyUsable !== "boolean") errors.push("publiclyUsable must be true or false");
  else if (publiclyUsable && b.kind !== "social_photo") errors.push("publiclyUsable applies only to social_photo");

  const o = b.original;
  if (!o || typeof o !== "object") errors.push("original is required");
  else {
    if (!ORIGINAL_TYPES.includes(o.contentType)) errors.push(`original.contentType must be ${ORIGINAL_TYPES.join(" or ")}`);
    if (!isSize(o.size, LIMITS.original)) errors.push(`original.size must be 1 to ${LIMITS.original} bytes`);
  }
  for (const v of /** @type {const} */ (["display", "thumb"])) {
    const c = b[v];
    if (!c || typeof c !== "object") errors.push(`${v} is required`);
    else {
      if (c.contentType !== undefined && c.contentType !== COPY_TYPE) errors.push(`${v}.contentType must be ${COPY_TYPE}`);
      if (!isSize(c.size, LIMITS[v])) errors.push(`${v}.size must be 1 to ${LIMITS[v]} bytes`);
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
      display: { size: b.display.size },
      thumb: { size: b.thumb.size },
    },
  };
}

/** The three keys for a row; the user's filename never reaches them. */
export function keysFor(eventDate, id, originalType) {
  const ext = /** @type {"jpg"|"png"} */ (extForContentType(originalType));
  return {
    original: mediaKey(eventDate, id, "original", ext),
    display: mediaKey(eventDate, id, "display", "jpg"),
    thumb: mediaKey(eventDate, id, "thumb", "jpg"),
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
  const { eventDate, kind, publiclyUsable, original, display, thumb } = v.values;
  const id = randomUUID();
  const keys = keysFor(eventDate, id, original.contentType);
  const signed = {
    original: { contentType: original.contentType, size: original.size },
    display: { contentType: COPY_TYPE, size: display.size },
    thumb: { contentType: COPY_TYPE, size: thumb.size },
  };
  // Sign first (no I/O): a signing error then leaves nothing behind.
  const uploads = Object.fromEntries(VARIANTS.map((variant) => {
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
         (id, event_date, kind, original_key, display_key, thumb_key, content_type, size_bytes,
          publicly_usable, status, uploaded_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10)`,
      [id, eventDate, kind, keys.original, keys.display, keys.thumb, original.contentType, original.size,
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
  thumb_key as "thumbKey", content_type as "contentType", size_bytes::int8 as "sizeBytes",
  publicly_usable as "publiclyUsable", status, uploaded_by as "uploadedBy", created_at as "createdAt"`;

async function getRow(db, id) {
  if (!isUuid(id)) throw new NotFoundError("media not found");
  const { rows } = await db.query(`select ${MEDIA_COLUMNS} from public.event_media where id = $1`, [id]);
  if (!rows.length) throw new NotFoundError("media not found");
  const r = rows[0];
  return { ...r, sizeBytes: Number(r.sizeBytes) };
}

/**
 * Confirm the three objects landed as signed, then pending -> ready.
 * @param {string} actorUserId
 * @param {import("./storage.mjs").Storage} storage
 * @param {string} id
 * @param {{ db: { query: Function } }} deps  the pool (reads outside the write transaction)
 * @returns {Promise<{ id: string, status: "ready" } | { id: string, status: "pending", problems: string[] }>}
 */
export async function completeUpload(actorUserId, storage, id, { db }) {
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
  };
  const keys = { original: row.originalKey, display: row.displayKey, thumb: row.thumbKey };

  const heads = await Promise.all(VARIANTS.map((v) => storage.headObject({ key: keys[v] })));
  const problems = [];
  VARIANTS.forEach((v, i) => {
    const h = heads[i];
    if (!h) return problems.push(`${v}: not uploaded`);
    const type = (h.contentType ?? "").split(";")[0].trim().toLowerCase();
    if (type !== expected[v].contentType) problems.push(`${v}: content type ${type || "missing"}, expected ${expected[v].contentType}`);
    const max = LIMITS[v];
    const sizeOk = expected[v].size === undefined ? h.contentLength > 0 && h.contentLength <= max : h.contentLength === expected[v].size;
    if (!sizeOk) problems.push(`${v}: ${h.contentLength} bytes, expected ${expected[v].size ?? `1 to ${max}`}`);
  });
  if (problems.length) return { id, status: "pending", problems };

  const updated = await withAudit(actorUserId, async (client) => {
    const r = await client.query(
      "update public.event_media set status = 'ready' where id = $1 and status = 'pending'", [id]);
    return r.rowCount;
  }, { action: "media.ready", targetTable: "event_media", targetId: id, details: { eventDate: row.eventDate, kind: row.kind } });
  if (updated !== 1) {
    // Raced with another complete (now ready: fine) or a delete (gone: 404).
    const again = await getRow(db, id);
    return { id, status: again.status === "ready" ? "ready" : "pending", ...(again.status === "ready" ? {} : { problems: ["state changed, try again"] }) };
  }
  return { id, status: "ready" };
}

/**
 * Social photos only: "OK to use publicly". Audited with the before/after value.
 * @param {string} actorUserId
 * @param {string} id
 * @param {boolean} value
 */
export async function setPubliclyUsable(actorUserId, id, value) {
  if (typeof value !== "boolean") throw new ValidationError(["publiclyUsable must be true or false"]);
  if (!isUuid(id)) throw new NotFoundError("media not found");
  return withAudit(actorUserId, async (client) => {
    const { rows } = await client.query(
      "select kind, publicly_usable, event_date::text as d from public.event_media where id = $1 for update", [id]);
    if (!rows.length) throw new NotFoundError("media not found");
    if (rows[0].kind !== "social_photo") throw new ValidationError(["publiclyUsable applies only to social_photo"]);
    await client.query("update public.event_media set publicly_usable = $2 where id = $1", [id, value]);
    return { id, eventDate: rows[0].d, before: rows[0].publicly_usable, publiclyUsable: value };
  }, (r) => ({
    action: "media.publicly_usable", targetTable: "event_media", targetId: id,
    details: { eventDate: r.eventDate, before: r.before, after: r.publiclyUsable },
  }));
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
    const { rows } = await client.query(
      `delete from public.event_media where id = $1
       returning event_date::text as "eventDate", kind, status, original_key, display_key, thumb_key`, [id]);
    if (!rows.length) throw new NotFoundError("media not found");
    return rows[0];
  }, (r) => ({
    action: "media.delete", targetTable: "event_media", targetId: id,
    details: { eventDate: r.eventDate, kind: r.kind, status: r.status, keys: [r.original_key, r.display_key, r.thumb_key].filter(Boolean) },
  }));

  const keys = [row.original_key, row.display_key, row.thumb_key].filter(Boolean);
  const results = await Promise.allSettled(keys.map((key) => storage.deleteObject({ key })));
  const leftovers = keys.filter((_, i) => results[i].status === "rejected");
  if (leftovers.length) {
    log(`[admin] media delete ${id}: row deleted, but these objects are still in the bucket: ${leftovers.join(", ")}`);
  }
  return { id, eventDate: row.eventDate, leftovers };
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
