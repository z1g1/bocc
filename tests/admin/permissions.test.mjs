// Postgres-level guarantees of migration 20261116120000_admin_auth.sql (ADR 0008
// decision 6), checked by connecting AS each role. These are the backstop under the
// app's role checks.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  ADMIN_URL, CHECKIN_URL, OWNER_URL, assertAllowed, assertRefused, connect, inRollback, seedAttendee, unique,
} from "./helpers.mjs";

let owner, admin, writer, seed;

before(async () => {
  owner = await connect(OWNER_URL);
  admin = await connect(ADMIN_URL);
  writer = await connect(CHECKIN_URL);
  seed = await seedAttendee(owner);
});
after(async () => {
  await Promise.all([owner?.end(), admin?.end(), writer?.end()]);
});

describe("migrations", () => {
  test("every migration applied once, in order, on vanilla Postgres", async () => {
    const { rows } = await owner.query("select filename from schema_migrations order by filename");
    assert.deepEqual(rows.map((r) => r.filename), [
      "20260625120000_checkin_core_schema.sql",
      "20260625120100_streak_views.sql",
      "20260625120200_least_privilege_rls.sql",
      "20260912120000_streak_celebration_fields.sql",
      "20261116120000_admin_auth.sql",
    ]);
  });

  test("Better Auth tables exist in the auth schema", async () => {
    const { rows } = await owner.query(
      "select table_name from information_schema.tables where table_schema = 'auth' order by 1");
    assert.deepEqual(rows.map((r) => r.table_name), ["account", "passkey", "rateLimit", "session", "user", "verification"]);
  });

  test("admin_app is created NOLOGIN by the migration (LOGIN is set out of band)", async () => {
    // scripts/test-db.sh grants LOGIN afterwards, like the operator does on Neon; the
    // migration text itself must create it NOLOGIN.
    const fs = await import("node:fs");
    const sql = fs.readFileSync(new URL("../../backend/db/migrations/20261116120000_admin_auth.sql", import.meta.url), "utf8");
    assert.match(sql, /create role admin_app nologin noinherit/);
    const { rows: [r] } = await owner.query("select rolsuper, rolcreaterole, rolcreatedb, rolbypassrls from pg_roles where rolname = 'admin_app'");
    assert.deepEqual(r, { rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false });
  });
});

describe("admin_app on attendee and check-in data", () => {
  test("can read attendees, checkins, held_occurrences and streaks", async () => {
    for (const rel of ["attendees", "checkins", "held_occurrences", "streaks"]) {
      await admin.query(`select count(*) from ${rel}`);
    }
    const { rows } = await admin.query("select id from attendees where id = $1", [seed.attendeeId]);
    assert.equal(rows.length, 1, "RLS select policy lets admin_app see rows");
  });

  test("can update only ok_to_email, name, business_name, phone", () =>
    inRollback(admin, async () => {
      const r = await assertAllowed(admin,
        "update attendees set ok_to_email = false, name = 'N', business_name = 'B', phone = 'P' where id = $1",
        [seed.attendeeId]);
      assert.equal(r.rowCount, 1, "RLS update policy lets the row through");
      for (const col of ["email = 'x@example.com'", "debug = true", "legacy_airtable_id = 'x'", "created_at = now()", "id = gen_random_uuid()"]) {
        await assertRefused(admin, `update attendees set ${col} where id = $1`, [seed.attendeeId]);
      }
    }));

  test("cannot insert or delete attendees, or touch checkins beyond SELECT", () =>
    inRollback(admin, async () => {
      await assertRefused(admin, "insert into attendees (email, name) values ('new@example.com', 'New')");
      await assertRefused(admin, "delete from attendees where id = $1", [seed.attendeeId]);
      await assertRefused(admin, "truncate attendees");
      await assertRefused(admin, "insert into checkins (attendee_id, event_id, checkin_date) values ($1, 'bocc', current_date)", [seed.attendeeId]);
      await assertRefused(admin, "update checkins set debug = true where id = $1", [seed.checkinId]);
      await assertRefused(admin, "delete from checkins where id = $1", [seed.checkinId]);
      await assertRefused(admin, "truncate checkins");
    }));

  test("no DDL and no schema_migrations", () =>
    inRollback(admin, async () => {
      await assertRefused(admin, "create table public.x (id int)");
      await assertRefused(admin, "create table auth.x (id int)");
      await assertRefused(admin, "select * from schema_migrations");
      await assertRefused(admin, "alter table attendees disable row level security", [], /must be owner/);
      await assertRefused(admin, "alter table audit_log disable trigger audit_log_no_update_delete", [], /must be owner/);
    }));
});

describe("audit_log", () => {
  test("admin_app can insert and read", () =>
    inRollback(admin, async () => {
      const { rows: [r] } = await admin.query(
        "insert into audit_log (actor_user_id, action, details) values ('u1', 'test.insert', '{\"a\":1}') returning id");
      const { rows } = await admin.query("select action, details from audit_log where id = $1", [r.id]);
      assert.deepEqual(rows[0], { action: "test.insert", details: { a: 1 } });
    }));

  test("admin_app cannot UPDATE, DELETE or TRUNCATE (no grant)", () =>
    inRollback(admin, async () => {
      await admin.query("insert into audit_log (action) values ('test.row')");
      await assertRefused(admin, "update audit_log set action = 'x'");
      await assertRefused(admin, "delete from audit_log");
      await assertRefused(admin, "truncate audit_log");
    }));

  test("even the owner is stopped by the append-only trigger", () =>
    inRollback(owner, async () => {
      await owner.query("insert into audit_log (action) values ('test.row')");
      await assertRefused(owner, "update audit_log set action = 'x'", [], /append-only \(UPDATE refused\)/);
      await assertRefused(owner, "delete from audit_log", [], /append-only \(DELETE refused\)/);
      await assertRefused(owner, "truncate audit_log", [], /append-only \(TRUNCATE refused\)/);
    }));
});

describe("user_roles", () => {
  test("admin_app can select, insert and delete; not update", () =>
    inRollback(admin, async () => {
      const id = unique("user");
      await admin.query(
        `insert into auth."user" (id, name, email, "emailVerified") values ($1, 'T', $2, false)`,
        [id, `${id}@example.com`]);
      await admin.query("insert into user_roles (user_id, role) values ($1, 'social')", [id]);
      const { rows } = await admin.query("select role from user_roles where user_id = $1", [id]);
      assert.deepEqual(rows, [{ role: "social" }]);
      await assertRefused(admin, "update user_roles set role = 'admin' where user_id = $1", [id]);
      await assertRefused(admin, "insert into user_roles (user_id, role) values ($1, 'superuser')", [id], /check constraint/);
      const del = await admin.query("delete from user_roles where user_id = $1", [id]);
      assert.equal(del.rowCount, 1);
    }));

  test("roles go when the Better Auth user is deleted", () =>
    inRollback(admin, async () => {
      const id = unique("user");
      await admin.query(`insert into auth."user" (id, name, email, "emailVerified") values ($1, 'T', $2, false)`, [id, `${id}@example.com`]);
      await admin.query("insert into user_roles (user_id, role) values ($1, 'admin')", [id]);
      await admin.query(`delete from auth."user" where id = $1`, [id]);
      const { rows } = await admin.query("select 1 from user_roles where user_id = $1", [id]);
      assert.equal(rows.length, 0);
    }));
});

describe("checkin_writer is unchanged", () => {
  test("table grants are exactly what migration 0003 gave it", async () => {
    const { rows } = await owner.query(
      `select table_schema || '.' || table_name || ':' || privilege_type as g
         from information_schema.role_table_grants
        where grantee = 'checkin_writer' order by 1`);
    assert.deepEqual(rows.map((r) => r.g), [
      "public.attendees:INSERT", "public.attendees:SELECT",
      "public.checkins:INSERT", "public.checkins:SELECT",
      "public.held_occurrences:SELECT", "public.streaks:SELECT",
    ]);
    const { rows: cols } = await owner.query(
      "select count(*)::int as n from information_schema.column_privileges where grantee = 'checkin_writer' and privilege_type = 'UPDATE'");
    assert.equal(cols[0].n, 0, "no column-level UPDATE leaked to checkin_writer");
  });

  test("cannot reach the auth schema, user_roles or audit_log", () =>
    inRollback(writer, async () => {
      await assertRefused(writer, `select * from auth."user"`);
      await assertRefused(writer, `select * from auth.session`);
      await assertRefused(writer, "select * from user_roles");
      await assertRefused(writer, "insert into audit_log (action) values ('x')");
      await assertRefused(writer, "update attendees set ok_to_email = false");
      await assertRefused(writer, "delete from checkins");
    }));

  test("the real check-in function still works end to end (TLS, verify-full)", async () => {
    // backend/netlify/functions/checkin.js, unchanged, as checkin_writer through
    // utils/db-ssl.js. DB_CA_CERT is the test container's self-signed localhost cert.
    const fs = await import("node:fs");
    const { createRequire } = await import("node:module");
    process.env.CHECKIN_DB_URL = CHECKIN_URL;
    process.env.DB_CA_CERT = fs.readFileSync(process.env.DB_CA_CERT_FILE, "utf8");
    const require = createRequire(import.meta.url);
    const { handler } = require("../../backend/netlify/functions/checkin.js");
    const { _getPool } = require("../../backend/netlify/functions/utils/pg-store.js");
    const email = `${unique("checkin")}@example.com`;
    const event = (body) => ({ httpMethod: "POST", headers: {}, body: JSON.stringify(body) });
    const body = { email, name: "Test Person", phone: "", businessName: "", okToEmail: true, eventId: "bocc", token: "t", debug: "0" };
    try {
      const first = await handler(event(body));
      assert.equal(first.statusCode, 200, first.body);
      assert.equal(JSON.parse(first.body).message, "Check-in successful");
      const again = await handler(event(body));
      assert.equal(JSON.parse(again.body).alreadyCheckedIn, true);
    } finally {
      await _getPool().end();
    }
  });
});
