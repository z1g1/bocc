// The glossary rename, EXPAND half (ticket #50, parent #49), against the throwaway
// database (npm run test:db):
//   1. migration 20261203120000_glossary_rename_expand.sql: the new table and column
//      names, existing rows carried through (re-run on a rebuilt pre-migration schema, in
//      a rolled-back transaction), the renamed constraints, and the grants per role.
//      The status/kind VALUE backfill ships with #51 and #54, not here (see the migration;
//      #51's is tested in event-status-migration.test.mjs)
//   2. the compatibility pieces: the old code's queries, copied as they were before the
//      rename, run as each role against the migrated database and still work
//   3. a LinkedIn token stored before the rename still decrypts
// Delete this file's section 2 with the contract migration. Dates: 2056 (not used elsewhere).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { ADMIN_URL, CHECKIN_URL, OWNER_URL, assertAllowed, assertRefused, connect, inRollback, unique, useAdminEnv } from "./helpers.mjs";

useAdminEnv();
const { pool } = await import("../../src/lib/auth/auth.mjs");
const { createUser } = await import("../../src/lib/admin/users.mjs");
const { decryptToken, encryptToken } = await import("../../src/lib/linkedin/crypto.mjs");

const SITE_URL = process.env.TEST_SITE_URL;
const SOCIAL_CHECK_URL = process.env.TEST_SOCIAL_CHECK_URL;
const MIGRATION = readFileSync(new URL("../../backend/db/migrations/20261203120000_glossary_rename_expand.sql", import.meta.url), "utf8");
const CHANNELS = ["facebook", "instagram", "threads", "tiktok", "linkedin_page"];

let owner, admin, site, checker, writer, actor;
let n = 0;
const date = () => new Date(Date.UTC(2056, 0, 4 + 7 * n++)).toISOString().slice(0, 10);
const keys = (d, id) => ({
  original: `events/${d}/${id}/original.jpg`, display: `events/${d}/${id}/display.jpg`,
  thumb: `events/${d}/${id}/thumb.jpg`, cover: `events/${d}/${id}/cover.jpg`,
});

before(async () => {
  owner = await connect(OWNER_URL);
  admin = await connect(ADMIN_URL);
  site = await connect(SITE_URL);
  checker = await connect(SOCIAL_CHECK_URL);
  writer = await connect(CHECKIN_URL);
  actor = await createUser({ email: `${unique("glossary")}@example.com`, name: "Glossary Admin", password: "correct horse battery staple" });
});
after(async () => {
  await Promise.all([owner, admin, site, checker, writer].map((c) => c?.end()));
  await pool.end();
});

const relkind = async (name) =>
  (await owner.query(`select relkind from pg_class where oid = to_regclass($1)`, [`public.${name}`])).rows[0]?.relkind ?? null;
const columns = async (name) =>
  (await owner.query(
    `select column_name from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position`,
    [name])).rows.map((r) => r.column_name);

// Undo the expand migration (structure only) so it can be re-run on old-shaped rows.
async function rebuildPreMigrationSchema(db) {
  await db.query(`
    drop view social_posts, social_post_channels, linkedin_connections;
    alter table social_plans rename to social_posts;
    alter table social_posts rename column thumbnail_media_id to cover_media_id;
    alter table social_posts rename column thumbnail_timecode to cover_note;
    alter table social_media_posts rename to social_post_channels;
    alter table linkedin_authentications rename to linkedin_connections;
    drop trigger event_reports_glossary_compat on event_reports;
    drop function event_reports_glossary_compat();
    alter table event_reports drop column gives_asks_count;
    alter table event_reports rename column attendee_count to gives_asks_count;
    drop trigger event_media_glossary_compat on event_media;
    drop function event_media_glossary_compat();
    alter table event_media drop column cover_key, drop column cover_outdated;
    alter table event_media rename column image_16x9_key to cover_key;
    alter table event_media rename column image_16x9_outdated to cover_outdated;
    alter table event_media drop constraint event_media_image_16x9_ck;
    alter table event_media add constraint event_media_cover_ck check (
      case when kind = 'event_image' then cover_key is not null when kind = 'social_photo' then true else cover_key is null end);
  `);
}

// ── 1. Migration ────────────────────────────────────────────────────────────
describe("migration 20261203120000_glossary_rename_expand.sql", () => {
  test("the tables and columns carry the glossary's names", async () => {
    assert.equal(await relkind("social_plans"), "r");
    assert.equal(await relkind("social_media_posts"), "r");
    assert.equal(await relkind("linkedin_authentications"), "r");
    const plan = await columns("social_plans");
    for (const c of ["thumbnail_media_id", "thumbnail_timecode", "status", "ready"]) assert.ok(plan.includes(c), c);
    for (const c of ["cover_media_id", "cover_note"]) assert.ok(!plan.includes(c), c);
    assert.ok((await columns("event_reports")).includes("attendee_count"));
    const media = await columns("event_media");
    for (const c of ["image_16x9_key", "image_16x9_outdated"]) assert.ok(media.includes(c), c);
  });

  test("no constraint, index or trigger on the renamed tables keeps an old name", async () => {
    const { rows } = await owner.query(`
      select name from (
        select conname as name, conrelid as rel from pg_constraint
        union all select i.relname, x.indrelid from pg_index x join pg_class i on i.oid = x.indexrelid
        union all select tgname, tgrelid from pg_trigger where not tgisinternal) o
       where rel in ('public.social_plans'::regclass, 'public.social_media_posts'::regclass,
                     'public.linkedin_authentications'::regclass, 'public.event_media'::regclass,
                     'public.event_reports'::regclass)
         and name ~ '(social_posts|social_post_channels|linkedin_connections|cover|gives_asks)'`);
    assert.deepEqual(rows.map((r) => r.name), []);
  });

  test("existing rows keep their values under the new names, `ready` included; old status and kind values are left for #51 and #54", () =>
    inRollback(owner, async () => {
      await rebuildPreMigrationSchema(owner);
      const d = date();
      const photo = randomUUID();
      const k = keys(d, photo);
      await owner.query(`insert into events (event_date, status) values ($1, 'held')`, [d]);
      await owner.query(`insert into event_reports (event_date, gives_asks_count, bling_given, source) values ($1, 23, false, 'admin')`, [d]);
      await owner.query(
        `insert into event_media (id, event_date, kind, original_key, display_key, thumb_key, cover_key, cover_outdated,
                                  content_type, size_bytes, status, publicly_usable)
         values ($1, $2, 'social_photo', $3, $4, $5, $6, true, 'image/jpeg', 10, 'ready', true)`,
        [photo, d, k.original, k.display, k.thumb, k.cover]);
      await owner.query(
        `insert into social_posts (event_date, publish_at, cover_note, cover_media_id, ready) values ($1, now(), '0:07', $2, true)`, [d, photo]);
      await owner.query(`insert into social_post_channels (event_date, channel, status) values ($1, 'tiktok', 'live')`, [d]);
      const before = (await owner.query(`select updated_at from events where event_date = $1`, [d])).rows[0].updated_at;

      await owner.query(MIGRATION);

      const ev = (await owner.query(`select status, updated_at from events where event_date = $1`, [d])).rows[0];
      assert.equal(ev.status, "reported", "the 'held' write is rewritten by #51's trigger (event-status-migration.test.mjs)");
      assert.deepEqual(ev.updated_at, before, "the migration is not an edit");
      assert.equal((await owner.query(`select attendee_count from event_reports where event_date = $1`, [d])).rows[0].attendee_count, 23);
      assert.deepEqual((await owner.query(
        `select kind, image_16x9_key as key, image_16x9_outdated as outdated from event_media where id = $1`, [photo])).rows[0],
        { kind: "social_photo", key: k.cover, outdated: true });
      assert.deepEqual((await owner.query(
        `select thumbnail_timecode as t, thumbnail_media_id as m, ready from social_plans where event_date = $1`, [d])).rows[0],
        { t: "0:07", m: photo, ready: true });
      assert.equal((await owner.query(`select status from social_media_posts where event_date = $1`, [d])).rows[0].status, "live");
    }));

  test("each role keeps exactly its privileges on the renamed tables", async () => {
    const priv = async (role, rel, p) =>
      (await owner.query(`select has_table_privilege($1, $2, $3) as ok`, [role, `public.${rel}`, p])).rows[0].ok;
    const colPriv = async (role, rel, col) =>
      (await owner.query(`select has_column_privilege($1, $2, $3, 'select') as ok`, [role, `public.${rel}`, col])).rows[0].ok;
    const expect = {
      social_plans: { admin_app: ["select", "insert", "update"], social_checker: ["select"] },
      social_media_posts: { admin_app: ["select", "insert", "update"], social_checker: ["select"] },
      linkedin_authentications: { admin_app: ["select", "insert", "update", "delete"] },
    };
    for (const [rel, byRole] of Object.entries(expect)) {
      for (const role of ["admin_app", "social_checker", "site_reader", "checkin_writer"]) {
        for (const p of ["select", "insert", "update", "delete", "truncate"]) {
          assert.equal(await priv(role, rel, p), (byRole[role] ?? []).includes(p), `${role} ${p} on ${rel}`);
        }
      }
    }
    for (const col of ["user_id", "expires_at", "display_name"]) assert.equal(await colPriv("social_checker", "linkedin_authentications", col), true, col);
    for (const col of ["token_ciphertext", "member_urn", "scope"]) assert.equal(await colPriv("social_checker", "linkedin_authentications", col), false, col);
    for (const col of ["image_16x9_key", "image_16x9_outdated"]) assert.equal(await colPriv("social_checker", "event_media", col), false, col);
    for (const role of ["site_reader", "checkin_writer"]) {
      assert.equal(await priv(role, "event_media", "select"), false);
      assert.equal(await priv(role, "event_reports", "select"), false);
    }
  });

  test("as each role, against the new names", async () => {
    const d = date();
    await owner.query(`insert into events (event_date) values ($1)`, [d]);
    await owner.query(`insert into social_plans (event_date, publish_at, thumbnail_timecode) values ($1, now(), '0:03')`, [d]);
    await owner.query(`insert into social_media_posts (event_date, channel) select $1, unnest($2::text[])`, [d, CHANNELS]);
    try {
      assert.equal((await checker.query(`select thumbnail_timecode from social_plans where event_date = $1`, [d])).rows[0].thumbnail_timecode, "0:03");
      assert.equal((await checker.query(`select count(*)::int as n from social_media_posts where event_date = $1`, [d])).rows[0].n, 5);
      await checker.query("begin");
      await assertRefused(checker, `update social_plans set thumbnail_timecode = 'x' where event_date = $1`, [d]);
      await assertRefused(checker, `select token_ciphertext from linkedin_authentications`);
      await checker.query("rollback");
      for (const c of [site, writer]) {
        await c.query("begin");
        for (const rel of ["social_plans", "social_media_posts", "linkedin_authentications", "social_posts", "social_post_channels", "linkedin_connections"]) {
          await assertRefused(c, `select 1 from ${rel}`);
        }
        await c.query("rollback");
      }
    } finally {
      await owner.query(`delete from social_media_posts where event_date = $1`, [d]);
      await owner.query(`delete from social_plans where event_date = $1`, [d]);
      await owner.query(`delete from events where event_date = $1`, [d]);
    }
  });
});

// ── 2. The old code's queries (as written before the rename) ─────────────────
describe("compatibility: the code live before the deploy keeps working", () => {
  test("events and reports (admin_app): 'held' and 'reported' both accepted; gives_asks_count reads and writes attendee_count", () =>
    inRollback(admin, async () => {
      const d = date();
      await admin.query(`insert into public.events (event_date) values ($1::date) on conflict (event_date) do nothing returning event_date`, [d]);
      await admin.query(
        `insert into public.event_reports (event_date, gives_asks_count, notes, bling_given, bling_details, submitted_by, source)
         values ($1::date, $2, $3, $4, $5, $6, 'admin')`, [d, 31, "Good one", false, null, actor.id]);
      await admin.query(`update public.events set status = 'held' where event_date = $1::date`, [d]);
      const { rows: [row] } = await admin.query(
        `select e.status, r.gives_asks_count, r.attendee_count from public.events e
           left join public.event_reports r on r.event_date = e.event_date where e.event_date = $1::date`, [d]);
      assert.deepEqual(row, { status: "reported", gives_asks_count: 31, attendee_count: 31 }, "#51's trigger rewrites 'held'");
      await admin.query(`update public.events set status = 'reported' where event_date = $1::date`, [d]);
      await admin.query("savepoint s");
      await assert.rejects(admin.query(`update public.events set status = 'done' where event_date = $1`, [d]), /check constraint/);
      await admin.query("rollback to savepoint s");
      await admin.query(`update public.event_reports set gives_asks_count = $2 where event_date = $1::date`, [d, 40]);
      assert.equal((await admin.query(`select attendee_count from event_reports where event_date = $1`, [d])).rows[0].attendee_count, 40);
      await admin.query(`update event_reports set attendee_count = 41 where event_date = $1`, [d]);
      assert.equal((await admin.query(`select gives_asks_count from event_reports where event_date = $1`, [d])).rows[0].gives_asks_count, 41);
      await admin.query("savepoint s");
      await assert.rejects(admin.query(`update public.event_reports set gives_asks_count = -1 where event_date = $1`, [d]), /check constraint/);
      await admin.query("rollback to savepoint s");
    }));

  test("media (admin_app): 'social_photo' and 'event_photo' both accepted; cover_key and cover_outdated read and write the 16:9 columns", () =>
    inRollback(admin, async () => {
      const d = date();
      const id = randomUUID();
      const k = keys(d, id);
      await admin.query("insert into public.events (event_date) values ($1) on conflict (event_date) do nothing", [d]);
      await admin.query(
        `insert into public.event_media
           (id, event_date, kind, original_key, display_key, thumb_key, cover_key, content_type, size_bytes, publicly_usable, uploaded_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [id, d, "social_photo", k.original, k.display, k.thumb, null, "image/jpeg", 1000, true, actor.id]);
      await admin.query("update public.event_media set status = 'ready' where id = $1 and status = 'pending'", [id]);
      await admin.query(
        "update public.event_media set cover_key = $2 where id = $1 and cover_key is null and kind = 'social_photo'", [id, k.cover]);
      await admin.query("update public.event_media set cover_outdated = true where id = $1", [id]);
      const { rows: [m] } = await admin.query(
        `select kind, cover_key, cover_outdated, image_16x9_key, image_16x9_outdated, publicly_usable from public.event_media where id = $1`, [id]);
      assert.deepEqual(m, { kind: "social_photo", cover_key: k.cover, cover_outdated: true, image_16x9_key: k.cover, image_16x9_outdated: true, publicly_usable: true });
      await admin.query("update public.event_media set cover_outdated = false where id = $1 and cover_key = $2 and cover_outdated", [id, k.cover]);
      assert.equal((await admin.query(`select image_16x9_outdated as o from event_media where id = $1`, [id])).rows[0].o, false);
      await admin.query("update event_media set image_16x9_key = null where id = $1", [id]);
      assert.equal((await admin.query(`select cover_key from event_media where id = $1`, [id])).rows[0].cover_key, null);
      // A Photo from Event under the new kind may be publicly usable and have a 16:9 copy.
      const fresh = randomUUID();
      const k3 = keys(d, fresh);
      await assertAllowed(admin,
        `insert into event_media (id, event_date, kind, original_key, display_key, thumb_key, image_16x9_key, content_type, size_bytes, publicly_usable)
         values ($1, $2, 'event_photo', $3, $4, $5, $6, 'image/jpeg', 1, true)`, [fresh, d, k3.original, k3.display, k3.thumb, k3.cover]);
      await assertRefused(admin,
        `insert into event_media (id, event_date, kind, original_key, display_key, thumb_key, content_type, size_bytes, publicly_usable)
         values ($1, $2, 'signin_board', $3, $4, $5, 'image/jpeg', 1, true)`, [fresh, d, k3.original, k3.display, k3.thumb], /check constraint/);
      // The unique 16:9 key still holds through the old name.
      const other = randomUUID();
      const k2 = keys(d, other);
      await admin.query("savepoint s");
      await admin.query(`update event_media set image_16x9_key = $2 where id = $1`, [id, k.cover]);
      await assert.rejects(admin.query(
        `insert into event_media (id, event_date, kind, original_key, display_key, thumb_key, cover_key, content_type, size_bytes, publicly_usable)
         values ($1, $2, 'social_photo', $3, $4, $5, $6, 'image/jpeg', 1, true)`, [other, d, k2.original, k2.display, k2.thumb, k.cover]), /unique/);
      await admin.query("rollback to savepoint s");
    }));

  test("the Social plan through the social_posts and social_post_channels views (admin_app)", () =>
    inRollback(admin, async () => {
      const d = date();
      const photo = randomUUID();
      const k = keys(d, photo);
      await admin.query(`insert into public.events (event_date) values ($1::date) on conflict (event_date) do nothing`, [d]);
      await admin.query(
        `insert into public.event_media (id, event_date, kind, original_key, display_key, thumb_key, content_type, size_bytes, status, publicly_usable)
         values ($1, $2, 'social_photo', $3, $4, $5, 'image/jpeg', 10, 'ready', true)`, [photo, d, k.original, k.display, k.thumb]);
      await admin.query(
        `insert into public.social_posts (event_date, publish_at) values ($1::date, $2) on conflict (event_date) do nothing`,
        [d, new Date("2056-01-01T12:00:00Z")]);
      await admin.query(
        `insert into public.social_post_channels (event_date, channel)
         select $1::date, unnest($2::text[]) on conflict (event_date, channel) do nothing`, [d, CHANNELS]);
      const { rows: [locked] } = await admin.query(
        `select status, ready, cover_note, cover_media_id from public.social_posts where event_date = $1::date for update`, [d]);
      assert.deepEqual(locked, { status: "todo", ready: false, cover_note: null, cover_media_id: null });
      await admin.query(`update public.social_posts set cover_note = $2, base_caption = $3 where event_date = $1::date`, [d, "0:12", "Coffee"]);
      await admin.query(`update public.social_posts set cover_media_id = $2 where event_date = $1::date`, [d, photo]);
      await admin.query(`update public.social_posts set ready = true where event_date = $1::date`, [d]);
      await admin.query(`select caption, first_comment from public.social_post_channels where event_date = $1::date and channel = $2 for update`, [d, "tiktok"]);
      await admin.query(
        `update public.social_post_channels set status = $3, post_url = $4, verified_at = now() where event_date = $1::date and channel = $2`,
        [d, "tiktok", "scheduled", "https://www.tiktok.com/@bocc/video/1"]);
      await admin.query(`update public.social_posts set status = $2 where event_date = $1::date`, [d, "posted"]);
      const { rows: [plan] } = await admin.query(
        `select thumbnail_timecode, thumbnail_media_id, ready, status, base_caption from social_plans where event_date = $1`, [d]);
      assert.deepEqual(plan, { thumbnail_timecode: "0:12", thumbnail_media_id: photo, ready: true, status: "posted", base_caption: "Coffee" });
      const { rows: [post] } = await admin.query(`select status, post_url from social_media_posts where event_date = $1 and channel = 'tiktok'`, [d]);
      assert.deepEqual(post, { status: "scheduled", post_url: "https://www.tiktok.com/@bocc/video/1" });
      const { rows: [joined] } = await admin.query(
        `select (select count(*)::int from public.social_post_channels c where c.event_date = e.event_date and c.status in ('scheduled', 'live')) as done,
                p.status from public.events e left join public.social_posts p on p.event_date = e.event_date where e.event_date = $1`, [d]);
      assert.deepEqual(joined, { done: 1, status: "posted" });
      // Deleting the Thumbnail photo still returns the plan to the Event Image.
      await admin.query(`delete from public.event_media where id = $1`, [photo]);
      assert.equal((await admin.query(`select cover_media_id from public.social_posts where event_date = $1`, [d])).rows[0].cover_media_id, null);
      // No DELETE on a plan, through either name.
      await assertRefused(admin, `delete from public.social_posts where event_date = $1`, [d]);
      await assertRefused(admin, `delete from social_plans where event_date = $1`, [d]);
    }));

  test("the Thursday social check's queries (social_checker), including the LinkedIn expiry columns only", async () => {
    const d = date();
    const u = await createUser({ email: `${unique("glossary-li")}@example.com`, name: "Glossary LI", password: "correct horse battery staple" });
    await owner.query(`insert into events (event_date) values ($1)`, [d]);
    await owner.query(`insert into social_plans (event_date, publish_at, thumbnail_timecode) values ($1, now(), '0:09')`, [d]);
    await owner.query(`insert into social_media_posts (event_date, channel) select $1, unnest($2::text[])`, [d, CHANNELS]);
    await owner.query(
      `insert into linkedin_authentications (user_id, token_ciphertext, expires_at, member_urn, display_name)
       values ($1, $2, now() + interval '5 days', 'urn:li:person:abc', 'Glossary LI')`, [u.id, randomBytes(40)]);
    try {
      const { rows: [p] } = await checker.query(
        `select video_media_id as "videoMediaId", cover_note as "coverNote", base_caption as "baseCaption",
                extra_hashtags as "extraHashtags", publish_at as "publishAt", status, updated_at as "updatedAt"
           from public.social_posts where event_date = $1::date`, [d]);
      assert.equal(p.coverNote, "0:09");
      const { rows: channels } = await checker.query(
        `select channel, caption, first_comment as "firstComment", status, post_url as "postUrl",
                verified_at as "verifiedAt", comment_posted_at as "commentPostedAt", notes
           from public.social_post_channels where event_date = $1::date`, [d]);
      assert.equal(channels.length, 5);
      const { rows: li } = await checker.query(
        `select c.display_name as name, c.expires_at as "expiresAt" from public.linkedin_connections c order by c.expires_at, c.user_id`);
      assert.ok(li.some((r) => r.name === "Glossary LI"));
      await checker.query("begin");
      await assertRefused(checker, `select token_ciphertext from public.linkedin_connections`);
      await assertRefused(checker, `select member_urn from public.linkedin_connections`);
      await assertRefused(checker, `update public.social_posts set cover_note = 'x' where event_date = $1`, [d]);
      await assertRefused(checker, `insert into public.social_post_channels (event_date, channel) values ($1, 'facebook')`, [d]);
      await checker.query("rollback");
    } finally {
      await owner.query(`delete from linkedin_authentications where user_id = $1`, [u.id]);
      await owner.query(`delete from social_media_posts where event_date = $1`, [d]);
      await owner.query(`delete from social_plans where event_date = $1`, [d]);
      await owner.query(`delete from events where event_date = $1`, [d]);
    }
  });

  test("LinkedIn authentication through the linkedin_connections view (admin_app): connect, reconnect, read, disconnect", () =>
    inRollback(admin, async () => {
      const u = await createUser({ email: `${unique("glossary-conn")}@example.com`, name: "Glossary Conn", password: "correct horse battery staple" });
      const upsert = (name) => admin.query(
        `insert into public.linkedin_connections (user_id, token_ciphertext, expires_at, member_urn, display_name, scope, connected_at)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (user_id) do update
            set token_ciphertext = excluded.token_ciphertext, expires_at = excluded.expires_at,
                member_urn = excluded.member_urn, display_name = excluded.display_name,
                scope = excluded.scope, connected_at = excluded.connected_at
         returning (xmax <> 0) as reconnect`,
        [u.id, randomBytes(40), new Date(Date.now() + 864e5), "urn:li:person:xyz", name, "openid", new Date()]);
      assert.equal((await upsert("First")).rows[0].reconnect, false);
      assert.equal((await upsert("Second")).rows[0].reconnect, true);
      const { rows: [r] } = await admin.query(
        `select display_name, member_urn, expires_at from public.linkedin_connections where user_id = $1`, [u.id]);
      assert.equal(r.display_name, "Second");
      assert.equal((await admin.query(`select display_name from linkedin_authentications where user_id = $1`, [u.id])).rows[0].display_name, "Second");
      const { rowCount } = await admin.query(`delete from public.linkedin_connections where user_id = $1`, [u.id]);
      assert.equal(rowCount, 1);
      assert.equal((await admin.query(`select 1 from linkedin_authentications where user_id = $1`, [u.id])).rowCount, 0);
    }));

  test("a check-in (checkin_writer) still records and reads its streak", () =>
    inRollback(writer, async () => {
      const { rows: [a] } = await writer.query(
        `insert into attendees (email, name, ok_to_email) values ($1, 'Glossary Person', false) returning id`,
        [`${unique("glossary-ci")}@example.com`]);
      await writer.query(`insert into checkins (attendee_id, event_id, token, checkin_date, debug) values ($1, 'bocc', 'tok', current_date, true)`, [a.id]);
      await assertAllowed(writer, `select * from streaks where attendee_id = $1`, [a.id]);
    }));
});

// ── 3. LinkedIn token ───────────────────────────────────────────────────────
describe("the LinkedIn token after the table rename", () => {
  test("a token encrypted before the rename decrypts from linkedin_authentications", () =>
    inRollback(owner, async () => {
      const u = await createUser({ email: `${unique("glossary-tok")}@example.com`, name: "Glossary Tok", password: "correct horse battery staple" });
      const key = randomBytes(32);
      const box = encryptToken("AQX-access-token", { key, userId: u.id });
      await owner.query(
        `insert into linkedin_connections (user_id, token_ciphertext, expires_at, member_urn, display_name)
         values ($1, $2, now() + interval '30 days', 'urn:li:person:tok', 'Glossary Tok')`, [u.id, box]);
      const { rows: [r] } = await owner.query(`select token_ciphertext from linkedin_authentications where user_id = $1`, [u.id]);
      assert.equal(decryptToken(r.token_ciphertext, { key, userId: u.id }), "AQX-access-token");
    }));
});
