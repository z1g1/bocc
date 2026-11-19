// The Event Image picked from a recent Photo from Event (ticket #21, ADR 0012
// decision 3) against the throwaway database and MinIO (npm run test:db):
//   1. the schema (migration 20261126120000): events.event_image_media_id, a reference
//      that refuses the referenced photo's delete
//   2. src/lib/admin/event-image.mjs + media.mjs as admin_app: the picker list, pick
//      (audited, a reference not a copy), the 16:9 cover made for a photo without one,
//      switching between uploaded / picked / default, the delete refusal
//   3. the picker form and the delete refusal over HTTP through a real `astro dev`
// Photos are seeded as the owner on dates in 2077 (the picker reads "the last 8 events
// on or before this one", so the seeded run of dates is all it sees from a 2077 date).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { ADMIN_URL, OWNER_URL, assertAllowed, assertRefused, connect, inRollback, unique, useAdminEnv } from "./helpers.mjs";

const skip = process.env.STORAGE_ENDPOINT ? false : "MinIO not running (STORAGE_ENDPOINT unset)";

const port = await new Promise((resolve, reject) => {
  const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  s.on("error", reject);
});
const BASE = `http://localhost:${port}`;
useAdminEnv();
process.env.BETTER_AUTH_URL = BASE;
process.env.ASTRO_TELEMETRY_DISABLED = "1";

const { pool } = await import("../../src/lib/auth/auth.mjs");
const { handleAuthRequest } = await import("../../src/lib/auth/handler.mjs");
const { withAudit } = await import("../../src/lib/admin/db.mjs");
const { createUser, grantRole } = await import("../../src/lib/admin/users.mjs");
const { getStorage } = await import("../../src/lib/admin/storage.mjs");
const media = await import("../../src/lib/admin/media.mjs");
const ei = await import("../../src/lib/admin/event-image.mjs");

const PASSWORD = "correct horse battery staple";
const COVER = Buffer.from("\xff\xd8 a photo's 16:9 cover", "binary");

let owner;
let actor;
const storage = () => getStorage().storage;

// Each describe gets its own run of dates in 2077, a week apart.
let nextDay = 0;
const used = new Set();
function dates(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2077, 0, 5) + (nextDay++) * 7 * 86400000).toISOString().slice(0, 10);
    used.add(d);
    out.push(d);
  }
  return out;
}
const ensureEvent = (d) => owner.query("insert into events (event_date) values ($1) on conflict do nothing", [d]);

/** Seed a ready Photo from Event (or another kind) as the owner. */
async function seedPhoto(d, { kind = "social_photo", cover = false, status = "ready" } = {}) {
  await ensureEvent(d);
  const id = randomUUID();
  const k = (v, ext = "jpg") => `events/${d}/${id}/${v}.${ext}`;
  await owner.query(
    `insert into event_media (id, event_date, kind, original_key, display_key, thumb_key, cover_key, content_type,
                              size_bytes, publicly_usable, status)
     values ($1, $2, $3, $4, $5, $6, $7, 'image/jpeg', 10, $8, $9)`,
    [id, d, kind, k("original"), k("display"), k("thumb"), cover ? k("cover") : null, kind === "social_photo", status]);
  return id;
}
const row = (id) => owner.query("select * from event_media where id = $1", [id]).then((r) => r.rows[0]);
const ref = (d) => owner.query("select event_image_media_id from events where event_date = $1", [d]).then((r) => r.rows[0]?.event_image_media_id ?? null);
const auditsFor = (id) => owner.query("select actor_user_id, action, details from audit_log where target_id = $1 order by id", [id]).then((r) => r.rows);
const exists = async (key) => (await storage().headObject({ key })) !== null;

before(async () => {
  owner = await connect(OWNER_URL);
  actor = await createUser({ email: `${unique("pickactor")}@example.com`, name: "Pick Actor", password: PASSWORD });
});
after(async () => {
  const ds = [...used];
  try {
    await owner?.query("update events set event_image_media_id = null where event_date = any($1::date[])", [ds]);
    await owner?.query("delete from event_media where event_date = any($1::date[])", [ds]);
    await owner?.query("delete from events where event_date = any($1::date[])", [ds]);
  } finally {
    await owner?.end();
    await pool.end();
  }
});

// ── 1. Schema ───────────────────────────────────────────────────────────────
describe("schema: the Event Image reference", () => {
  test("admin_app can set and clear an event's reference to a photo", async () => {
    const [p, d] = dates(2);
    const photo = await seedPhoto(p);
    await ensureEvent(d);
    const admin = await connect(ADMIN_URL);
    try {
      await inRollback(admin, async () => {
        await assertAllowed(admin, "update events set event_image_media_id = $1 where event_date = $2", [photo, d]);
        await assertAllowed(admin, "update events set event_image_media_id = null where event_date = $1", [d]);
      });
    } finally {
      await admin.end();
    }
  });

  test("a referenced photo can't be deleted, even straight in SQL", async () => {
    const [p, d] = dates(2);
    const photo = await seedPhoto(p);
    await ensureEvent(d);
    const admin = await connect(ADMIN_URL);
    try {
      await inRollback(admin, async () => {
        await admin.query("update events set event_image_media_id = $1 where event_date = $2", [photo, d]);
        await assertRefused(admin, "delete from event_media where id = $1", [photo], /events_event_image_media_id_fkey/);
      });
    } finally {
      await admin.end();
    }
  });
});

// ── 2. Data module ──────────────────────────────────────────────────────────
describe("the picker: publicly usable photos from about the last 8 events", () => {
  test("lists ready social photos of the 8 most recent events with photos, on or before this one, newest first", async () => {
    const ds = dates(11); // ds[0] oldest … ds[10] the event being edited
    const target = ds[10];
    const photos = {};
    for (const d of ds.slice(0, 10)) photos[d] = await seedPhoto(d);
    // Never listed: a sign-in board photo, a pending upload.
    const board = await seedPhoto(ds[9], { kind: "signin_board" });
    const pending = await seedPhoto(ds[9], { status: "pending" });
    await ensureEvent(target);
    const second = await seedPhoto(ds[8], { cover: true });

    const list = await ei.listPickablePhotos(pool, target);
    const ids = list.map((p) => p.id);
    assert.ok(!ids.includes(board) && !ids.includes(pending));
    assert.deepEqual([...new Set(list.map((p) => p.eventDate))], ds.slice(2, 10).reverse(), "the 8 most recent dates, newest first");
    assert.ok(ids.includes(photos[ds[2]]) && !ids.includes(photos[ds[1]]));
    const withCover = list.find((p) => p.id === second);
    assert.equal(withCover.coverKey, `events/${ds[8]}/${second}/cover.jpg`);
    assert.equal(withCover.thumbKey, `events/${ds[8]}/${second}/thumb.jpg`);
    assert.equal(withCover.displayKey, `events/${ds[8]}/${second}/display.jpg`);
    assert.equal(list.find((p) => p.id === photos[ds[8]]).coverKey, null);

    // From an earlier event, later photos aren't offered.
    const earlier = await ei.listPickablePhotos(pool, ds[3]);
    assert.deepEqual([...new Set(earlier.map((p) => p.eventDate))].slice(0, 4), [ds[3], ds[2], ds[1], ds[0]]);
  });
});

describe("pick a photo as the Event Image", () => {
  test("sets a reference (no copy), audited; the image resolves to the photo's own files", async () => {
    const [p, d] = dates(2);
    const photo = await seedPhoto(p, { cover: true });
    const before = (await owner.query("select count(*)::int as n from event_media")).rows[0].n;

    const res = await ei.pickEventImage(actor.id, null, d, photo);
    assert.deepEqual(res, { changed: true, eventDate: d, mediaId: photo, needsCover: false, replaced: null, leftovers: [] });
    assert.equal(await ref(d), photo, "the event row is created and points at the photo");
    assert.equal((await owner.query("select count(*)::int as n from event_media")).rows[0].n, before, "nothing copied");

    const img = await ei.getEventImage(pool, d);
    assert.equal(img.source, "referenced");
    assert.equal(img.mediaId, photo);
    assert.equal(img.eventDate, p);
    assert.deepEqual(img.original, { key: `events/${p}/${photo}/original.jpg`, contentType: "image/jpeg" });
    assert.deepEqual(img.cover, { key: `events/${p}/${photo}/cover.jpg`, contentType: "image/jpeg" });

    const picks = (await auditsFor(photo)).filter((x) => x.action === "event_image.pick");
    assert.equal(picks.length, 1);
    assert.equal(picks[0].actor_user_id, actor.id);
    assert.deepEqual(picks[0].details, { eventDate: d, mediaId: photo, photoDate: p, previous: null, replaced: null });

    // Picking the same photo again changes nothing and isn't audited again.
    const again = await ei.pickEventImage(actor.id, null, d, photo);
    assert.equal(again.changed, false);
    assert.equal((await auditsFor(photo)).filter((x) => x.action === "event_image.pick").length, 1);
  });

  test("a photo without a 16:9 cover is picked with cover null and needsCover", async () => {
    const [p, d] = dates(2);
    const photo = await seedPhoto(p);
    const res = await ei.pickEventImage(actor.id, null, d, photo);
    assert.equal(res.needsCover, true);
    assert.equal((await ei.getEventImage(pool, d)).cover, null);
  });

  test("picking another photo switches the reference (audited with the previous one)", async () => {
    const [p, d] = dates(2);
    const a = await seedPhoto(p);
    const b = await seedPhoto(p);
    await ei.pickEventImage(actor.id, null, d, a);
    await ei.pickEventImage(actor.id, null, d, b);
    assert.equal(await ref(d), b);
    const pick = (await auditsFor(b)).find((x) => x.action === "event_image.pick");
    assert.equal(pick.details.previous, a);
  });

  test("refuses what the picker doesn't offer: a sign-in board photo, a pending one, an unknown id, a bad date", async () => {
    const [p, d] = dates(2);
    const board = await seedPhoto(p, { kind: "signin_board" });
    const pending = await seedPhoto(p, { status: "pending" });
    for (const id of [board, pending, randomUUID(), "nope"]) {
      await assert.rejects(ei.pickEventImage(actor.id, null, d, id), { status: 400 }, String(id));
    }
    await assert.rejects(ei.pickEventImage(actor.id, null, "2077-02-30", await seedPhoto(p)), { status: 400 });
    assert.equal(await ref(d), null);
  });

  test("refuses a photo from too long ago (not among the last 8 events)", async () => {
    const ds = dates(10);
    const old = await seedPhoto(ds[0]);
    for (const d of ds.slice(1, 9)) await seedPhoto(d);
    await assert.rejects(ei.pickEventImage(actor.id, null, ds[9], old), { status: 400 });
  });
});
