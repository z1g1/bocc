// Phone photo upload (ADR 0010) against the throwaway database and MinIO
// (npm run test:db):
//   1. src/lib/admin/media.mjs as admin_app: validation, the events row made on the
//      first upload, presign -> real PUTs to MinIO -> complete -> ready, a missing or
//      wrong object keeps the row pending, delete removes row and objects (audited),
//      publicly_usable only on social photos, stale pending rows
//   2. the routes over HTTP through a real `astro dev`: roles (none / no role /
//      social -> refused), Origin and method checks, the full flow, the gallery on
//      the event page, delete and toggle form posts
// Media switched off is covered in media-disabled.test.mjs (its own process and env).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { OWNER_URL, connect, unique, useAdminEnv } from "./helpers.mjs";

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
const { getStorage, mediaKey } = await import("../../src/lib/admin/storage.mjs");
const media = await import("../../src/lib/admin/media.mjs");
const lib = await import("../../public/js/admin-media-lib.js");

const PASSWORD = "correct horse battery staple";
// Tiny real images (Pillow-made): a 3x2 JPEG and a 5x3 PNG.
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAACAAMDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCzRRRXwR9sf//Z", "base64");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAUAAAADCAYAAABbNsX4AAAAFUlEQVR4nGNkiDrRwIAGmNAFcAoCAGLOAagRY1pyAAAAAElFTkSuQmCC", "base64");
// Stand-ins for the browser-made copies (MinIO stores bytes; it doesn't decode them).
const DISPLAY = Buffer.concat([JPEG, Buffer.from("display")]);
const THUMB = Buffer.concat([JPEG, Buffer.from("t")]);

let owner;
const storage = () => getStorage().storage;

/** A date with no events row yet, in 2025 (inside the allowed range). */
async function freshDate() {
  for (;;) {
    const d = new Date(Date.UTC(2025, 0, 1) + Math.floor(Math.random() * 364) * 86400000).toISOString().slice(0, 10);
    const { rowCount } = await owner.query("select 1 from events where event_date = $1", [d]);
    if (rowCount === 0) return d;
  }
}
const body = (eventDate, over = {}) => ({
  eventDate, kind: "signin_board", publiclyUsable: false,
  original: { contentType: "image/jpeg", size: JPEG.length }, display: { size: DISPLAY.length }, thumb: { size: THUMB.length },
  ...over,
});
const putAll = async (uploads, files = { original: JPEG, display: DISPLAY, thumb: THUMB }) => {
  for (const [variant, bytes] of Object.entries(files)) {
    const u = uploads[variant];
    const res = await fetch(u.url, { method: u.method, headers: u.headers, body: bytes });
    assert.equal(res.status, 200, `${variant}: ${await res.text()}`);
  }
};
const row = (id) => owner.query("select * from event_media where id = $1", [id]).then((r) => r.rows[0]);
const audits = (id) => owner.query("select actor_user_id, action, details from audit_log where target_id = $1 order by id", [id]).then((r) => r.rows);
const exists = async (key) => (await storage().headObject({ key })) !== null;

let ipCounter = 0;
const nextIp = () => `198.20.${Math.floor(++ipCounter / 250)}.${ipCounter % 250 + 1}`;
async function signedIn(roles) {
  const user = await createUser({ email: `${unique("md")}@example.com`, name: "Media User", password: PASSWORD });
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

let actor;
before(async () => {
  owner = await connect(OWNER_URL);
  actor = await createUser({ email: `${unique("mdactor")}@example.com`, name: "Media Actor", password: PASSWORD });
});
after(async () => { await owner?.end(); await pool.end(); });

// ── 1. The data module ──────────────────────────────────────────────────────
describe("upload validation", () => {
  const v = (over) => media.validateUploadRequest(body("2026-11-24", over), { today: new Date("2026-11-17T12:00:00Z") });
  const errs = (over) => { const r = v(over); assert.equal(r.ok, false, JSON.stringify(over)); return r.errors.join("; "); };

  test("a good request passes", () => {
    assert.equal(v({}).ok, true);
    assert.equal(v({ kind: "social_photo", publiclyUsable: true, original: { contentType: "image/png", size: 5 } }).ok, true);
  });
  test("bad dates", () => {
    for (const eventDate of ["2026-02-30", "11/24/2026", "", null, "2023-12-31", "2027-11-19"]) {
      assert.match(errs({ eventDate }), /eventDate/, String(eventDate));
    }
  });
  test("bad kind (promo videos are not photo uploads)", () => {
    for (const kind of ["promo_video", "SIGNIN_BOARD", undefined]) assert.match(errs({ kind }), /kind/);
  });
  test("bad types", () => {
    for (const contentType of ["image/heic", "image/gif", "image/jpeg; charset=x", "text/html"]) {
      assert.match(errs({ original: { contentType, size: 10 } }), /original.contentType/);
    }
    assert.match(errs({ display: { contentType: "image/png", size: 10 } }), /display.contentType/);
  });
  test("bad sizes, including over the caps", () => {
    for (const size of [0, -1, 1.5, "10", media.LIMITS.original + 1]) {
      assert.match(errs({ original: { contentType: "image/jpeg", size } }), /original.size/, String(size));
    }
    assert.match(errs({ display: { size: media.LIMITS.display + 1 } }), /display.size/);
    assert.match(errs({ thumb: { size: media.LIMITS.thumb + 1 } }), /thumb.size/);
    assert.match(errs({ thumb: undefined }), /thumb is required/);
  });
  test("publicly_usable only on social_photo, and only a boolean", () => {
    assert.match(errs({ kind: "signin_board", publiclyUsable: true }), /only to social_photo/);
    assert.match(errs({ kind: "social_photo", publiclyUsable: "yes" }), /true or false/);
  });
  test("the browser's limits match the server's", () => {
    assert.equal(lib.MAX_ORIGINAL_BYTES, media.LIMITS.original);
    assert.equal(lib.MAX_DISPLAY_BYTES, media.LIMITS.display);
    assert.equal(lib.MAX_THUMB_BYTES, media.LIMITS.thumb);
    assert.deepEqual(lib.ACCEPTED_TYPES, [...media.ORIGINAL_TYPES]);
  });
  test("startUpload refuses invalid input before touching anything", async () => {
    await assert.rejects(media.startUpload(actor.id, storage() ?? {}, body("2026-02-30")), { status: 400 });
  });
});

describe("upload flow against MinIO", { skip }, () => {
  test("first upload creates the events row (scheduled) and a pending row with server-built keys", async () => {
    const date = await freshDate();
    const r = await media.startUpload(actor.id, storage(), body(date));
    assert.equal(r.eventCreated, true);
    const { rows: [ev] } = await owner.query("select status from events where event_date = $1", [date]);
    assert.equal(ev.status, "scheduled");
    const m = await row(r.id);
    assert.equal(m.status, "pending");
    assert.equal(m.uploaded_by, actor.id);
    assert.equal(m.original_key, `events/${date}/${r.id}/original.jpg`);
    assert.equal(m.display_key, `events/${date}/${r.id}/display.jpg`);
    assert.equal(m.thumb_key, `events/${date}/${r.id}/thumb.jpg`);
    assert.equal(Number(m.size_bytes), JPEG.length);
    const [a] = await audits(r.id);
    assert.equal(a.action, "media.upload");
    assert.equal(a.actor_user_id, actor.id);
    assert.equal(a.details.eventCreated, true);
    assert.deepEqual(a.details.signed.display, { contentType: "image/jpeg", size: DISPLAY.length });

    const again = await media.startUpload(actor.id, storage(), body(date, { kind: "social_photo", publiclyUsable: true }));
    assert.equal(again.eventCreated, false, "second upload for the date reuses the event");
    for (const u of Object.values(again.uploads)) {
      assert.equal(u.method, "PUT");
      const signed = new URL(u.url).searchParams.get("X-Amz-SignedHeaders");
      assert.equal(signed, "content-length;content-type;host");
      assert.equal(new URL(u.url).searchParams.get("X-Amz-Expires"), String(media.PUT_EXPIRES));
    }
  });

  test("presign, PUT the bytes, complete -> ready (audited); complete again is a no-op", async () => {
    const date = await freshDate();
    const r = await media.startUpload(actor.id, storage(), body(date, { original: { contentType: "image/png", size: PNG.length } }));
    assert.match(r.uploads.original.url, /\/original\.png\?/);
    await putAll(r.uploads, { original: PNG, display: DISPLAY, thumb: THUMB });
    assert.deepEqual(await media.completeUpload(actor.id, storage(), r.id, { db: pool }), { id: r.id, status: "ready" });
    assert.equal((await row(r.id)).status, "ready");
    assert.deepEqual((await audits(r.id)).map((a) => a.action), ["media.upload", "media.ready"]);
    assert.deepEqual(await media.completeUpload(actor.id, storage(), r.id, { db: pool }), { id: r.id, status: "ready" });
    assert.equal((await audits(r.id)).length, 2);
    const listed = await media.listEventMedia(pool, date);
    assert.deepEqual(listed.ready.map((m) => m.id), [r.id]);
  });

  test("complete with a missing object stays pending and says which", async () => {
    const date = await freshDate();
    const r = await media.startUpload(actor.id, storage(), body(date));
    await putAll(r.uploads, { original: JPEG, thumb: THUMB });
    const res = await media.completeUpload(actor.id, storage(), r.id, { db: pool });
    assert.equal(res.status, "pending");
    assert.deepEqual(res.problems, ["display: not uploaded"]);
    assert.equal((await row(r.id)).status, "pending");
    assert.deepEqual((await audits(r.id)).map((a) => a.action), ["media.upload"]);
  });

  test("an object that doesn't match what was signed keeps the row pending", async () => {
    const date = await freshDate();
    const r = await media.startUpload(actor.id, storage(), body(date));
    const m = await row(r.id);
    await putAll(r.uploads, { original: JPEG, thumb: THUMB });
    // Written around the signed URL (as only the server could): wrong size and type.
    const sneaky = storage().presignPut({ key: m.display_key, contentType: "image/png", contentLength: 3 });
    assert.equal((await fetch(sneaky.url, { method: "PUT", headers: sneaky.headers, body: Buffer.from("abc") })).status, 200);
    const res = await media.completeUpload(actor.id, storage(), r.id, { db: pool });
    assert.equal(res.status, "pending");
    assert.equal(res.problems.length, 2, res.problems.join("; "));
    assert.equal((await row(r.id)).status, "pending");
  });

  test("delete removes the row and all three objects, and is audited with the keys", async () => {
    const date = await freshDate();
    const r = await media.startUpload(actor.id, storage(), body(date));
    await putAll(r.uploads);
    await media.completeUpload(actor.id, storage(), r.id, { db: pool });
    const m = await row(r.id);
    const keys = [m.original_key, m.display_key, m.thumb_key];
    for (const k of keys) assert.ok(await exists(k));

    const res = await media.deleteMedia(actor.id, storage(), r.id);
    assert.deepEqual(res, { id: r.id, eventDate: date, leftovers: [] });
    assert.equal(await row(r.id), undefined);
    for (const k of keys) assert.equal(await exists(k), false, k);
    const a = (await audits(r.id)).at(-1);
    assert.equal(a.action, "media.delete");
    assert.deepEqual(a.details.keys, keys);
    await assert.rejects(media.deleteMedia(actor.id, storage(), r.id), { status: 404 });
  });

  test("delete when the bucket fails: the row still goes, leftovers are logged", async () => {
    const date = await freshDate();
    const r = await media.startUpload(actor.id, storage(), body(date));
    const failing = { deleteObject: async ({ key }) => { if (key.endsWith("original.jpg")) throw new Error("boom"); } };
    const logs = [];
    const res = await media.deleteMedia(actor.id, failing, r.id, { log: (m) => logs.push(m) });
    assert.deepEqual(res.leftovers, [`events/${date}/${r.id}/original.jpg`]);
    assert.equal(await row(r.id), undefined);
    assert.match(logs[0], /still in the bucket: events\/.*original\.jpg/);
  });

  test("publicly_usable toggles on social photos only, audited", async () => {
    const date = await freshDate();
    const social = await media.startUpload(actor.id, storage(), body(date, { kind: "social_photo" }));
    const board = await media.startUpload(actor.id, storage(), body(date));
    assert.deepEqual(await media.setPubliclyUsable(actor.id, social.id, true),
      { id: social.id, eventDate: date, before: false, publiclyUsable: true });
    assert.equal((await row(social.id)).publicly_usable, true);
    assert.deepEqual((await audits(social.id)).at(-1).details, { eventDate: date, before: false, after: true });
    await assert.rejects(media.setPubliclyUsable(actor.id, board.id, true), { status: 400 });
    await assert.rejects(media.setPubliclyUsable(actor.id, social.id, "1"), { status: 400 });
    assert.equal((await row(board.id)).publicly_usable, false);
  });

  test("the database allows HEIC/HEIF originals for signin_board only (migration 20261119120000)", async () => {
    const date = await freshDate();
    await owner.query("insert into events (event_date) values ($1)", [date]);
    const admin = await connect(process.env.TEST_ADMIN_URL);
    await admin.query("begin");
    try {
      const ins = (kind, contentType, ext, displayExt = "jpg") => {
        const id = crypto.randomUUID();
        const base = `events/${date}/${id}`;
        return admin.query(
          `insert into event_media (id, event_date, kind, original_key, display_key, thumb_key, content_type, size_bytes)
           values ($1, $2, $3, $4, $5, $6, $7, 10)`,
          [id, date, kind, `${base}/original.${ext}`, `${base}/display.${displayExt}`, `${base}/thumb.jpg`, contentType]);
      };
      await ins("signin_board", "image/heic", "heic");
      await ins("signin_board", "image/heif", "heif");
      for (const [kind, type] of [["social_photo", "image/heic"], ["social_photo", "image/heif"], ["signin_board", "image/gif"],
        ["promo_video", "image/heic"]]) {
        await admin.query("savepoint s");
        await assert.rejects(ins(kind, type, "heic"), /check constraint/, `${kind} ${type}`);
        await admin.query("rollback to savepoint s");
      }
    } finally {
      await admin.query("rollback");
      await admin.end();
    }
  });

  test("pending rows over a day old are listed as stale", async () => {
    const date = await freshDate();
    const old = await media.startUpload(actor.id, storage(), body(date));
    const fresh = await media.startUpload(actor.id, storage(), body(date));
    await owner.query("update event_media set created_at = now() - interval '25 hours' where id = $1", [old.id]);
    const stale = await media.listStalePending(pool, { date });
    assert.deepEqual(stale.map((m) => m.id), [old.id]);
    assert.ok((await media.listStalePending(pool)).some((m) => m.id === old.id));
    const listed = await media.listEventMedia(pool, date);
    assert.deepEqual(listed.pending.map((m) => [m.id, m.stale]), [[old.id, true], [fresh.id, false]]);
  });
});

// ── 2. Over HTTP, through astro dev ─────────────────────────────────────────
describe("media routes over HTTP", { skip, timeout: 300_000 }, () => {
  let server, admin, social, noRole;
  const root = fileURLToPath(new URL("../../", import.meta.url));

  before(async () => {
    const { dev } = await import("astro");
    server = await dev({ root, logLevel: "error", server: { port, host: "localhost" } });
    admin = await signedIn(["admin"]);
    social = await signedIn(["social"]);
    noRole = await signedIn([]);
  });
  after(async () => { await server?.stop(); });

  const req = (path, { cookie, method = "POST", json, form, origin = BASE } = {}) => {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    let reqBody;
    if (origin) headers.origin = origin;
    if (json !== undefined) { headers["content-type"] = "application/json"; reqBody = JSON.stringify(json); }
    if (form !== undefined) { headers["content-type"] = "application/x-www-form-urlencoded"; reqBody = new URLSearchParams(form).toString(); }
    return fetch(`${BASE}${path}`, { method, headers, body: method === "GET" ? undefined : reqBody, redirect: "manual" });
  };
  const someId = "00000000-0000-4000-8000-000000000000";
  const routes = (date) => [
    { path: "/api/admin/media/uploads", json: body(date) },
    { path: `/api/admin/media/${someId}/complete`, json: {} },
    { path: `/api/admin/media/${someId}/delete`, form: {} },
    { path: `/api/admin/media/${someId}/public`, form: { publiclyUsable: "1" } },
  ];

  test("no session -> 401; no role, or the social role -> 403; nothing is written", async () => {
    const date = await freshDate();
    for (const r of routes(date)) {
      assert.equal((await req(r.path, r)).status, 401, r.path);
      assert.equal((await req(r.path, { ...r, cookie: noRole.cookie })).status, 403, `${r.path} (no role)`);
      assert.equal((await req(r.path, { ...r, cookie: social.cookie })).status, 403, `${r.path} (social)`);
    }
    const { rowCount } = await owner.query("select 1 from events where event_date = $1", [date]);
    assert.equal(rowCount, 0);
    // The component renders nothing for social (the event page itself is admin only).
    const page = await req(`/admin/events/${date}/`, { method: "GET", cookie: social.cookie });
    assert.equal(page.status, 403);
    assert.ok(!(await page.text()).includes("data-media-upload"));
  });

  test("wrong or missing Origin -> 403; other methods -> 405", async () => {
    const date = await freshDate();
    for (const r of routes(date)) {
      for (const origin of ["https://evil.example", null]) {
        assert.equal((await req(r.path, { ...r, cookie: admin.cookie, origin })).status, 403, `${r.path} origin=${origin}`);
      }
      for (const method of ["GET", "PUT", "DELETE"]) {
        const res = await req(r.path, { ...r, cookie: admin.cookie, method });
        assert.equal(res.status, 405, `${method} ${r.path}`);
        if (method !== "GET") assert.equal(res.headers.get("allow"), "POST");
      }
    }
    assert.equal((await owner.query("select 1 from events where event_date = $1", [date])).rowCount, 0);
  });

  test("validation errors -> 400 with the reasons", async () => {
    const date = await freshDate();
    const bad = [
      body("2026-13-01"), body(date, { kind: "promo_video" }),
      body(date, { original: { contentType: "image/heic", size: 10 } }),
      body(date, { original: { contentType: "image/jpeg", size: 26 * 1024 * 1024 } }),
      body(date, { publiclyUsable: true }),
    ];
    for (const b of bad) {
      const res = await req("/api/admin/media/uploads", { cookie: admin.cookie, json: b });
      assert.equal(res.status, 400, JSON.stringify(b));
      assert.ok((await res.json()).errors.length >= 1);
    }
    const notJson = await req("/api/admin/media/uploads", { cookie: admin.cookie, form: { eventDate: date } });
    assert.equal(notJson.status, 400);
    const garbage = await fetch(`${BASE}/api/admin/media/uploads`, {
      method: "POST", headers: { cookie: admin.cookie, origin: BASE, "content-type": "application/json" }, body: "{nope",
    });
    assert.equal(garbage.status, 400);
    assert.equal((await req(`/api/admin/media/not-a-uuid/complete`, { cookie: admin.cookie, json: {} })).status, 404);
    assert.equal((await owner.query("select 1 from events where event_date = $1", [date])).rowCount, 0);
  });

  test("the full flow: upload, PUT to MinIO, complete, gallery, toggle, delete", async () => {
    const date = await freshDate();
    const start = await req("/api/admin/media/uploads", { cookie: admin.cookie, json: body(date, { kind: "social_photo" }) });
    assert.equal(start.status, 201);
    const plan = await start.json();
    assert.equal(plan.eventCreated, true);

    const early = await req(`/api/admin/media/${plan.id}/complete`, { cookie: admin.cookie, json: {} });
    assert.equal(early.status, 409);
    assert.equal((await early.json()).status, "pending");

    await putAll(plan.uploads);
    const done = await req(`/api/admin/media/${plan.id}/complete`, { cookie: admin.cookie, json: {} });
    assert.equal(done.status, 200);
    assert.deepEqual(await done.json(), { id: plan.id, status: "ready" });

    // The event page's gallery: presigned thumbnail, display and original links.
    const pageRes = await req(`/admin/events/${date}/`, { method: "GET", cookie: admin.cookie });
    assert.equal(pageRes.status, 200);
    const csp = pageRes.headers.get("content-security-policy");
    assert.match(csp, new RegExp(`img-src 'self' data: blob: ${process.env.STORAGE_ENDPOINT}`));
    const page = await pageRes.text();
    assert.match(page, /<script type="module" src="\/js\/admin-media\.js"><\/script>/);
    assert.match(page, /data-media-upload/);
    assert.match(page, /accept="image\/jpeg,image\/png"/);
    assert.match(page, /role="status" aria-live="polite"/);
    // Two sections, each with its own heading, form (kind fixed, no dropdown) and status.
    const section = (slug) => {
      const m = page.match(new RegExp(`<section[^>]*id="media-${slug}"[\\s\\S]*?</section>`));
      assert.ok(m, `section ${slug}`);
      return m[0];
    };
    const signin = section("signin");
    const socialSec = section("social");
    assert.match(signin, /<h2[^>]*>Sign-in board<\/h2>/);
    assert.match(socialSec, /<h2[^>]*>Social photos<\/h2>/);
    assert.match(signin, /data-media-upload[^>]*data-kind="signin_board"/);
    assert.match(signin, /<input type="hidden" name="kind" value="signin_board"/);
    assert.match(socialSec, /<input type="hidden" name="kind" value="social_photo"/);
    assert.ok(!/<select[^>]*name="kind"/.test(page), "no kind dropdown");
    assert.match(socialSec, /name="publiclyUsable"/);
    assert.ok(!signin.includes("publiclyUsable"), "no public checkbox or toggle for the sign-in board");
    assert.ok(!signin.includes("OK to use publicly"));
    for (const sec of [signin, socialSec]) {
      const statusId = sec.match(/data-status="([^"]+)"/)[1];
      assert.match(sec, new RegExp(`id="${statusId}" role="status" aria-live="polite"`));
    }
    assert.notEqual(signin.match(/data-status="([^"]+)"/)[1], socialSec.match(/data-status="([^"]+)"/)[1]);
    assert.match(signin, /No sign-in board photo yet\./);
    assert.ok(socialSec.includes(`${plan.id}/thumb.jpg`), "the social photo is in the social gallery");
    assert.ok(!signin.includes(plan.id), "and not in the sign-in board's");
    const thumb = page.match(new RegExp(`src="([^"]*/${plan.id}/thumb\\.jpg\\?[^"]*)"`));
    assert.ok(thumb, "thumbnail img");
    const thumbRes = await fetch(thumb[1].replaceAll("&amp;", "&"));
    assert.equal(thumbRes.status, 200);
    assert.deepEqual(Buffer.from(await thumbRes.arrayBuffer()), THUMB);
    assert.match(page, new RegExp(`href="[^"]*/${plan.id}/display\\.jpg\\?`));
    assert.match(page, new RegExp(`href="[^"]*/${plan.id}/original\\.jpg\\?[^"]*" download[^>]*>Download original`));

    const on = await req(`/api/admin/media/${plan.id}/public`, {
      cookie: admin.cookie, form: { publiclyUsable: "1" } });
    assert.equal(on.status, 303);
    assert.equal(on.headers.get("location"), `/admin/events/${date}/?media=public-on#event-media`);
    assert.equal((await row(plan.id)).publicly_usable, true);
    const after = await (await req(`/admin/events/${date}/?media=public-on`, { method: "GET", cookie: admin.cookie })).text();
    assert.match(after, /OK to use publicly<\/span>/);
    assert.match(after, /Marked OK to use publicly\./);

    const evil = await req(`/api/admin/media/${plan.id}/delete`, { cookie: admin.cookie, form: { return: "https://evil.example/" } });
    assert.equal(evil.status, 303);
    assert.equal(evil.headers.get("location"), `/admin/events/${date}/?media=deleted#event-media`, "the row's own event page");
    assert.equal(await row(plan.id), undefined);
    for (const v of ["original", "display", "thumb"]) assert.equal(await exists(`events/${date}/${plan.id}/${v}.jpg`), false);
    assert.deepEqual((await audits(plan.id)).map((a) => [a.action, a.actor_user_id]),
      [["media.upload", admin.user.id], ["media.ready", admin.user.id], ["media.publicly_usable", admin.user.id], ["media.delete", admin.user.id]]);
  });

  test("a JSON delete (the upload script giving up) answers JSON", async () => {
    const date = await freshDate();
    const plan = await (await req("/api/admin/media/uploads", { cookie: admin.cookie, json: body(date) })).json();
    const res = await req(`/api/admin/media/${plan.id}/delete`, { cookie: admin.cookie, json: {} });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { id: plan.id, eventDate: date, leftovers: [] });
    const toggle = await req(`/api/admin/media/${plan.id}/public`, { cookie: admin.cookie, json: { publiclyUsable: true } });
    assert.equal(toggle.status, 404);
  });

  test("an imported sign-in photo (uploaded_by NULL, HEIC original) shows in the sign-in board gallery", async () => {
    const date = await freshDate();
    const id = randomUUID();
    const keys = {
      original: mediaKey(date, id, "original", "heic"),
      display: mediaKey(date, id, "display", "jpg"),
      thumb: mediaKey(date, id, "thumb", "jpg"),
    };
    const HEIC = Buffer.from("not really a heic, MinIO doesn't care");
    const files = { original: [HEIC, "image/heic"], display: [DISPLAY, "image/jpeg"], thumb: [THUMB, "image/jpeg"] };
    for (const [variant, [bytes, contentType]] of Object.entries(files)) {
      const put = storage().presignPut({ key: keys[variant], contentType, contentLength: bytes.length });
      const res = await fetch(put.url, { method: "PUT", headers: put.headers, body: bytes });
      assert.equal(res.status, 200, variant);
    }
    // As the import does it (scripts/signin-photos/import.mjs): as the owner, ready, no uploader.
    await owner.query("insert into events (event_date, status) values ($1, 'held')", [date]);
    await owner.query(
      `insert into event_media (id, event_date, kind, original_key, display_key, thumb_key, content_type, size_bytes,
                                publicly_usable, status, uploaded_by)
       values ($1, $2, 'signin_board', $3, $4, $5, 'image/heic', $6, false, 'ready', null)`,
      [id, date, keys.original, keys.display, keys.thumb, HEIC.length]);

    const res = await req(`/admin/events/${date}/`, { method: "GET", cookie: admin.cookie });
    assert.equal(res.status, 200);
    const page = await res.text();
    const signin = page.match(/<section[^>]*id="media-signin"[\s\S]*?<\/section>/)[0];
    const img = signin.match(new RegExp(`<img src="([^"]*/${id}/thumb\\.jpg\\?[^"]*)" alt="Sign-in board, ${date}"`));
    assert.ok(img, "thumbnail <img> with its alt text");
    assert.equal((await fetch(img[1].replaceAll("&amp;", "&"))).status, 200);
    assert.match(signin, new RegExp(`<a href="[^"]*/${id}/display\\.jpg\\?[^"]*"[^>]*><img`), "the thumbnail links to the display copy");
    const original = signin.match(new RegExp(`href="([^"]*/${id}/original\\.heic\\?[^"]*)" download[^>]*>Download original`));
    assert.ok(original, "Download original");
    const dl = await fetch(original[1].replaceAll("&amp;", "&"));
    assert.equal(dl.status, 200);
    assert.equal(dl.headers.get("content-type"), "image/heic");
    assert.equal(dl.headers.get("content-disposition"), `attachment; filename="bocc-${date}-signin_board-${id.slice(0, 8)}.heic"`);
    assert.ok(!signin.includes("publiclyUsable"));
  });

  test("stale pending uploads are listed on the event page with a delete button", async () => {
    const date = await freshDate();
    const plan = await (await req("/api/admin/media/uploads", { cookie: admin.cookie, json: body(date) })).json();
    await owner.query("update event_media set created_at = now() - interval '2 days' where id = $1", [plan.id]);
    const page = await (await req(`/admin/events/${date}/`, { method: "GET", cookie: admin.cookie })).text();
    assert.match(page, /Unfinished uploads/);
    assert.match(page, new RegExp(`action="/api/admin/media/${plan.id}/delete"`));
    assert.ok(!page.includes(`${plan.id}/thumb.jpg`), "pending media is not in the gallery");
  });

  test("redirects go to the photo's event page, whatever `return` says (no open redirect)", async () => {
    const date = await freshDate();
    const probes = ["/admin/..//evil.example/x", "/admin/%2e%2e//evil.example", "//evil.example", "https://evil.example/"];
    for (const ret of probes) {
      const plan = await (await req("/api/admin/media/uploads", { cookie: admin.cookie, json: body(date, { kind: "social_photo" }) })).json();
      const toggle = await req(`/api/admin/media/${plan.id}/public`, { cookie: admin.cookie, form: { publiclyUsable: "1", return: ret } });
      assert.equal(toggle.status, 303);
      assert.equal(toggle.headers.get("location"), `/admin/events/${date}/?media=public-on#event-media`, ret);
      const del = await req(`/api/admin/media/${plan.id}/delete`, { cookie: admin.cookie, form: { return: ret } });
      assert.equal(del.status, 303);
      const loc = del.headers.get("location");
      assert.equal(loc, `/admin/events/${date}/?media=deleted#event-media`, ret);
      assert.equal(new URL(loc, BASE).origin, BASE);
    }
  });

  test("HEIC/HEIF are refused by the upload API (ADR 0010 decision 3), though the import may store them", async () => {
    const date = await freshDate();
    for (const contentType of ["image/heic", "image/heif"]) {
      for (const kind of ["signin_board", "social_photo"]) {
        const res = await req("/api/admin/media/uploads", {
          cookie: admin.cookie, json: body(date, { kind, original: { contentType, size: 1000 } }) });
        assert.equal(res.status, 400, `${kind} ${contentType}`);
        assert.match((await res.json()).errors.join(" "), /original\.contentType must be image\/jpeg or image\/png/);
      }
    }
    assert.equal((await owner.query("select 1 from events where event_date = $1", [date])).rowCount, 0);
  });

  test("the browser scripts are served as JavaScript", async () => {
    for (const p of ["/js/admin-media.js", "/js/admin-media-lib.js"]) {
      const res = await fetch(`${BASE}${p}`);
      assert.equal(res.status, 200, p);
      assert.match(res.headers.get("content-type"), /javascript/);
    }
  });
});
