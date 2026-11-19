// The Social Post cover image (ticket #22) against the throwaway database
// (npm run test:db):
//   1. migration 20261127120000_social_post_cover.sql: the nullable cover reference,
//      which may only point at event_media and is cleared when that media is deleted
//   2. src/lib/admin/social.mjs as admin_app: the cover resolves to the Event Image (the
//      logo default or an uploaded one); setCover sets and clears an override, each
//      audited; only a ready, publicly usable Photo from Event can be chosen; the video
//      is still what blocks ready
//   3. the Cover image block of the Social post section over HTTP (astro dev)
// The pure resolution is in social-unit.test.mjs; the work order's cover link in
// social-orders.test.mjs.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { OWNER_URL, assertRefused, connect, inRollback, unique, useAdminEnv } from "./helpers.mjs";

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
const so = await import("../../src/lib/admin/social.mjs");
const media = await import("../../src/lib/admin/media.mjs");
const el = await import("../../src/lib/admin/event-links.mjs");

const PASSWORD = "correct horse battery staple";
let owner, actor;

// Tuesdays far ahead, so every publish time is in the future, one per call, starting
// at a random week so a rerun against a database kept up doesn't collide. Kept within
// 2086-2090: social-orders.test.mjs (which runs after this file) lists every upcoming
// post from 2091 on, so posts made here must be earlier than its dates.
let n = randomInt(0, 50);
const date = () => new Date(Date.UTC(2086, 0, 1 + 7 * n++)).toISOString().slice(0, 10);
let h = 100 + randomInt(0, 60);
const httpDate = () => new Date(Date.UTC(2086, 0, 1 + 7 * h++)).toISOString().slice(0, 10);

const postRow = (d) => owner.query(`select * from social_posts where event_date = $1`, [d]).then((r) => r.rows[0] ?? null);
const coverAudits = (d) => owner.query(
  `select actor_user_id, action, details from audit_log
    where target_id = $1 and action = 'social_post.cover' order by id`, [d]).then((r) => r.rows);

/** A media row inserted as the owner (no bucket needed). */
async function insertMedia(d, { kind = "social_photo", status = "ready" } = {}) {
  const id = randomUUID();
  const video = kind === "promo_video";
  const base = `events/${d}/${id}`;
  await owner.query(`insert into events (event_date) values ($1) on conflict do nothing`, [d]);
  await owner.query(
    `insert into event_media (id, event_date, kind, original_key, display_key, thumb_key, cover_key, content_type, size_bytes, status, publicly_usable)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 4800000, $9, $10)`,
    [id, d, kind, `${base}/original.${video ? "mp4" : "jpg"}`, video ? null : `${base}/display.jpg`, video ? null : `${base}/thumb.jpg`,
      kind === "event_image" ? `${base}/cover.jpg` : null, video ? "video/mp4" : "image/jpeg", status, kind === "social_photo"]);
  return id;
}

let ipCounter = 0;
const nextIp = () => `198.22.${Math.floor(++ipCounter / 250)}.${ipCounter % 250 + 1}`;
async function signedIn(roles) {
  const user = await createUser({ email: `${unique("cov")}@example.com`, name: "Cover Test", password: PASSWORD });
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

before(async () => {
  owner = await connect(OWNER_URL);
  actor = await createUser({ email: `${unique("cover")}@example.com`, name: "Cover Admin", password: PASSWORD });
});
after(async () => { await owner?.end(); await pool.end(); });

// ── 1. Migration ────────────────────────────────────────────────────────────
describe("migration 20261127120000_social_post_cover.sql", () => {
  test("cover_media_id is nullable, must be event_media, and is cleared when that media is deleted", async () => {
    const { rows: [col] } = await owner.query(
      `select is_nullable, data_type from information_schema.columns
        where table_schema = 'public' and table_name = 'social_posts' and column_name = 'cover_media_id'`);
    assert.deepEqual(col, { is_nullable: "YES", data_type: "uuid" });
    const d = date();
    const photo = await insertMedia(d);
    await inRollback(owner, async () => {
      await owner.query(`insert into social_posts (event_date, publish_at) values ($1, now())`, [d]);
      await assertRefused(owner, `update social_posts set cover_media_id = $2 where event_date = $1`, [d, randomUUID()], /foreign key/);
      await owner.query(`update social_posts set cover_media_id = $2 where event_date = $1`, [d, photo]);
      await owner.query(`delete from event_media where id = $1`, [photo]);
      assert.equal((await postRow(d)).cover_media_id, null);
    });
  });
});

// ── 2. The module ───────────────────────────────────────────────────────────
describe("social cover (admin_app)", () => {
  test("no override: the cover is the Event Image, the logo by default, then an uploaded one", async () => {
    const d = date();
    const none = await so.getWorkOrder(pool, d);
    assert.deepEqual([none.cover.source, none.cover.eventImageSource, none.cover.file.path],
      ["event_image", "default", "/assets/images/brand/bocc-logo-square.png"]);
    const img = await insertMedia(d, { kind: "event_image" });
    const up = await so.getWorkOrder(pool, d);
    assert.deepEqual([up.cover.source, up.cover.eventImageSource, up.cover.mediaId, up.cover.file.key],
      ["event_image", "uploaded", img, `events/${d}/${img}/display.jpg`]);
  });

  test("setCover: set, change and clear an override, each audited; clearing returns to the Event Image", async () => {
    const [d, earlier] = [date(), date()];
    const mine = await insertMedia(d);
    const old = await insertMedia(earlier);
    const r1 = await so.setCover(actor.id, d, mine);
    assert.deepEqual(r1, { changed: true, eventCreated: false });
    assert.equal((await postRow(d)).cover_media_id, mine);
    let w = await so.getWorkOrder(pool, d);
    assert.deepEqual([w.cover.source, w.cover.mediaId, w.cover.file.key], ["override", mine, `events/${d}/${mine}/display.jpg`]);
    assert.deepEqual(await so.setCover(actor.id, d, mine), { changed: false, eventCreated: false });

    await so.setCover(actor.id, d, old); // a photo from another event is fine
    assert.equal((await so.getWorkOrder(pool, d)).cover.eventDate, earlier);

    assert.deepEqual(await so.setCover(actor.id, d, ""), { changed: true, eventCreated: false });
    w = await so.getWorkOrder(pool, d);
    assert.deepEqual([w.cover.source, w.cover.eventImageSource], ["event_image", "default"]);
    assert.deepEqual(await so.setCover(actor.id, d, ""), { changed: false, eventCreated: false });

    const a = await coverAudits(d);
    assert.deepEqual(a.map((x) => [x.actor_user_id, x.details.before.cover_media_id, x.details.after.cover_media_id]), [
      [actor.id, null, mine], [actor.id, mine, old], [actor.id, old, null],
    ]);
    assert.equal(a[0].details.created, true, "the first set creates the post");
  });

  test("clearing with no post creates nothing", async () => {
    const d = date();
    assert.deepEqual(await so.setCover(actor.id, d, ""), { changed: false, eventCreated: false });
    assert.equal(await postRow(d), null);
    assert.deepEqual(await coverAudits(d), []);
  });

  test("only a ready, publicly usable Photo from Event can be the cover", async () => {
    const d = date();
    const video = await insertMedia(d, { kind: "promo_video" });
    const board = await insertMedia(d, { kind: "signin_board" });
    const img = await insertMedia(d, { kind: "event_image" });
    const pending = await insertMedia(d, { status: "pending" });
    for (const id of [video, board, img, randomUUID()]) {
      await assert.rejects(so.setCover(actor.id, d, id), (e) => /isn't a Photo from Event/.test(e.errors.cover), id);
    }
    await assert.rejects(so.setCover(actor.id, d, pending), (e) => /finished uploading/.test(e.errors.cover));
    await assert.rejects(so.setCover(actor.id, d, "nope"), (e) => /Choose a photo/.test(e.errors.cover));
    assert.equal(await postRow(d), null, "nothing created");
  });

  test("the video is still required for ready; the cover doesn't change that", async () => {
    const d = date();
    await el.setLink(actor.id, d, "luma", { url: "https://luma.com/bocc-cover", externalId: "" });
    await so.setCover(actor.id, d, await insertMedia(d));
    await assert.rejects(so.savePost(actor.id, d, { baseCaption: "Coffee", ready: "on" }),
      (e) => e.errors.ready === "Not ready yet: Upload the promo video.");
    await so.setVideo(actor.id, d, await insertMedia(d, { kind: "promo_video" }));
    assert.deepEqual((await so.savePost(actor.id, d, { baseCaption: "Coffee", ready: "on" })).changed, true);
  });

  test("deleting the override photo returns the cover to the Event Image", async () => {
    const d = date();
    const photo = await insertMedia(d);
    await so.setCover(actor.id, d, photo);
    await media.deleteMedia(actor.id, { deleteObject: async () => {} }, photo);
    assert.equal((await so.getWorkOrder(pool, d)).cover.source, "event_image");
  });

  test("listCoverChoices: ready, publicly usable photos of this and earlier events, newest first", async () => {
    const [a, b, c] = [date(), date(), date()];
    const pa = await insertMedia(a);
    const pb = await insertMedia(b);
    await insertMedia(b, { status: "pending" });
    await insertMedia(b, { kind: "signin_board" });
    await insertMedia(c); // after b: not offered for b
    const got = (await so.listCoverChoices(pool, b)).filter((p) => [a, b, c].includes(p.eventDate));
    assert.deepEqual(got.map((p) => p.id), [pb, pa]);
    assert.deepEqual(Object.keys(got[0]).sort(), ["contentType", "eventDate", "id", "thumbKey"]);
  });
});

// ── 3. Over HTTP ────────────────────────────────────────────────────────────
// Needs MinIO: the photo choices are only offered when media storage is set up.
const skip = process.env.STORAGE_ENDPOINT ? false : "MinIO not running (STORAGE_ENDPOINT unset)";
describe("the Cover image block over HTTP", { timeout: 300_000, skip }, () => {
  let server, admin, social;
  const root = fileURLToPath(new URL("../../", import.meta.url));

  before(async () => {
    const { dev } = await import("astro");
    server = await dev({ root, logLevel: "error", server: { port, host: "localhost" } });
    admin = await signedIn(["admin"]);
    social = await signedIn(["social"]);
  });
  after(async () => { await server?.stop(); });

  const req = (path, { cookie, method = "GET", form, origin = BASE } = {}) => {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    let body;
    if (method === "POST") {
      if (origin) headers.origin = origin;
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(form ?? {}).toString();
    }
    return fetch(`${BASE}${path}`, { method, headers, body, redirect: "manual" });
  };

  test("the block shows the Event Image by default; set and clear the override (PRG); refusals", async () => {
    const d = httpDate();
    const photo = await insertMedia(d);
    const page = await (await req(`/admin/events/${d}/?tab=social`, { cookie: admin.cookie })).text();
    assert.ok(page.includes('id="social-cover"'));
    assert.ok(page.includes("Event Image (the BOCC logo)"), "the default is named");
    assert.ok(page.includes(`value="${photo}"`), "the photo is offered");

    const set = await req(`/admin/events/${d}/`, { cookie: admin.cookie, method: "POST", form: { action: "social_cover", mediaId: photo } });
    assert.equal(set.status, 303);
    assert.equal(set.headers.get("location"), `/admin/events/${d}/?tab=social&notice=social_cover#social-cover`);
    assert.equal((await postRow(d)).cover_media_id, photo);
    const after = await (await req(`/admin/events/${d}/?tab=social&notice=social_cover`, { cookie: admin.cookie })).text();
    assert.ok(after.includes("Cover image saved."));
    assert.ok(after.includes(`Photo from Event (${d})`));
    assert.ok(after.includes("Use the Event Image"));

    const clear = await req(`/admin/events/${d}/`, { cookie: admin.cookie, method: "POST", form: { action: "social_cover", mediaId: "" } });
    assert.equal(clear.status, 303);
    assert.equal((await postRow(d)).cover_media_id, null);

    const bad = await req(`/admin/events/${d}/`, { cookie: admin.cookie, method: "POST",
      form: { action: "social_cover", mediaId: await insertMedia(d, { kind: "signin_board" }) } });
    assert.equal(bad.status, 400);
    assert.match(await bad.text(), /t a Photo from Event/);

    const soc = await req(`/admin/events/${d}/`, { cookie: social.cookie, method: "POST", form: { action: "social_cover", mediaId: photo } });
    assert.equal(soc.status, 403);
    const wrong = await req(`/admin/events/${d}/`, { cookie: admin.cookie, method: "POST", origin: "https://evil.example",
      form: { action: "social_cover", mediaId: photo } });
    assert.equal(wrong.status, 403);
    assert.equal((await postRow(d)).cover_media_id, null, "neither wrote anything");
  });
});
