// The Event Image (ADR 0012 decision 3) against the throwaway database and MinIO
// (npm run test:db):
//   1. the schema (migration 20261125120000): the event_image kind and its cover copy,
//      at most one ready per event, admin_app's grants
//   2. src/lib/admin/media.mjs + event-image.mjs as admin_app: upload with the 16:9
//      cover, replace, clear, each audited; resolution back to the logo; the cover's
//      bytes read on the server (for the LinkedIn upload)
//   3. the event page and the clear form over HTTP through a real `astro dev`
// Dates are random days in 2024 (inside the upload API's allowed range).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { ADMIN_URL, OWNER_URL, assertAllowed, assertRefused, connect, inRollback, unique, useAdminEnv } from "./helpers.mjs";

/** The text a reader gets from the page's Event Image section (alt texts included, markup dropped). */
const sectionText = (page) => (page.match(/<section\b[^>]*id="event-image"[\s\S]*?<\/section>/)?.[0] ?? "")
  .replace(/<(script|style)\b[\s\S]*?<\/\1>/g, " ")
  .replace(/<[^>]*\balt="([^"]*)"[^>]*>/g, " $1 ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");


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
// Stand-ins for the files (MinIO stores bytes; it doesn't decode them).
const ORIGINAL = Buffer.from("\x89PNG\r\n\x1a\n original bytes", "binary");
const DISPLAY = Buffer.from("\xff\xd8 display", "binary");
const THUMB = Buffer.from("\xff\xd8 t", "binary");
const COVER = Buffer.from("\xff\xd8 the 16:9 Event Image", "binary");
const FILES = { original: ORIGINAL, display: DISPLAY, thumb: THUMB, cover: COVER };

let owner;
let actor;
const storage = () => getStorage().storage;

async function freshDate() {
  for (;;) {
    const d = new Date(Date.UTC(2024, 0, 1) + Math.floor(Math.random() * 365) * 86400000).toISOString().slice(0, 10);
    const { rowCount } = await owner.query("select 1 from events where event_date = $1", [d]);
    if (rowCount === 0 && !used.has(d)) { used.add(d); return d; }
  }
}
// The uploads create `scheduled` events in the past, which would show as "report
// missing" and crowd other files' dates off the 25-row past list: removed in after().
const used = new Set();
const body = (eventDate, over = {}) => ({
  eventDate, kind: "event_image",
  original: { contentType: "image/png", size: ORIGINAL.length, width: 2000, height: 2000 },
  display: { size: DISPLAY.length }, thumb: { size: THUMB.length }, cover: { size: COVER.length },
  ...over,
});
const putAll = async (uploads, files = FILES) => {
  for (const [variant, bytes] of Object.entries(files)) {
    const u = uploads[variant];
    const res = await fetch(u.url, { method: u.method, headers: u.headers, body: bytes });
    assert.equal(res.status, 200, `${variant}: ${await res.text()}`);
  }
};
/** Upload an Event Image all the way to ready. */
async function upload(date) {
  const r = await media.startUpload(actor.id, storage(), body(date));
  await putAll(r.uploads);
  assert.deepEqual(await media.completeUpload(actor.id, storage(), r.id, { db: pool }), { id: r.id, status: "ready" });
  return r.id;
}
const row = (id) => owner.query("select * from event_media where id = $1", [id]).then((r) => r.rows[0]);
const auditsFor = (id) => owner.query("select actor_user_id, action, details from audit_log where target_id = $1 order by id", [id]).then((r) => r.rows);
const exists = async (key) => (await storage().headObject({ key })) !== null;

before(async () => {
  owner = await connect(OWNER_URL);
  actor = await createUser({ email: `${unique("eiactor")}@example.com`, name: "Event Image Actor", password: PASSWORD });
});
after(async () => {
  const dates = [...used];
  await owner?.query("delete from event_media where event_date = any($1::date[])", [dates]);
  await owner?.query("delete from events where event_date = any($1::date[])", [dates]);
  await owner?.end();
  await pool.end();
});

// ── 1. Schema ───────────────────────────────────────────────────────────────
describe("schema: event_image kind and 16:9 Event Image copy", () => {
  const insert = `insert into event_media (event_date, kind, original_key, display_key, thumb_key, image_16x9_key, content_type, size_bytes, status)
                  values ($1, $2, $3, $4, $5, $6, 'image/png', 10, $7)`;
  const keys = (d) => { const id = randomUUID(); return [`events/${d}/${id}/original.png`, `events/${d}/${id}/display.jpg`, `events/${d}/${id}/thumb.jpg`, `events/${d}/${id}/cover.jpg`]; };

  test("an event_image row needs all four copies; the cover is only for event_image and event_photo", async () => {
    const d = await freshDate();
    await inRollback(owner, async () => {
      await owner.query("insert into events (event_date) values ($1)", [d]);
      await assertAllowed(owner, insert, [d, "event_image", ...keys(d), "ready"]);
      const [o, di, t] = keys(d);
      await assertRefused(owner, insert, [d, "event_image", o, di, t, null, "pending"], /event_media_image_16x9_ck/);
      await assertRefused(owner, insert, [d, "signin_board", ...keys(d), "ready"], /event_media_image_16x9_ck/);
      await assertAllowed(owner, insert, [d, "event_photo", ...keys(d), "ready"]);
    });
  });

  test("at most one ready Event Image per event; pending uploads alongside are fine", async () => {
    const d = await freshDate();
    await inRollback(owner, async () => {
      await owner.query("insert into events (event_date) values ($1)", [d]);
      await owner.query(insert, [d, "event_image", ...keys(d), "ready"]);
      await owner.query(insert, [d, "event_image", ...keys(d), "pending"]);
      await assertRefused(owner, insert, [d, "event_image", ...keys(d), "ready"], /event_media_one_event_image_idx/);
    });
  });

  test("an Event Image is never publicly usable (it isn't covered by the photo waiver)", async () => {
    const d = await freshDate();
    await inRollback(owner, async () => {
      await owner.query("insert into events (event_date) values ($1)", [d]);
      const [o, di, t, c] = keys(d);
      await assertRefused(owner,
        `insert into event_media (event_date, kind, original_key, display_key, thumb_key, image_16x9_key, content_type, size_bytes, publicly_usable)
         values ($1, 'event_image', $2, $3, $4, $5, 'image/png', 10, true)`, [d, o, di, t, c], /event_media_publicly_usable_ck/);
    });
  });

  test("admin_app can insert, update and delete Event Image rows (the event_media grants)", async () => {
    const admin = await connect(ADMIN_URL);
    try {
      const d = await freshDate();
      await inRollback(admin, async () => {
        await admin.query("insert into events (event_date) values ($1)", [d]);
        const [o, di, t, c] = keys(d);
        await admin.query(insert, [d, "event_image", o, di, t, c, "pending"]);
        await assertAllowed(admin, "update event_media set status = 'ready' where image_16x9_key = $1", [c]);
        await assertAllowed(admin, "delete from event_media where image_16x9_key = $1", [c]);
      });
    } finally {
      await admin.end();
    }
  });
});

// ── 2. Data module ──────────────────────────────────────────────────────────
describe("Event Image: resolution with nothing set", () => {
  test("an event with no Event Image resolves to the logo and the wide logo", async () => {
    const d = await freshDate();
    const r = await ei.getEventImage(pool, d);
    assert.equal(r.source, "default");
    assert.equal(r.original.path, "/assets/images/brand/bocc-logo-square.png");
    assert.equal(r.image16x9.path, "/assets/images/brand/bocc-logo-wide-16x9.png");
  });
});

describe("Event Image against MinIO", { skip }, () => {
  test("upload: four presigned PUTs including the 16:9 Event Image; complete stores all four (audited set)", async () => {
    const date = await freshDate();
    const r = await media.startUpload(actor.id, storage(), body(date));
    assert.deepEqual(Object.keys(r.uploads).sort(), ["cover", "display", "original", "thumb"]);
    const m = await row(r.id);
    assert.equal(m.kind, "event_image");
    assert.equal(m.status, "pending");
    assert.equal(m.publicly_usable, false);
    assert.equal(m.image_16x9_key, `events/${date}/${r.id}/cover.jpg`);
    const [a] = await auditsFor(r.id);
    assert.deepEqual(a.details.signed.cover, { contentType: "image/jpeg", size: COVER.length });
    assert.deepEqual(a.details.signed.original, { contentType: "image/png", size: ORIGINAL.length, width: 2000, height: 2000 });

    // Not the Event Image until complete.
    assert.equal((await ei.getEventImage(pool, date)).source, "default");

    await putAll(r.uploads);
    assert.deepEqual(await media.completeUpload(actor.id, storage(), r.id, { db: pool }), { id: r.id, status: "ready" });
    for (const k of [m.original_key, m.display_key, m.thumb_key, m.image_16x9_key]) assert.ok(await exists(k), k);
    const actions = (await auditsFor(r.id)).map((x) => x.action);
    assert.deepEqual(actions, ["media.upload", "event_image.set", "media.ready"]);
    const set = (await auditsFor(r.id)).find((x) => x.action === "event_image.set");
    assert.equal(set.actor_user_id, actor.id);
    assert.deepEqual(set.details, { eventDate: date, mediaId: r.id, replaced: null });

    const img = await ei.getEventImage(pool, date);
    assert.equal(img.source, "uploaded");
    assert.equal(img.mediaId, r.id);
    assert.deepEqual(img.image16x9, { key: m.image_16x9_key, contentType: "image/jpeg" });
    // The gallery (Photos from Event, Sign-in board) doesn't list it.
    assert.deepEqual((await media.listEventMedia(pool, date)).ready, []);
  });

  test("a missing cover keeps the upload pending", async () => {
    const date = await freshDate();
    const r = await media.startUpload(actor.id, storage(), body(date));
    await putAll(r.uploads, { original: ORIGINAL, display: DISPLAY, thumb: THUMB });
    const res = await media.completeUpload(actor.id, storage(), r.id, { db: pool });
    assert.deepEqual(res, { id: r.id, status: "pending", problems: ["16:9 Event Image: not uploaded"] });
  });

  test("replace: the new image takes over on complete; the old row and its four objects go (audited)", async () => {
    const date = await freshDate();
    const first = await upload(date);
    const old = await row(first);

    const r = await media.startUpload(actor.id, storage(), body(date));
    assert.equal((await ei.getEventImage(pool, date)).mediaId, first, "the old one stays until the new one completes");
    await putAll(r.uploads);
    await media.completeUpload(actor.id, storage(), r.id, { db: pool });

    assert.equal((await ei.getEventImage(pool, date)).mediaId, r.id);
    assert.equal(await row(first), undefined);
    for (const k of [old.original_key, old.display_key, old.thumb_key, old.image_16x9_key]) assert.equal(await exists(k), false, k);
    const set = (await auditsFor(r.id)).find((x) => x.action === "event_image.set");
    assert.deepEqual(set.details, { eventDate: date, mediaId: r.id, replaced: first });
  });

  test("clear: back to the logo, row and objects gone, audited; clearing again changes nothing", async () => {
    const date = await freshDate();
    const id = await upload(date);
    const m = await row(id);

    const res = await ei.clearEventImage(actor.id, storage(), date);
    assert.deepEqual(res, { changed: true, eventDate: date, mediaId: id, leftovers: [] });
    assert.equal(await row(id), undefined);
    for (const k of [m.original_key, m.display_key, m.thumb_key, m.image_16x9_key]) assert.equal(await exists(k), false, k);
    const clear = (await auditsFor(id)).at(-1);
    assert.equal(clear.action, "event_image.clear");
    assert.equal(clear.actor_user_id, actor.id);
    assert.equal(clear.details.eventDate, date);
    assert.deepEqual(clear.details.keys.sort(), [m.image_16x9_key, m.display_key, m.original_key, m.thumb_key].sort());
    assert.equal((await ei.getEventImage(pool, date)).source, "default");

    const before = (await owner.query("select count(*)::int as n from audit_log where action = 'event_image.clear'")).rows[0].n;
    assert.deepEqual(await ei.clearEventImage(actor.id, storage(), date), { changed: false, eventDate: date, mediaId: null, leftovers: [] });
    assert.equal((await owner.query("select count(*)::int as n from audit_log where action = 'event_image.clear'")).rows[0].n, before);
  });

  test("clear refuses a bad date", async () => {
    await assert.rejects(ei.clearEventImage(actor.id, storage(), "2024-02-30"), { status: 400 });
  });

  test("deleting the Event Image row (an abandoned upload) removes its cover object too", async () => {
    const date = await freshDate();
    const r = await media.startUpload(actor.id, storage(), body(date));
    await putAll(r.uploads);
    const m = await row(r.id);
    const res = await media.deleteMedia(actor.id, storage(), r.id);
    assert.equal(res.kind, "event_image");
    assert.equal(await exists(m.image_16x9_key), false);
  });

  test("the server reads the cover's bytes: the uploaded copy from the bucket, the logo's from the site", async () => {
    const date = await freshDate();
    await upload(date);
    const got = await ei.load16x9Bytes(await ei.getEventImage(pool, date), { storage: storage() });
    assert.equal(got.contentType, "image/jpeg");
    assert.deepEqual(got.bytes, COVER);

    const asked = [];
    const logo = await ei.load16x9Bytes(await ei.getEventImage(pool, await freshDate()), {
      storage: storage(),
      readAsset: async (path) => { asked.push(path); return Buffer.from("png"); },
    });
    assert.deepEqual(asked, ["/assets/images/brand/bocc-logo-wide-16x9.png"]);
    assert.deepEqual(logo, { contentType: "image/png", bytes: Buffer.from("png") });
  });
});

// ── 3. Over HTTP ────────────────────────────────────────────────────────────
describe("the Event Image section and its clear form over HTTP", { skip, timeout: 300_000 }, () => {
  let server;
  let admin;
  let social;

  let ipCounter = 0;
  const nextIp = () => `198.21.${Math.floor(++ipCounter / 250)}.${ipCounter % 250 + 1}`;
  async function signedIn(roles) {
    const user = await createUser({ email: `${unique("ei")}@example.com`, name: "Event Image User", password: PASSWORD });
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
  const req = (path, { cookie, method = "GET", form, origin = BASE } = {}) => fetch(`${BASE}${path}`, {
    method,
    redirect: "manual",
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(method === "POST" ? { origin, "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });

  before(async () => {
    const { dev } = await import("astro");
    const root = fileURLToPath(new URL("../..", import.meta.url));
    server = await dev({ root, logLevel: "error", server: { port, host: "localhost" } });
    admin = await signedIn(["admin"]);
    social = await signedIn(["social"]);
  });
  after(async () => { await server?.stop(); });

  test("the Event Image section says Event Image and 16:9 Event Image, never cover", async () => {
    const d = await freshDate();
    const text = sectionText(await (await req(`/admin/events/${d}/?tab=info`, { cookie: admin.cookie })).text());
    assert.match(text, /The 16:9 Event Image \(for the listings entered by hand and LinkedIn\) is made for you/);
    assert.match(text, /Event Image, 16:9, /, "the wide preview's alt text");
    assert.match(text, /16:9 Event Image \(listings entered by hand, LinkedIn\)/, "the wide preview's caption");
    assert.match(text, /Download 16:9 Event Image/);
    assert.doesNotMatch(text, /cover|16:9 version/i);
  });

  test("the Event Info tab shows the logo default with both previews and downloads", async () => {
    const d = await freshDate();
    const res = await req(`/admin/events/${d}/?tab=info`, { cookie: admin.cookie });
    assert.equal(res.status, 200);
    const page = await res.text();
    assert.match(page, /<h2[^>]*id="h-event-image"[^>]*>Event Image<\/h2>/);
    assert.match(page, /Using the default: the BOCC logo/);
    assert.match(page, /<img[^>]*src="\/assets\/images\/brand\/bocc-logo-square\.png"/);
    assert.match(page, /<img[^>]*src="\/assets\/images\/brand\/bocc-logo-wide-16x9\.png"/);
    assert.match(page, /<a[^>]*href="\/assets\/images\/brand\/bocc-logo-wide-16x9\.png"[^>]*download/);
    assert.match(page, /data-media-upload[^>]*data-kind="event_image"|data-kind="event_image"[^>]*data-media-upload/);
    assert.ok(!/action="\/api\/admin\/media\/event-image\/clear"/.test(page), "nothing to clear");
    // Event readiness is only shown for upcoming dates: this one is in 2024.
  });

  test("with an image: previews and downloads are presigned bucket links; clear posts back to the Event Info tab", async () => {
    const d = await freshDate();
    const id = await upload(d);
    const m = await row(id);
    const page = await (await req(`/admin/events/${d}/?tab=info`, { cookie: admin.cookie })).text();
    assert.match(page, /Uploaded/);
    const origin = new URL(process.env.STORAGE_ENDPOINT).host;
    const imgs = [...page.matchAll(/<img[^>]*src="([^"]+)"/g)].map((x) => x[1].replaceAll("&amp;", "&"));
    assert.ok(imgs.some((u) => u.includes(origin) && u.includes(m.display_key)), "display preview");
    assert.ok(imgs.some((u) => u.includes(origin) && u.includes(m.image_16x9_key)), "cover preview");
    const links = [...page.matchAll(/<a[^>]*href="([^"]+)"[^>]*download/g)].map((x) => x[1].replaceAll("&amp;", "&"));
    const cover = links.find((u) => u.includes(m.image_16x9_key));
    assert.ok(cover, "cover download");
    assert.match(new URL(cover).searchParams.get("response-content-disposition"), new RegExp(`attachment; filename="bocc-${d}-event-image-16x9\\.jpg"`));
    assert.ok(links.some((u) => u.includes(m.original_key)), "original download");
    const fetched = await fetch(cover);
    assert.equal(fetched.status, 200);
    assert.deepEqual(Buffer.from(await fetched.arrayBuffer()), COVER);

    assert.match(page, /action="\/api\/admin\/media\/event-image\/clear"/);
    const cleared = await req("/api/admin/media/event-image/clear", { cookie: admin.cookie, method: "POST", form: { eventDate: d } });
    assert.equal(cleared.status, 303);
    assert.equal(cleared.headers.get("location"), `/admin/events/${d}/?tab=info&media=event-image-cleared#event-image`);
    assert.equal(await row(id), undefined);
    const after = await (await req(cleared.headers.get("location"), { cookie: admin.cookie })).text();
    assert.match(after, /Event Image cleared\. The event uses the BOCC logo\./);
    assert.match(after, /Using the default: the BOCC logo/);

    const again = await req("/api/admin/media/event-image/clear", { cookie: admin.cookie, method: "POST", form: { eventDate: d } });
    assert.equal(again.headers.get("location"), `/admin/events/${d}/?tab=info&media=event-image-unchanged#event-image`);
  });

  test("the clear form: admin only, Origin-checked, POST only, a bad date is 400", async () => {
    const d = await freshDate();
    const id = await upload(d);
    const form = { eventDate: d };
    assert.equal((await req("/api/admin/media/event-image/clear", { method: "POST", form })).status, 401);
    assert.equal((await req("/api/admin/media/event-image/clear", { cookie: social.cookie, method: "POST", form })).status, 403);
    assert.equal((await req("/api/admin/media/event-image/clear", { cookie: admin.cookie, method: "POST", form, origin: "https://evil.example" })).status, 403);
    assert.equal((await req("/api/admin/media/event-image/clear", { cookie: admin.cookie })).status, 405);
    assert.equal((await req("/api/admin/media/event-image/clear", { cookie: admin.cookie, method: "POST", form: { eventDate: "2024-02-30" } })).status, 400);
    assert.ok(await row(id), "nothing was cleared");
  });

  test("an upcoming event's Event readiness says Event Image: Default (BOCC logo) while the logo is in use", async () => {
    const d = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
    const page = await (await req(`/admin/events/${d}/?tab=info`, { cookie: admin.cookie })).text();
    assert.match(page, /Event Image: Default \(BOCC logo\)/);
  });

  test("the browser scripts are served as JavaScript", async () => {
    for (const p of ["/js/admin-media.js", "/js/admin-media-lib.js"]) {
      const res = await fetch(`${BASE}${p}`);
      assert.equal(res.status, 200, p);
      assert.match(res.headers.get("content-type"), /javascript/);
    }
  });
});
