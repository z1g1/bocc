// The LinkedIn event ledger, preview and dry run (ADR 0012, issue #25) against the
// throwaway database (npm run test:db):
//   1. migration 20261127120000_linkedin_events.sql: grants (admin_app SELECT/INSERT/
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
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { ADMIN_URL, CHECKIN_URL, OWNER_URL, assertAllowed, assertRefused, connect, inRollback, unique, useAdminEnv } from "./helpers.mjs";
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
process.env.LINKEDIN_TOKEN_KEY = "6".repeat(64);
delete process.env.LINKEDIN_LIVE;

const { pool } = await import("../../src/lib/auth/auth.mjs");
const { handleAuthRequest } = await import("../../src/lib/auth/handler.mjs");
const { withAudit } = await import("../../src/lib/admin/db.mjs");
const { createUser, grantRole } = await import("../../src/lib/admin/users.mjs");
const { setLinkedInClientForTests } = await import("../../src/lib/linkedin/client.mjs");
const li = await import("../../src/lib/linkedin/linkedin.mjs");
const rules = await import("../../src/lib/linkedin/rules.mjs");
const { readLinkedInEnv } = await import("../../src/lib/linkedin/env.mjs");
const { signState } = await import("../../src/lib/linkedin/crypto.mjs");

const SITE_URL = process.env.TEST_SITE_URL;
const SOCIAL_CHECK_URL = process.env.TEST_SOCIAL_CHECK_URL;
const PASSWORD = "correct horse battery staple";
const { config } = readLinkedInEnv();
const LIVE = { ...config, live: true };
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
after(async () => { await owner?.end(); await pool.end(); });

const NOW = new Date("2087-06-01T16:00:00Z"); // the Sunday before 2087-06-03 (a Tuesday)
const newUser = () => createUser({ email: `${unique("lie")}@example.com`, name: "LinkedIn Event Test", password: PASSWORD });

/** A user connected through the real finishConnect, with a fake LinkedIn. */
async function connectedUser({ expiresIn = 60 * 86400, now = NOW } = {}) {
  const user = await newUser();
  const { state, cookie } = signState({ key: config.tokenKey, userId: user.id, returnTo: "account", now });
  const client = createFakeLinkedInClient({ accessToken: `AQV-${user.id}`, expiresIn, profile: { memberUrn: "urn:li:person:member9", name: "M" } });
  const r = await li.finishConnect(user.id, { code: "c", state, cookie }, { config, baseURL: BASE, client, now });
  assert.equal(r.ok, true);
  return user;
}
const ledgerRows = (date) => owner.query(`select * from linkedin_events where event_date = $1`, [date]).then((r) => r.rows);
const ledgerAudits = (date) => owner.query(
  `select action from audit_log where target_table = 'linkedin_events' and details->>'eventDate' = $1`, [date]).then((r) => r.rows);

// ── 1. Migration ────────────────────────────────────────────────────────────
describe("migration 20261127120000_linkedin_events.sql", () => {
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

// ── 2. The use-case ─────────────────────────────────────────────────────────
describe("preview and dry run (use-case, fake client)", () => {
  const opts = (client, over = {}) => ({ config, client, now: NOW, storage: null, ...over });
  const codes = (r) => r.refusals.map((x) => x.code);

  test("preview: what would be sent for an upcoming lobby event, before connecting", async () => {
    const date = "2087-06-17";
    await seedEvent(date, { location: "lobby" });
    const user = await newUser();
    const p = await li.linkedInEventPreview(pool, user.id, date, opts(createFakeLinkedInClient()));
    assert.equal(p.mode, "dry_run");
    assert.equal(p.action, "create");
    assert.deepEqual(p.refusals, []);
    assert.equal(p.ledger, null);
    assert.equal(p.connection, null);
    assert.equal(p.spec.name, "Buffalo Open Coffee Club for June 17th");
    assert.equal(p.spec.commentary, "Please join me at Buffalo Open Coffee Club");
    assert.equal(p.image.source, "default");
    assert.equal(p.payloads.event.discoveryMode, "LISTED");
    assert.equal(p.payloads.event.backgroundImage, li.PLACEHOLDERS.asset);
    assert.equal(p.payloads.post.author, li.PLACEHOLDERS.member);
    assert.equal(p.payloads.post.content.reference.id, `urn:li:event:${li.PLACEHOLDERS.eventId}`);
  });

  test("preview: location other has no payload and says why", async () => {
    const date = "2087-06-24";
    await owner.query(`insert into events (event_date, location, location_other) values ($1, 'other', 'Rooftop')
                       on conflict (event_date) do nothing`, [date]);
    const p = await li.linkedInEventPreview(pool, (await newUser()).id, date, opts(createFakeLinkedInClient()));
    assert.deepEqual(codes(p), ["location_other"]);
    assert.equal(p.spec, null);
    assert.equal(p.payloads, null);
  });

  test("create refuses a request without confirm=live, and sends and writes nothing", async () => {
    const date = "2087-07-01";
    await seedEvent(date);
    const user = await connectedUser();
    const client = createFakeLinkedInClient();
    for (const confirm of [undefined, "", "yes"]) {
      const r = await li.createLinkedInEvent(user.id, date, { confirm }, opts(client));
      assert.equal(r.ok, false);
      assert.deepEqual(codes(r), ["confirm"]);
    }
    assert.deepEqual(client.calls, []);
    assert.deepEqual(await ledgerRows(date), []);
  });

  test("dry run, not connected: the payloads that would be sent, nothing sent, no ledger row", async () => {
    const date = "2087-07-08";
    await seedEvent(date, { location: "food_hall" });
    const user = await newUser();
    const client = createFakeLinkedInClient();
    const r = await li.createLinkedInEvent(user.id, date, { confirm: "live" }, opts(client));
    assert.equal(r.ok, true);
    assert.equal(r.mode, "dry_run");
    assert.equal(r.duplicateCheck, "skipped");
    assert.deepEqual(client.calls, []);
    assert.deepEqual(r.requests.map((q) => [q.op, q.method, q.url]), [
      ["initializeImageUpload", "POST", "https://api.linkedin.com/rest/images?action=initializeUpload"],
      ["uploadImage", "PUT", "<the uploadUrl LinkedIn returns>"],
      ["createEvent", "POST", "https://api.linkedin.com/rest/events"],
      ["createPost", "POST", "https://api.linkedin.com/rest/posts"],
    ]);
    const [init, upload, create, post] = r.requests;
    assert.deepEqual(init.body, { initializeUploadRequest: { owner: li.PLACEHOLDERS.member } });
    assert.match(upload.body, /^\d+ bytes of image\/png \(1920×1080\)$/);
    assert.equal(create.body.description.localized.en_US.rawText.includes("Food hall"), true);
    assert.equal(post.body.commentary, create.body.description.localized.en_US.rawText);
    assert.deepEqual(r.image.errors, []);
    // The preview matches what the run would send.
    const p = await li.linkedInEventPreview(pool, user.id, date, opts(client));
    assert.deepEqual(p.payloads.event, create.body);
    assert.deepEqual(p.payloads.post, post.body);
    assert.deepEqual(p.payloads.imageUpload, init.body);
    assert.deepEqual(await ledgerRows(date), []);
    assert.deepEqual(await ledgerAudits(date), []);
  });

  test("dry run, connected: the read-only organizer listing runs; no write is sent", async () => {
    const date = "2087-07-15";
    await seedEvent(date, { location: "lobby" });
    const user = await connectedUser();
    const client = createFakeLinkedInClient({ events: [] });
    const r = await li.createLinkedInEvent(user.id, date, { confirm: "live" }, opts(client));
    assert.equal(r.ok, true);
    assert.equal(r.duplicateCheck, "passed");
    assert.deepEqual(client.ops(), ["listOrganizerEvents"]);
    assert.deepEqual(client.calls[0].args, [`AQV-${user.id}`, "urn:li:organization:89993057"]);
    assert.equal(r.requests[0].body.initializeUploadRequest.owner, "urn:li:person:member9");
    assert.equal(r.requests[3].body.author, "urn:li:person:member9");
    assert.deepEqual(await ledgerRows(date), []);
  });

  test("the duplicate check refuses the same name (either style) or the same Eastern day", async () => {
    const date = "2087-07-22";
    await seedEvent(date, { location: "lobby" });
    const user = await connectedUser();
    const li7 = (name, startsAt) => ({ id: "7249812613549670401", name: { localized: { en_US: name } }, startsAt });
    const otherDay = Date.parse("2087-07-29T11:30:00Z");
    for (const events of [
      [li7("Buffalo Open Coffee Club for July 22nd", otherDay)],
      [li7("Buffalo Open Coffee Club for 7/22", otherDay)],
      [li7("Made by hand", Date.parse("2087-07-23T02:00:00Z"))], // 22:00 EDT on the 22nd
    ]) {
      const client = createFakeLinkedInClient({ events });
      const r = await li.createLinkedInEvent(user.id, date, { confirm: "live" }, opts(client));
      assert.equal(r.ok, false);
      assert.deepEqual(codes(r), ["duplicate"]);
      assert.deepEqual(r.duplicates.map((d) => d.id), ["7249812613549670401"]);
      assert.deepEqual(client.ops(), ["listOrganizerEvents"]);
    }
    const fine = createFakeLinkedInClient({ events: [li7("Buffalo Open Coffee Club for 7/29", otherDay)] });
    assert.equal((await li.createLinkedInEvent(user.id, date, { confirm: "live" }, opts(fine))).ok, true);
    assert.deepEqual(await ledgerRows(date), []);
  });

  test("a failed organizer listing refuses with LinkedIn's plain-language message", async () => {
    const date = "2087-07-29";
    await seedEvent(date);
    const user = await connectedUser();
    const client = createFakeLinkedInClient();
    client.fail("listOrganizerEvents", new LinkedInError("expired", "linkedin list_organizer_events answered HTTP 401", { status: 401 }));
    const r = await li.createLinkedInEvent(user.id, date, { confirm: "live" }, opts(client));
    assert.equal(r.ok, false);
    assert.deepEqual(codes(r), ["linkedin"]);
    assert.match(r.refusals[0].message, /Reconnect LinkedIn/);
  });

  test("the server enforces the matrix: past, cancelled, other and an existing ledger row", async () => {
    const user = await connectedUser();
    const client = createFakeLinkedInClient();
    const past = "2087-05-27";
    await seedEvent(past);
    assert.deepEqual(codes(await li.createLinkedInEvent(user.id, past, { confirm: "live" }, opts(client))), ["past"]);

    const cancelled = "2087-08-05";
    await owner.query(`insert into events (event_date, status, cancel_reason) values ($1, 'cancelled', 'weather')
                       on conflict (event_date) do nothing`, [cancelled]);
    assert.deepEqual(codes(await li.createLinkedInEvent(user.id, cancelled, { confirm: "live" }, opts(client))), ["cancelled"]);

    const other = "2087-06-24"; // location other, seeded above
    assert.deepEqual(codes(await li.createLinkedInEvent(user.id, other, { confirm: "live" }, opts(client))), ["location_other"]);

    const taken = "2087-08-12";
    await seedEvent(taken);
    await owner.query(`${PENDING} on conflict (event_date) where status <> 'retired' do nothing`, [taken]);
    const r = await li.createLinkedInEvent(user.id, taken, { confirm: "live" }, opts(client));
    assert.deepEqual(codes(r), ["ledger"]);
    assert.equal(r.preview.action, "allow_retry");
    assert.deepEqual(client.calls, []);
    assert.equal((await ledgerRows(taken)).length, 1);
  });

  test("live: no connection or an expired one is refused; with one, the live sequence is not wired yet (#26)", async () => {
    const date = "2087-08-19";
    await seedEvent(date);
    const client = createFakeLinkedInClient();
    assert.deepEqual(codes(await li.createLinkedInEvent((await newUser()).id, date, { confirm: "live" }, opts(client, { config: LIVE }))), ["no_connection"]);

    const stale = await connectedUser({ expiresIn: 86400, now: new Date(NOW.getTime() - 3 * 86400_000) });
    assert.deepEqual(codes(await li.createLinkedInEvent(stale.id, date, { confirm: "live" }, opts(client, { config: LIVE }))), ["expired"]);

    const user = await connectedUser();
    const r = await li.createLinkedInEvent(user.id, date, { confirm: "live" }, opts(client, { config: LIVE }));
    assert.equal(r.ok, false);
    assert.deepEqual(codes(r), ["live_unavailable"]);
    assert.deepEqual(client.ops(), ["listOrganizerEvents"]);
    assert.deepEqual(await ledgerRows(date), []);
  });
});

// ── 3. Over HTTP ────────────────────────────────────────────────────────────
let ipCounter = 0;
const nextIp = () => `198.25.${Math.floor(++ipCounter / 250)}.${ipCounter % 250 + 1}`;
async function signedIn(roles) {
  const user = await newUser();
  for (const r of roles) await withAudit(null, (c) => grantRole(c, user.id, r), { action: "test.grant" });
  const res = await handleAuthRequest(new Request(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, "x-nf-client-connection-ip": nextIp() },
    body: JSON.stringify({ email: user.email, password: PASSWORD }),
  }));
  assert.equal(res.status, 200);
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).filter((c) => !c.endsWith("=")).join("; ");
  return { user, cookie };
}

describe("the LinkedIn event section and its create form over HTTP", { timeout: 300_000 }, () => {
  let server, admin, social, fake;
  const root = fileURLToPath(new URL("../../", import.meta.url));

  before(async () => {
    const { dev } = await import("astro");
    server = await dev({ root, logLevel: "error", server: { port, host: "localhost" } });
    admin = await signedIn(["admin"]);
    social = await signedIn(["social"]);
    fake = createFakeLinkedInClient();
    setLinkedInClientForTests(fake);
  });
  after(async () => { setLinkedInClientForTests(undefined); await server?.stop(); });

  const req = (path, { cookie, method = "GET", form, origin = BASE } = {}) => {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    let body;
    if (method === "POST") {
      if (origin) headers.origin = origin;
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(form ?? {}).toString();
    }
    return fetch(`${BASE}${path}`, { method, headers, body, redirect: "manual" });
  };
  const page = (date) => `/admin/events/${date}/?tab=social`;
  const create = (date, who, form = {}, opts = {}) =>
    req(`/admin/events/${date}/`, { cookie: who.cookie, method: "POST", form: { action: "linkedin_create", ...form }, ...opts });
  const writes = () => fake.ops().filter((op) => op !== "listOrganizerEvents");

  test("the Social Posts tab shows the full preview and the confirmation dialog", async () => {
    const date = "2087-09-02";
    await seedEvent(date, { location: "lobby" });
    const res = await req(page(date), { cookie: admin.cookie });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    const html = await res.text();
    for (const text of [
      "Buffalo Open Coffee Club for September 2nd", "Join us on September 2nd for Buffalo Open Coffee Club",
      "BOCC is right in the lobby, please come up the escalators", "Please join me at Buffalo Open Coffee Club",
      "1 Seneca St", "Buffalo, New York 14203", "https://luma.com/716coffeeclub", "LISTED",
      "7:30", "9:00", "/assets/images/brand/bocc-logo-wide-16x9.png", "Dry run: nothing will be sent",
      "REAL public LinkedIn event", "PUBLIC post from your profile", "&quot;discoveryMode&quot;",
    ]) assert.ok(html.includes(text), `page shows ${text}`);
    assert.match(html, /<dialog[^>]*id="linkedin-confirm"/);
    assert.match(html, /<input type="hidden" name="confirm" value="live"/);
    assert.match(html, /<script[^>]*src="\/js\/admin-linkedin\.js"/);
  });

  test("a create without confirm=live is refused (409), shows the confirmation inline, sends nothing", async () => {
    const date = "2087-09-09";
    await seedEvent(date, { location: "lobby" });
    const res = await create(date, admin);
    assert.equal(res.status, 409);
    const html = await res.text();
    assert.ok(html.includes(rules.REFUSALS.confirm));
    assert.match(html, /<dialog[^>]*id="linkedin-confirm"[^>]*open/);
    assert.deepEqual(writes(), []);
    assert.deepEqual(await ledgerRows(date), []);
  });

  test("confirm=live on a dry run shows the payloads that would have been sent, and writes no ledger row", async () => {
    const date = "2087-09-16";
    await seedEvent(date, { location: "food_hall" });
    const res = await create(date, admin, { confirm: "live" });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("Dry run: nothing was sent"));
    for (const url of ["https://api.linkedin.com/rest/images?action=initializeUpload", "https://api.linkedin.com/rest/events", "https://api.linkedin.com/rest/posts"]) {
      assert.ok(html.includes(url), url);
    }
    assert.ok(html.includes("This week BOCC is in the Seneca One Food hall, not the lobby"));
    assert.deepEqual(writes(), []);
    assert.deepEqual(await ledgerRows(date), []);
  });

  test("the server refuses what the matrix refuses, whatever the form says", async () => {
    const date = "2087-09-23";
    await owner.query(`insert into events (event_date, status, cancel_reason) values ($1, 'cancelled', 'weather')
                       on conflict (event_date) do nothing`, [date]);
    const res = await create(date, admin, { confirm: "live" });
    assert.equal(res.status, 409);
    assert.ok((await res.text()).includes("This event is cancelled"));
    assert.deepEqual(await ledgerRows(date), []);
  });

  test("connected: the organizer duplicate check refuses a match", async () => {
    const date = "2087-09-30";
    await seedEvent(date, { location: "lobby" });
    const who = await signedIn(["admin"]);
    const { state, cookie } = signState({ key: config.tokenKey, userId: who.user.id, returnTo: "account", now: new Date() });
    await li.finishConnect(who.user.id, { code: "c", state, cookie }, { config, baseURL: BASE, client: createFakeLinkedInClient() });
    fake.state.events = [{ id: "7249812613549670402", name: { localized: { en_US: "Buffalo Open Coffee Club for 9/30" } }, startsAt: 1 }];
    try {
      const res = await create(date, who, { confirm: "live" });
      assert.equal(res.status, 409);
      const html = await res.text();
      assert.ok(html.includes(rules.REFUSALS.duplicate));
      assert.ok(html.includes("Buffalo Open Coffee Club for 9/30"));
    } finally {
      fake.state.events = [];
    }
    assert.deepEqual(writes(), []);
  });

  test("role fences and the Origin check", async () => {
    const date = "2087-10-07";
    await seedEvent(date, { location: "lobby" });
    assert.equal((await req(page(date), { cookie: social.cookie })).status, 403);
    assert.equal((await create(date, social, { confirm: "live" })).status, 403);
    assert.equal((await create(date, admin, { confirm: "live" }, { origin: "https://evil.example" })).status, 403);
    const anon = await req(`/admin/events/${date}/`, { method: "POST", form: { action: "linkedin_create", confirm: "live" } });
    assert.ok([302, 303].includes(anon.status));
    assert.deepEqual(writes(), []);
  });
});
