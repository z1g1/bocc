// The Event Image picked from a recent Photo from Event (ticket #21, ADR 0012
// decision 3) against the throwaway database and MinIO (npm run test:db):
//   1. the schema (migration 20261126120000): events.event_image_media_id, a reference
//      that refuses the referenced photo's delete
//   2. src/lib/admin/event-image.mjs + media.mjs as admin_app: the picker list, pick
//      (audited, a reference not a copy), the 16:9 cover made for a photo without one,
//      switching between uploaded / picked / default, the delete refusal
//   3. the picker form and the delete refusal over HTTP through a real `astro dev`
// Photos are seeded as the owner on dates in 2077 (the picker reads "the last 8 events
// on or before this one", so the seeded run of dates is all it sees from a 2077 date).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { ADMIN_URL, OWNER_URL, assertAllowed, assertRefused, connect, inRollback, unique, useAdminEnv } from "./helpers.mjs";

const skip = process.env.STORAGE_ENDPOINT ? false : "MinIO not running (STORAGE_ENDPOINT unset)";

const port = await new Promise((resolve, reject) => {
  const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  s.on("error", reject);
});
const BASE = `http://localhost:${port}`;
useAdminEnv();
process.env.BETTER_AUTH_URL = BASE;
process.env.ASTRO_TELEMETRY_DISABLED = "1";

const { pool } = await import("../../src/lib/auth/auth.mjs");
const { handleAuthRequest } = await import("../../src/lib/auth/handler.mjs");
const { withAudit } = await import("../../src/lib/admin/db.mjs");
const { createUser, grantRole } = await import("../../src/lib/admin/users.mjs");
const { getStorage } = await import("../../src/lib/admin/storage.mjs");
const media = await import("../../src/lib/admin/media.mjs");
const ei = await import("../../src/lib/admin/event-image.mjs");

const PASSWORD = "correct horse battery staple";
const COVER = Buffer.from("\xff\xd8 a photo's 16:9 cover", "binary");

let owner;
let actor;
const storage = () => getStorage().storage;

// Each describe gets its own run of dates in 2077, a week apart.
let nextDay = 0;
const used = new Set();
function dates(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2077, 0, 5) + (nextDay++) * 7 * 86400000).toISOString().slice(0, 10);
    used.add(d);
    out.push(d);
  }
  return out;
}
const ensureEvent = (d) => owner.query("insert into events (event_date) values ($1) on conflict do nothing", [d]);

/** Seed a ready Photo from Event (or another kind) as the owner. */
async function seedPhoto(d, { kind = "social_photo", cover = false, status = "ready" } = {}) {
  await ensureEvent(d);
  const id = randomUUID();
  const k = (v, ext = "jpg") => `events/${d}/${id}/${v}.${ext}`;
  await owner.query(
    `insert into event_media (id, event_date, kind, original_key, display_key, thumb_key, cover_key, content_type,
                              size_bytes, publicly_usable, status)
     values ($1, $2, $3, $4, $5, $6, $7, 'image/jpeg', 10, $8, $9)`,
    [id, d, kind, k("original"), k("display"), k("thumb"), cover ? k("cover") : null, kind === "social_photo", status]);
  return id;
}
const row = (id) => owner.query("select * from event_media where id = $1", [id]).then((r) => r.rows[0]);
const ref = (d) => owner.query("select event_image_media_id from events where event_date = $1", [d]).then((r) => r.rows[0]?.event_image_media_id ?? null);
const auditsFor = (id) => owner.query("select actor_user_id, action, details from audit_log where target_id = $1 order by id", [id]).then((r) => r.rows);
const exists = async (key) => (await storage().headObject({ key })) !== null;

before(async () => {
  owner = await connect(OWNER_URL);
  actor = await createUser({ email: `${unique("pickactor")}@example.com`, name: "Pick Actor", password: PASSWORD });
});
after(async () => {
  const ds = [...used];
  try {
    await owner?.query("update events set event_image_media_id = null where event_date = any($1::date[])", [ds]);
    await owner?.query("delete from event_media where event_date = any($1::date[])", [ds]);
    await owner?.query("delete from events where event_date = any($1::date[])", [ds]);
  } finally {
    await owner?.end();
    await pool.end();
  }
});

// ── 1. Schema ───────────────────────────────────────────────────────────────
describe("schema: the Event Image reference", () => {
  test("admin_app can set and clear an event's reference to a photo", async () => {
    const [p, d] = dates(2);
    const photo = await seedPhoto(p);
    await ensureEvent(d);
    const admin = await connect(ADMIN_URL);
    try {
      await inRollback(admin, async () => {
        await assertAllowed(admin, "update events set event_image_media_id = $1 where event_date = $2", [photo, d]);
        await assertAllowed(admin, "update events set event_image_media_id = null where event_date = $1", [d]);
      });
    } finally {
      await admin.end();
    }
  });

  test("a referenced photo can't be deleted, even straight in SQL", async () => {
    const [p, d] = dates(2);
    const photo = await seedPhoto(p);
    await ensureEvent(d);
    const admin = await connect(ADMIN_URL);
    try {
      await inRollback(admin, async () => {
        await admin.query("update events set event_image_media_id = $1 where event_date = $2", [photo, d]);
        await assertRefused(admin, "delete from event_media where id = $1", [photo], /events_event_image_media_id_fkey/);
      });
    } finally {
      await admin.end();
    }
  });
});
