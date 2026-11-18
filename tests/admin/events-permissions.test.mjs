// Postgres-level guarantees of migration 20261118120000_events_media.sql: admin_app's
// grants on events / event_reports / event_media (ADR 0008 decision 6), the shape
// CHECKs (ADR 0009, 0010) and the updated_at trigger. Connects AS each role.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ADMIN_URL, CHECKIN_URL, OWNER_URL, assertAllowed, assertRefused, connect, inRollback, unique } from "./helpers.mjs";

const TABLES = ["events", "event_reports", "event_media"];
const CHECK = /violates check constraint/;
let owner, admin, writer, userId;

// Test dates far from any real event, a new one per call.
let n = 0;
const testDate = () => new Date(Date.UTC(2099, 0, 1 + n++)).toISOString().slice(0, 10);

before(async () => {
  owner = await connect(OWNER_URL);
  admin = await connect(ADMIN_URL);
  writer = await connect(CHECKIN_URL);
  userId = unique("media-user");
  await owner.query(`insert into auth."user" (id, name, email, "emailVerified") values ($1, 'M', $2, false)`,
    [userId, `${userId}@example.com`]);
});
after(async () => {
  await owner?.query(`delete from auth."user" where id = $1`, [userId]);
  await Promise.all([owner?.end(), admin?.end(), writer?.end()]);
});

const photo = (date, over = {}) => {
  const id = randomUUID();
  const base = `events/${date}/${id}`;
  return {
    id, event_date: date, kind: "social_photo", original_key: `${base}/original.jpg`,
    display_key: `${base}/display.jpg`, thumb_key: `${base}/thumb.jpg`,
    content_type: "image/jpeg", size_bytes: 123456, publicly_usable: false, uploaded_by: userId, ...over,
  };
};
const insertMedia = (db, m) => {
  const cols = Object.keys(m);
  return db.query(`insert into event_media (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning *`,
    Object.values(m));
};

describe("migration", () => {
  test("applied after the admin auth migration", async () => {
    // Later migrations (e.g. 20261119120000_media_heic_originals.sql) may follow it.
    const { rows } = await owner.query("select filename from schema_migrations where filename >= '20261116' order by filename");
    const names = rows.map((r) => r.filename);
    assert.ok(names.indexOf("20261118120000_events_media.sql") > names.indexOf("20261116120000_admin_auth.sql"));
    assert.ok(names.indexOf("20261116120000_admin_auth.sql") >= 0);
  });

  test("the Phase 5 tables come from their own migration (social.test.mjs)", async () => {
    const { rows } = await owner.query(
      `select table_name from information_schema.tables where table_schema = 'public'
        and table_name in ('social_posts', 'social_post_channels') order by 1`);
    assert.deepEqual(rows.map((r) => r.table_name), ["social_post_channels", "social_posts"]);
  });

  test("grants are exactly ADR 0008's, and nobody else gains anything", async () => {
    const { rows } = await owner.query(
      `select g.table_name || ':' || g.grantee || ':' || g.privilege_type as g
         from information_schema.role_table_grants g
         join pg_class c on c.relname = g.table_name and c.relnamespace = 'public'::regnamespace
        where g.table_schema = 'public' and g.table_name = any($1)
          and g.grantee <> pg_get_userbyid(c.relowner)
        order by 1`, [TABLES]);
    assert.deepEqual(rows.map((r) => r.g), [
      "event_media:admin_app:DELETE", "event_media:admin_app:INSERT", "event_media:admin_app:SELECT", "event_media:admin_app:UPDATE",
      "event_reports:admin_app:INSERT", "event_reports:admin_app:SELECT", "event_reports:admin_app:UPDATE",
      "events:admin_app:INSERT", "events:admin_app:SELECT", "events:admin_app:UPDATE",
      "events:site_reader:SELECT", // migration 20261121120000 (public event pages)
    ]);
  });
});

describe("admin_app on events, event_reports, event_media", () => {
  test("can select, insert and update all three", () =>
    inRollback(admin, async () => {
      const d = testDate();
      await admin.query("insert into events (event_date, location) values ($1, 'lobby')", [d]);
      await admin.query(
        `insert into event_reports (event_date, gives_asks_count, notes, bling_given, bling_details, submitted_by)
         values ($1, 12, 'good one', true, 'mug', $2)`, [d, userId]);
      await admin.query("update events set status = 'held' where event_date = $1", [d]);
      await admin.query("update event_reports set gives_asks_count = 13 where event_date = $1", [d]);
      const { rows: [m] } = await insertMedia(admin, photo(d));
      assert.equal(m.status, "pending");
      await admin.query("update event_media set status = 'ready', publicly_usable = true where id = $1", [m.id]);
      const { rows } = await admin.query(
        `select e.status, r.gives_asks_count, r.source, count(m.*)::int as media
           from events e join event_reports r using (event_date) left join event_media m using (event_date)
          where e.event_date = $1 group by 1, 2, 3`, [d]);
      assert.deepEqual(rows, [{ status: "held", gives_asks_count: 13, source: "admin", media: 1 }]);
    }));

  test("can delete only event_media; no TRUNCATE anywhere", () =>
    inRollback(admin, async () => {
      const d = testDate();
      await admin.query("insert into events (event_date) values ($1)", [d]);
      await admin.query("insert into event_reports (event_date, gives_asks_count) values ($1, 1)", [d]);
      const { rows: [m] } = await insertMedia(admin, photo(d));
      await assertRefused(admin, "delete from event_reports where event_date = $1", [d]);
      await assertRefused(admin, "delete from events where event_date = $1", [d]);
      for (const t of TABLES) await assertRefused(admin, `truncate ${t}`);
      const del = await admin.query("delete from event_media where id = $1", [m.id]);
      assert.equal(del.rowCount, 1);
    }));

  test("no DDL on the new tables", () =>
    inRollback(admin, async () => {
      for (const t of TABLES) {
        await assertRefused(admin, `alter table ${t} add column x int`, [], /must be owner/);
        await assertRefused(admin, `alter table ${t} disable trigger all`, [], /must be owner/);
      }
    }));

  test("updated_at is maintained by the trigger", () =>
    inRollback(admin, async () => {
      const d = testDate();
      const { rows: [a] } = await admin.query(
        "insert into events (event_date) values ($1) returning updated_at, created_at", [d]);
      // now() is fixed within a transaction: a hand-set value must be replaced by it.
      await admin.query("update events set updated_at = '2000-01-01' where event_date = $1", [d]);
      const { rows: [b] } = await admin.query("select updated_at, created_at from events where event_date = $1", [d]);
      assert.equal(b.updated_at.getTime(), a.updated_at.getTime(), "trigger overrides a hand-set updated_at");
      assert.equal(b.created_at.getTime(), a.created_at.getTime());
    }));
});

describe("checkin_writer", () => {
  test("can't read or write any of them", () =>
    inRollback(writer, async () => {
      for (const t of TABLES) {
        await assertRefused(writer, `select * from ${t}`);
      }
      await assertRefused(writer, "insert into events (event_date) values ('2099-12-31')");
    }));
});

describe("shape checks", () => {
  test("events: location_other iff location = 'other'", () =>
    inRollback(admin, async () => {
      await assertRefused(admin, "insert into events (event_date, location) values ($1, 'other')", [testDate()], CHECK);
      await assertRefused(admin, "insert into events (event_date, location, location_other) values ($1, 'other', '  ')", [testDate()], CHECK);
      await assertRefused(admin, "insert into events (event_date, location, location_other) values ($1, 'lobby', 'x')", [testDate()], CHECK);
      await assertRefused(admin, "insert into events (event_date, location_other) values ($1, 'x')", [testDate()], CHECK);
      await assertRefused(admin, "insert into events (event_date, location) values ($1, 'roof')", [testDate()], CHECK);
      await assertRefused(admin, "insert into events (event_date, status) values ($1, 'postponed')", [testDate()], CHECK);
      await assertAllowed(admin, "insert into events (event_date, location, location_other) values ($1, 'other', 'Rooftop')", [testDate()]);
      await assertAllowed(admin, "insert into events (event_date) values ($1)", [testDate()]); // location unknown
    }));

  test("events: cancel fields only when cancelled, reason required, 'other' needs text", () =>
    inRollback(admin, async () => {
      const ins = (cols, vals) => `insert into events (event_date, ${cols}) values ($1, ${vals})`;
      await assertRefused(admin, ins("status", "'cancelled'"), [testDate()], CHECK);
      await assertRefused(admin, ins("cancel_reason", "'weather'"), [testDate()], CHECK);
      await assertRefused(admin, ins("status, cancel_announced", "'held', true"), [testDate()], CHECK);
      await assertRefused(admin, ins("status, cancel_reason", "'cancelled', 'other'"), [testDate()], CHECK);
      await assertRefused(admin, ins("status, cancel_reason, cancel_reason_other", "'cancelled', 'weather', 'snow'"), [testDate()], CHECK);
      await assertRefused(admin, ins("status, cancel_reason", "'cancelled', 'aliens'"), [testDate()], CHECK);
      await assertAllowed(admin, ins("status, cancel_reason, cancel_announced", "'cancelled', 'weather', true"), [testDate()]);
      await assertAllowed(admin, ins("status, cancel_reason, cancel_reason_other", "'cancelled', 'other', 'Power cut'"), [testDate()]);

      // Un-cancelling has to clear the cancel fields in the same UPDATE.
      const d = testDate();
      await admin.query(ins("status, cancel_reason, cancel_announced", "'cancelled', 'facility', true"), [d]);
      await assertRefused(admin, "update events set status = 'scheduled' where event_date = $1", [d], CHECK);
      await assertAllowed(admin,
        "update events set status = 'scheduled', cancel_reason = null, cancel_announced = false where event_date = $1", [d]);
    }));

  test("event_reports: count >= 0, known sources, no Bling details when Bling was not given, real event and user", () =>
    inRollback(admin, async () => {
      const ins = (cols, vals) => `insert into event_reports (event_date, ${cols}) values ($1, ${vals})`;
      const d = () => { const x = testDate(); return admin.query("insert into events (event_date) values ($1)", [x]).then(() => x); };
      await assertRefused(admin, ins("gives_asks_count", "-1"), [await d()], CHECK);
      await assertRefused(admin, ins("source", "'csv'"), [await d()], CHECK);
      await assertRefused(admin, ins("bling_given, bling_details", "false, 'mug'"), [await d()], CHECK);
      await assertRefused(admin, ins("gives_asks_count", "1"), ["2099-12-30"], /foreign key/);
      await assertRefused(admin, ins("submitted_by", "'no-such-user'"), [await d()], /foreign key/);
      // Imported rows: nothing recorded but the date, no submitter.
      await assertAllowed(admin, ins("source", "'pre_form'"), [await d()]);
      await assertAllowed(admin, ins("source, gives_asks_count, bling_details", "'google_form', 0, 'mug'"), [await d()]);
    }));

  test("event_media: variants per kind, content types, publicly_usable only on social photos", () =>
    inRollback(admin, async () => {
      const d = testDate();
      await admin.query("insert into events (event_date) values ($1)", [d]);
      const refused = async (over) => {
        await admin.query("savepoint s");
        try {
          await assert.rejects(insertMedia(admin, photo(d, over)), CHECK, JSON.stringify(over));
        } finally {
          await admin.query("rollback to savepoint s");
        }
      };
      await refused({ display_key: null });
      await refused({ thumb_key: null });
      await refused({ kind: "promo_video", content_type: "video/mp4" }); // video with photo copies
      await refused({ content_type: "image/heic" });
      await refused({ content_type: "video/mp4" });
      await refused({ kind: "signin_board", publicly_usable: true });
      await refused({ size_bytes: 0 });
      await refused({ status: "uploading" });
      await refused({ kind: "selfie" });
      await insertMedia(admin, photo(d, { kind: "signin_board", content_type: "image/png" }));
      await insertMedia(admin, photo(d, { kind: "promo_video", content_type: "video/mp4", display_key: null, thumb_key: null,
        original_key: `events/${d}/${randomUUID()}/original.mp4` }));
      const dup = photo(d);
      await insertMedia(admin, dup);
      await assertRefused(admin, "insert into event_media (event_date, kind, original_key, display_key, thumb_key, content_type, size_bytes) values ($1, 'social_photo', $2, 'a', 'b', 'image/jpeg', 1)",
        [d, dup.original_key], /duplicate key/);
      await assertRefused(admin, "insert into event_media (event_date, kind, original_key, display_key, thumb_key, content_type, size_bytes) values ('2099-12-30', 'social_photo', 'x', 'y', 'z', 'image/jpeg', 1)",
        [], /foreign key/);
    }));

  test("deleting an account keeps its reports and media, with no submitter", () =>
    inRollback(owner, async () => {
      const d = testDate();
      const u = unique("gone-user");
      await owner.query(`insert into auth."user" (id, name, email, "emailVerified") values ($1, 'G', $2, false)`, [u, `${u}@example.com`]);
      await owner.query("insert into events (event_date) values ($1)", [d]);
      await owner.query("insert into event_reports (event_date, gives_asks_count, submitted_by) values ($1, 3, $2)", [d, u]);
      await insertMedia(owner, photo(d, { uploaded_by: u }));
      await owner.query(`delete from auth."user" where id = $1`, [u]);
      const { rows } = await owner.query(
        "select r.submitted_by, m.uploaded_by from event_reports r join event_media m using (event_date) where event_date = $1", [d]);
      assert.deepEqual(rows, [{ submitted_by: null, uploaded_by: null }]);
    }));
});

describe("migration 20261120120000 (social photos publicly usable)", () => {
  test("backfills social photos to true, leaves sign-in board photos false, and is idempotent", async () => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync(new URL("../../backend/db/migrations/20261120120000_social_photos_publicly_usable.sql", import.meta.url), "utf8");
    await inRollback(owner, async () => {
      const d = testDate();
      await owner.query("insert into events (event_date) values ($1)", [d]);
      const social = photo(d, { publicly_usable: false });
      const board = photo(d, { kind: "signin_board", publicly_usable: false });
      await insertMedia(owner, social);
      await insertMedia(owner, board);
      const first = await owner.query(sql);
      assert.ok(first.rowCount >= 1);
      const { rows } = await owner.query("select id, publicly_usable from event_media where event_date = $1", [d]);
      const pu = Object.fromEntries(rows.map((r) => [r.id, r.publicly_usable]));
      assert.deepEqual(pu, { [social.id]: true, [board.id]: false });
      assert.equal((await owner.query(sql)).rowCount, 0, "a re-run changes nothing");
    });
  });
});
