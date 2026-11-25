// Migration 20261205120000_luma_sync.sql (issue #72, spec #70, ADR 0014), against the
// throwaway database (npm run test:db), connecting AS each role:
//   1. the launch backfill: re-run on a rebuilt pre-migration state in a rolled-back
//      transaction, every non-debug Email-list Attendee becomes On Luma "before launch"
//      and everyone else stays Not yet; no luma_syncs rows are created
//   2. the `email` role is accepted by user_roles
//   3. grants: admin_app updates only its On Luma columns on attendees and may select,
//      insert and update luma_syncs; checkin_writer reaches none of it
//   4. On Luma is never turned off once set (ADR 0014 §5)
// Dates: 2058 (not used elsewhere).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ADMIN_URL, CHECKIN_URL, OWNER_URL, assertAllowed, assertRefused, connect, inRollback, unique,
} from "./helpers.mjs";

const MIGRATION = readFileSync(
  new URL("../../backend/db/migrations/20261205120000_luma_sync.sql", import.meta.url), "utf8");

let owner, admin, writer;
let n = 0;
const date = () => new Date(Date.UTC(2058, 0, 6 + 7 * n++)).toISOString().slice(0, 10);

before(async () => {
  owner = await connect(OWNER_URL);
  admin = await connect(ADMIN_URL);
  writer = await connect(CHECKIN_URL);
});
after(async () => {
  await Promise.all([owner, admin, writer].map((c) => c?.end()));
});

async function attendee(db, { ok = true, debug = false } = {}) {
  const { rows: [a] } = await db.query(
    `insert into attendees (email, name, ok_to_email, debug) values ($1, 'Luma Person', $2, $3) returning id`,
    [`${unique("luma")}@example.com`, ok, debug]);
  return a.id;
}
const onLuma = async (db, id) => (await db.query(
  "select on_luma_at, on_luma_before_launch from attendees where id = $1", [id])).rows[0];

/** Undo the migration inside the current transaction, so it can be applied again. */
async function unapply(db) {
  await db.query(`
    drop table public.luma_syncs;
    drop trigger attendees_on_luma_never_cleared on public.attendees;
    drop function public.attendees_on_luma_never_cleared();
    alter table public.attendees drop column on_luma_at, drop column on_luma_before_launch;
    alter table public.user_roles drop constraint user_roles_role_check;
    alter table public.user_roles add constraint user_roles_role_check
      check (role in ('admin', 'social')) not valid;`);
}

describe("migration 20261205120000_luma_sync.sql: launch backfill", () => {
  test("every non-debug Email-list Attendee is Before launch; everyone else is Not yet; no syncs", () =>
    inRollback(owner, async () => {
      await unapply(owner);
      const onList = await attendee(owner);
      const debugOptedIn = await attendee(owner, { debug: true });
      const notOptedIn = await attendee(owner, { ok: false });
      const debugNotOptedIn = await attendee(owner, { ok: false, debug: true });

      await owner.query(MIGRATION);

      assert.deepEqual(await onLuma(owner, onList), { on_luma_at: null, on_luma_before_launch: true });
      for (const id of [debugOptedIn, notOptedIn, debugNotOptedIn]) {
        assert.deepEqual(await onLuma(owner, id), { on_luma_at: null, on_luma_before_launch: false }, id);
      }
      const { rows: [{ count }] } = await owner.query("select count(*)::int as count from luma_syncs");
      assert.equal(count, 0, "no luma_syncs rows for past Events");
      const { rows: [{ wrong }] } = await owner.query(
        `select count(*)::int as wrong from attendees
          where on_luma_before_launch <> (ok_to_email and not debug) or on_luma_at is not null`);
      assert.equal(wrong, 0, "the backfill covers every existing Attendee");
    }));

  test("an Attendee created after the migration starts Not yet", () =>
    inRollback(owner, async () => {
      assert.deepEqual(await onLuma(owner, await attendee(owner)), { on_luma_at: null, on_luma_before_launch: false });
    }));
});

describe("the email role", () => {
  test("user_roles accepts admin, social and email, and nothing else", () =>
    inRollback(admin, async () => {
      const id = unique("user");
      await admin.query(
        `insert into auth."user" (id, name, email, "emailVerified") values ($1, 'T', $2, false)`,
        [id, `${id}@example.com`]);
      await admin.query("insert into user_roles (user_id, role) values ($1, 'email'), ($1, 'social')", [id]);
      const { rows } = await admin.query("select role from user_roles where user_id = $1 order by role", [id]);
      assert.deepEqual(rows.map((r) => r.role), ["email", "social"]);
      await assertRefused(admin, "insert into user_roles (user_id, role) values ($1, 'luma')", [id], /check constraint/);
    }));
});

describe("grants", () => {
  test("admin_app may set the On Luma columns, still only the correctable columns besides", () =>
    inRollback(admin, async () => {
      const id = await attendee(owner);
      const r = await assertAllowed(admin,
        "update attendees set on_luma_at = now(), on_luma_before_launch = true where id = $1", [id]);
      assert.equal(r.rowCount, 1);
      for (const col of ["email = 'x@example.com'", "debug = true", "created_at = now()"]) {
        await assertRefused(admin, `update attendees set ${col} where id = $1`, [id]);
      }
    }));

  test("admin_app can select, insert and update luma_syncs; not delete or truncate", async () => {
    const d = date();
    await owner.query("insert into events (event_date) values ($1)", [d]); // committed: admin must see it
    try {
      await inRollback(admin, async () => {
        await admin.query(
          "insert into luma_syncs (event_date, status, updated_by) values ($1, 'todo', 'u1')", [d]);
        await admin.query(
          "update luma_syncs set status = 'error', note = 'x@example.com not found', updated_by = 'u2' where event_date = $1", [d]);
        const { rows: [row] } = await admin.query("select status, note, updated_by from luma_syncs where event_date = $1", [d]);
        assert.deepEqual(row, { status: "error", note: "x@example.com not found", updated_by: "u2" });
        await assertRefused(admin, "delete from luma_syncs where event_date = $1", [d]);
        await assertRefused(admin, "truncate luma_syncs");
      });
    } finally {
      await owner.query("delete from events where event_date = $1", [d]);
    }
  });

  test("luma_syncs: status is todo | nothing_to_add | done | error, Error needs a note, one row per Event", () =>
    inRollback(owner, async () => {
      const d = date();
      await owner.query("insert into events (event_date) values ($1)", [d]);
      for (const status of ["todo", "nothing_to_add", "done"]) {
        await assertAllowed(owner, "insert into luma_syncs (event_date, status) values ($1, $2)", [d, status]);
      }
      await assertAllowed(owner, "insert into luma_syncs (event_date, status, note) values ($1, 'error', 'missing')", [d]);
      await assertRefused(owner, "insert into luma_syncs (event_date, status) values ($1, 'pending')", [d], /check constraint/);
      await assertRefused(owner, "insert into luma_syncs (event_date, status) values ($1, 'error')", [d], /check constraint/);
      await assertRefused(owner, "insert into luma_syncs (event_date, status, note) values ($1, 'error', '  ')", [d], /check constraint/);
      await assertRefused(owner, "insert into luma_syncs (event_date, status) values ('2058-12-30', 'todo')", [],
        /foreign key/);
      await owner.query("insert into luma_syncs (event_date) values ($1)", [d]);
      const { rows: [row] } = await owner.query("select status, updated_at is not null as stamped from luma_syncs where event_date = $1", [d]);
      assert.deepEqual(row, { status: "todo", stamped: true });
      await assertRefused(owner, "insert into luma_syncs (event_date) values ($1)", [d], /duplicate key/);
    }));

  test("checkin_writer can't read luma_syncs or set On Luma", () =>
    inRollback(writer, async () => {
      await assertRefused(writer, "select * from luma_syncs");
      await assertRefused(writer, "insert into luma_syncs (event_date) values ('2058-01-06')");
      await assertRefused(writer, "update attendees set on_luma_at = now()");
      await assertRefused(writer, "update attendees set on_luma_before_launch = true");
    }));
});

describe("On Luma is never turned off", () => {
  test("clearing either column is refused, even for the owner; setting is fine", () =>
    inRollback(owner, async () => {
      const id = await attendee(owner);
      await owner.query("update attendees set on_luma_at = '2058-01-06T02:00:00Z' where id = $1", [id]);
      await owner.query("update attendees set on_luma_before_launch = true where id = $1", [id]);
      await assertRefused(owner, "update attendees set on_luma_at = null where id = $1", [id], /never turned off/);
      await assertRefused(owner, "update attendees set on_luma_before_launch = false where id = $1", [id], /never turned off/);
      await owner.query("update attendees set name = 'Still Fine' where id = $1", [id]);
      assert.deepEqual(await onLuma(owner, id),
        { on_luma_at: new Date("2058-01-06T02:00:00Z"), on_luma_before_launch: true });
    }));
});
