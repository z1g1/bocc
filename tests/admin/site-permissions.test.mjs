// site_reader, the role behind the public event pages (migration
// 20261121120000_event_links_site_reader.sql): SELECT on events and event_links, and
// nothing else. Public traffic must never read reports, media, people or check-ins.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { assertAllowed, assertRefused, connect } from "./helpers.mjs";

const SITE_URL = process.env.TEST_SITE_URL;
if (!SITE_URL) throw new Error("TEST_SITE_URL is not set: run these tests with npm run test:db");

let site;
before(async () => { site = await connect(SITE_URL); await site.query("begin"); });
after(async () => { await site?.query("rollback").catch(() => {}); await site?.end(); });

describe("site_reader permissions", () => {
  test("may read events and event_links", async () => {
    await assertAllowed(site, "select event_date, status, location, location_other from events limit 1");
    await assertAllowed(site, "select event_date, platform, url, external_id from event_links limit 1");
  });

  for (const table of ["event_reports", "event_media", "attendees", "checkins", "audit_log", "user_roles", "streaks", "held_occurrences", 'auth."user"', "auth.session"]) {
    test(`may not read ${table}`, async () => {
      await assertRefused(site, `select * from ${table} limit 1`);
    });
  }

  test("may not write events or event_links", async () => {
    await assertRefused(site, "insert into events (event_date) values ('2031-01-07')");
    await assertRefused(site, "update events set location = 'lobby'");
    await assertRefused(site, "delete from event_links");
    await assertRefused(site, "insert into event_links (event_date, platform, url) values ('2031-01-07', 'luma', 'https://luma.com/x')");
  });

  test("is not a superuser and can't create objects in public", async () => {
    const { rows: [r] } = await site.query("select rolsuper, rolcreaterole, rolcreatedb from pg_roles where rolname = current_user");
    assert.deepEqual(r, { rolsuper: false, rolcreaterole: false, rolcreatedb: false });
    await assertRefused(site, "create table public.site_reader_probe (x int)");
  });
});
