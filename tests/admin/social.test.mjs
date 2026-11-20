// Phase 5 social work order, part A (ADR 0011), against the throwaway database
// (npm run test:db):
//   1. migration 20261122120000_social_posts.sql: grants (admin_app SELECT/INSERT/UPDATE
//      only; site_reader and checkin_writer nothing), the CHECKs, the same-event video
//      FK, the updated_at trigger
//   2. src/lib/admin/social.mjs as admin_app: the first save creates the event, the post
//      and five pending channels (audited), no-op saves, validation, what blocks
//      `ready`, attaching a video, channel overrides, and deleting the attached video
//      (media.mjs) un-readying the post; promo video uploads through media.mjs with a
//      fake bucket
//   3. the "Social post" section on /admin/events/YYYY-MM-DD/ over HTTP (astro dev):
//      roles, Origin, post/redirect/get, the readiness checklist's social lines
// The pure rules (texts, hashtags, times) are in social-unit.test.mjs.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { ADMIN_URL, CHECKIN_URL, OWNER_URL, assertAllowed, assertRefused, connect, inRollback, unique, useAdminEnv } from "./helpers.mjs";

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
const { ValidationError } = await import("../../src/lib/admin/events.mjs");

const PASSWORD = "correct horse battery staple";
const SITE_URL = process.env.TEST_SITE_URL;
const CHANNELS = ["facebook", "instagram", "threads", "tiktok", "linkedin_page"];
let owner, actor;

// Dates far ahead, so every publish time is in the future: 2083 (module) and 2084 (HTTP), one per call.
let n = 0;
const date = () => new Date(Date.UTC(2083, 0, 2 + 7 * n++)).toISOString().slice(0, 10);
let h = 0;
const httpDate = () => new Date(Date.UTC(2084, 0, 4 + 7 * h++)).toISOString().slice(0, 10);

const postRow = (d) => owner.query(`select * from social_posts where event_date = $1`, [d]).then((r) => r.rows[0] ?? null);
const channelRows = (d) => owner.query(
  `select channel, caption, first_comment, status from social_post_channels where event_date = $1 order by channel`, [d]).then((r) => r.rows);
const audits = (d) => owner.query(
  `select actor_user_id, action, target_table, details from audit_log
    where target_id = $1 and target_table in ('social_posts', 'social_post_channels') order by id`, [d]).then((r) => r.rows);

/** A media row inserted as the owner (no bucket needed for these tests). */
async function insertMedia(d, { kind = "promo_video", status = "ready", contentType } = {}) {
  const id = randomUUID();
  const video = kind === "promo_video";
  const base = `events/${d}/${id}`;
  await owner.query(`insert into events (event_date) values ($1) on conflict do nothing`, [d]);
  await owner.query(
    `insert into event_media (id, event_date, kind, original_key, display_key, thumb_key, content_type, size_bytes, status, publicly_usable)
     values ($1, $2, $3, $4, $5, $6, $7, 4800000, $8, $9)`,
    [id, d, kind, `${base}/original.${video ? "mp4" : "jpg"}`, video ? null : `${base}/display.jpg`, video ? null : `${base}/thumb.jpg`,
      contentType ?? (video ? "video/mp4" : "image/jpeg"), status, kind === "social_photo"]);
  return id;
}
const lumaLink = (d) => el.setLink(actor.id, d, "luma", { url: "https://luma.com/bocc-test", externalId: "" });

/** Everything ready: a video, a caption and the Luma link. */
async function readyable(d) {
  await lumaLink(d);
  const vid = await insertMedia(d);
  await so.setVideo(actor.id, d, vid);
  return vid;
}

let ipCounter = 0;
const nextIp = () => `198.21.${Math.floor(++ipCounter / 250)}.${ipCounter % 250 + 1}`;
async function signedIn(roles) {
  const user = await createUser({ email: `${unique("so")}@example.com`, name: "Social Test", password: PASSWORD });
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
  actor = await createUser({ email: `${unique("social")}@example.com`, name: "Social Admin", password: PASSWORD });
});
after(async () => { await owner?.end(); await pool.end(); });

// ── 1. Migration ────────────────────────────────────────────────────────────
describe("migration 20261122120000_social_posts.sql", () => {
  test("grants: admin_app SELECT, INSERT, UPDATE on both tables, social_checker SELECT, and nobody else anything", async () => {
    const { rows } = await owner.query(
      `select g.table_name || ':' || g.grantee || ':' || g.privilege_type as g
         from information_schema.role_table_grants g
         join pg_class c on c.relname = g.table_name and c.relnamespace = 'public'::regnamespace
        where g.table_schema = 'public' and g.table_name in ('social_posts', 'social_post_channels')
          and g.grantee <> pg_get_userbyid(c.relowner)
        order by 1`);
    assert.deepEqual(rows.map((r) => r.g), [
      "social_post_channels:admin_app:INSERT", "social_post_channels:admin_app:SELECT", "social_post_channels:admin_app:UPDATE",
      "social_post_channels:social_checker:SELECT", // migration 20261123120000 (the Thursday check, social-alert.test.mjs)
      "social_posts:admin_app:INSERT", "social_posts:admin_app:SELECT", "social_posts:admin_app:UPDATE",
      "social_posts:social_checker:SELECT",
    ]);
  });

  test("as each role: admin_app may not delete or truncate; checkin_writer and site_reader can't read", async () => {
    const admin = await connect(ADMIN_URL);
    const writer = await connect(CHECKIN_URL);
    const site = SITE_URL ? await connect(SITE_URL) : null;
    try {
      await inRollback(admin, async () => {
        const d = date();
        await admin.query(`insert into events (event_date) values ($1)`, [d]);
        await admin.query(`insert into social_posts (event_date, publish_at) values ($1, now())`, [d]);
        await admin.query(`insert into social_post_channels (event_date, channel) values ($1, 'facebook')`, [d]);
        await assertAllowed(admin, `update social_post_channels set status = 'scheduled' where event_date = $1`, [d]);
        await assertRefused(admin, `delete from social_post_channels where event_date = $1`, [d]);
        await assertRefused(admin, `delete from social_posts where event_date = $1`, [d]);
        await assertRefused(admin, `truncate social_plans, social_media_posts`);
      });
      for (const db of [writer, site].filter(Boolean)) {
        await db.query("begin");
        await assertRefused(db, `select * from social_posts limit 1`);
        await assertRefused(db, `select * from social_post_channels limit 1`);
        await db.query("rollback");
      }
    } finally {
      await Promise.all([admin.end(), writer.end(), site?.end()]);
    }
  });

  test("CHECKs: channel and status values, https post_url, blank texts, hashtag count, ready needs video and caption", () =>
    inRollback(owner, async () => {
      const d = date();
      await owner.query(`insert into events (event_date) values ($1)`, [d]);
      await owner.query(`insert into social_posts (event_date, publish_at) values ($1, now())`, [d]);
      const CHECK = /violates check constraint/;
      const refused = (sql, params) => assertRefused(owner, sql, params, CHECK);
      await refused(`insert into social_post_channels (event_date, channel) values ($1, 'myspace')`, [d]);
      await owner.query(`insert into social_post_channels (event_date, channel) values ($1, 'threads')`, [d]);
      await refused(`update social_post_channels set status = 'posted' where event_date = $1`, [d]);
      await refused(`update social_post_channels set post_url = 'http://threads.net/x' where event_date = $1`, [d]);
      await refused(`update social_post_channels set post_url = 'https://threads.net/a b' where event_date = $1`, [d]);
      await refused(`update social_post_channels set caption = '  ' where event_date = $1`, [d]);
      await refused(`update social_post_channels set first_comment = '' where event_date = $1`, [d]);
      await assertAllowed(owner, `update social_post_channels set post_url = 'https://www.threads.net/@bocc/post/1', status = 'scheduled' where event_date = $1`, [d]);
      await refused(`update social_posts set base_caption = ' ' where event_date = $1`, [d]);
      await refused(`update social_posts set extra_hashtags = $2 where event_date = $1`, [d, Array.from({ length: 11 }, (_, i) => `#t${i}`)]);
      await refused(`update social_posts set status = 'ready' where event_date = $1`, [d]);
      await refused(`update social_posts set status = 'ready', base_caption = 'x' where event_date = $1`, [d]);
      // An unknown event: FK.
      await assertRefused(owner, `insert into social_posts (event_date, publish_at) values ('2099-12-29', now())`, [], /foreign key/);
    }));

  test("the video must be media of the same event (FK on event_date, video_media_id)", async () => {
    const [a, b] = [date(), date()];
    const vidB = await insertMedia(b);
    await inRollback(owner, async () => {
      await owner.query(`insert into events (event_date) values ($1)`, [a]);
      await owner.query(`insert into social_posts (event_date, publish_at) values ($1, now())`, [a]);
      await assertRefused(owner, `update social_posts set video_media_id = $2 where event_date = $1`, [a, vidB], /foreign key/);
    });
    // Referenced media can't be deleted behind the post's back (media.mjs clears it first).
    await inRollback(owner, async () => {
      await owner.query(`insert into social_posts (event_date, publish_at, video_media_id) values ($1, now(), $2)`, [b, vidB]);
      await assertRefused(owner, `delete from event_media where id = $1`, [vidB], /foreign key/);
    });
  });

  test("updated_at moves on update", () =>
    inRollback(owner, async () => {
      const d = date();
      await owner.query(`insert into events (event_date) values ($1)`, [d]);
      await owner.query(`insert into social_posts (event_date, publish_at, updated_at) values ($1, now(), now() - interval '1 day')`, [d]);
      await owner.query(`insert into social_post_channels (event_date, channel, updated_at) values ($1, 'tiktok', now() - interval '1 day')`, [d]);
      await owner.query(`update social_posts set cover_note = 'x' where event_date = $1`, [d]);
      await owner.query(`update social_post_channels set notes = 'x' where event_date = $1`, [d]);
      const { rows: [r] } = await owner.query(
        `select (select updated_at > now() - interval '1 minute' from social_posts where event_date = $1) as p,
                (select updated_at > now() - interval '1 minute' from social_post_channels where event_date = $1) as c`, [d]);
      assert.deepEqual(r, { p: true, c: true });
    }));
});

// ── 2. The module ───────────────────────────────────────────────────────────
describe("social module (admin_app)", () => {
  test("the first save creates the event, the post (default publish time) and five pending channels, audited", async () => {
    const d = date();
    assert.equal(await so.getSocialPost(pool, d), null);
    const fresh = await so.getWorkOrder(pool, d);
    assert.deepEqual([fresh.exists, fresh.actionable, fresh.eventStatus], [false, false, "scheduled"]);

    const res = await so.savePost(actor.id, d, { baseCaption: "  Coffee!\r\nTuesday.  ", extraHashtags: "founders, #Networking", coverNote: "", publishAt: "" });
    assert.deepEqual(res, { changed: true, eventCreated: true });
    assert.equal((await owner.query(`select status from events where event_date = $1`, [d])).rows[0].status, "scheduled");
    const row = await postRow(d);
    assert.deepEqual([row.base_caption, row.extra_hashtags, row.cover_note, row.status, row.video_media_id],
      ["Coffee!\nTuesday.", ["#founders"], null, "todo", null], "#Networking is a default TikTok tag: dropped");
    assert.equal(row.publish_at.toISOString(), so.defaultPublishAt(d).toISOString());
    assert.equal(new Date(row.publish_at).getUTCDay(), 1, "a Monday");
    assert.deepEqual(await channelRows(d), [...CHANNELS].sort().map((channel) => ({ channel, caption: null, first_comment: null, status: "pending" })));

    const [a] = await audits(d);
    assert.deepEqual([a.actor_user_id, a.action, a.target_table, a.details.created, a.details.eventCreated],
      [actor.id, "social_post.update", "social_posts", true, true]);
    assert.deepEqual(a.details.after, { base_caption: "Coffee!\nTuesday.", extra_hashtags: ["#founders"] });

    // The same again (the form shows the saved Eastern time): nothing written.
    const saved = so.formatPublishAt(row.publish_at).local;
    assert.deepEqual(await so.savePost(actor.id, d, { baseCaption: "Coffee!\nTuesday.", extraHashtags: "#founders", publishAt: saved }),
      { changed: false, eventCreated: false });
    assert.equal((await audits(d)).length, 1);

    const p = await so.getSocialPost(pool, d);
    assert.deepEqual(Object.keys(p.channels), CHANNELS);
    assert.equal(p.channels.tiktok.status, "pending");
  });

  test("validation: bad hashtags, a skipped hour, too long; nothing is created", async () => {
    const d = date();
    await assert.rejects(so.savePost(actor.id, d, { extraHashtags: "#ok #not-ok", publishAt: "2083-03-14T02:30", baseCaption: "x".repeat(2001) }),
      (e) => e instanceof ValidationError && "extraHashtags" in e.errors && "publishAt" in e.errors && "baseCaption" in e.errors);
    await assert.rejects(so.saveChannel(actor.id, d, "myspace", {}), (e) => "channel" in e.errors);
    await assert.rejects(so.setVideo(actor.id, d, "not-a-uuid"), (e) => "video" in e.errors);
    await assert.rejects(so.savePost(actor.id, "2083-02-30", {}), (e) => "date" in e.errors);
    assert.equal((await owner.query(`select 1 from events where event_date = $1`, [d])).rowCount, 0);
  });

  test("ready is refused until video, caption and Luma are all there; the refusal rolls back the whole save", async () => {
    const d = date();
    await assert.rejects(so.savePost(actor.id, d, { baseCaption: "Coffee", status: "ready" }), (e) => {
      assert.ok(e instanceof ValidationError);
      assert.match(e.errors.status, /Upload the promo video\..*Add the Luma listing/);
      assert.doesNotMatch(e.errors.status, /base caption/);
      return true;
    });
    assert.equal(await postRow(d), null, "nothing created");
    await lumaLink(d);
    const vid = await insertMedia(d);
    assert.deepEqual(await so.setVideo(actor.id, d, vid), { changed: true, eventCreated: false });
    await assert.rejects(so.savePost(actor.id, d, { baseCaption: "", status: "ready" }), (e) => /base caption/.test(e.errors.status));
    // A publish time already passed (or after the event) can't be saved, nor made ready.
    await assert.rejects(so.savePost(actor.id, d, { baseCaption: "Coffee", publishAt: "2020-01-06T07:00" }), (e) => /already passed/.test(e.errors.publishAt));
    const dayAfter = new Date(Date.parse(`${d}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10);
    await assert.rejects(so.savePost(actor.id, d, { baseCaption: "Coffee", publishAt: `${dayAfter}T07:00` }), (e) => /after the event/.test(e.errors.publishAt));

    assert.deepEqual(await so.savePost(actor.id, d, { baseCaption: "Coffee", status: "ready", coverNote: "Frame 0:02" }), { changed: true, eventCreated: false });
    const w = await so.getWorkOrder(pool, d);
    assert.deepEqual([w.ready, w.actionable, w.problems, w.video.id, w.video.kind], [true, true, [], vid, "promo_video"]);
    assert.equal(w.channels.find((c) => c.channel === "facebook").caption, "Coffee\n\nRSVP: https://luma.com/bocc-test");
    assert.equal(w.channels.find((c) => c.channel === "instagram").firstComment, "RSVP: https://luma.com/bocc-test");
    assert.equal(w.coverNote, "Frame 0:02");
    const acts = (await audits(d)).map((a) => a.action);
    assert.deepEqual(acts, ["social_post.video", "social_post.update"]);

    // Clearing the Luma listing afterwards: still ready, but no longer actionable.
    await el.clearLink(actor.id, d, "luma");
    const w2 = await so.getWorkOrder(pool, d);
    assert.deepEqual([w2.ready, w2.actionable, w2.problems.map((p) => p.key)], [true, false, ["luma"]]);
    // A cancelled event: likewise.
    await lumaLink(d);
    await owner.query(`update events set status = 'cancelled', cancel_reason = 'weather' where event_date = $1`, [d]);
    assert.deepEqual((await so.getWorkOrder(pool, d)).problems.map((p) => p.key), ["event"]);
    await assert.rejects(so.savePost(actor.id, d, { baseCaption: "Coffee again", status: "ready" }), (e) => /cancelled/.test(e.errors.status));
    // Back to To do is always allowed.
    assert.equal((await so.savePost(actor.id, d, { baseCaption: "Coffee", status: "todo" })).changed, true);
    assert.equal((await postRow(d)).status, "todo");
  });

  test("setVideo: only a ready promo video of the same event", async () => {
    const [d, other] = [date(), date()];
    const photo = await insertMedia(d, { kind: "social_photo" });
    const pending = await insertMedia(d, { status: "pending" });
    const elsewhere = await insertMedia(other);
    await assert.rejects(so.setVideo(actor.id, d, photo), (e) => /isn't a promo video of this event/.test(e.errors.video));
    await assert.rejects(so.setVideo(actor.id, d, elsewhere), (e) => /isn't a promo video of this event/.test(e.errors.video));
    await assert.rejects(so.setVideo(actor.id, d, randomUUID()), (e) => /isn't a promo video/.test(e.errors.video));
    await assert.rejects(so.setVideo(actor.id, d, pending), (e) => /finished uploading/.test(e.errors.video));
    assert.equal(await postRow(d), null);
    const mov = await insertMedia(d, { contentType: "video/quicktime" });
    await so.setVideo(actor.id, d, mov);
    assert.deepEqual(await so.setVideo(actor.id, d, mov), { changed: false, eventCreated: false });
    const [a] = await audits(d);
    assert.deepEqual([a.action, a.details.created, a.details.before, a.details.after],
      ["social_post.video", true, { video_media_id: null }, { video_media_id: mov }]);
  });

  test("channel overrides: stored, back to the default when blank or equal to it; over the limit refused on a ready post", async () => {
    const d = date();
    await readyable(d);
    await so.savePost(actor.id, d, { baseCaption: "Coffee", status: "ready" });
    assert.deepEqual(await so.saveChannel(actor.id, d, "instagram", { caption: " IG only text ", firstComment: "" }), { changed: true, eventCreated: false });
    let rows = await channelRows(d);
    assert.deepEqual(rows.find((r) => r.channel === "instagram"), { channel: "instagram", caption: "IG only text", first_comment: null, status: "pending" });
    const w = await so.getWorkOrder(pool, d);
    const ig = w.channels.find((c) => c.channel === "instagram");
    assert.deepEqual([ig.caption, ig.captionOverridden, ig.firstComment], ["IG only text", true, "RSVP: https://luma.com/bocc-test"]);
    // Pasting the default back stores NULL, so later caption edits flow through.
    await so.saveChannel(actor.id, d, "instagram", { caption: ig.defaultCaption, firstComment: ig.defaultFirstComment });
    rows = await channelRows(d);
    assert.equal(rows.find((r) => r.channel === "instagram").caption, null);
    assert.deepEqual(await so.saveChannel(actor.id, d, "instagram", { caption: "", firstComment: "" }), { changed: false, eventCreated: false });

    await assert.rejects(so.saveChannel(actor.id, d, "threads", { caption: "t".repeat(501) }), (e) => /Threads caption is 501 characters; the limit is 500/.test(e.errors.caption));
    await assert.rejects(so.saveChannel(actor.id, d, "facebook", { caption: "f".repeat(5001) }), (e) => /At most 5000/.test(e.errors.caption));
    assert.ok((await so.saveChannel(actor.id, d, "facebook", { caption: "f".repeat(4000) })).changed, "Facebook's limit is higher");
    // A base caption pushing Threads over its limit can't be saved while ready.
    await assert.rejects(so.savePost(actor.id, d, { baseCaption: "b".repeat(490), status: "ready" }), (e) => /Threads caption/.test(e.errors.status));

    const acts = (await audits(d)).filter((a) => a.target_table === "social_post_channels");
    assert.deepEqual(acts.map((a) => [a.action, a.details.channel]), [
      ["social_post_channel.update", "instagram"], ["social_post_channel.update", "instagram"], ["social_post_channel.update", "facebook"],
    ]);
    assert.deepEqual(acts[0].details.after, { caption: "IG only text" });
  });

  test("deleting the attached video clears it from the post and moves it back to To do, in the delete's transaction", async () => {
    const d = date();
    const vid = await readyable(d);
    await so.savePost(actor.id, d, { baseCaption: "Coffee", status: "ready" });
    const deleted = [];
    const fakeStorage = { deleteObject: async ({ key }) => { deleted.push(key); } };
    const res = await media.deleteMedia(actor.id, fakeStorage, vid);
    assert.deepEqual([res.kind, res.eventDate, res.leftovers], ["promo_video", d, []]);
    assert.deepEqual(deleted, [`events/${d}/${vid}/original.mp4`]);
    const row = await postRow(d);
    assert.deepEqual([row.video_media_id, row.status], [null, "todo"]);
    const { rows: [a] } = await owner.query(`select details from audit_log where action = 'media.delete' and target_id = $1`, [vid]);
    assert.equal(a.details.detachedFromSocialPost, true);
    assert.deepEqual((await so.getWorkOrder(pool, d)).problems.map((p) => p.key), ["video"]);
  });

  test("promo video upload through media.mjs: one presigned PUT, complete checks only the original", async () => {
    const d = date();
    const signedPuts = [];
    const storage = {
      presignPut: (p) => { signedPuts.push(p); return { method: "PUT", url: `https://bucket.example/${p.key}`, headers: { "Content-Type": p.contentType } }; },
      headObject: async ({ key }) => (key.endsWith("/original.mov") ? { contentType: "video/quicktime", contentLength: 4_800_000 } : null),
    };
    const start = await media.startUpload(actor.id, storage, {
      eventDate: d, kind: "promo_video", original: { contentType: "video/quicktime", size: 4_800_000 },
    }, { today: new Date(`${d}T12:00:00Z`) });
    assert.deepEqual(Object.keys(start.uploads), ["original"]);
    assert.deepEqual(signedPuts.map((p) => [p.key, p.contentType, p.contentLength]),
      [[`events/${d}/${start.id}/original.mov`, "video/quicktime", 4_800_000]]);
    const { rows: [m] } = await owner.query(`select kind, status, display_key, thumb_key, publicly_usable from event_media where id = $1`, [start.id]);
    assert.deepEqual(m, { kind: "promo_video", status: "pending", display_key: null, thumb_key: null, publicly_usable: false });
    assert.deepEqual(await media.completeUpload(actor.id, storage, start.id, { db: pool }), { id: start.id, status: "ready" });
    // The videos list for the section; photos' gallery doesn't show it.
    const vids = await media.listPromoVideos(pool, d);
    assert.deepEqual(vids.ready.map((v) => v.id), [start.id]);
    assert.deepEqual((await media.listEventMedia(pool, d)).ready, []);
    await so.setVideo(actor.id, d, start.id);
    assert.equal((await so.getWorkOrder(pool, d)).video.contentType, "video/quicktime");

    // A wrong-size object keeps it pending.
    const bad = await media.startUpload(actor.id, storage, {
      eventDate: d, kind: "promo_video", original: { contentType: "video/quicktime", size: 999 },
    }, { today: new Date(`${d}T12:00:00Z`) });
    const r = await media.completeUpload(actor.id, storage, bad.id, { db: pool });
    assert.equal(r.status, "pending");
    assert.match(r.problems.join(" "), /original: 4800000 bytes, expected 999/);
  });
});

// ── 3. Over HTTP ────────────────────────────────────────────────────────────
describe("the Social post section over HTTP", { timeout: 300_000 }, () => {
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

  test("admin sees the section; the social role gets 403 and can't post; wrong Origin refused", async () => {
    const d = httpDate();
    const page = await (await req(`/admin/events/${d}/?tab=social`, { cookie: admin.cookie })).text();
    assert.ok(page.includes('id="h-social"') && page.includes("Social post"));
    for (const c of CHANNELS) assert.ok(page.includes(`id="channel-${c}"`), c);
    assert.ok(page.includes('src="/js/admin-video.js"'), "the upload script is an external file (CSP script-src 'self')");
    assert.ok(page.includes(so.formatPublishAt(so.defaultPublishAt(d)).utc), "the default publish time in UTC");
    assert.ok(page.includes("Social Posts: not set up yet"));

    assert.equal((await req(`/admin/events/${d}/`, { cookie: social.cookie })).status, 403);
    const sp = await req(`/admin/events/${d}/`, { cookie: social.cookie, method: "POST", form: { action: "social_post", baseCaption: "x" } });
    assert.equal(sp.status, 403);
    const wrong = await req(`/admin/events/${d}/`, { cookie: admin.cookie, method: "POST", origin: "https://evil.example", form: { action: "social_post", baseCaption: "x" } });
    assert.equal(wrong.status, 403);
    assert.equal(await postRow(d), null, "nothing written");
  });

  test("save, refused ready (400 with the reasons, re-filled), channel override, and the readiness lines", async () => {
    const d = httpDate();
    const ok = await req(`/admin/events/${d}/`, { cookie: admin.cookie, method: "POST",
      form: { action: "social_post", baseCaption: "Coffee <b>Tuesday</b>", extraHashtags: "founders", coverNote: "", publishAt: `${so.mondayBefore(d)}T08:30` } });
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.get("location"), `/admin/events/${d}/?tab=social&notice=social_post#social`);
    const row = await postRow(d);
    assert.equal(so.formatPublishAt(row.publish_at).local, `${so.mondayBefore(d)}T08:30`);

    const page = await (await req(`/admin/events/${d}/?tab=social&notice=social_post`, { cookie: admin.cookie })).text();
    assert.ok(page.includes("Social post saved."));
    assert.ok(page.includes("Coffee &lt;b&gt;Tuesday&lt;/b&gt;") && !page.includes("<b>Tuesday</b>"), "escaped");
    const ready = page.slice(page.indexOf('id="h-ready"'), page.indexOf('aria-label="Event page tabs"'));
    assert.ok(ready.includes("Social Posts: To do") && ready.includes("Facebook: pending") && ready.includes("0/5 channels scheduled"));
    assert.ok(ready.includes("Add the Luma listing"), "the problems under the bullet");
    assert.ok(!ready.includes("not marked ready"));
    assert.ok(page.includes(`RSVP: [Luma link: add the Luma listing]`), "preview flags the missing Luma link");

    const bad = await req(`/admin/events/${d}/`, { cookie: admin.cookie, method: "POST",
      form: { action: "social_post", baseCaption: "Coffee again", status: "ready" } });
    assert.equal(bad.status, 400);
    const badHtml = await bad.text();
    assert.ok(badHtml.includes("Not ready yet: Upload the promo video.") && badHtml.includes("Coffee again"));
    assert.equal((await postRow(d)).base_caption, "Coffee <b>Tuesday</b>", "nothing saved");

    const ch = await req(`/admin/events/${d}/`, { cookie: admin.cookie, method: "POST",
      form: { action: "social_channel", channel: "threads", caption: "Threads text", firstComment: "" } });
    assert.equal(ch.status, 303);
    const after = await (await req(`/admin/events/${d}/?tab=social`, { cookie: admin.cookie })).text();
    assert.ok(after.includes("Threads text") && after.includes("override"));

    await owner.query(`update social_post_channels set status = 'scheduled', post_url = 'https://www.facebook.com/reel/1' where event_date = $1 and channel = 'facebook'`, [d]);
    const sched = await (await req(`/admin/events/${d}/?tab=social`, { cookie: admin.cookie })).text();
    assert.ok(sched.includes("Facebook: scheduled") && sched.includes("1/5 channels scheduled") && sched.includes('href="https://www.facebook.com/reel/1"'));
    assert.ok(sched.includes("Changes here don't change posts already scheduled"));

    const unknown = await req(`/admin/events/${d}/`, { cookie: admin.cookie, method: "POST", form: { action: "social_channel", channel: "myspace" } });
    assert.equal(unknown.status, 400);
  });

  test("the status dropdown (ticket #39): the intro, four statuses, Ready for Posting refused next to it, the others saved and audited", async () => {
    const d = httpDate();
    const page = await (await req(`/admin/events/${d}/?tab=social`, { cookie: admin.cookie })).text();
    assert.ok(page.includes("The weekly promo video, posted on Facebook, Instagram, Threads, TikTok, and LinkedIn page is done by work order."));
    assert.ok(page.includes("It is only posted when the status is set to &#39;Ready for Posting&#39;") || page.includes("It is only posted when the status is set to 'Ready for Posting'"));
    assert.ok(page.includes("Automated posting requires a logged in AI Agent with the Social role and a scheduled task to look for posts"));
    assert.ok(!page.includes('name="ready"'), "the checkbox is gone");
    const select = page.match(/<select[^>]*name="status"[^>]*>([\s\S]*?)<\/select>/);
    assert.ok(select, "a status dropdown");
    const options = [...select[1].matchAll(/<option[^>]*value="([a-z]+)"([^>]*)>([^<]*)<\/option>/g)].map((m) => [m[1], m[3], /selected/.test(m[2])]);
    assert.deepEqual(options, [["todo", "To do", true], ["ready", "Ready for Posting", false], ["posted", "Posted", false], ["error", "Error", false]]);

    const bad = await req(`/admin/events/${d}/`, { cookie: admin.cookie, method: "POST",
      form: { action: "social_post", baseCaption: "Coffee", status: "ready" } });
    assert.equal(bad.status, 400);
    const badHtml = await bad.text();
    // The reasons sit right after the dropdown, which keeps what was chosen.
    const near = badHtml.match(/<select[^>]*name="status"[\s\S]*?<\/select>\s*<p[^>]*id="status-error"[^>]*>([^<]*)</);
    assert.ok(near, "the error follows the dropdown");
    assert.match(near[1], /^Not ready yet: Upload the promo video\./);
    assert.match(badHtml, /<option[^>]*value="ready"[^>]*selected/);
    assert.equal(await postRow(d), null, "nothing saved");

    const ok = await req(`/admin/events/${d}/`, { cookie: admin.cookie, method: "POST",
      form: { action: "social_post", baseCaption: "Coffee", status: "posted" } });
    assert.equal(ok.status, 303);
    assert.equal((await postRow(d)).status, "posted");
    const [audit] = (await audits(d)).filter((a) => a.action === "social_post.update");
    assert.deepEqual([audit.actor_user_id, audit.details.before.status, audit.details.after.status], [admin.user.id, "todo", "posted"]);
    const after = await (await req(`/admin/events/${d}/?tab=social`, { cookie: admin.cookie })).text();
    assert.match(after, /<option[^>]*value="posted"[^>]*selected[^>]*>Posted<\/option>/);
    const unknown = await req(`/admin/events/${d}/`, { cookie: admin.cookie, method: "POST",
      form: { action: "social_post", baseCaption: "Coffee", status: "live" } });
    assert.equal(unknown.status, 400);
  });

  test("the cover wording: cover image intro, Thumbnail timecode, and the Publish at default hint (#41)", async () => {
    const d = "2086-11-19"; // a Tuesday; the Monday before is Nov 18
    const page = await (await req(`/admin/events/${d}/?tab=social`, { cookie: admin.cookie })).text();
    const text = page.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    assert.ok(text.includes("The video's cover image on the platforms that support this feature"), "cover image intro");
    assert.ok(!text.includes("promo video's cover on the platforms"), "the old intro is gone");
    assert.match(page, /<label for="coverNote"[^>]*>Thumbnail timecode </);
    assert.ok(text.includes("the frame of the video to use where a cover image can't be uploaded, for example \"0:03\""), "timecode hint");
    assert.ok(!text.includes("Cover note"), "no Cover note label left");
    assert.ok(text.includes("(blank = the Monday before the event, 7:00 AM Eastern (Mon, Nov 18))"), "Publish at hint");
  });

  test("the video upload script is served as JavaScript", async () => {
    const res = await fetch(`${BASE}/js/admin-video.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /javascript/);
  });
});
