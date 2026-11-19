// The Social Post status (ticket #39): To do / Ready for Posting / Posted / Error,
// against the throwaway database (npm run test:db):
//   1. migration 20261201120000_social_post_status.sql: the mapping from the old
//      `ready` flag (re-run on a rebuilt pre-migration table, in a rolled-back
//      transaction), the CHECKs, the grants
//   2. src/lib/admin/social.mjs as admin_app: savePost's status (Ready for Posting
//      checked, the others always allowed, audited) and setChannelResult moving the
//      post to Posted / Error in the channel update's transaction, audited
// The pure rules are in social-unit.test.mjs; the dropdown over HTTP in social.test.mjs.
// Dates: 2073 (not used elsewhere).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { ADMIN_URL, OWNER_URL, assertAllowed, assertRefused, connect, inRollback, unique, useAdminEnv } from "./helpers.mjs";

useAdminEnv();
const { pool } = await import("../../src/lib/auth/auth.mjs");
const { createUser } = await import("../../src/lib/admin/users.mjs");
const so = await import("../../src/lib/admin/social.mjs");
const el = await import("../../src/lib/admin/event-links.mjs");

const MIGRATION = readFileSync(new URL("../../backend/db/migrations/20261201120000_social_post_status.sql", import.meta.url), "utf8");
const CHANNELS = ["facebook", "instagram", "threads", "tiktok", "linkedin_page"];
let owner, actor, social;

let n = 0;
const date = () => new Date(Date.UTC(2073, 0, 3 + 7 * n++)).toISOString().slice(0, 10);
const NOW = new Date("2072-12-01T12:00:00Z"); // before every 2073 publish time

const postRow = (d) => owner.query(`select * from social_posts where event_date = $1`, [d]).then((r) => r.rows[0] ?? null);
const statusAudits = (d) => owner.query(
  `select actor_user_id, action, details from audit_log
    where target_id = $1 and action in ('social_post.update', 'social_post.status') order by id`, [d]).then((r) => r.rows);

async function readyable(d) {
  await el.setLink(actor.id, d, "luma", { url: "https://luma.com/bocc-test", externalId: "" });
  const id = randomUUID();
  await owner.query(`insert into events (event_date) values ($1) on conflict do nothing`, [d]);
  await owner.query(
    `insert into event_media (id, event_date, kind, original_key, content_type, size_bytes, status)
     values ($1, $2, 'promo_video', $3, 'video/mp4', 4800000, 'ready')`, [id, d, `events/${d}/${id}/original.mp4`]);
  await so.setVideo(actor.id, d, id);
}
async function readyPost(d) {
  await readyable(d);
  await so.savePost(actor.id, d, { baseCaption: "Coffee Tuesday", status: "ready" }, { now: NOW });
}

before(async () => {
  owner = await connect(OWNER_URL);
  actor = await createUser({ email: `${unique("status")}@example.com`, name: "Status Admin", password: "correct horse battery staple" });
  social = await createUser({ email: `${unique("status-social")}@example.com`, name: "Status Agent", password: "correct horse battery staple" });
});
after(async () => { await owner?.end(); await pool.end(); });

// ── 1. Migration ────────────────────────────────────────────────────────────
describe("migration 20261201120000_social_post_status.sql", () => {
  test("maps ready -> 'ready' and not ready -> 'todo', and drops the flag", () =>
    inRollback(owner, async () => {
      // Back to the table as it was before the migration, then run the migration file.
      await owner.query(`alter table social_posts drop constraint social_posts_status_ready_ck`);
      await owner.query(`alter table social_posts drop column status`);
      await owner.query(`alter table social_posts add column ready boolean not null default false`);
      await owner.query(`alter table social_posts add constraint social_posts_ready_ck
                           check (not ready or (video_media_id is not null and base_caption is not null))`);
      const [a, b] = [date(), date()];
      await owner.query(`insert into events (event_date) values ($1), ($2)`, [a, b]);
      const vid = randomUUID();
      await owner.query(
        `insert into event_media (id, event_date, kind, original_key, content_type, size_bytes, status)
         values ($1, $2, 'promo_video', $3, 'video/mp4', 10, 'ready')`, [vid, a, `events/${a}/${vid}/original.mp4`]);
      await owner.query(
        `insert into social_posts (event_date, publish_at, video_media_id, base_caption, ready) values
           ($1, now(), $3, 'Coffee', true), ($2, now(), null, null, false)`, [a, b, vid]);
      await owner.query(MIGRATION);
      const { rows } = await owner.query(
        `select event_date::text as d, status from social_posts where event_date in ($1, $2) order by 1`, [a, b]);
      assert.deepEqual(rows, [{ d: a, status: "ready" }, { d: b, status: "todo" }]);
      const { rows: cols } = await owner.query(
        `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'social_posts' and column_name in ('ready', 'status')`);
      assert.deepEqual(cols.map((c) => c.column_name), ["status"]);
    }));

  test("CHECKs: four statuses, default To do; Ready for Posting needs the video and the caption", () =>
    inRollback(owner, async () => {
      const d = date();
      await owner.query(`insert into events (event_date) values ($1)`, [d]);
      await owner.query(`insert into social_posts (event_date, publish_at) values ($1, now())`, [d]);
      assert.equal((await postRow(d)).status, "todo");
      const CHECK = /violates check constraint/;
      await assertRefused(owner, `update social_posts set status = 'live' where event_date = $1`, [d], CHECK);
      await assertRefused(owner, `update social_posts set status = 'ready' where event_date = $1`, [d], CHECK);
      await assertRefused(owner, `update social_posts set status = 'ready', base_caption = 'x' where event_date = $1`, [d], CHECK);
      for (const s of ["posted", "error", "todo"]) {
        await assertAllowed(owner, `update social_posts set status = $2 where event_date = $1`, [d, s]);
      }
    }));

  test("grants: admin_app reads and writes the status; social_checker only reads it", async () => {
    const { rows } = await owner.query(
      `select grantee, privilege_type from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'social_posts' and grantee in ('admin_app', 'social_checker')
        order by 1, 2`);
    assert.deepEqual(rows.map((r) => `${r.grantee}:${r.privilege_type}`),
      ["admin_app:INSERT", "admin_app:SELECT", "admin_app:UPDATE", "social_checker:SELECT"]);
    const admin = await connect(ADMIN_URL);
    try {
      await inRollback(admin, async () => {
        const d = date();
        await admin.query(`insert into events (event_date) values ($1)`, [d]);
        await admin.query(`insert into social_posts (event_date, publish_at) values ($1, now())`, [d]);
        await assertAllowed(admin, `update social_posts set status = 'posted' where event_date = $1`, [d]);
        await assertAllowed(admin, `select status from social_posts where event_date = $1`, [d]);
      });
    } finally {
      await admin.end();
    }
  });
});

// ── 2. The module ───────────────────────────────────────────────────────────
describe("the post status (admin_app)", () => {
  test("Ready for Posting is refused with the ready problems; To do, Posted and Error always save; each change audited", async () => {
    const d = date();
    await assert.rejects(so.savePost(actor.id, d, { baseCaption: "Coffee", status: "ready" }, { now: NOW }), (e) => {
      assert.match(e.errors.status, /^Not ready yet: Upload the promo video\..*Add the Luma listing/);
      return true;
    });
    assert.equal(await postRow(d), null); // refused: nothing written
    for (const s of ["posted", "error", "todo"]) {
      assert.equal((await so.savePost(actor.id, d, { baseCaption: "Coffee", status: s }, { now: NOW })).changed, true, s);
    }
    await assert.rejects(so.savePost(actor.id, d, { baseCaption: "Coffee", status: "on" }, { now: NOW }),
      (e) => /To do, Ready for Posting, Posted or Error/.test(e.errors.status));
    await readyable(d);
    await so.savePost(actor.id, d, { baseCaption: "Coffee", status: "ready" }, { now: NOW });
    assert.equal((await postRow(d)).status, "ready");
    // No status in the input keeps the current one.
    assert.equal((await so.savePost(actor.id, d, { baseCaption: "Coffee" }, { now: NOW })).changed, false);
    const statuses = (await statusAudits(d)).map((a) => [a.action, a.details.before.status ?? null, a.details.after.status ?? null]);
    assert.deepEqual(statuses, [
      ["social_post.update", "todo", "posted"], // the first save creates the post (To do), then sets Posted
      ["social_post.update", "posted", "error"],
      ["social_post.update", "error", "todo"],
      ["social_post.update", "todo", "ready"],
    ]);
    const wo = await so.getWorkOrder(pool, d);
    assert.deepEqual([wo.status, wo.statusLabel, wo.actionable], ["ready", "Ready for Posting", true]);
  });

  test("scheduling every channel moves the post to Posted, in the same transaction, audited as the social user", async () => {
    const d = date();
    await readyPost(d);
    for (const c of CHANNELS.slice(0, -1)) await so.setChannelResult(social.id, d, c, { status: "scheduled" }, { now: NOW });
    assert.equal((await postRow(d)).status, "ready");
    await so.setChannelResult(social.id, d, "linkedin_page", { status: "scheduled" }, { now: NOW });
    assert.equal((await postRow(d)).status, "posted");
    const auto = (await statusAudits(d)).filter((a) => a.action === "social_post.status");
    assert.deepEqual(auto.map((a) => [a.actor_user_id, a.details]), [[social.id, {
      before: { status: "ready" }, after: { status: "posted" }, automatic: true, channel: "linkedin_page", channelStatus: "scheduled",
    }]]);
    // Going live keeps it Posted (no second audit row).
    await so.setChannelResult(social.id, d, "facebook", { status: "live", postUrl: "https://www.facebook.com/reel/1" }, { now: NOW });
    assert.equal((await statusAudits(d)).filter((a) => a.action === "social_post.status").length, 1);
    // A Posted post isn't offered for scheduling any more.
    assert.equal((await so.getWorkOrder(pool, d)).actionable, false);
  });

  test("a failed channel moves the post to Error; the rest can still be scheduled; a retry back to Posted", async () => {
    const d = date();
    await readyPost(d);
    await so.setChannelResult(social.id, d, "facebook", { status: "failed", notes: "Business Suite error" }, { now: NOW });
    assert.equal((await postRow(d)).status, "error");
    for (const c of CHANNELS.slice(1)) await so.setChannelResult(social.id, d, c, { status: "scheduled" }, { now: NOW });
    assert.equal((await postRow(d)).status, "error");
    await so.setChannelResult(social.id, d, "facebook", { status: "scheduled" }, { now: NOW });
    assert.equal((await postRow(d)).status, "posted");
    const auto = (await statusAudits(d)).filter((a) => a.action === "social_post.status");
    assert.deepEqual(auto.map((a) => [a.details.before.status, a.details.after.status, a.details.channel]),
      [["ready", "error", "facebook"], ["error", "posted", "facebook"]]);
  });

  test("a refused channel update changes no status", async () => {
    const d = date();
    await readyPost(d);
    // failed needs a note: refused, so the post stays Ready for Posting and nothing is audited.
    await assert.rejects(so.setChannelResult(social.id, d, "tiktok", { status: "failed" }, { now: NOW }), (e) => Boolean(e.errors.notes));
    assert.equal((await postRow(d)).status, "ready");
    assert.equal((await statusAudits(d)).filter((a) => a.action === "social_post.status").length, 0);
  });

  test("To do isn't offered: scheduling is refused", async () => {
    const d = date();
    await readyable(d);
    await so.savePost(actor.id, d, { baseCaption: "Coffee", status: "todo" }, { now: NOW });
    await assert.rejects(so.setChannelResult(social.id, d, "facebook", { status: "scheduled" }, { now: NOW }),
      (e) => e.status === 409 && /isn't set to Ready for Posting/.test(e.errors.status));
  });

  test("findNext: a week an Admin set to Posted isn't handed out, even with channels pending", async () => {
    const [d, d2] = [date(), date()];
    const now = new Date(Date.parse(`${d}T17:00:00Z`) - 6 * 86400_000); // the Wednesday before d
    await readyPost(d);
    await readyPost(d2);
    assert.equal((await so.findNext(pool, { now })).order?.date, d);
    await so.savePost(actor.id, d, { baseCaption: "Coffee Tuesday", status: "posted" }, { now: NOW });
    const r = await so.findNext(pool, { now });
    assert.equal(r.order?.date, d2, "d is Posted: the next week");
  });
});
