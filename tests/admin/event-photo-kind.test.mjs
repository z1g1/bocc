// Photo from Event: one name everywhere (ticket #54, parent #49), against the throwaway
// database (npm run test:db). Migration 20261203150000_event_photo_kind.sql:
//   1. backfills 'social_photo' rows to 'event_photo' without touching updated_at, and
//      leaves the other kinds alone (re-run on old-valued rows, in a rolled-back transaction)
//   2. an old-value write (the code live before the deploy, as admin_app) lands as
//      'event_photo'
//   3. only a Photo from Event may be publicly usable; a Sign-in board photo never is
// Delete section 2 with the contract migration (#60). Dates: 2058 (not used elsewhere).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { ADMIN_URL, OWNER_URL, connect, inRollback } from "./helpers.mjs";

const MIGRATION = readFileSync(new URL("../../backend/db/migrations/20261203150000_event_photo_kind.sql", import.meta.url), "utf8");

let owner, admin;
let n = 0;
const date = () => new Date(Date.UTC(2058, 0, 1 + 7 * n++)).toISOString().slice(0, 10);

before(async () => {
  owner = await connect(OWNER_URL);
  admin = await connect(ADMIN_URL);
});
after(async () => { await Promise.all([owner, admin].map((c) => c?.end())); });

async function insertMedia(db, d, kind, { publiclyUsable = kind !== "signin_board" } = {}) {
  const id = randomUUID();
  const base = `events/${d}/${id}`;
  await db.query(
    `insert into event_media (id, event_date, kind, original_key, display_key, thumb_key, content_type, size_bytes, status, publicly_usable)
     values ($1, $2, $3, $4, $5, $6, 'image/jpeg', 10, 'ready', $7)`,
    [id, d, kind, `${base}/original.jpg`, `${base}/display.jpg`, `${base}/thumb.jpg`, publiclyUsable]);
  return id;
}
const kindOf = async (db, id) => (await db.query("select kind from event_media where id = $1", [id])).rows[0].kind;

describe("migration 20261203150000_event_photo_kind.sql", () => {
  test("backfills social_photo rows to event_photo, leaves other kinds and updated_at alone", () =>
    inRollback(owner, async () => {
      // Back to the state before this migration, so it can be re-run on old-valued rows.
      await owner.query(`drop trigger event_media_event_photo_compat on event_media;
                         drop function event_media_event_photo_compat();`);
      const d = date();
      await owner.query("insert into events (event_date) values ($1)", [d]);
      const photo = await insertMedia(owner, d, "social_photo");
      const board = await insertMedia(owner, d, "signin_board");
      // A known updated_at (now() is the same for the whole test transaction, so it couldn't tell).
      await owner.query("alter table event_media disable trigger event_media_set_updated_at");
      await owner.query("update event_media set updated_at = '2058-01-01T00:00:00Z' where event_date = $1", [d]);
      await owner.query("alter table event_media enable trigger event_media_set_updated_at");

      await owner.query(MIGRATION);

      const { rows } = await owner.query(
        "select id, kind, publicly_usable, updated_at = '2058-01-01T00:00:00Z' as untouched from event_media where event_date = $1", [d]);
      const byId = Object.fromEntries(rows.map(({ id, ...r }) => [id, r]));
      assert.deepEqual(byId, {
        [photo]: { kind: "event_photo", publicly_usable: true, untouched: true },
        [board]: { kind: "signin_board", publicly_usable: false, untouched: true },
      });
      assert.equal((await owner.query("select count(*)::int as c from event_media where kind = 'social_photo'")).rows[0].c, 0);
    }));

  test("an old-value write (the code live before the deploy) lands as event_photo", () =>
    inRollback(admin, async () => {
      const d = date();
      await admin.query("insert into events (event_date) values ($1) on conflict (event_date) do nothing", [d]);
      const id = await insertMedia(admin, d, "social_photo");
      assert.equal(await kindOf(admin, id), "event_photo");
    }));

  test("an old-value UPDATE of kind (owner) lands as event_photo", () =>
    inRollback(owner, async () => {
      const d = date();
      await owner.query("insert into events (event_date) values ($1)", [d]);
      const id = await insertMedia(owner, d, "signin_board", { publiclyUsable: false });
      await owner.query("update event_media set kind = 'social_photo' where id = $1", [id]);
      assert.equal(await kindOf(owner, id), "event_photo");
    }));

  test("only a Photo from Event may be publicly usable; a Sign-in board photo never is", () =>
    inRollback(owner, async () => {
      const d = date();
      await owner.query("insert into events (event_date) values ($1)", [d]);
      await insertMedia(owner, d, "event_photo", { publiclyUsable: true });
      await assert.rejects(insertMedia(owner, d, "signin_board", { publiclyUsable: true }), /event_media_publicly_usable_ck/);
    }));
});
