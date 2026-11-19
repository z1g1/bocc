// The live LinkedIn create and its recovery (ADR 0012, issue #26) against the throwaway
// database (npm run test:db), as admin_app with the fake LinkedIn client:
//   1. the use-case: the happy path to `posted` (ledger, audit, the linkedin_event
//      listing), a failure injected at each step and the state it leaves, Publish-retry,
//      allow-retry, and the plain-language error messages
//   2. over HTTP (astro dev, with LINKEDIN_LIVE=1 in this process only): the create,
//      Publish event and allow-retry forms and what the section shows in each state
// Dates: Tuesdays from 2073, starting at a random week so a rerun on a kept database
// doesn't collide (no other file uses 2073-2075).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { OWNER_URL, connect, unique, useAdminEnv } from "./helpers.mjs";
import { createFakeLinkedInClient, LinkedInError } from "./fake-linkedin.mjs";

const port = await new Promise((resolve, reject) => {
  const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  s.on("error", reject);
});
const BASE = `http://localhost:${port}`;
useAdminEnv();
process.env.BETTER_AUTH_URL = BASE;
process.env.ASTRO_TELEMETRY_DISABLED = "1";
process.env.LINKEDIN_CLIENT_ID = "test-client-id";
process.env.LINKEDIN_CLIENT_SECRET = "test-client-secret-value";
process.env.LINKEDIN_TOKEN_KEY = "7".repeat(64);
process.env.LINKEDIN_LIVE = "1";

const { pool } = await import("../../src/lib/auth/auth.mjs");
const { handleAuthRequest } = await import("../../src/lib/auth/handler.mjs");
const { withAudit } = await import("../../src/lib/admin/db.mjs");
const { createUser, grantRole } = await import("../../src/lib/admin/users.mjs");
const { setLinkedInClientForTests } = await import("../../src/lib/linkedin/client.mjs");
const li = await import("../../src/lib/linkedin/linkedin.mjs");
const { readLinkedInEnv } = await import("../../src/lib/linkedin/env.mjs");
const { signState } = await import("../../src/lib/linkedin/crypto.mjs");

const PASSWORD = "correct horse battery staple";
const { config } = readLinkedInEnv();
assert.equal(config.live, true);
const DRY = { ...config, live: false };
let owner;

let week = randomInt(0, 100);
const nextDate = () => new Date(Date.UTC(2073, 0, 3 + 7 * week++)).toISOString().slice(0, 10); // 2073-01-03 is a Tuesday
const NOW = new Date("2072-12-01T16:00:00Z");

const seedEvent = (date, cols = {}) => owner.query(
  `insert into events (event_date, status, location) values ($1, $2, $3)
   on conflict (event_date) do update set status = excluded.status, location = excluded.location`,
  [date, cols.status ?? "scheduled", cols.location ?? null]);

before(async () => { owner = await connect(OWNER_URL); });
after(async () => { await owner?.end(); await pool.end(); });

const newUser = () => createUser({ email: `${unique("lil")}@example.com`, name: "LinkedIn Live Test", password: PASSWORD });

/** Connect `user` through the real finishConnect with a fake LinkedIn. */
async function connectUser(user, { now = NOW } = {}) {
  const { state, cookie } = signState({ key: config.tokenKey, userId: user.id, returnTo: "account", now });
  const client = createFakeLinkedInClient({ accessToken: `AQV-${user.id}`, profile: { memberUrn: "urn:li:person:member26", name: "Member 26" } });
  const r = await li.finishConnect(user.id, { code: "c", state, cookie }, { config, baseURL: BASE, client, now });
  assert.equal(r.ok, true);
  return user;
}
const connectedUser = async () => connectUser(await newUser());

const ledger = (date) => owner.query(
  `select * from linkedin_events where event_date = $1 order by created_at`, [date]).then((r) => r.rows);
const active = async (date) => (await ledger(date)).filter((r) => r.status !== "retired");
const audits = (date) => owner.query(
  `select actor_user_id, action, target_table, details from audit_log
    where (target_table = 'linkedin_events' and details->>'eventDate' = $1)
       or (target_table = 'event_links' and target_id = $1)
    order by occurred_at, id`, [date]).then((r) => r.rows);
const listing = (date) => owner.query(
  `select url from event_links where event_date = $1 and platform = 'linkedin_event'`, [date]).then((r) => r.rows[0]?.url ?? null);

const EVENT_URL = "https://www.linkedin.com/events/buffaloopencoffeeclubfor10-67249812613549670400/";
const POST_URN = "urn:li:ugcPost:7511865991627468800";
const POST_URL = `https://www.linkedin.com/feed/update/${POST_URN}/`;

// ── 1. The use-case ─────────────────────────────────────────────────────────
describe("live create, recovery and errors (use-case, fake client)", () => {
  const opts = (client, over = {}) => ({ config, client, now: NOW, storage: null, ...over });
  const create = (user, date, client, over) => li.createLinkedInEvent(user.id, date, { confirm: "live" }, opts(client, over));

  test("happy path: pending, upload, create, created, post, posted; the listing is filled; every step audited", async () => {
    const date = nextDate();
    await seedEvent(date, { location: "food_hall" });
    const user = await connectedUser();
    const client = createFakeLinkedInClient();
    const r = await create(user, date, client);
    assert.equal(r.ok, true);
    assert.equal(r.mode, "live");
    assert.equal(r.status, "posted");
    assert.deepEqual(client.ops(), ["listOrganizerEvents", "initializeImageUpload", "uploadImage", "createEvent", "createPost"]);

    const token = `AQV-${user.id}`;
    const [, init, upload, createEv, post] = client.calls;
    assert.deepEqual(init.args, [token, "urn:li:person:member26"]);
    assert.equal(upload.args[1], "https://www.linkedin.com/dms-uploads/fake");
    assert.equal(upload.args[3], "image/png");
    assert.equal(createEv.args[1].backgroundImage, "urn:li:digitalmediaAsset:D55");
    assert.equal(post.args[1].content.reference.id, "urn:li:event:7249812613549670400");
    assert.equal(post.args[1].author, "urn:li:person:member26");

    const [row] = await ledger(date);
    assert.equal(row.status, "posted");
    assert.equal(row.created_by, user.id);
    assert.equal(row.linkedin_event_id, "7249812613549670400");
    assert.equal(row.event_url, EVENT_URL);
    assert.equal(row.post_urn, POST_URN);
    assert.equal(row.post_url, POST_URL);
    assert.equal(row.location, "food_hall");
    assert.equal(row.commentary, post.args[1].commentary);
    assert.equal(row.name, createEv.args[1].name.localized.en_US);
    assert.equal(row.image_source, "default");
    assert.equal(row.image_ref, "/assets/images/brand/bocc-logo-wide-16x9.png");
    assert.equal(row.image_asset_urn, "urn:li:digitalmediaAsset:D55");

    assert.equal(await listing(date), EVENT_URL);
    const a = await audits(date);
    // posted and the listing commit together, so their order isn't part of the contract.
    assert.deepEqual(a.slice(0, 2).map((x) => x.action), ["linkedin_event.pending", "linkedin_event.created"]);
    assert.deepEqual(a.slice(2).map((x) => x.action).sort(), ["event_link.set", "linkedin_event.posted"]);
    assert.ok(a.every((x) => x.actor_user_id === user.id));
    assert.equal(a.find((x) => x.action === "event_link.set").details.platform, "linkedin_event");
    assert.ok(!JSON.stringify(a).includes(token), "no token in an audit row");
  });
});
