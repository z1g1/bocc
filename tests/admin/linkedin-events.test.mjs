// The LinkedIn event ledger, preview and dry run (ADR 0012, issue #25) against the
// throwaway database (npm run test:db):
//   1. migration 20261126120000_linkedin_events.sql: grants (admin_app SELECT/INSERT/
//      UPDATE, no DELETE; nobody else anything), one active row per date, retiring a
//      pending row frees the date, only forward status moves
//   2. the use-case as admin_app with a fake LinkedIn client: preview, the refusals,
//      confirm=live, the organizer duplicate check, and that a dry run sends nothing
//      and writes no ledger row
//   3. the LinkedIn event form on the event page over HTTP (astro dev): the preview,
//      the dialog, confirm=live, the dry-run payloads, role fences and the Origin check
// The pure rules are in linkedin-event-unit.test.mjs. Dates: 2087 (not used elsewhere).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_URL, CHECKIN_URL, OWNER_URL, assertAllowed, assertRefused, connect, inRollback } from "./helpers.mjs";

const SITE_URL = process.env.TEST_SITE_URL;
const SOCIAL_CHECK_URL = process.env.TEST_SOCIAL_CHECK_URL;
let owner;

const seedEvent = (date, cols = {}) => owner.query(
  `insert into events (event_date, status, location) values ($1, $2, $3)
   on conflict (event_date) do update set status = excluded.status, location = excluded.location`,
  [date, cols.status ?? "scheduled", cols.location ?? null]);

const PENDING = `insert into linkedin_events (event_date, status, name, commentary, location, image_source, image_ref)
                 values ($1, 'pending', 'Buffalo Open Coffee Club for June 3rd', 'Please join me', 'lobby', 'default', '/x.png')`;

before(async () => {
  owner = await connect(OWNER_URL);
});
after(async () => { await owner?.end(); });

// ── 1. Migration ────────────────────────────────────────────────────────────
describe("migration 20261126120000_linkedin_events.sql", () => {
  test("grants: admin_app SELECT, INSERT, UPDATE and no DELETE; nobody else anything", async () => {
    const { rows } = await owner.query(
      `select g.grantee || ':' || g.privilege_type as g
         from information_schema.role_table_grants g
         join pg_class c on c.relname = g.table_name and c.relnamespace = 'public'::regnamespace
        where g.table_schema = 'public' and g.table_name = 'linkedin_events'
          and g.grantee <> pg_get_userbyid(c.relowner)
        order by 1`);
    assert.deepEqual(rows.map((r) => r.g), ["admin_app:INSERT", "admin_app:SELECT", "admin_app:UPDATE"]);
  });

  test("as admin_app: one active row per date, no DELETE, and retiring a pending row frees the date", async () => {
    await seedEvent("2087-06-03");
    const admin = await connect(ADMIN_URL);
    try {
      await inRollback(admin, async () => {
        await admin.query(PENDING, ["2087-06-03"]);
        await assertRefused(admin, PENDING, ["2087-06-03"], /duplicate key|linkedin_events_event_date_active_key/);
        await assertRefused(admin, `delete from linkedin_events where event_date = $1`, ["2087-06-03"]);
        await assertRefused(admin, `truncate linkedin_events`);
        await admin.query(`update linkedin_events set status = 'retired', retired_at = now() where event_date = $1`, ["2087-06-03"]);
        await admin.query(PENDING, ["2087-06-03"]);
        const { rows } = await admin.query(`select status from linkedin_events where event_date = $1 order by attempted_at, status`, ["2087-06-03"]);
        assert.deepEqual(rows.map((r) => r.status).sort(), ["pending", "retired"]);
      });
    } finally {
      await admin.end();
    }
  });

  test("status only moves forward: pending -> created -> posted, or pending -> retired", async () => {
    await seedEvent("2087-06-10");
    const admin = await connect(ADMIN_URL);
    try {
      await inRollback(admin, async () => {
        await admin.query(PENDING, ["2087-06-10"]);
        const set = (sql) => `update linkedin_events set ${sql} where event_date = '2087-06-10' and status <> 'retired'`;
        // A created row needs its id and URL; a posted one its post too.
        await assertRefused(admin, set(`status = 'created'`), [], /linkedin_events_status_fields_ck/);
        await admin.query(set(`status = 'created', linkedin_event_id = '7249812613549670400',
          event_url = 'https://www.linkedin.com/events/7249812613549670400/', event_created_at = now()`));
        await assertRefused(admin, set(`status = 'retired', retired_at = now(), linkedin_event_id = null, event_url = null, event_created_at = null`), [], /status/);
        await assertRefused(admin, set(`status = 'pending', linkedin_event_id = null, event_url = null, event_created_at = null`), [], /status/);
        await admin.query(set(`status = 'posted', post_urn = 'urn:li:ugcPost:7511865991627468800',
          post_url = 'https://www.linkedin.com/feed/update/urn:li:ugcPost:7511865991627468800/', posted_at = now()`));
        await assertAllowed(admin, set(`cancelled_on_linkedin_at = now()`));
        await assertRefused(admin, set(`event_date = '2087-06-03'`), [], /event_date/);
      });
    } finally {
      await admin.end();
    }
  });

  test("checkin_writer, site_reader and social_checker can't read or write it", async () => {
    const others = await Promise.all([CHECKIN_URL, SITE_URL, SOCIAL_CHECK_URL].filter(Boolean).map(connect));
    try {
      for (const db of others) {
        await inRollback(db, async () => {
          await assertRefused(db, `select * from linkedin_events limit 1`);
          await assertRefused(db, PENDING, ["2087-06-03"]);
        });
      }
    } finally {
      await Promise.all(others.map((db) => db.end()));
    }
  });
});
