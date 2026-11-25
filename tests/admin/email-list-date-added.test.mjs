// Email list Date added (issue #71), against the throwaway database (npm run test:db).
// Date added = the Eastern date of the Attendee's first non-debug Check-in, otherwise
// the Eastern date their attendees row was created (people imported from Airtable).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { OWNER_URL, connect, unique, useAdminEnv } from "./helpers.mjs";

useAdminEnv();
const { pool } = await import("../../src/lib/auth/auth.mjs");
const { createUser } = await import("../../src/lib/admin/users.mjs");
const { listSubscribers, exportEmailList } = await import("../../src/lib/admin/email-list.mjs");

let owner;
const fx = {};

/** An opted-in attendee whose row was created at `createdAt` (an ISO timestamp). */
async function attendee({ name, business = "Biz", createdAt }) {
  const email = `${unique("da")}@example.com`;
  const { rows: [a] } = await owner.query(
    `insert into attendees (email, name, phone, business_name, ok_to_email, created_at)
     values ($1, $2, '716-555-0100', $3, true, $4) returning id`, [email, name, business, createdAt]);
  return { id: a.id, email, name };
}
/** A check-in at `at` (ISO timestamp); checkin_date is its Eastern day, as the check-in API writes it. */
async function checkin(a, at, { debug = false } = {}) {
  await owner.query(
    `insert into checkins (attendee_id, event_id, token, checkin_at, checkin_date, debug)
     values ($1, $2, 'tok', $3::timestamptz, ($3::timestamptz at time zone 'America/New_York')::date, $4)`,
    [a.id, unique("da-event"), at, debug]);
}

before(async () => {
  owner = await connect(OWNER_URL);
  // Two real check-ins; the first is late on a Tuesday evening Eastern (already Wednesday in UTC).
  fx.regular = await attendee({ name: "Dana Dated", createdAt: "2026-01-02T15:00:00Z" });
  await checkin(fx.regular, "2026-03-11T01:30:00Z");          // 2026-03-10 21:30 EDT
  await checkin(fx.regular, "2026-04-14T13:00:00Z");
  // An earlier debug check-in is ignored.
  fx.debugFirst = await attendee({ name: "Debra Debugfirst", createdAt: "2025-12-01T15:00:00Z" });
  await checkin(fx.debugFirst, "2026-01-06T13:00:00Z", { debug: true });
  await checkin(fx.debugFirst, "2026-02-03T13:00:00Z");
  // Only debug check-ins: falls back to the row's creation date (Eastern).
  fx.debugOnly = await attendee({ name: "Doug Debugonly", createdAt: "2025-11-04T03:00:00Z" }); // 11-03 22:00 EST
  await checkin(fx.debugOnly, "2026-01-13T13:00:00Z", { debug: true });
  // No check-ins at all (imported from Airtable): the creation date.
  fx.imported = await attendee({ name: "=Imogen Imported", business: "+Old Co", createdAt: "2024-05-20T16:00:00Z" });
});
after(async () => { await owner?.end(); await pool.end(); });

describe("email list Date added", () => {
  const byEmail = async () => new Map((await listSubscribers(pool)).map((s) => [s.email, s]));

  test("is the Eastern date of the first non-debug check-in", async () => {
    assert.equal((await byEmail()).get(fx.regular.email).dateAdded, "2026-03-10");
  });

  test("ignores debug check-ins", async () => {
    assert.equal((await byEmail()).get(fx.debugFirst.email).dateAdded, "2026-02-03");
  });

  test("with only debug check-ins, falls back to the record's creation date", async () => {
    assert.equal((await byEmail()).get(fx.debugOnly.email).dateAdded, "2025-11-03");
  });

  test("with no check-ins, falls back to the record's creation date", async () => {
    assert.equal((await byEmail()).get(fx.imported.email).dateAdded, "2024-05-20");
  });

  test("every subscriber has an ISO Date added", async () => {
    for (const s of await listSubscribers(pool)) assert.match(s.dateAdded, /^\d{4}-\d{2}-\d{2}$/, s.email);
  });

  test("the CSV ends with date_added, and formula escaping still applies", async () => {
    const user = await createUser({ email: `${unique("da")}@example.com`, name: "Date Added Admin", password: "correct horse battery staple" });
    const { csv } = await exportEmailList(user.id);
    const lines = csv.trimEnd().split("\r\n");
    assert.equal(lines[0], "email,name,business_name,date_added");
    assert.ok(lines.includes(`${fx.regular.email},Dana Dated,Biz,2026-03-10`));
    assert.ok(lines.includes(`${fx.imported.email},'=Imogen Imported,'+Old Co,2024-05-20`), "formula cells neutralised");
  });
});
