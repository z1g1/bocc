// Remaking the 16:9 Event Image made under the old centre-crop rule (ticket #40) against
// the throwaway database and MinIO (npm run test:db):
//   1. the schema (migration 20261202120000): event_media.image_16x9_outdated, set on every
//      existing 16:9 Event Image, never without one
//   2. src/lib/admin/event-image.mjs + media.mjs as admin_app: an outdated version is
//      still the 16:9 Event Image (a posted LinkedIn event keeps its image ref) but is flagged;
//      the picker and pick ask for a new one; startImage16x9 / completeImage16x9 remake it in
//      place (same key) and clear the flag; listOutdated16x9Images lists what's left;
//      load16x9Bytes refuses an outdated version (no new LinkedIn event gets it)
//   3. over HTTP through a real `astro dev`: the event page remakes it on open, the
//      /admin/media/covers/ page remakes them all
// Rows are seeded as the owner on dates in 2078 (no other file uses them).
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
const OLD_COVER = Buffer.from("\xff\xd8 the old centre crop", "binary");
const NEW_COVER = Buffer.from("\xff\xd8 the image on the beans background", "binary");

let owner;
let actor;
const storage = () => getStorage().storage;

let nextDay = 0;
const used = new Set();
function dates(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2078, 0, 4) + (nextDay++) * 7 * 86400000).toISOString().slice(0, 10);
    used.add(d);
    out.push(d);
  }
  return out;
}
const ensureEvent = (d) => owner.query("insert into events (event_date) values ($1) on conflict do nothing", [d]);

/** Seed a ready Photo from Event or uploaded Event Image as the owner, its cover made under the old rule. */
async function seed(d, { kind = "event_photo", cover = true, outdated = cover } = {}) {
  await ensureEvent(d);
  const id = randomUUID();
  const k = (v) => `events/${d}/${id}/${v}.jpg`;
  await owner.query(
    `insert into event_media (id, event_date, kind, original_key, display_key, thumb_key, image_16x9_key, image_16x9_outdated,
                              content_type, size_bytes, publicly_usable, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'image/jpeg', 10, $9, 'ready')`,
    [id, d, kind, k("original"), k("display"), k("thumb"), cover ? k("cover") : null, outdated, kind === "event_photo"]);
  return id;
}
const row = (id) => owner.query("select * from event_media where id = $1", [id]).then((r) => r.rows[0]);
const auditsFor = (id) => owner.query("select action, details from audit_log where target_id = $1 order by id", [id]).then((r) => r.rows);
async function putObject(key, bytes) {
  const p = storage().presignPut({ key, contentType: "image/jpeg", contentLength: bytes.length });
  const res = await fetch(p.url, { method: p.method, headers: p.headers, body: bytes });
  assert.equal(res.status, 200);
}

before(async () => {
  owner = await connect(OWNER_URL);
  actor = await createUser({ email: `${unique("remake")}@example.com`, name: "Remake Actor", password: PASSWORD });
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
describe("schema: image_16x9_outdated", () => {
  test("a new row's 16:9 Event Image is not outdated; admin_app can set and clear the flag", async () => {
    const [d] = dates(1);
    await ensureEvent(d);
    const id = randomUUID();
    await owner.query(
      `insert into event_media (id, event_date, kind, original_key, display_key, thumb_key, image_16x9_key, content_type, size_bytes, status)
       values ($1, $2, 'event_image', $3, $4, $5, $6, 'image/png', 10, 'ready')`,
      [id, d, `x/${id}/o.png`, `x/${id}/d.jpg`, `x/${id}/t.jpg`, `x/${id}/c.jpg`]);
    assert.equal((await row(id)).image_16x9_outdated, false);
    const admin = await connect(ADMIN_URL);
    try {
      await inRollback(admin, async () => {
        await assertAllowed(admin, "update event_media set image_16x9_outdated = true where id = $1", [id]);
        await assertAllowed(admin, "update event_media set image_16x9_outdated = false where id = $1", [id]);
      });
    } finally {
      await admin.end();
    }
  });

  test("only a row with a 16:9 Event Image can be outdated", async () => {
    const [d] = dates(1);
    const id = await seed(d, { cover: false });
    await inRollback(owner, async () => {
      await assertRefused(owner, "update event_media set image_16x9_outdated = true where id = $1", [id], /event_media_image_16x9_outdated_ck/);
    });
  });
});

// ── 2. The library ──────────────────────────────────────────────────────────
describe("an outdated 16:9 Event Image", () => {
  test("an uploaded Event Image keeps its 16:9 Event Image (same key, so a posted LinkedIn event shows no drift) and is flagged", async () => {
    const [d] = dates(1);
    const id = await seed(d, { kind: "event_image" });
    const img = await ei.getEventImage(pool, d);
    assert.equal(img.source, "uploaded");
    assert.deepEqual(img.image16x9, { key: `events/${d}/${id}/cover.jpg`, contentType: "image/jpeg" });
    assert.equal(img.image16x9Outdated, true);
  });

  test("a current version and the logo default are not flagged", async () => {
    const [d1, d2] = dates(2);
    await seed(d1, { kind: "event_image", outdated: false });
    assert.equal((await ei.getEventImage(pool, d1)).image16x9Outdated, false);
    await ensureEvent(d2);
    assert.equal((await ei.getEventImage(pool, d2)).image16x9Outdated, false);
  });

  test("a picked photo with an outdated version is flagged; the picker and pick ask for a new one", async () => {
    const [p, d] = dates(2);
    const old = await seed(p);
    const fresh = await seed(p, { outdated: false });
    const listed = Object.fromEntries((await ei.listPickablePhotos(pool, d)).map((m) => [m.id, m]));
    assert.equal(listed[old].image16x9Outdated, true);
    assert.equal(listed[fresh].image16x9Outdated, false);
    assert.equal((await ei.pickEventImage(actor.id, null, d, old)).needs16x9, true);
    assert.equal((await ei.getEventImage(pool, d)).image16x9Outdated, true);
    assert.equal((await ei.pickEventImage(actor.id, null, d, fresh)).needs16x9, false);
  });

  test("load16x9Bytes refuses it, so no new LinkedIn event is sent the old crop", async () => {
    const [d] = dates(1);
    await seed(d, { kind: "event_image" });
    const img = await ei.getEventImage(pool, d);
    await assert.rejects(ei.load16x9Bytes(img, { storage: { getObject: async () => ({ bytes: OLD_COVER }) } }), /being remade/);
  });

  test("listOutdated16x9Images lists the ready Event Images and Photos from Event still to remake, newest event first", async () => {
    const [d1, d2] = dates(2);
    const a = await seed(d1);
    const b = await seed(d2, { kind: "event_image" });
    const current = await seed(d2, { outdated: false });
    const none = await seed(d2, { cover: false });
    const list = (await media.listOutdated16x9Images(pool)).filter((m) => used.has(m.eventDate));
    const ids = list.map((m) => m.id);
    assert.ok(ids.includes(a) && ids.includes(b));
    assert.ok(!ids.includes(current) && !ids.includes(none));
    assert.ok(ids.indexOf(b) < ids.indexOf(a), "newest event first");
    const item = list.find((m) => m.id === b);
    assert.equal(item.kind, "event_image");
    assert.equal(item.displayKey, `events/${d2}/${b}/display.jpg`);
  });
});

describe("remaking an outdated 16:9 Event Image against MinIO", { skip }, () => {
  for (const kind of ["event_photo", "event_image"]) {
    test(`${kind}: start signs a PUT to the same key; complete waits for the new file, then clears the flag (audited)`, async () => {
      const [d] = dates(1);
      const id = await seed(d, { kind });
      const key = `events/${d}/${id}/cover.jpg`;
      await putObject(key, OLD_COVER);

      const start = await media.startImage16x9(actor.id, storage(), id, { size: NEW_COVER.length });
      assert.equal(start.key, key);
      // The old file is still there at the same key: not the new one yet.
      const early = await media.completeImage16x9(actor.id, storage(), id, { db: pool });
      assert.equal(early.status, "pending");
      assert.equal((await row(id)).image_16x9_outdated, true);

      const res = await fetch(start.upload.url, { method: start.upload.method, headers: start.upload.headers, body: NEW_COVER });
      assert.equal(res.status, 200);
      assert.deepEqual(await media.completeImage16x9(actor.id, storage(), id, { db: pool }), { id, status: "ready", image16x9Key: key });
      const r = await row(id);
      assert.equal(r.image_16x9_key, key);
      assert.equal(r.image_16x9_outdated, false);
      const done = (await auditsFor(id)).filter((x) => x.action === "media.cover");
      assert.deepEqual(done.map((x) => x.details), [{ eventDate: d, key, remade: true }]);
      // Done: no second remake, and complete again just answers ready.
      await assert.rejects(media.startImage16x9(actor.id, storage(), id, { size: NEW_COVER.length }), { status: 400 });
      assert.equal((await media.completeImage16x9(actor.id, storage(), id, { db: pool })).status, "ready");
      if (kind === "event_image") {
        const img = await ei.getEventImage(pool, d);
        assert.equal(img.image16x9Outdated, false);
        assert.deepEqual((await ei.load16x9Bytes(img, { storage: storage() })).bytes, NEW_COVER);
      }
    });
  }

  test("complete without a remake started since the flag was set stays pending (an old cover_upload doesn't count)", async () => {
    const [d] = dates(1);
    const id = await seed(d);
    const key = `events/${d}/${id}/cover.jpg`;
    await putObject(key, OLD_COVER);
    // The cover upload of the old rule, before this ticket: no layout recorded.
    await withAudit(actor.id, async () => {}, {
      action: "media.cover_upload", targetTable: "event_media", targetId: id,
      details: { eventDate: d, key, signed: { contentType: "image/jpeg", size: OLD_COVER.length } },
    });
    const r = await media.completeImage16x9(actor.id, storage(), id, { db: pool });
    assert.deepEqual(r, { id, status: "pending", problems: ["16:9 Event Image: not started"] });
    assert.equal((await row(id)).image_16x9_outdated, true);
  });

  test("a sign-in board photo or a current Event Image can't be given another version", async () => {
    const [d] = dates(1);
    const board = await seed(d, { kind: "signin_board", cover: false });
    const current = await seed(d, { kind: "event_image", outdated: false });
    for (const id of [board, current]) {
      await assert.rejects(media.startImage16x9(actor.id, storage(), id, { size: 10 }), { status: 400 }, id);
    }
  });
});

// ── 3. Over HTTP ────────────────────────────────────────────────────────────
describe("remaking over HTTP", { skip, timeout: 300_000 }, () => {
  let server;
  let admin;
  let social;

  let ipCounter = 0;
  const nextIp = () => `198.40.${Math.floor(++ipCounter / 250)}.${ipCounter % 250 + 1}`;
  async function signedIn(roles) {
    const user = await createUser({ email: `${unique("remake")}@example.com`, name: "Remake User", password: PASSWORD });
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
  const req = (path, { cookie, method = "GET", json, origin = BASE } = {}) => fetch(`${BASE}${path}`, {
    method,
    redirect: "manual",
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(method === "POST" ? { origin, "content-type": "application/json" } : {}),
    },
    body: json ? JSON.stringify(json) : undefined,
  });
  const tag = (page, attr, value) => [...page.matchAll(/<(?:form|li|input)\b[^>]*>/g)].map((m) => m[0])
    .find((t) => t.includes(attr) && t.includes(value));

  before(async () => {
    const { dev } = await import("astro");
    const root = fileURLToPath(new URL("../..", import.meta.url));
    server = await dev({ root, logLevel: "error", server: { port, host: "localhost" } });
    admin = await signedIn(["admin"]);
    social = await signedIn(["social"]);
  });
  after(async () => { await server?.stop(); });

  test("the event page explains the 16:9 composition, asks for a square, and has a place for the composed preview", async () => {
    const [d] = dates(1);
    await ensureEvent(d);
    const page = await (await req(`/admin/events/${d}/?tab=info`, { cookie: admin.cookie })).text();
    assert.match(page, /full height/);
    assert.match(page, /Just the Beans/);
    assert.match(page, /1:1 square/);
    // The upload hint states the minimum the checks enforce (checkEventImage: 480x270).
    assert.match(page, /at least 480×270/);
    assert.doesNotMatch(page, /480×480/);
    assert.match(page, /<form[^>]*data-media-upload[^>]*data-preview="[^"]+"/);
  });

  test("the event page remakes an outdated Event Image's 16:9 Event Image as it opens", async () => {
    const [d] = dates(1);
    const id = await seed(d, { kind: "event_image" });
    const page = await (await req(`/admin/events/${d}/?tab=info`, { cookie: admin.cookie })).text();
    const form = tag(page, "data-make-16x9", id);
    assert.ok(form, "a make-cover form for the image");
    assert.match(form, /data-auto/);
    assert.match(form.replaceAll("&amp;", "&"), new RegExp(`data-display-url="[^"]*${id}/display\\.jpg`));
    const text = sectionText(page);
    assert.match(text, /Remake the 16:9 Event Image/);
    assert.match(text, /This 16:9 Event Image is a centre crop, made under the old rule/);
    assert.doesNotMatch(text, /cover|16:9 version/i);
  });

  test("a picked photo without a 16:9 Event Image is offered one (the step works without the picker script)", async () => {
    const [p, d] = dates(2);
    const photo = await seed(p, { cover: false });
    await ensureEvent(d);
    await owner.query("update events set event_image_media_id = $2 where event_date = $1", [d, photo]);
    const page = await (await req(`/admin/events/${d}/?tab=info`, { cookie: admin.cookie })).text();
    const form = tag(page, "data-make-16x9", photo);
    assert.ok(form, "a make form for the photo");
    assert.doesNotMatch(form, /data-auto/);
    const text = sectionText(page);
    assert.match(text, /Make the 16:9 Event Image/);
    assert.match(text, /No 16:9 Event Image yet\./);
    assert.doesNotMatch(text, /cover|16:9 version/i);
  });

  test("a current version gets no remake form; an outdated photo in the picker needs a new one", async () => {
    const [p, d] = dates(2);
    await seed(d, { kind: "event_image", outdated: false });
    const photo = await seed(p);
    const page = await (await req(`/admin/events/${d}/?tab=info`, { cookie: admin.cookie })).text();
    assert.ok(!/data-make-16x9/.test(page));
    const radio = tag(page, 'name="mediaId"', photo);
    assert.ok(radio, "the photo is offered");
    assert.match(radio, /data-needs-16x9/);
    assert.match(radio.replaceAll("&amp;", "&"), new RegExp(`data-display-url="[^"]*${photo}/display\\.jpg`));
  });

  test("the cover routes remake an uploaded Event Image's version", async () => {
    const [d] = dates(1);
    const id = await seed(d, { kind: "event_image" });
    const key = `events/${d}/${id}/cover.jpg`;
    await putObject(key, OLD_COVER);
    const start = await req(`/api/admin/media/${id}/cover`, { cookie: admin.cookie, method: "POST", json: { size: NEW_COVER.length } });
    assert.equal(start.status, 201);
    const plan = await start.json();
    assert.equal((await fetch(plan.upload.url, { method: "PUT", headers: plan.upload.headers, body: NEW_COVER })).status, 200);
    const done = await req(`/api/admin/media/${id}/cover-complete`, { cookie: admin.cookie, method: "POST", json: {} });
    assert.equal(done.status, 200);
    assert.equal((await row(id)).image_16x9_outdated, false);
  });

  test("/admin/media/covers/ lists every outdated version to remake at once; admin only", async () => {
    const [d] = dates(1);
    const a = await seed(d, { kind: "event_image" });
    const current = await seed(d, { outdated: false });
    const res = await req("/admin/media/covers/", { cookie: admin.cookie });
    assert.equal(res.status, 200);
    const page = await res.text();
    assert.match(page, /<form[^>]*data-remake-16x9/);
    assert.match(page, /<title>[^<]*Remake 16:9 Event Images/);
    assert.match(page, /<h1\b[^>]*>Remake 16:9 Event Images<\/h1>/);
    const main = (page.match(/<main\b[\s\S]*?<\/main>/)?.[0] ?? page)
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/g, " ").replace(/<[^>]+>/g, " ");
    assert.doesNotMatch(main, /cover|16:9 version/i);
    const li = tag(page, "data-image-16x9-id", a);
    assert.ok(li, "the outdated Event Image is listed");
    assert.match(li.replaceAll("&amp;", "&"), new RegExp(`data-display-url="[^"]*${a}/display\\.jpg`));
    assert.ok(!page.includes(current));
    assert.match(page, /<script[^>]*src="\/js\/admin-media\.js"/);

    assert.equal((await req("/admin/media/covers/", { cookie: social.cookie })).status, 403);
    assert.equal((await req("/admin/media/covers/")).status, 302);
  });
});
