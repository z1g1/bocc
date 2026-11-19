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
/** The next Tuesday (2073-01-03 is one) with no events row yet, so reruns on a kept database don't collide. */
async function nextDate() {
  for (;;) {
    const d = new Date(Date.UTC(2073, 0, 3 + 7 * week++)).toISOString().slice(0, 10);
    const { rowCount } = await owner.query(`select 1 from events where event_date = $1`, [d]);
    if (rowCount === 0) return d;
  }
}
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
    const date = await nextDate();
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

  for (const [op, step, status, nothingCreated, ops] of [
    ["initializeImageUpload", "image_init", "pending", true, ["initializeImageUpload"]],
    ["uploadImage", "image_upload", "pending", true, ["initializeImageUpload", "uploadImage"]],
    ["createEvent", "create", "pending", false, ["initializeImageUpload", "uploadImage", "createEvent"]],
    ["createPost", "post", "created", false, ["initializeImageUpload", "uploadImage", "createEvent", "createPost"]],
  ]) {
    test(`a failure at ${step} leaves the row ${status} and offers its recovery`, async () => {
      const date = await nextDate();
      await seedEvent(date);
      const user = await connectedUser();
      const client = createFakeLinkedInClient();
      client.fail(op, new LinkedInError(op === "createEvent" ? "uncertain" : "unknown", `linkedin ${op} failed`));
      const r = await create(user, date, client);
      assert.equal(r.ok, false);
      assert.equal(r.mode, "live");
      assert.equal(r.status, status);
      assert.equal(r.failure.step, step);
      assert.equal(r.failure.nothingCreated, nothingCreated);
      assert.ok(r.failure.message.length > 0);
      assert.deepEqual(client.ops().filter((o) => o !== "listOrganizerEvents"), ops);
      assert.equal(r.preview.ledger.status, status);
      assert.equal(r.preview.action, status === "pending" ? "allow_retry" : "publish_retry");
      const rows = await ledger(date);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, status);
      assert.equal(await listing(date), null);
      const actions = (await audits(date)).map((x) => x.action);
      assert.deepEqual(actions, status === "pending" ? ["linkedin_event.pending"] : ["linkedin_event.pending", "linkedin_event.created"]);
    });
  }

  test("a definite refusal of the create says nothing was created", async () => {
    const date = await nextDate();
    await seedEvent(date);
    const user = await connectedUser();
    const client = createFakeLinkedInClient();
    client.fail("createEvent", new LinkedInError("page_role", "linkedin create_event answered HTTP 403", { status: 403 }));
    const r = await create(user, date, client);
    assert.equal(r.status, "pending");
    assert.equal(r.failure.nothingCreated, true);
    assert.match(r.failure.message, /ADMINISTRATOR or CONTENT_ADMINISTRATOR/);
  });

  test("a second create for the date is refused by the ledger, sending nothing", async () => {
    const date = await nextDate();
    await seedEvent(date);
    const user = await connectedUser();
    const first = createFakeLinkedInClient();
    first.fail("createEvent", new LinkedInError("uncertain", "timed out"));
    await create(user, date, first);
    const second = createFakeLinkedInClient();
    const r = await create(user, date, second);
    assert.deepEqual(r.refusals.map((x) => x.code), ["ledger"]);
    assert.deepEqual(second.calls, []);
  });

  test("the errors map to plain language: reconnect, page role, hidden post, validation shown, unknown", async () => {
    const cases = [
      [new LinkedInError("expired", "401", { status: 401 }), /Reconnect LinkedIn/],
      [new LinkedInError("page_role", "403", { status: 403 }), /ADMINISTRATOR or CONTENT_ADMINISTRATOR/],
      [new LinkedInError("hidden_post", "422", { status: 422 }), /hidden member post/],
      [new LinkedInError("validation", "422", { status: 422, detail: "commentary is too long" }), /invalid.*commentary is too long/],
      [new LinkedInError("unknown", "500", { status: 500 }), /LinkedIn failed/],
      [new Error("socket hang up"), /LinkedIn failed/],
    ];
    for (const [err, message] of cases) {
      const date = await nextDate();
      await seedEvent(date);
      const user = await connectedUser();
      const client = createFakeLinkedInClient();
      client.fail("createPost", err);
      const r = await create(user, date, client);
      assert.equal(r.status, "created");
      assert.match(r.failure.message, message);
    }
  });

  test("Publish-retry only posts, then the row is posted and the listing filled", async () => {
    const date = await nextDate();
    await seedEvent(date);
    const user = await connectedUser();
    const client = createFakeLinkedInClient();
    client.fail("createPost", new LinkedInError("unknown", "500"));
    await create(user, date, client);

    const retry = createFakeLinkedInClient();
    assert.deepEqual((await li.publishRetry(user.id, date, {}, opts(retry))).refusals.map((x) => x.code), ["confirm"]);
    const r = await li.publishRetry(user.id, date, { confirm: "live" }, opts(retry));
    assert.equal(r.ok, true);
    assert.equal(r.status, "posted");
    assert.deepEqual(retry.ops(), ["createPost"]);
    assert.equal(retry.calls[0].args[1].content.reference.id, "urn:li:event:7249812613549670400");
    const [row] = await ledger(date);
    assert.equal(row.status, "posted");
    assert.equal(row.post_url, POST_URL);
    assert.equal(await listing(date), EVENT_URL);
    const a = await audits(date);
    const posted = a.find((x) => x.action === "linkedin_event.posted");
    assert.equal(posted.details.retry, true);
    assert.equal(posted.actor_user_id, user.id);

    // Nothing left to retry: posted, and a pending row, are both refused.
    assert.deepEqual((await li.publishRetry(user.id, date, { confirm: "live" }, opts(retry))).refusals.map((x) => x.code), ["not_created"]);
    assert.deepEqual(retry.ops(), ["createPost"]);
  });

  test("Publish-retry is refused for a pending row and when not created at all", async () => {
    const date = await nextDate();
    await seedEvent(date);
    const user = await connectedUser();
    const client = createFakeLinkedInClient();
    assert.deepEqual((await li.publishRetry(user.id, date, { confirm: "live" }, opts(client))).refusals.map((x) => x.code), ["not_created"]);
    client.fail("createEvent", new LinkedInError("uncertain", "timed out"));
    await create(user, date, client);
    const again = createFakeLinkedInClient();
    assert.deepEqual((await li.publishRetry(user.id, date, { confirm: "live" }, opts(again))).refusals.map((x) => x.code), ["not_created"]);
    assert.deepEqual(again.calls, []);
  });

  test("Publish-retry on a dry run shows the post it would send and sends nothing", async () => {
    const date = await nextDate();
    await seedEvent(date);
    const user = await connectedUser();
    const client = createFakeLinkedInClient();
    client.fail("createPost", new LinkedInError("unknown", "500"));
    await create(user, date, client);
    const dry = createFakeLinkedInClient();
    const r = await li.publishRetry(user.id, date, { confirm: "live" }, opts(dry, { config: DRY }));
    assert.equal(r.ok, true);
    assert.equal(r.mode, "dry_run");
    assert.deepEqual(r.requests.map((q) => q.op), ["createPost"]);
    assert.deepEqual(dry.calls, []);
    assert.equal((await ledger(date))[0].status, "created");
  });

  test("allow-retry retires only a pending row, audited, and frees the date for a new create", async () => {
    const date = await nextDate();
    await seedEvent(date);
    const user = await connectedUser();
    assert.deepEqual((await li.allowRetry(user.id, date, { now: NOW })).refusals.map((x) => x.code), ["not_pending"]);

    const client = createFakeLinkedInClient();
    client.fail("initializeImageUpload", new LinkedInError("expired", "401", { status: 401 }));
    await create(user, date, client);
    const other = await newUser();
    assert.deepEqual(await li.allowRetry(other.id, date, { now: NOW }), { ok: true });
    const [row] = await ledger(date);
    assert.equal(row.status, "retired");
    assert.equal(row.retired_by, other.id);
    const retire = (await audits(date)).find((x) => x.action === "linkedin_event.retire");
    assert.equal(retire.actor_user_id, other.id);
    assert.equal(retire.details.eventDate, date);

    const r = await create(user, date, createFakeLinkedInClient());
    assert.equal(r.ok, true);
    assert.deepEqual((await ledger(date)).map((x) => x.status), ["retired", "posted"]);
    // A created or posted row can't be retired.
    assert.deepEqual((await li.allowRetry(user.id, date, { now: NOW })).refusals.map((x) => x.code), ["not_pending"]);
  });

  test("a dry run still writes nothing, with LINKEDIN_LIVE unset", async () => {
    const date = await nextDate();
    await seedEvent(date);
    const user = await connectedUser();
    const client = createFakeLinkedInClient();
    const r = await create(user, date, client, { config: DRY });
    assert.equal(r.ok, true);
    assert.equal(r.mode, "dry_run");
    assert.deepEqual(client.ops(), ["listOrganizerEvents"]);
    assert.deepEqual(await ledger(date), []);
    assert.deepEqual(await audits(date), []);
  });
});
