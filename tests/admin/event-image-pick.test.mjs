// The Event Image picked from a recent Photo from Event (ticket #21, ADR 0012
// decision 3) against the throwaway database and MinIO (npm run test:db):
//   1. the schema (migration 20261128120000): events.event_image_media_id, a reference
//      that refuses the referenced photo's delete
//   2. src/lib/admin/event-image.mjs + media.mjs as admin_app: the picker list, pick
//      (audited, a reference not a copy), the 16:9 Event Image made for a photo without one,
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
const COVER = Buffer.from("\xff\xd8 a photo's 16:9 Event Image", "binary");

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
    `insert into event_media (id, event_date, kind, original_key, display_key, thumb_key, image_16x9_key, content_type,
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
    await owner?.query("delete from social_posts where event_date = any($1::date[])", [ds]);
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
    assert.equal(withCover.image16x9Key, `events/${ds[8]}/${second}/cover.jpg`);
    assert.equal(withCover.thumbKey, `events/${ds[8]}/${second}/thumb.jpg`);
    assert.equal(withCover.displayKey, `events/${ds[8]}/${second}/display.jpg`);
    assert.equal(list.find((p) => p.id === photos[ds[8]]).image16x9Key, null);

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
    assert.deepEqual(res, { changed: true, eventDate: d, mediaId: photo, needs16x9: false, replaced: null, leftovers: [] });
    assert.equal(await ref(d), photo, "the event row is created and points at the photo");
    assert.equal((await owner.query("select count(*)::int as n from event_media")).rows[0].n, before, "nothing copied");

    const img = await ei.getEventImage(pool, d);
    assert.equal(img.source, "referenced");
    assert.equal(img.mediaId, photo);
    assert.equal(img.eventDate, p);
    assert.deepEqual(img.original, { key: `events/${p}/${photo}/original.jpg`, contentType: "image/jpeg" });
    assert.deepEqual(img.image16x9, { key: `events/${p}/${photo}/cover.jpg`, contentType: "image/jpeg" });

    const picks = (await auditsFor(photo)).filter((x) => x.action === "event_image.pick");
    assert.equal(picks.length, 1);
    assert.equal(picks[0].actor_user_id, actor.id);
    assert.deepEqual(picks[0].details, { eventDate: d, mediaId: photo, photoDate: p, previous: null, replaced: null });

    // Picking the same photo again changes nothing and isn't audited again.
    const again = await ei.pickEventImage(actor.id, null, d, photo);
    assert.equal(again.changed, false);
    assert.equal((await auditsFor(photo)).filter((x) => x.action === "event_image.pick").length, 1);
  });

  test("a photo without a 16:9 Event Image is picked with image16x9 null and needs16x9", async () => {
    const [p, d] = dates(2);
    const photo = await seedPhoto(p);
    const res = await ei.pickEventImage(actor.id, null, d, photo);
    assert.equal(res.needs16x9, true);
    assert.equal((await ei.getEventImage(pool, d)).image16x9, null);
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

describe("deleting a photo that is an Event Image", () => {
  test("is refused, naming the events that use it; nothing is deleted or audited", async () => {
    const [p, d1, d2] = dates(3);
    const photo = await seedPhoto(p);
    await ei.pickEventImage(actor.id, null, d2, photo);
    await ei.pickEventImage(actor.id, null, d1, photo);
    const deletes = () => owner.query("select count(*)::int as n from audit_log where action = 'media.delete' and target_id = $1", [photo]).then((r) => r.rows[0].n);
    const objects = [];
    const fakeStorage = { deleteObject: async ({ key }) => { objects.push(key); } };

    await assert.rejects(media.deleteMedia(actor.id, fakeStorage, photo), (err) => {
      assert.equal(err.status, 409);
      assert.deepEqual(err.eventDates, [d1, d2]);
      assert.equal(err.message, `This photo is the Event Image for ${d1} and ${d2}, so it wasn't deleted. Pick another image for those events first.`);
      return true;
    });
    assert.ok(await row(photo));
    assert.deepEqual(objects, []);
    assert.equal(await deletes(), 0);
  });

  test("an unreferenced photo still deletes as before, its cover object too", async () => {
    const [p] = dates(1);
    const photo = await seedPhoto(p, { cover: true });
    const objects = [];
    const res = await media.deleteMedia(actor.id, { deleteObject: async ({ key }) => { objects.push(key); } }, photo);
    assert.equal(res.kind, "social_photo");
    assert.equal(await row(photo), undefined);
    assert.ok(objects.includes(`events/${p}/${photo}/cover.jpg`));
  });

  test("once the event picks something else, the photo deletes", async () => {
    const [p, d] = dates(2);
    const a = await seedPhoto(p);
    const b = await seedPhoto(p);
    await ei.pickEventImage(actor.id, null, d, a);
    await ei.pickEventImage(actor.id, null, d, b);
    await media.deleteMedia(actor.id, { deleteObject: async () => {} }, a);
    assert.equal(await row(a), undefined);
  });
  test("a photo that is both an Event Image and a Social Post cover: refused, the cover kept; once un-picked, the delete resets the cover", async () => {
    const [p, d] = dates(2);
    const photo = await seedPhoto(p);
    const other = await seedPhoto(p);
    await ei.pickEventImage(actor.id, null, d, photo);
    await owner.query("insert into social_posts (event_date, publish_at, cover_media_id) values ($1, now(), $2)", [d, photo]);
    const cover = () => owner.query("select cover_media_id from social_posts where event_date = $1", [d]).then((r) => r.rows[0].cover_media_id);

    await assert.rejects(media.deleteMedia(actor.id, { deleteObject: async () => {} }, photo), (err) => err.status === 409);
    assert.ok(await row(photo));
    assert.equal(await cover(), photo);

    await ei.pickEventImage(actor.id, null, d, other);
    await media.deleteMedia(actor.id, { deleteObject: async () => {} }, photo);
    assert.equal(await row(photo), undefined);
    assert.equal(await cover(), null); // back to the Event Image
  });
});

describe("switching and the 16:9 Event Image against MinIO", { skip }, () => {
  const ORIGINAL = Buffer.from("\x89PNG\r\n\x1a\n original", "binary");
  const DISPLAY = Buffer.from("\xff\xd8 display", "binary");
  const THUMB = Buffer.from("\xff\xd8 t", "binary");
  const FILES = { original: ORIGINAL, display: DISPLAY, thumb: THUMB, cover: COVER };
  async function upload(date) {
    const r = await media.startUpload(actor.id, storage(), {
      eventDate: date, kind: "event_image",
      original: { contentType: "image/png", size: ORIGINAL.length, width: 2000, height: 2000 },
      display: { size: DISPLAY.length }, thumb: { size: THUMB.length }, cover: { size: COVER.length },
    });
    for (const [v, bytes] of Object.entries(FILES)) {
      const u = r.uploads[v];
      assert.equal((await fetch(u.url, { method: u.method, headers: u.headers, body: bytes })).status, 200);
    }
    assert.equal((await media.completeUpload(actor.id, storage(), r.id, { db: pool })).status, "ready");
    return r.id;
  }
  // Uploads are limited to today+366: these events are in 2024, the photos in 2077 are
  // not offered to them (later than the event), so pick a photo seeded in 2024 too.
  const day2024 = (() => { let n = 0; return () => {
    const d = new Date(Date.UTC(2024, 6, 2) + (n++) * 86400000 * 3 + Math.floor(Math.random() * 3) * 86400000).toISOString().slice(0, 10);
    used.add(d);
    return d;
  }; })();

  test("uploaded -> picked -> uploaded -> picked -> default", async () => {
    const d = day2024();
    const photo = await seedPhoto(d, { cover: true });

    const up = await upload(d);
    const upRow = await row(up);
    const picked = await ei.pickEventImage(actor.id, storage(), d, photo);
    assert.equal(picked.replaced, up, "the upload gives way to the picked photo");
    assert.equal(await row(up), undefined);
    for (const k of [upRow.original_key, upRow.image_16x9_key]) assert.equal(await exists(k), false, k);
    assert.equal((await ei.getEventImage(pool, d)).source, "referenced");
    assert.equal((await auditsFor(photo)).find((x) => x.action === "event_image.pick").details.replaced, up);

    const up2 = await upload(d);
    assert.equal(await ref(d), null, "an upload drops the reference");
    const img = await ei.getEventImage(pool, d);
    assert.equal(img.source, "uploaded");
    assert.equal(img.mediaId, up2);

    await ei.pickEventImage(actor.id, storage(), d, photo);
    assert.equal((await ei.getEventImage(pool, d)).source, "referenced");
    const cleared = await ei.clearEventImage(actor.id, storage(), d);
    assert.equal(cleared.changed, true);
    assert.equal(cleared.mediaId, photo);
    assert.equal(await ref(d), null);
    assert.ok(await row(photo), "clearing a picked photo never deletes the photo");
    assert.equal((await ei.getEventImage(pool, d)).source, "default");
    const clear = (await auditsFor(photo)).find((x) => x.action === "event_image.clear");
    assert.deepEqual(clear.details, { eventDate: d, mediaId: photo, referenced: true, keys: [] });
    assert.equal((await ei.clearEventImage(actor.id, storage(), d)).changed, false);
  });

  test("a picked photo without a cover gets one: presigned PUT, then complete checks it and sets image_16x9_key (audited)", async () => {
    const [p, d] = dates(2);
    const photo = await seedPhoto(p);
    assert.equal((await ei.pickEventImage(actor.id, storage(), d, photo)).needs16x9, true);

    const start = await media.startImage16x9(actor.id, storage(), photo, { size: COVER.length });
    assert.equal(start.key, `events/${p}/${photo}/cover.jpg`);
    const early = await media.completeImage16x9(actor.id, storage(), photo, { db: pool });
    assert.deepEqual(early, { id: photo, status: "pending", problems: ["16:9 Event Image: not uploaded"] });
    assert.equal((await row(photo)).image_16x9_key, null);

    const res = await fetch(start.upload.url, { method: start.upload.method, headers: start.upload.headers, body: COVER });
    assert.equal(res.status, 200);
    assert.deepEqual(await media.completeImage16x9(actor.id, storage(), photo, { db: pool }), { id: photo, status: "ready", image16x9Key: start.key });
    assert.equal((await row(photo)).image_16x9_key, start.key);

    const img = await ei.getEventImage(pool, d);
    assert.deepEqual(img.image16x9, { key: start.key, contentType: "image/jpeg" });
    assert.deepEqual((await ei.load16x9Bytes(img, { storage: storage() })).bytes, COVER);
    const actions = (await auditsFor(photo)).map((x) => x.action);
    assert.deepEqual(actions.filter((a) => a.startsWith("media.cover")), ["media.cover_upload", "media.cover"]);
    const done = (await auditsFor(photo)).find((x) => x.action === "media.cover");
    assert.equal(done.actor_user_id, actor.id);
    assert.deepEqual(done.details, { eventDate: p, key: start.key });

    // Already has one: no second cover.
    await assert.rejects(media.startImage16x9(actor.id, storage(), photo, { size: COVER.length }), { status: 400 });
  });

  test("the cover: a wrong size stays pending; only for ready social photos; size within the cap", async () => {
    const [p] = dates(1);
    const photo = await seedPhoto(p);
    const start = await media.startImage16x9(actor.id, storage(), photo, { size: COVER.length + 1 });
    const put = await fetch(start.upload.url, { method: "PUT", headers: start.upload.headers, body: COVER });
    assert.equal(put.ok, false, "the bucket refuses a file of another size than signed");
    assert.equal((await media.completeImage16x9(actor.id, storage(), photo, { db: pool })).status, "pending");
    const board = await seedPhoto(p, { kind: "signin_board" });
    await assert.rejects(media.startImage16x9(actor.id, storage(), board, { size: 10 }), { status: 400 });
    await assert.rejects(media.startImage16x9(actor.id, storage(), photo, { size: 0 }), { status: 400 });
    await assert.rejects(media.startImage16x9(actor.id, storage(), photo, { size: media.LIMITS.cover + 1 }), { status: 400 });
    await assert.rejects(media.startImage16x9(actor.id, storage(), randomUUID(), { size: 10 }), { status: 404 });
  });
});

// ── 3. Over HTTP ────────────────────────────────────────────────────────────
describe("the picker form, the cover routes and the delete refusal over HTTP", { skip, timeout: 300_000 }, () => {
  let server;
  let admin;
  let social;

  let ipCounter = 0;
  const nextIp = () => `198.22.${Math.floor(++ipCounter / 250)}.${ipCounter % 250 + 1}`;
  async function signedIn(roles) {
    const user = await createUser({ email: `${unique("pick")}@example.com`, name: "Pick User", password: PASSWORD });
    for (const r of roles) await withAudit(null, (c) => grantRole(c, user.id, r), { action: "test.grant" });
    const res = await handleAuthRequest(new Request(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, "x-nf-client-connection-ip": nextIp() },
      body: JSON.stringify({ email: user.email, password: PASSWORD }),
    }));
    assert.equal(res.status, 200);
    const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).filter((c) => !c.endsWith("=")).join("; ");
    return { user, cookie };
  }
  const req = (path, { cookie, method = "GET", form, json, origin = BASE } = {}) => fetch(`${BASE}${path}`, {
    method,
    redirect: "manual",
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(method === "POST" ? { origin, "content-type": json ? "application/json" : "application/x-www-form-urlencoded" } : {}),
    },
    body: json ? JSON.stringify(json) : form ? new URLSearchParams(form).toString() : undefined,
  });

  before(async () => {
    const { dev } = await import("astro");
    const root = fileURLToPath(new URL("../..", import.meta.url));
    server = await dev({ root, logLevel: "error", server: { port, host: "localhost" } });
    admin = await signedIn(["admin"]);
    social = await signedIn(["social"]);
  });
  after(async () => { await server?.stop(); });

  test("the Event Info tab lists the recent photos as thumbnails in a pick form", async () => {
    const [p, d] = dates(2);
    const withCover = await seedPhoto(p, { cover: true });
    const without = await seedPhoto(p);
    const board = await seedPhoto(p, { kind: "signin_board" });
    const page = await (await req(`/admin/events/${d}/?tab=info`, { cookie: admin.cookie })).text();
    assert.match(page, /<form[^>]*action="\/api\/admin\/media\/event-image\/pick"/);
    // Collapsed on load: a closed <details> whose summary opens the picker (issue #37).
    const picker = page.match(/<details\b[^>]*>[\s\S]*?<\/details>/)?.[0] ?? "";
    assert.match(picker, /<summary\b[^>]*>[\s\S]*Or pick a Photo from Event[\s\S]*<\/summary>/, "the summary names the picker");
    assert.ok(!/<details\b[^>]*\bopen\b/.test(picker), "closed on load");
    assert.match(picker, /<form[^>]*data-event-image-pick/, "the pick form is inside it");
    const origin = new URL(process.env.STORAGE_ENDPOINT).host;
    const imgs = [...page.matchAll(/<img[^>]*src="([^"]+)"/g)].map((x) => x[1].replaceAll("&amp;", "&"));
    assert.ok(imgs.some((u) => u.includes(origin) && u.includes(`${withCover}/thumb.jpg`)), "thumbnail");
    assert.ok(imgs.some((u) => u.includes(`${without}/thumb.jpg`)));
    assert.ok(!page.includes(board), "a sign-in board photo isn't offered");
    assert.match(page, new RegExp(`<input[^>]*name="mediaId"[^>]*value="${without}"[^>]*data-needs-16x9|data-needs-16x9[^>]*value="${without}"`));
    assert.ok(!new RegExp(`value="${withCover}"[^>]*data-needs-16x9`).test(page));
  });

  test("picking posts back to the Event Info tab; the page shows the photo, and clear un-picks it", async () => {
    const [p, d] = dates(2);
    const photo = await seedPhoto(p, { cover: true });
    const res = await req("/api/admin/media/event-image/pick", { cookie: admin.cookie, method: "POST", form: { eventDate: d, mediaId: photo } });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), `/admin/events/${d}/?tab=info&media=event-image-picked#event-image`);
    assert.equal(await ref(d), photo);
    const page = await (await req(res.headers.get("location"), { cookie: admin.cookie })).text();
    assert.match(page, /Event Image set to a photo from the event\./);
    assert.match(page, new RegExp(`A photo from the ${p} event`));
    const imgs = [...page.matchAll(/<img[^>]*src="([^"]+)"/g)].map((x) => x[1].replaceAll("&amp;", "&"));
    assert.ok(imgs.some((u) => u.includes(`${photo}/cover.jpg`)), "the 16:9 preview is the photo's cover");
    const links = [...page.matchAll(/<a[^>]*href="([^"]+)"[^>]*download/g)].map((x) => x[1].replaceAll("&amp;", "&"));
    assert.ok(links.some((u) => u.includes(`${photo}/original.jpg`)), "download the referenced photo's original");
    assert.match(page, /action="\/api\/admin\/media\/event-image\/clear"/);

    const cleared = await req("/api/admin/media/event-image/clear", { cookie: admin.cookie, method: "POST", form: { eventDate: d } });
    assert.equal(cleared.headers.get("location"), `/admin/events/${d}/?tab=info&media=event-image-cleared#event-image`);
    assert.equal(await ref(d), null);
    assert.ok(await row(photo));
  });

  test("the pick form: admin only, Origin-checked, POST only; a photo not offered is 400", async () => {
    const [p, d] = dates(2);
    const photo = await seedPhoto(p);
    const board = await seedPhoto(p, { kind: "signin_board" });
    const form = { eventDate: d, mediaId: photo };
    const path = "/api/admin/media/event-image/pick";
    assert.equal((await req(path, { method: "POST", form })).status, 401);
    assert.equal((await req(path, { cookie: social.cookie, method: "POST", form })).status, 403);
    assert.equal((await req(path, { cookie: admin.cookie, method: "POST", form, origin: "https://evil.example" })).status, 403);
    assert.equal((await req(path, { cookie: admin.cookie })).status, 405);
    assert.equal((await req(path, { cookie: admin.cookie, method: "POST", form: { eventDate: d, mediaId: board } })).status, 400);
    assert.equal((await req(path, { cookie: admin.cookie, method: "POST", form: { eventDate: "2077-02-30", mediaId: photo } })).status, 400);
    assert.equal(await ref(d), null);
  });

  test("the cover routes: start gives a presigned PUT, complete sets the cover (JSON, admin only)", async () => {
    const [p] = dates(1);
    const photo = await seedPhoto(p);
    assert.equal((await req(`/api/admin/media/${photo}/cover`, { cookie: social.cookie, method: "POST", json: { size: COVER.length } })).status, 403);
    const start = await req(`/api/admin/media/${photo}/cover`, { cookie: admin.cookie, method: "POST", json: { size: COVER.length } });
    assert.equal(start.status, 201);
    const plan = await start.json();
    const pending = await req(`/api/admin/media/${photo}/cover-complete`, { cookie: admin.cookie, method: "POST", json: {} });
    assert.equal(pending.status, 409);
    assert.equal((await fetch(plan.upload.url, { method: "PUT", headers: plan.upload.headers, body: COVER })).status, 200);
    const done = await req(`/api/admin/media/${photo}/cover-complete`, { cookie: admin.cookie, method: "POST", json: {} });
    assert.equal(done.status, 200);
    assert.deepEqual(await done.json(), { id: photo, status: "ready", image16x9Key: `events/${p}/${photo}/cover.jpg` });
    assert.equal((await req(`/api/admin/media/${photo}/cover`, { cookie: admin.cookie, method: "POST", json: { size: 5 } })).status, 400);
  });

  test("deleting a referenced photo from the gallery is refused with a message naming the event", async () => {
    const [p, d] = dates(2);
    const photo = await seedPhoto(p);
    await ei.pickEventImage(actor.id, null, d, photo);
    const res = await req(`/api/admin/media/${photo}/delete`, { cookie: admin.cookie, method: "POST", form: {} });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), `/admin/events/${p}/?tab=post&media=in-use&used-by=${d}#event-media`);
    assert.ok(await row(photo));
    const page = await (await req(res.headers.get("location"), { cookie: admin.cookie })).text();
    assert.match(page, new RegExp(`This photo is the Event Image for ${d}, so it wasn&#39;t deleted\\.|This photo is the Event Image for ${d}, so it wasn't deleted\\.`));

    const asJson = await req(`/api/admin/media/${photo}/delete`, { cookie: admin.cookie, method: "POST", json: {} });
    assert.equal(asJson.status, 409);
    assert.deepEqual((await asJson.json()).eventDates, [d]);

    // Unreferenced: deletes as before.
    await ei.clearEventImage(actor.id, storage(), d);
    const ok = await req(`/api/admin/media/${photo}/delete`, { cookie: admin.cookie, method: "POST", form: {} });
    assert.equal(ok.headers.get("location"), `/admin/events/${p}/?tab=post&media=deleted#event-media`);
    assert.equal(await row(photo), undefined);
  });
});
