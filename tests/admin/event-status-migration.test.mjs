// Event status value switch `held` -> `reported` (ticket #51, parent #49), against the
// throwaway database (npm run test:db):
//   1. migration 20261203130000_event_status_reported.sql backfills existing rows without
//      touching updated_at (re-run on a rebuilt pre-migration state, in a rolled-back
//      transaction)
//   2. a write of the old value `held` (the code live before the deploy) lands as `reported`
// Delete section 2 with the contract migration. Dates: 2057 (not used elsewhere).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ADMIN_URL, OWNER_URL, connect, inRollback } from "./helpers.mjs";

const MIGRATION = readFileSync(new URL("../../backend/db/migrations/20261203130000_event_status_reported.sql", import.meta.url), "utf8");

let owner, admin;
let n = 0;
const date = () => new Date(Date.UTC(2057, 0, 1 + 7 * n++)).toISOString().slice(0, 10);

before(async () => {
  owner = await connect(OWNER_URL);
  admin = await connect(ADMIN_URL);
});
after(async () => {
  await Promise.all([owner, admin].map((c) => c?.end()));
});

const statusOf = async (db, d) =>
  (await db.query(`select status, updated_at from events where event_date = $1`, [d])).rows[0];

describe("migration 20261203130000_event_status_reported.sql", () => {
  test("existing `held` rows become `reported`; others and updated_at are untouched", () =>
    inRollback(owner, async () => {
      await owner.query(`drop trigger events_status_held_compat on events; drop function events_status_held_compat();`);
      const [held, scheduled, cancelled] = [date(), date(), date()];
      await owner.query(
        `insert into events (event_date, status, cancel_reason) values ($1, 'held', null), ($2, 'scheduled', null), ($3, 'cancelled', 'weather')`,
        [held, scheduled, cancelled]);
      const before = (await statusOf(owner, held)).updated_at;

      await owner.query(MIGRATION);

      const after = await statusOf(owner, held);
      assert.equal(after.status, "reported");
      assert.deepEqual(after.updated_at, before, "the backfill is not an edit");
      assert.equal((await statusOf(owner, scheduled)).status, "scheduled");
      assert.equal((await statusOf(owner, cancelled)).status, "cancelled");
    }));
});

describe("compatibility: the code live before the deploy writes `held`", () => {
  test("an insert, an upsert and an update of `held` as admin_app land as `reported`", () =>
    inRollback(admin, async () => {
      const [a, b] = [date(), date()];
      await admin.query(`insert into public.events (event_date, status) values ($1::date, 'held')`, [a]);
      assert.equal((await statusOf(admin, a)).status, "reported");

      await admin.query(`insert into public.events (event_date) values ($1::date)`, [b]);
      await admin.query(`update public.events set status = 'held' where event_date = $1::date`, [b]);
      assert.equal((await statusOf(admin, b)).status, "reported");

      await admin.query(`update public.events set status = 'scheduled' where event_date = $1::date`, [b]);
      await admin.query(
        `insert into public.events (event_date, status) values ($1::date, 'held')
         on conflict (event_date) do update set status = 'held'`, [b]);
      assert.equal((await statusOf(admin, b)).status, "reported");
    }));
});
