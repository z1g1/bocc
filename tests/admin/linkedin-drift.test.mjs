// LinkedIn drift and cancellation flags (ADR 0012, issue #27) against the throwaway
// database (npm run test:db), as admin_app, with a posted ledger row created through
// the live use-case and the fake LinkedIn client:
//   1. the use-case: linkedInFollowUpFor (drift on a location or Event Image change, the
//      cancel item) and markCancelledOnLinkedIn ("Done on LinkedIn", audited)
//   2. over HTTP (astro dev): the drift notice, the red item in Cancel and Readiness,
//      and the "Done on LinkedIn" form (Origin, role, 303, refusals)
// Dates: Tuesdays from 2078, starting at a random week so a rerun on a kept database
// doesn't collide (no other file uses 2078-2079).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { OWNER_URL, connect, unique, useAdminEnv } from "./helpers.mjs";
import { createFakeLinkedInClient } from "./fake-linkedin.mjs";

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
const ev = await import("../../src/lib/admin/events.mjs");
const li = await import("../../src/lib/linkedin/linkedin.mjs");
const { readLinkedInEnv } = await import("../../src/lib/linkedin/env.mjs");
const { signState } = await import("../../src/lib/linkedin/crypto.mjs");

const PASSWORD = "correct horse battery staple";
const { config } = readLinkedInEnv();
const NOW = new Date("2077-12-01T16:00:00Z");
const EVENT_URL = "https://www.linkedin.com/events/buffaloopencoffeeclubfor10-67249812613549670400/";
let owner;

let week = randomInt(0, 90);
async function nextDate() {
  for (;;) {
    const d = new Date(Date.UTC(2078, 0, 4 + 7 * week++)).toISOString().slice(0, 10);
    const { rowCount } = await owner.query(`select 1 from events where event_date = $1`, [d]);
    if (rowCount === 0) return d;
  }
}

before(async () => { owner = await connect(OWNER_URL); });
after(async () => { await owner?.end(); await pool.end(); });

const newUser = () => createUser({ email: `${unique("lid")}@example.com`, name: "LinkedIn Drift Test", password: PASSWORD });
async function connectUser(user, { now = NOW } = {}) {
  const { state, cookie } = signState({ key: config.tokenKey, userId: user.id, returnTo: "account", now });
  const client = createFakeLinkedInClient({ accessToken: `AQV-${user.id}`, profile: { memberUrn: "urn:li:person:member27", name: "Member 27" } });
  const r = await li.finishConnect(user.id, { code: "c", state, cookie }, { config, baseURL: BASE, client, now });
  assert.equal(r.ok, true);
  return user;
}

/** A date with a posted ledger row, created through the live use-case with the fake client. */
async function postedDate(user, { location = "lobby" } = {}) {
  const date = await nextDate();
  await owner.query(`insert into events (event_date, status, location) values ($1, 'scheduled', $2)`, [date, location]);
  const r = await li.createLinkedInEvent(user.id, date, { confirm: "live" }, { config, client: createFakeLinkedInClient(), now: NOW, storage: null });
  assert.equal(r.status, "posted");
  return date;
}
/** An uploaded Event Image for the date, seeded as owner (media upload refuses far-future dates). */
async function seedEventImage(date) {
  const id = randomUUID();
  await owner.query(
    `insert into event_media (event_date, kind, original_key, display_key, thumb_key, cover_key, content_type, size_bytes, status)
     values ($1, 'event_image', $2, $3, $4, $5, 'image/png', 10, 'ready')`,
    [date, ...["original.png", "display.jpg", "thumb.jpg", "cover.jpg"].map((f) => `events/${date}/${id}/${f}`)]);
}
const cancel = (user, date) => ev.saveEvent(user.id, date, { status: "cancelled", cancelReason: "weather" });
const ackAudits = (date) => owner.query(
  `select actor_user_id, target_id, details from audit_log
    where action = 'linkedin_event.cancel_ack' and details->>'eventDate' = $1`, [date]).then((r) => r.rows);
const row = (date) => owner.query(
  `select id, cancelled_on_linkedin_at, cancelled_on_linkedin_by from linkedin_events where event_date = $1 and status <> 'retired'`, [date]).then((r) => r.rows[0]);

// ── 1. The use-case ─────────────────────────────────────────────────────────
describe("drift and cancellation (use-case, admin_app, fake client)", () => {
  let user;
  before(async () => { user = await connectUser(await newUser()); });

  test("posted and unchanged: no flags, the event link", async () => {
    const date = await postedDate(user);
    const f = await li.linkedInFollowUpFor(pool, date);
    assert.deepEqual(f, { eventUrl: EVENT_URL, drift: null, cancel: null });
  });

  test("the location changed after posting: drift, linking the event", async () => {
    const date = await postedDate(user);
    await ev.saveEvent(user.id, date, { status: "scheduled", location: "food_hall" });
    const f = await li.linkedInFollowUpFor(pool, date);
    assert.deepEqual(f.drift.changes, ["location"]);
    assert.equal(f.drift.href, EVENT_URL);
  });

  test("the Event Image changed after posting: drift", async () => {
    const date = await postedDate(user);
    await seedEventImage(date);
    assert.deepEqual((await li.linkedInFollowUpFor(pool, date)).drift.changes, ["image"]);
  });

  test("never posted: no flags, even cancelled with a changed location", async () => {
    const date = await nextDate();
    await owner.query(`insert into events (event_date, status, location, cancel_reason) values ($1, 'cancelled', 'food_hall', 'weather')`, [date]);
    assert.deepEqual(await li.linkedInFollowUpFor(pool, date), { eventUrl: null, drift: null, cancel: null });
    await assert.rejects(li.markCancelledOnLinkedIn(user.id, date, { now: NOW }), (e) => e instanceof ev.ConflictError && /posted/.test(e.errors.linkedin));
  });

  test("cancelled: the item is due until Done on LinkedIn, which is audited and clears it", async () => {
    const date = await postedDate(user);
    await assert.rejects(li.markCancelledOnLinkedIn(user.id, date, { now: NOW }), (e) => e instanceof ev.ConflictError && /cancelled/.test(e.errors.linkedin));
    await cancel(user, date);
    const due = await li.linkedInFollowUpFor(pool, date);
    assert.equal(due.cancel.due, true);
    assert.equal(due.cancel.href, EVENT_URL);

    const other = await newUser();
    assert.deepEqual(await li.markCancelledOnLinkedIn(other.id, date, { now: NOW }), { changed: true });
    const r = await row(date);
    assert.equal(r.cancelled_on_linkedin_by, other.id);
    assert.equal(r.cancelled_on_linkedin_at.toISOString(), NOW.toISOString());
    const [a, ...rest] = await ackAudits(date);
    assert.equal(rest.length, 0);
    assert.equal(a.actor_user_id, other.id);
    assert.equal(a.target_id, r.id);

    const done = await li.linkedInFollowUpFor(pool, date);
    assert.equal(done.cancel.due, false);
    // Ticking it again changes nothing and writes no second audit row.
    assert.deepEqual(await li.markCancelledOnLinkedIn(user.id, date, { now: NOW }), { changed: false });
    assert.equal((await ackAudits(date)).length, 1);
  });
});

// ── 2. Over HTTP ────────────────────────────────────────────────────────────
let ipCounter = 0;
const nextIp = () => `198.27.${Math.floor(++ipCounter / 250)}.${ipCounter % 250 + 1}`;
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

describe("drift notice, cancel item and Done on LinkedIn over HTTP", { timeout: 300_000 }, () => {
  let server, admin, social, poster;
  const root = fileURLToPath(new URL("../../", import.meta.url));

  before(async () => {
    const { dev } = await import("astro");
    server = await dev({ root, logLevel: "error", server: { port, host: "localhost" } });
    admin = await signedIn(["admin"]);
    social = await signedIn(["social"]);
    poster = await connectUser(await newUser());
  });
  after(async () => { await server?.stop(); });

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
  const page = (date, tab) => req(`/admin/events/${date}/?tab=${tab}`, { cookie: admin.cookie }).then((r) => r.text());
  const done = (date, who = admin, opts = {}) =>
    req(`/admin/events/${date}/`, { cookie: who.cookie, method: "POST", form: { action: "linkedin_cancel_done" }, ...opts });
  const readinessOf = (html) => html.slice(html.indexOf('id="h-ready"'), html.indexOf('aria-label="Event page tabs"'));
  const cancelOf = (html) => html.slice(html.indexOf('id="linkedin-cancel"'));

  test("unchanged: no drift notice or LinkedIn items; changed: the notice in Readiness and the LinkedIn section", async () => {
    const date = await postedDate(poster);
    for (const tab of ["info", "social"]) assert.doesNotMatch(await page(date, tab), /LinkedIn is out of date/);
    await ev.saveEvent(admin.user.id, date, { status: "scheduled", location: "food_hall" });
    const info = await page(date, "info");
    assert.match(readinessOf(info), /LinkedIn is out of date/);
    assert.ok(readinessOf(info).includes('href="?tab=info#h-linkedin"'), "readiness points at the LinkedIn section on Event Info");
    assert.ok(info.includes('id="h-linkedin"'), "the LinkedIn section is on Event Info");
    const section = info.slice(info.indexOf('id="h-linkedin"'));
    assert.match(section, /LinkedIn is out of date: the location changed/);
    const social = await page(date, "social");
    assert.ok(!social.includes('id="h-linkedin"'), "the LinkedIn section is not on Social Posts");
    assert.doesNotMatch(social, /class="linkedin-drift"/, "nor its notice");
    assert.ok(section.includes(`href="${EVENT_URL}"`), "the notice links the event");
  });

  test("never posted and cancelled: no LinkedIn items in Cancel or Readiness", async () => {
    const date = await nextDate();
    await owner.query(`insert into events (event_date, status, location, cancel_reason) values ($1, 'cancelled', 'lobby', 'weather')`, [date]);
    const html = await page(date, "info");
    assert.doesNotMatch(html, /Cancel the LinkedIn event on LinkedIn/);
    assert.doesNotMatch(html, /name="action" value="linkedin_cancel_done"/);
    const res = await done(date);
    assert.equal(res.status, 409);
  });

  test("cancelled after posting: red item in Cancel and Readiness; Done on LinkedIn clears it (303, audited)", async () => {
    const date = await postedDate(poster);
    await cancel(admin.user, date);
    const html = await page(date, "info");
    assert.match(readinessOf(html), /Cancel the LinkedIn event on LinkedIn/);
    const c = cancelOf(html);
    assert.match(c, /class="[^"]*linkedin-cancel[^"]*"[^>]*>[\s\S]*Cancel the LinkedIn event on LinkedIn/);
    assert.ok(c.includes(`href="${EVENT_URL}"`), "links the event");
    assert.match(c, /name="action" value="linkedin_cancel_done"/);
    assert.match(c, /Done on LinkedIn/);

    // Origin and role fences.
    assert.equal((await done(date, admin, { origin: "https://evil.example" })).status, 403);
    assert.equal((await done(date, social)).status, 403);
    assert.equal((await row(date)).cancelled_on_linkedin_at, null);

    const res = await done(date);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), `/admin/events/${date}/?tab=info&notice=linkedin_cancel_done#linkedin-cancel`);
    assert.equal((await row(date)).cancelled_on_linkedin_by, admin.user.id);
    assert.equal((await ackAudits(date)).length, 1);

    const after = await page(date, "info");
    assert.doesNotMatch(readinessOf(after), /Cancel the LinkedIn event on LinkedIn/);
    assert.doesNotMatch(after, /name="action" value="linkedin_cancel_done"/);
    assert.match(cancelOf(after), /Done on LinkedIn/i);

    // Again: nothing changed.
    const again = await done(date);
    assert.equal(again.status, 303);
    assert.match(again.headers.get("location"), /notice=unchanged/);
  });
});
