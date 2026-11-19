// Phase 5 social work order, part B (ADR 0011 decisions 3, 4, 6): the social role's
// pages and API, against the throwaway database (npm run test:db):
//   1. pure rules: status transitions, post URL domains, the social role's path
//      allowlist (roles.mjs mayReach, guard.mjs), the nav links
//   2. src/lib/admin/social.mjs as admin_app: setChannelResult (audited, transitions,
//      URL checks, verified_at / comment_posted_at, no-ops), findNext's states (no
//      post, not ready, problems, ready; never skipping a stuck week; cancelled weeks; the holiday break and its override) and findVerify's, with an injected
//      clock in far-future years (2091-2097) so other tests' posts don't interfere
//   3. over HTTP (astro dev, the real clock): /admin/social/next/ and /verify/ and
//      /api/admin/social/*: roles (social reaches only these), Origin, PRG, refused
//      saves, the agent-facing markup, and no personal data on any of them
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { OWNER_URL, connect, unique, useAdminEnv } from "./helpers.mjs";

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
const sp = await import("../../src/lib/admin/social-pages.mjs");
const el = await import("../../src/lib/admin/event-links.mjs");
const { todayEastern } = await import("../../src/lib/admin/events.mjs");
const { mayReach, SOCIAL_PATHS } = await import("../../src/lib/admin/roles.mjs");
const { guardRequest } = await import("../../src/lib/admin/guard.mjs");
const { navLinksFor, SOCIAL_LINKS } = await import("../../src/lib/admin/nav.mjs");

const PASSWORD = "correct horse battery staple";
const CHANNELS = ["facebook", "instagram", "threads", "tiktok", "linkedin_page"];
const GOOD_URLS = {
  facebook: "https://www.facebook.com/reel/123456",
  instagram: "https://www.instagram.com/reel/AbC123/",
  threads: "https://www.threads.com/@716coffeeclub/post/AbC",
  tiktok: "https://www.tiktok.com/@716coffeeclub/video/7311",
  linkedin_page: "https://www.linkedin.com/feed/update/urn:li:activity:7311/",
};
let owner, actor;

const channelRow = (d, c) => owner.query(
  `select status, post_url, notes, verified_at, comment_posted_at from social_post_channels where event_date = $1 and channel = $2`,
  [d, c]).then((r) => r.rows[0] ?? null);
const resultAudits = (d) => owner.query(
  `select actor_user_id, action, target_table, details from audit_log
    where target_id = $1 and action = 'social_post_channel.result' order by id`, [d]).then((r) => r.rows);

async function insertVideo(d) {
  const id = randomUUID();
  await owner.query(`insert into events (event_date) values ($1) on conflict do nothing`, [d]);
  await owner.query(
    `insert into event_media (id, event_date, kind, original_key, content_type, size_bytes, status, publicly_usable)
     values ($1, $2, 'promo_video', $3, 'video/mp4', 4800000, 'ready', false)`,
    [id, d, `events/${d}/${id}/original.mp4`]);
  return id;
}

/** A post that is ready (video, caption, Luma) through the module, as an admin would make it. */
async function readyPost(d, { caption = "Coffee Tuesday in Buffalo", coverNote = "Frame at 0:03" } = {}) {
  await el.setLink(actor.id, d, "luma", { url: "https://luma.com/bocc-test", externalId: "" });
  await so.setVideo(actor.id, d, await insertVideo(d));
  await so.savePost(actor.id, d, { baseCaption: caption, coverNote, ready: "on" });
}

/** Mid-day Eastern, `days` after `d` (YYYY-MM-DD). */
const at = (d, days = 0, hourUtc = 17) => new Date(Date.parse(`${d}T${String(hourUtc).padStart(2, "0")}:00:00Z`) + days * 86400_000);

let ipCounter = 0;
const nextIp = () => `198.22.${Math.floor(++ipCounter / 250)}.${ipCounter % 250 + 1}`;
async function signedIn(roles) {
  const user = await createUser({ email: `${unique("sb")}@example.com`, name: "Social B Test", password: PASSWORD });
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
  actor = await createUser({ email: `${unique("socialb")}@example.com`, name: "Social B Admin", password: PASSWORD });
});
after(async () => { await owner?.end(); await pool.end(); });

// ── 1. Pure rules ───────────────────────────────────────────────────────────
describe("rules", () => {
  test("transitions: everything but live -> pending; the same status is always fine", () => {
    for (const s of so.STATUSES) assert.equal(so.canTransition(s, s), true);
    assert.equal(so.canTransition("pending", "scheduled"), true);
    assert.equal(so.canTransition("scheduled", "live"), true);
    assert.equal(so.canTransition("scheduled", "failed"), true);
    assert.equal(so.canTransition("scheduled", "pending"), true);
    assert.equal(so.canTransition("failed", "pending"), true);
    assert.equal(so.canTransition("live", "scheduled"), true);
    assert.equal(so.canTransition("live", "pending"), false);
    assert.equal(so.canTransition("pending", "bogus"), false);
  });

  test("post URLs: https on the channel's own domain only", () => {
    for (const [c, u] of Object.entries(GOOD_URLS)) assert.equal(so.postUrlProblem(c, u), null, c);
    assert.equal(so.postUrlProblem("facebook", "https://fb.com/x"), null);
    assert.equal(so.postUrlProblem("threads", "https://www.threads.net/@a/post/b"), null);
    assert.equal(so.postUrlProblem("instagram", "https://INSTAGRAM.com/p/x"), null);
    const bad = [
      ["facebook", "http://www.facebook.com/reel/1"],
      ["facebook", "https://evilfacebook.com/reel/1"],
      ["facebook", "https://facebook.com.evil.example/reel/1"],
      ["facebook", "https://www.instagram.com/reel/1"],
      ["facebook", "https://user:pw@facebook.com/reel/1"],
      ["facebook", "https://facebook.com:8443/reel/1"],
      ["facebook", "javascript:alert(1)//facebook.com"],
      ["facebook", "https://www.facebook.com/reel/1 x"],
      ["tiktok", `https://www.tiktok.com/${"a".repeat(500)}`],
      ["linkedin_page", "https://lnkd.in/abc"],
      ["threads", "https://threads.org/x"],
    ];
    for (const [c, u] of bad) assert.ok(so.postUrlProblem(c, u), `${c} ${u}`);
    assert.match(so.postUrlProblem("facebook", "https://x.com/1"), /https link on facebook\.com or fb\.com/);
  });

  test("first comments: only Instagram and TikTok", () => {
    assert.deepEqual([...so.COMMENT_CHANNELS], ["instagram", "tiktok"]);
    for (const c of ["facebook", "threads", "linkedin_page"]) {
      assert.throws(() => so.validateResultInput(c, { commentPosted: true }), (e) => /has no first comment/.test(e.errors.commentPosted));
    }
    assert.equal(so.validateResultInput("tiktok", { commentPosted: "true" }).commentPosted, true);
    assert.throws(() => so.validateResultInput("myspace", {}), (e) => Boolean(e.errors.channel));
    assert.throws(() => so.validateResultInput("facebook", { status: "posted" }), (e) => Boolean(e.errors.status));
  });

  test("result input: non-string postUrl / notes / status are refused, null and \"\" clear", () => {
    for (const bad of [123, {}, [], true]) {
      assert.throws(() => so.validateResultInput("facebook", { postUrl: bad }), (e) => /must be a string/.test(e.errors.postUrl), `postUrl ${JSON.stringify(bad)}`);
      assert.throws(() => so.validateResultInput("facebook", { notes: bad }), (e) => /must be a string/.test(e.errors.notes), `notes ${JSON.stringify(bad)}`);
      assert.throws(() => so.validateResultInput("facebook", { status: bad }), (e) => Boolean(e.errors.status), `status ${JSON.stringify(bad)}`);
    }
    assert.throws(() => so.validateResultInput("facebook", { status: null }), (e) => Boolean(e.errors.status));
    assert.throws(() => so.validateResultInput("tiktok", { verified: 1 }), (e) => Boolean(e.errors.verified));
    assert.throws(() => so.validateResultInput("tiktok", { commentPosted: {} }), (e) => Boolean(e.errors.commentPosted));
    assert.deepEqual(so.validateResultInput("facebook", { postUrl: null, notes: null }), { verified: false, postUrl: null, notes: null });
    assert.deepEqual(so.validateResultInput("facebook", { postUrl: "", notes: " " }), { verified: false, postUrl: null, notes: null });
  });

  test("post URLs are stored as parsed: an upper-case scheme or host is fine", () => {
    assert.equal(so.validateResultInput("facebook", { postUrl: "HTTPS://WWW.FaceBook.COM/reel/AbC" }).postUrl, "https://www.facebook.com/reel/AbC");
    assert.equal(so.validateResultInput("tiktok", { postUrl: "https://tiktok.com" }).postUrl, "https://tiktok.com/");
  });

  test("the social role reaches only its allowlist; admin everything; no role nothing", () => {
    const allowed = ["/admin", "/admin/", "/admin/account/", "/admin/social", "/admin/social/", "/admin/social/next/",
      "/admin/social/verify", "/api/admin/social/next", "/api/admin/social/channel", "/api/admin/me"];
    const refused = ["/admin/events/", "/admin/events/2026-11-24/", "/admin/attendees/", "/admin/attendees/x", "/admin/checkins/",
      "/admin/email-list/", "/admin/streaks/", "/admin/users/", "/api/admin/email-list.csv", "/api/admin/email-list/opt-out",
      "/api/admin/media/uploads", "/api/admin/media/x/delete", "/admin/socialx/", "/api/admin/socialx", "/admin/nope",
      "/api/admin/me/x", "/admin/account/x"];
    for (const p of allowed) assert.equal(mayReach(["social"], p), true, p);
    for (const p of refused) assert.equal(mayReach(["social"], p), false, p);
    for (const p of [...allowed, ...refused]) assert.equal(mayReach(["admin"], p), true, p);
    for (const p of allowed) assert.equal(mayReach([], p), false, p);
    assert.ok(SOCIAL_PATHS.length > 0);
  });

  test("guardRequest refuses social outside the allowlist before the route runs", async () => {
    const ctx = (roles) => async () => ({ user: { id: "u", email: "s@example.com", name: "S" }, session: { id: "s" }, roles, setCookies: [] });
    const u = (p) => new URL(`http://localhost${p}`);
    const page = await guardRequest(u("/admin/events/"), new Headers(), ctx(["social"]));
    assert.equal(page.response.status, 403);
    assert.match(page.response.headers.get("content-type"), /text\/html/);
    const api = await guardRequest(u("/api/admin/media/uploads"), new Headers(), ctx(["social"]));
    assert.equal(api.response.status, 403);
    assert.deepEqual(await api.response.json(), { error: "forbidden" });
    const ok = await guardRequest(u("/admin/social/next/"), new Headers(), ctx(["social"]));
    assert.equal(ok.response, null);
    assert.equal((await guardRequest(u("/admin/events/"), new Headers(), ctx(["admin"]))).response, null);
    assert.equal((await guardRequest(u("/admin/events/"), new Headers(), ctx(["admin", "social"]))).response, null);
  });

  test("nav: the social links for both roles, nothing else for social", () => {
    assert.deepEqual(SOCIAL_LINKS.map((l) => l.href), ["/admin/social/next/", "/admin/social/verify/"]);
    assert.deepEqual(navLinksFor(["social"]).map((l) => l.href), ["/admin/social/next/", "/admin/social/verify/"]);
    const admin = navLinksFor(["admin"]).map((l) => l.href);
    assert.ok(admin.includes("/admin/social/next/") && admin.includes("/admin/events/"));
    for (const l of SOCIAL_LINKS) assert.equal(mayReach(["social"], l.href), true, l.href);
  });

  test("resultInput passes on only the fields that were sent", () => {
    assert.deepEqual(sp.resultInput({ date: "x", channel: "facebook", status: "live", postUrl: "", extra: "y" }), { status: "live", postUrl: "" });
    assert.deepEqual(sp.resultInput({ commentPosted: "true" }), { commentPosted: "true" });
  });
});

// ── 2. The module ───────────────────────────────────────────────────────────
describe("setChannelResult (admin_app)", () => {
  const D = "2091-01-16"; // a Tuesday; publish Monday 2091-01-15 7:00 ET
  const now = at("2091-01-10");

  test("no post: 404, nothing written", async () => {
    await assert.rejects(so.setChannelResult(actor.id, "2091-01-09", "facebook", { status: "scheduled" }, { now }),
      (e) => e.status === 404 && /no social post/.test(e.errors.date));
    await assert.rejects(so.setChannelResult(actor.id, "not-a-date", "facebook", {}), (e) => e.status === 400 && Boolean(e.errors.date));
  });

  test("scheduling needs an actionable post (409), then pending -> scheduled is audited", async () => {
    await so.savePost(actor.id, D, { baseCaption: "Coffee" });
    await assert.rejects(so.setChannelResult(actor.id, D, "facebook", { status: "scheduled" }, { now }),
      (e) => e.status === 409 && /Can't schedule Facebook yet: The post isn't marked ready/.test(e.errors.status));
    assert.equal((await channelRow(D, "facebook")).status, "pending");

    await readyPost(D);
    const r = await so.setChannelResult(actor.id, D, "facebook", { status: "scheduled", postUrl: ` ${GOOD_URLS.facebook} `, notes: "Business Suite" }, { now });
    assert.deepEqual(r, { changed: true, eventCreated: false });
    const row = await channelRow(D, "facebook");
    assert.equal(row.status, "scheduled");
    assert.equal(row.post_url, GOOD_URLS.facebook);
    assert.equal(row.notes, "Business Suite");
    assert.equal(row.verified_at, null);
    const audits = await resultAudits(D);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].actor_user_id, actor.id);
    assert.equal(audits[0].target_table, "social_post_channels");
    assert.deepEqual(audits[0].details, {
      channel: "facebook",
      before: { status: "pending", post_url: null, notes: null },
      after: { status: "scheduled", post_url: GOOD_URLS.facebook, notes: "Business Suite" },
    });

    const again = await so.setChannelResult(actor.id, D, "facebook", { status: "scheduled", postUrl: GOOD_URLS.facebook }, { now });
    assert.equal(again.changed, false, "the same values: no-op");
    assert.equal((await resultAudits(D)).length, 1, "no audit row for a no-op");
  });

  test("post URL checks: wrong domain refused, nothing written; blank clears; absent keeps", async () => {
    await assert.rejects(so.setChannelResult(actor.id, D, "instagram", { status: "scheduled", postUrl: "https://www.facebook.com/reel/1" }, { now }),
      (e) => e.status === 400 && /instagram\.com/.test(e.errors.postUrl));
    assert.equal((await channelRow(D, "instagram")).status, "pending", "the refused save changed nothing");
    await so.setChannelResult(actor.id, D, "facebook", { postUrl: "" }, { now });
    assert.equal((await channelRow(D, "facebook")).post_url, null);
    await so.setChannelResult(actor.id, D, "facebook", { postUrl: GOOD_URLS.facebook }, { now });
    await so.setChannelResult(actor.id, D, "facebook", { notes: "kept the URL" }, { now });
    assert.equal((await channelRow(D, "facebook")).post_url, GOOD_URLS.facebook);
  });

  test("an upper-case post URL is saved (normalised; the column CHECK is case-sensitive); null clears", async () => {
    await so.setChannelResult(actor.id, D, "facebook", { postUrl: "HTTPS://WWW.FACEBOOK.COM/reel/123456" }, { now });
    assert.equal((await channelRow(D, "facebook")).post_url, "https://www.facebook.com/reel/123456");
    await so.setChannelResult(actor.id, D, "facebook", { notes: null }, { now });
    assert.equal((await channelRow(D, "facebook")).notes, null);
    await so.setChannelResult(actor.id, D, "facebook", { postUrl: GOOD_URLS.facebook, notes: "kept the URL" }, { now });
  });

  test("a channel result waits for an admin's lock on the post row (and goes on after it)", async () => {
    const other = await connect(OWNER_URL);
    try {
      await other.query("begin");
      await other.query(`select 1 from social_posts where event_date = $1 for update`, [D]);
      let done = false;
      const p = so.setChannelResult(actor.id, D, "facebook", { notes: "after the lock" }, { now }).then((r) => { done = true; return r; });
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(done, false, "blocked while the post row is locked FOR UPDATE");
      await other.query("rollback");
      assert.equal((await p).changed, true);
      assert.equal((await channelRow(D, "facebook")).notes, "after the lock");
    } finally {
      await other.query("rollback").catch(() => {});
      await other.end();
    }
    await so.setChannelResult(actor.id, D, "facebook", { notes: "kept the URL" }, { now });
  });

  test("live needs a URL and stamps verified_at; first comment only when live, only IG/TikTok", async () => {
    const later = at("2091-01-15", 0, 13);
    await so.setChannelResult(actor.id, D, "instagram", { status: "scheduled" }, { now });
    await assert.rejects(so.setChannelResult(actor.id, D, "instagram", { status: "live" }, { now: later }),
      (e) => e.status === 400 && /needs its Instagram post URL/.test(e.errors.postUrl));
    await assert.rejects(so.setChannelResult(actor.id, D, "instagram", { commentPosted: true }, { now: later }),
      (e) => e.status === 400 && /live before its first comment/.test(e.errors.commentPosted));
    await so.setChannelResult(actor.id, D, "instagram", { status: "live", postUrl: GOOD_URLS.instagram }, { now: later });
    let row = await channelRow(D, "instagram");
    assert.equal(row.status, "live");
    assert.equal(row.verified_at.getTime(), later.getTime());
    assert.equal(row.comment_posted_at, null);

    const t2 = new Date(later.getTime() + 60_000);
    await so.setChannelResult(actor.id, D, "instagram", { commentPosted: true }, { now: t2 });
    row = await channelRow(D, "instagram");
    assert.equal(row.comment_posted_at.getTime(), t2.getTime());
    assert.equal(row.verified_at.getTime(), later.getTime(), "saving live again keeps verified_at");
    assert.equal((await so.setChannelResult(actor.id, D, "instagram", { commentPosted: true }, { now: new Date(t2.getTime() + 1) })).changed, false,
      "already posted: no-op, the first time is kept");
    const t3 = new Date(t2.getTime() + 60_000);
    await so.setChannelResult(actor.id, D, "instagram", { status: "live", verified: true }, { now: t3 });
    assert.equal((await channelRow(D, "instagram")).verified_at.getTime(), t3.getTime(), "verified: true stamps it again");

    await assert.rejects(so.setChannelResult(actor.id, D, "facebook", { commentPosted: true }, { now }),
      (e) => e.status === 400 && /Facebook has no first comment/.test(e.errors.commentPosted));
    await assert.rejects(so.setChannelResult(actor.id, D, "facebook", { verified: true }, { now }),
      (e) => e.status === 400 && /Only a live post/.test(e.errors.verified));
  });

  test("fixing mistakes: live -> pending refused (409); live -> failed needs a note and clears verified_at; failed -> pending", async () => {
    await assert.rejects(so.setChannelResult(actor.id, D, "instagram", { status: "pending" }, { now }),
      (e) => e.status === 409 && /can become scheduled, failed/.test(e.errors.status));
    await assert.rejects(so.setChannelResult(actor.id, D, "instagram", { status: "failed", notes: "" }, { now }),
      (e) => e.status === 400 && /why Instagram failed/.test(e.errors.notes));
    await so.setChannelResult(actor.id, D, "instagram", { status: "failed", notes: "Reel was removed" }, { now });
    let row = await channelRow(D, "instagram");
    assert.equal(row.status, "failed");
    assert.equal(row.verified_at, null);
    assert.ok(row.comment_posted_at, "the comment time stays (the comment may still be there)");
    await so.setChannelResult(actor.id, D, "instagram", { status: "pending", commentPosted: false }, { now });
    row = await channelRow(D, "instagram");
    assert.equal(row.status, "pending");
    assert.equal(row.comment_posted_at, null);
    await so.setChannelResult(actor.id, D, "threads", { status: "live", postUrl: GOOD_URLS.threads }, { now });
    assert.equal((await channelRow(D, "threads")).status, "live", "pending -> live (Wednesday's save was missed)");
  });
});

describe("findNext and findVerify (admin_app, injected clock)", () => {
  test("next: no post, not ready, problems, ready; the earliest week with work, never a later one", async () => {
    const now = at("2092-01-02"); // a Wednesday
    const D = "2092-01-08", D2 = "2092-01-15", D3 = "2092-01-22";
    let r = await so.findNext(pool, { now });
    assert.equal(r.state, "nothing");
    assert.equal(r.reason, "no_post");
    assert.equal(r.date, D, "next Tuesday counts even without an events row");
    assert.match(r.message, /No social post is set up for 2092-01-08 yet/);

    // A later week that is ready doesn't jump the queue while D has no post.
    await readyPost(D2);
    r = await so.findNext(pool, { now });
    assert.equal(r.state, "nothing");
    assert.equal(r.reason, "no_post");
    assert.equal(r.date, D);
    assert.match(r.message, /Later weeks wait/);

    await so.savePost(actor.id, D, { baseCaption: "Coffee" });
    r = await so.findNext(pool, { now });
    assert.equal(r.reason, "not_ready");
    assert.equal(r.date, D);
    assert.deepEqual(r.problems.map((p) => p.key), ["video", "luma"]);
    assert.deepEqual(r.upcoming.slice(0, 2), [{ date: D, ready: false, pendingChannels: 5 }, { date: D2, ready: true, pendingChannels: 5 }]);

    await readyPost(D);
    r = await so.findNext(pool, { now });
    assert.equal(r.state, "ready");
    assert.equal(r.order.date, D);
    assert.equal(r.order.actionable, true);

    await el.clearLink(actor.id, D, "luma");
    r = await so.findNext(pool, { now });
    assert.equal(r.reason, "problems");
    assert.equal(r.date, D, "still D, not the ready D2");
    assert.deepEqual(r.problems.map((p) => p.key), ["luma"]);
    await el.setLink(actor.id, D, "luma", { url: "https://luma.com/bocc-test", externalId: "" });

    // Part done: still D.
    for (const c of CHANNELS.slice(0, 4)) await so.setChannelResult(actor.id, D, c, { status: "scheduled" }, { now });
    assert.equal((await so.findNext(pool, { now })).order?.date, D, "a channel still pending");
    await so.setChannelResult(actor.id, D, "linkedin_page", { status: "failed", notes: "LinkedIn was down" }, { now });
    r = await so.findNext(pool, { now });
    assert.equal(r.state, "ready");
    assert.equal(r.order.date, D2, "every channel of D is done, so the next week");

    // A cancelled week is skipped.
    await owner.query(`update events set status = 'cancelled', cancel_reason = 'weather' where event_date = $1`, [D2]);
    r = await so.findNext(pool, { now });
    assert.equal(r.reason, "no_post");
    assert.equal(r.date, D3, "D2 is cancelled");
    await owner.query(`update events set status = 'scheduled', cancel_reason = null where event_date = $1`, [D2]);

    // A week whose publish time has passed is the Monday task's, not this one's.
    const afterPublish = at("2092-01-14", 0, 15); // Monday 10 AM ET: D2's publish time has passed
    r = await so.findNext(pool, { now: afterPublish });
    assert.equal(r.date, D3);
    assert.notEqual(r.order?.date, D2, "a post whose publish time passed is not offered for scheduling");
  });

  test("next: the holiday break (Dec 22 to Jan 4) is skipped without a row, 2026", async () => {
    // No rows in this range (other tests' real-clock posts start at the coming Tuesday).
    const r = await so.findNext(pool, { now: at("2026-12-16") }); // Wednesday after 12/15
    assert.equal(r.date ?? r.order?.date, "2027-01-05", "12/22 and 12/29 don't exist");
    assert.ok(!r.upcoming.some((u) => u.date === "2026-12-22" || u.date === "2026-12-29"));
    // 12/15's publish time has passed: on to the first week after the break, not 12/22.
    const r2 = await so.findNext(pool, { now: at("2026-12-16"), today: "2026-12-14" });
    assert.equal(r2.date ?? r2.order?.date, "2027-01-05");
  });

  test("next: holiday weeks are skipped, a scheduled row on one is the override, normal weeks never skipped", async () => {
    // 2096: Tuesdays 12/18 (normal), 12/25 and 1/1 (holiday break), 1/8 and 1/15 (normal).
    const now = at("2096-12-12"); // a Wednesday
    const D = "2096-12-18", H1 = "2096-12-25", H2 = "2097-01-01", N1 = "2097-01-08", N2 = "2097-01-15";
    let r = await so.findNext(pool, { now });
    assert.equal(r.date, D, "the normal week before the break is unchanged");

    // D done: every listed week is done, so the fallback's first Tuesday after it, past the break.
    await readyPost(D);
    for (const c of CHANNELS) await so.setChannelResult(actor.id, D, c, { status: "scheduled" }, { now });
    r = await so.findNext(pool, { now });
    assert.equal(r.reason, "no_post");
    assert.equal(r.date, N1, "12/25 and 1/1 skipped");

    // A ready later week never jumps the first normal week after the break.
    await readyPost(N2);
    r = await so.findNext(pool, { now });
    assert.equal(r.reason, "no_post");
    assert.equal(r.date, N1);
    assert.ok(!r.upcoming.some((u) => u.date === H1 || u.date === H2));

    // The override: a deliberately saved (scheduled) row on a holiday date is a real event.
    await so.savePost(actor.id, H1, { baseCaption: "Holiday coffee" });
    assert.equal((await owner.query(`select status from events where event_date = $1`, [H1])).rows[0].status, "scheduled");
    r = await so.findNext(pool, { now });
    assert.equal(r.reason, "not_ready");
    assert.equal(r.date, H1, "a scheduled holiday row counts");
    assert.deepEqual(r.upcoming.map((u) => u.date), [D, H1, N2], "the override is listed with the other posts");

    // Cancelled, it is skipped again (like any cancelled week).
    await owner.query(`update events set status = 'cancelled', cancel_reason = 'weather' where event_date = $1`, [H1]);
    r = await so.findNext(pool, { now });
    assert.equal(r.date, N1);
  });

  test("verify skips a cancelled event", async () => {
    const D = "2095-03-08"; // Tuesday
    await readyPost(D);
    const monday = at("2095-03-07", 0, 13);
    assert.equal((await so.findVerify(pool, { now: monday })).order?.date, D);
    await owner.query(`update events set status = 'cancelled', cancel_reason = 'weather' where event_date = $1`, [D]);
    const r = await so.findVerify(pool, { now: monday });
    assert.equal(r.state, "nothing");
    assert.notEqual(r.nextPublish?.date, D);
    await owner.query(`update events set status = 'scheduled', cancel_reason = null where event_date = $1`, [D]);
  });

  test("verify: from the publish time through the event day; to-do and all done", async () => {
    const D = "2093-01-06"; // Tuesday; publish Monday 2093-01-05 12:00 UTC
    await readyPost(D);
    const before = at("2093-01-04");
    let r = await so.findVerify(pool, { now: before });
    assert.equal(r.state, "nothing");
    assert.equal(r.nextPublish.date, D);

    const monday = at("2093-01-05", 0, 13);
    await so.setChannelResult(actor.id, D, "facebook", { status: "scheduled", postUrl: GOOD_URLS.facebook }, { now: before });
    await so.setChannelResult(actor.id, D, "tiktok", { status: "scheduled" }, { now: before });
    await so.setChannelResult(actor.id, D, "instagram", { status: "live", postUrl: GOOD_URLS.instagram }, { now: monday });
    r = await so.findVerify(pool, { now: monday });
    assert.equal(r.state, "verify");
    assert.equal(r.order.date, D);
    assert.equal(r.allDone, false);
    assert.deepEqual(r.todo.map((t) => `${t.channel}:${t.task}`),
      ["facebook:verify", "instagram:comment", "threads:never_scheduled", "tiktok:verify", "linkedin_page:never_scheduled"]);

    assert.equal((await so.findVerify(pool, { now: at(D, 0, 22) })).order?.date, D, "still there on the event day");
    assert.equal((await so.findVerify(pool, { now: at(D, 1) })).state, "nothing", "gone the day after");

    for (const c of ["facebook", "tiktok", "threads", "linkedin_page"]) {
      await so.setChannelResult(actor.id, D, c, { status: "live", postUrl: GOOD_URLS[c] }, { now: monday });
    }
    await so.setChannelResult(actor.id, D, "instagram", { commentPosted: true }, { now: monday });
    r = await so.findVerify(pool, { now: monday });
    assert.deepEqual(r.todo.map((t) => `${t.channel}:${t.task}`), ["tiktok:comment"]);
    await so.setChannelResult(actor.id, D, "tiktok", { commentPosted: true }, { now: monday });
    r = await so.findVerify(pool, { now: monday });
    assert.equal(r.allDone, true);
  });

  test("loadPick adds a download link with a filename, or says storage is off; toJson drops the storage key", async () => {
    const D = "2094-01-05";
    await readyPost(D);
    const now = at("2094-01-01");
    const calls = [];
    const fake = { presignGet: (o) => { calls.push(o); return { url: "https://bucket.example/x?sig", expiresAt: new Date(0) }; } };
    const pick = await sp.loadPick("next", { now, storage: fake });
    assert.equal(pick.order.date, D);
    assert.equal(calls[0].downloadName, `bocc-${D}-promo.mp4`);
    assert.match(calls[0].key, new RegExp(`^events/${D}/.+/original\\.mp4$`));
    assert.equal(pick.video.downloadUrl, "https://bucket.example/x?sig");
    const off = await sp.loadPick("next", { now, storage: null });
    assert.match(off.video.unavailable, /can't be downloaded/);
    const j = JSON.stringify(sp.toJson(pick));
    assert.ok(!j.includes("original.mp4") && !j.includes("originalKey"), "no storage key in the JSON");
    assert.equal(JSON.parse(j).order.channels.length, 5);
  });
});

// ── 3. Over HTTP ────────────────────────────────────────────────────────────
describe("the social pages and API over HTTP", { timeout: 300_000 }, () => {
  let server, admin, social, norole;
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const today = todayEastern();
  // The week /admin/social/next/ is about right now (the real clock): the earliest
  // upcoming event with work left, whatever other test files left behind. Set in before().
  let NEXT;
  // An event later this week whose publish time we put in the past: the post to verify.
  const VERIFY = (() => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
  const PII = { name: `Zelda ${unique("Pii")}`, email: `${unique("pii")}@example.com`, business: `Acme ${unique("Biz")}`, phone: "716-555-0199" };

  before(async () => {
    const { dev } = await import("astro");
    server = await dev({ root, logLevel: "error", server: { port, host: "localhost" }, devToolbar: { enabled: false } });
    admin = await signedIn(["admin"]);
    social = await signedIn(["social"]);
    norole = await signedIn([]);
    const pick = await so.findNext(pool);
    NEXT = pick.order?.date ?? pick.date;
    const { rows: [a] } = await owner.query(
      `insert into attendees (email, name, phone, business_name, ok_to_email) values ($1, $2, $3, $4, true) returning id`,
      [PII.email, PII.name, PII.phone, PII.business]);
    await owner.query(`insert into checkins (attendee_id, event_id, token, checkin_date) values ($1, 'bocc', 'tok', current_date)`, [a.id]);
  });
  after(async () => { await server?.stop(); });

  const req = (path, { cookie, method = "GET", form, json, origin = BASE } = {}) => {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    let body;
    if (method === "POST") {
      if (origin) headers.origin = origin;
      if (json !== undefined) {
        headers["content-type"] = "application/json";
        body = typeof json === "string" ? json : JSON.stringify(json);
      } else {
        headers["content-type"] = "application/x-www-form-urlencoded";
        body = new URLSearchParams(form ?? {}).toString();
      }
    }
    return fetch(`${BASE}${path}`, { method, headers, body, redirect: "manual" });
  };
  /** The inner HTML of <tag id="id" …>…</tag> (scoped-style attributes allowed), or null. */
  const inner = (html, tag, id) => new RegExp(`<${tag} id="${id}"[^>]*>([\\s\\S]*?)</${tag}>`).exec(html)?.[1] ?? null;
  const has = (html, re) => re.test(html);
  const noPii = (text, where) => {
    for (const v of Object.values(PII)) assert.ok(!text.includes(v), `${where} shows ${v}`);
    for (const p of ["/admin/attendees", "/admin/checkins", "/admin/email-list", "/admin/streaks", "/admin/users", "/admin/events"]) {
      assert.ok(!text.includes(`href="${p}`), `${where} links to ${p}`);
    }
  };

  test("verify, nothing yet: the 'Nothing to verify' state", async () => {
    const res = await req("/admin/social/verify/", { cookie: social.cookie });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('id="nothing"') && html.includes("Nothing to verify"));
    const api = await (await req("/api/admin/social/verify", { cookie: social.cookie })).json();
    assert.equal(api.state, "nothing");
  });

  test("roles: signed out, no role, and the social role everywhere outside its pages", async () => {
    for (const p of ["/admin/social/next/", "/admin/social/verify/"]) {
      const r = await req(p);
      assert.equal(r.status, 302);
      assert.match(r.headers.get("location"), /^\/login\/\?next=/);
      assert.equal((await req(p, { cookie: norole.cookie })).status, 403);
    }
    assert.equal((await req("/api/admin/social/next")).status, 401);
    assert.equal((await req("/api/admin/social/next", { cookie: norole.cookie })).status, 403);

    for (const p of ["/admin/", "/admin/account/", "/admin/social/next/", "/admin/social/verify/", "/api/admin/social/next", "/api/admin/social/verify", "/api/admin/me"]) {
      assert.equal((await req(p, { cookie: social.cookie })).status, 200, p);
      assert.equal((await req(p, { cookie: admin.cookie })).status, 200, `admin ${p}`);
    }
    const idx = await req("/admin/social/", { cookie: social.cookie });
    assert.equal(idx.status, 302);
    assert.equal(idx.headers.get("location"), "/admin/social/next/");

    const pages = ["/admin/events/", `/admin/events/${NEXT}/`, "/admin/attendees/", `/admin/attendees/${randomUUID()}`, "/admin/checkins/",
      "/admin/email-list/", "/admin/streaks/", "/admin/users/", "/admin/no-such-page/"];
    for (const p of pages) {
      const r = await req(p, { cookie: social.cookie });
      assert.equal(r.status, 403, p);
      noPii(await r.text(), p);
    }
    for (const p of ["/api/admin/email-list.csv", "/api/admin/no-such-api"]) {
      assert.equal((await req(p, { cookie: social.cookie })).status, 403, p);
    }
    for (const p of ["/api/admin/media/uploads", `/api/admin/media/${randomUUID()}/delete`, `/api/admin/media/${randomUUID()}/complete`, "/api/admin/email-list/opt-out"]) {
      const r = await req(p, { cookie: social.cookie, method: "POST", json: {} });
      assert.equal(r.status, 403, p);
      assert.deepEqual(await r.json(), { error: "forbidden" }, p);
    }
    const ev = await req(`/admin/events/${NEXT}/`, { cookie: social.cookie, method: "POST", form: { action: "social_post", baseCaption: "x" } });
    assert.equal(ev.status, 403);

    const home = await (await req("/admin/", { cookie: social.cookie })).text();
    assert.ok(home.includes('href="/admin/social/next/"') && home.includes('href="/admin/social/verify/"'));
    noPii(home, "social home");
    const adminHome = await (await req("/admin/", { cookie: admin.cookie })).text();
    assert.ok(adminHome.includes('href="/admin/social/next/"'), "admins see the Social links too");
  });

  test("next: the agent-facing work order, PRG saves, refused saves, Origin", async () => {
    await readyPost(NEXT, { caption: "Coffee <b>Tuesday</b> & friends", coverNote: "Use the frame at 0:03" });
    const order = await so.getWorkOrder(pool, NEXT);
    const res = await req("/admin/social/next/", { cookie: social.cookie });
    assert.equal(res.status, 200);
    const html = await res.text();
    noPii(html, "next");
    assert.ok(html.includes(`data-date="${NEXT}"`), "this post is the next one");
    assert.ok(html.includes(order.publishAtDisplay.et) && html.includes(order.publishAtDisplay.utc), "publish time in ET and UTC");
    assert.ok(inner(html, "pre", "cover-note") === "Use the frame at 0:03");
    assert.ok(!/<script(?![^>]*\bsrc=)/.test(html), "no inline script (CSP script-src 'self')");
    assert.ok(!/<script[^>]*src="\/(?!@vite|src\/)/.test(html), "and no page script of its own (dev serves only Vite's client)");
    for (const c of order.channels) {
      assert.ok(html.includes(`<section id="channel-${c.channel}"`), c.channel);
      const esc = c.caption.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      assert.ok(inner(html, "pre", `caption-${c.channel}`) === esc, `exact caption ${c.channel}`);
      assert.ok(has(html, new RegExp(`<button type="submit"[^>]*>Save ${c.label}</button>`)), `Save ${c.label}`);
    }
    assert.ok(!html.includes("<b>Tuesday</b>"), "escaped");
    assert.ok(inner(html, "pre", "first-comment-instagram") === "RSVP: https://luma.com/bocc-test");
    assert.ok(html.includes("None: Facebook has no first comment."));
    if (process.env.STORAGE_ENDPOINT) {
      assert.ok(html.includes('id="video-download"') && html.includes("response-content-disposition"), "a presigned download link");
      assert.ok(html.includes(`bocc-${NEXT}-promo.mp4`));
    } else {
      assert.ok(html.includes('id="video-download-unavailable"'));
    }

    const save = await req("/admin/social/next/", { cookie: social.cookie, method: "POST",
      form: { date: NEXT, channel: "facebook", status: "scheduled", postUrl: GOOD_URLS.facebook, notes: "" } });
    assert.equal(save.status, 303);
    assert.equal(save.headers.get("location"), "/admin/social/next/?notice=saved&channel=facebook#channel-facebook");
    assert.equal((await channelRow(NEXT, "facebook")).status, "scheduled");
    const [audit] = await resultAudits(NEXT);
    assert.equal(audit.actor_user_id, social.user.id, "audited as the social user");
    const back = await (await req("/admin/social/next/?notice=saved&channel=facebook", { cookie: social.cookie })).text();
    assert.ok(back.includes("Facebook saved."));
    assert.ok(back.includes('data-channel="facebook" data-status="scheduled"'));
    assert.ok(back.includes("4 of 5 channels pending."));
    assert.ok(back.includes("Already done (scheduled)"));

    const bad = await req("/admin/social/next/", { cookie: social.cookie, method: "POST",
      form: { date: NEXT, channel: "instagram", status: "scheduled", postUrl: "https://evil.example/instagram.com", notes: "x" } });
    assert.equal(bad.status, 400);
    const badHtml = await bad.text();
    assert.ok(badHtml.includes("must be an https link on instagram.com") && badHtml.includes('value="https://evil.example/instagram.com"'));
    assert.equal((await channelRow(NEXT, "instagram")).status, "pending");

    const wrong = await req("/admin/social/next/", { cookie: social.cookie, method: "POST", origin: "https://evil.example",
      form: { date: NEXT, channel: "threads", status: "scheduled" } });
    assert.equal(wrong.status, 403);
    assert.equal((await channelRow(NEXT, "threads")).status, "pending");
    const unknown = await req("/admin/social/next/", { cookie: social.cookie, method: "POST", form: { date: NEXT, channel: "myspace", status: "scheduled" } });
    assert.equal(unknown.status, 400);
    const same = await req("/admin/social/next/", { cookie: social.cookie, method: "POST",
      form: { date: NEXT, channel: "facebook", status: "scheduled", postUrl: GOOD_URLS.facebook, notes: "" } });
    assert.equal(same.headers.get("location"), "/admin/social/next/?notice=unchanged&channel=facebook#channel-facebook");
  });

  test("JSON API: GET next, POST channel (Origin, bad body, 404, 409), 405", async () => {
    const api = await req("/api/admin/social/next", { cookie: social.cookie });
    assert.equal(api.status, 200);
    assert.match(api.headers.get("cache-control"), /no-store/);
    const text = await api.text();
    noPii(text, "api next");
    assert.ok(!text.includes("originalKey"));
    const j = JSON.parse(text);
    assert.equal(j.state, "ready");
    assert.equal(j.order.date, NEXT);
    assert.deepEqual(j.order.channels.map((c) => c.channel), CHANNELS);
    assert.equal(j.order.channels[0].status, "scheduled");

    const ok = await req("/api/admin/social/channel", { cookie: social.cookie, method: "POST",
      json: { date: NEXT, channel: "tiktok", status: "scheduled", notes: "TikTok Studio" } });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.changed, true);
    assert.equal(body.channel.status, "scheduled");
    assert.equal(body.channel.notes, "TikTok Studio");

    const cases = [
      [{ date: NEXT, channel: "tiktok", postUrl: "https://www.instagram.com/x" }, 400, "postUrl"],
      [{ date: NEXT, channel: "facebook", commentPosted: true }, 400, "commentPosted"],
      [{ date: NEXT, channel: "tiktok", postUrl: 123 }, 400, "postUrl"],
      [{ date: NEXT, channel: "tiktok", notes: { x: 1 } }, 400, "notes"],
      [{ date: NEXT, channel: "tiktok", status: ["scheduled"] }, 400, "status"],
      [{ date: "2026-02-30", channel: "facebook" }, 400, "date"],
      [{ date: "2089-06-05", channel: "facebook", status: "scheduled" }, 404, "date"],
      [{ date: NEXT, channel: "nope" }, 400, "channel"],
    ];
    for (const [payload, status, field] of cases) {
      const r = await req("/api/admin/social/channel", { cookie: social.cookie, method: "POST", json: payload });
      assert.equal(r.status, status, JSON.stringify(payload));
      assert.ok((await r.json()).errors[field], field);
    }
    await so.setChannelResult(actor.id, NEXT, "linkedin_page", { status: "live", postUrl: GOOD_URLS.linkedin_page });
    const conflict = await req("/api/admin/social/channel", { cookie: social.cookie, method: "POST", json: { date: NEXT, channel: "linkedin_page", status: "pending" } });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error, "conflict");
    const notJson = await req("/api/admin/social/channel", { cookie: social.cookie, method: "POST", json: "{nope" });
    assert.equal(notJson.status, 400);
    const cross = await req("/api/admin/social/channel", { cookie: social.cookie, method: "POST", origin: "https://evil.example", json: { date: NEXT, channel: "threads", status: "scheduled" } });
    assert.equal(cross.status, 403);
    assert.equal((await channelRow(NEXT, "threads")).status, "pending");
    assert.equal((await req("/api/admin/social/channel", { cookie: social.cookie })).status, 405);
    assert.equal((await req("/api/admin/social/next", { cookie: social.cookie, method: "POST", json: {} })).status, 405);
    assert.equal((await req("/api/admin/social/channel", { method: "POST", json: {} })).status, 401);
  });

  test("next moves on once every channel is done", async () => {
    for (const c of ["instagram", "threads"]) await so.setChannelResult(actor.id, NEXT, c, { status: "scheduled" });
    const html = await (await req("/admin/social/next/", { cookie: social.cookie })).text();
    assert.ok(!html.includes(`data-date="${NEXT}"`), "no longer offered");
    assert.ok(html.includes('<section id="nothing"'), "the following week has no post yet");
  });

  test("verify: links to open, live/failed forms, the first comment, PRG", async () => {
    await owner.query(`insert into events (event_date) values ($1) on conflict do nothing`, [VERIFY]);
    await owner.query(
      `insert into social_posts (event_date, base_caption, publish_at) values ($1, 'Coffee this week', now() - interval '1 hour')`, [VERIFY]);
    await owner.query(`insert into social_post_channels (event_date, channel) select $1, unnest($2::text[])`, [VERIFY, CHANNELS]);
    await owner.query(`update social_post_channels set status = 'scheduled', post_url = $2 where event_date = $1 and channel = 'facebook'`, [VERIFY, GOOD_URLS.facebook]);
    await owner.query(`update social_post_channels set status = 'scheduled', post_url = $2 where event_date = $1 and channel = 'instagram'`, [VERIFY, GOOD_URLS.instagram]);

    const res = await req("/admin/social/verify/", { cookie: social.cookie });
    assert.equal(res.status, 200);
    const html = await res.text();
    noPii(html, "verify");
    assert.ok(html.includes(`data-date="${VERIFY}"`));
    assert.ok(html.includes(`<a id="post-url-facebook" href="${GOOD_URLS.facebook}"`));
    assert.ok(has(html, />Mark Facebook live<\/button>/) && has(html, />Mark Facebook failed<\/button>/));
    assert.ok(inner(html, "pre", "first-comment-instagram") === "RSVP: [Luma link: add the Luma listing]");
    assert.ok(html.includes("Mark Instagram live first") && !html.includes('id="first-comment-facebook"'));
    assert.ok(html.includes('data-task="verify"') && html.includes('data-task="never_scheduled"'));
    assert.ok(html.includes('id="not-ready"'));

    const live = await req("/admin/social/verify/", { cookie: social.cookie, method: "POST",
      form: { date: VERIFY, channel: "instagram", status: "live", postUrl: GOOD_URLS.instagram, notes: "" } });
    assert.equal(live.status, 303);
    assert.equal(live.headers.get("location"), "/admin/social/verify/?notice=saved&channel=instagram#channel-instagram");
    assert.ok((await channelRow(VERIFY, "instagram")).verified_at);
    const page = await (await req("/admin/social/verify/", { cookie: social.cookie })).text();
    assert.ok(page.includes(">First comment posted on Instagram</button>") && page.includes('data-task="comment"'));

    const comment = await req("/admin/social/verify/", { cookie: social.cookie, method: "POST",
      form: { date: VERIFY, channel: "instagram", commentPosted: "true" } });
    assert.equal(comment.headers.get("location"), "/admin/social/verify/?notice=comment&channel=instagram#channel-instagram");
    assert.ok((await channelRow(VERIFY, "instagram")).comment_posted_at);
    const shown = await (await req("/admin/social/verify/?notice=comment&channel=instagram", { cookie: social.cookie })).text();
    assert.ok(shown.includes("Instagram: first comment saved.") && shown.includes('id="comment-posted-instagram"'));

    const fbComment = await req("/admin/social/verify/", { cookie: social.cookie, method: "POST",
      form: { date: VERIFY, channel: "facebook", commentPosted: "true" } });
    assert.equal(fbComment.status, 400);
    const failed = await req("/admin/social/verify/", { cookie: social.cookie, method: "POST",
      form: { date: VERIFY, channel: "facebook", status: "failed", postUrl: GOOD_URLS.facebook, notes: "" } });
    assert.equal(failed.status, 400);
    assert.ok((await failed.text()).includes("Say in the notes why Facebook failed."));
    assert.equal((await channelRow(VERIFY, "facebook")).status, "scheduled");

    const api = await (await req("/api/admin/social/verify", { cookie: social.cookie })).json();
    assert.equal(api.state, "verify");
    assert.equal(api.order.date, VERIFY);
    assert.ok(api.todo.some((t) => t.channel === "facebook" && t.task === "verify"));
    noPii(JSON.stringify(api), "api verify");
  });
});
