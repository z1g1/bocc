// Phase 3 admin events (ADR 0009): /admin/events/, /admin/events/YYYY-MM-DD/ and the
// dashboard block, against the throwaway database (npm run test:db):
//   1. src/lib/admin/events.mjs as admin_app: first save creates the event, cancel and
//      un-cancel within the CHECK constraints, a report moves the event to held with an
//      audit row, validation, refused states, "report missing" in Eastern time, and the
//      check-in count leaving out test rows
//   2. the routes over HTTP through a real `astro dev` server: roles, Origin, methods,
//      post/redirect/get and the validation messages
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { OWNER_URL, connect, unique, useAdminEnv } from "./helpers.mjs";

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
const ev = await import("../../src/lib/admin/events.mjs");
const { ValidationError, ConflictError } = ev;

const PASSWORD = "correct horse battery staple";
let owner, actor;

// Past dates in 2001, one per call, far from every other test file's dates.
let n = 0;
const pastDate = () => new Date(Date.UTC(2001, 0, 2 + n++)).toISOString().slice(0, 10);
const TODAY = "2026-11-17";

const eventRow = (date) => owner.query(
  `select status, location, location_other, cancel_reason, cancel_reason_other, cancel_announced
     from events where event_date = $1`, [date]).then((r) => r.rows[0] ?? null);
const reportRow = (date) => owner.query(
  `select gives_asks_count, notes, bling_given, bling_details, source, submitted_by
     from event_reports where event_date = $1`, [date]).then((r) => r.rows[0] ?? null);
const auditRows = (date) => owner.query(
  `select actor_user_id, action, target_table, details from audit_log where target_id = $1 order by id`, [date]).then((r) => r.rows);

async function attendee({ debug = false } = {}) {
  const { rows: [a] } = await owner.query(
    `insert into attendees (email, name, ok_to_email, debug) values ($1, 'Event Test', false, $2) returning id`,
    [`${unique("ev")}@example.com`, debug]);
  return a.id;
}
const checkin = (attendeeId, day, debug = false) => owner.query(
  `insert into checkins (attendee_id, event_id, token, checkin_at, checkin_date, debug)
   values ($1, 'bocc', 'tok', ($2::date + time '12:30') at time zone 'UTC', $2::date, $3)`, [attendeeId, day, debug]);

const REPORT = { givesAsksCount: "31", blingGiven: "no", notes: "  Good turnout.\r\nNew faces.  ", blingDetails: "" };

let ipCounter = 0;
const nextIp = () => `198.20.${Math.floor(++ipCounter / 250)}.${ipCounter % 250 + 1}`;
async function signedIn(roles) {
  const user = await createUser({ email: `${unique("evu")}@example.com`, name: "Events User", password: PASSWORD });
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

before(async () => {
  owner = await connect(OWNER_URL);
  actor = await createUser({ email: `${unique("actor")}@example.com`, name: "Report Writer", password: PASSWORD });
});
after(async () => { await owner?.end(); await pool.end(); });

// ── 1. Data module ──────────────────────────────────────────────────────────
describe("events module", () => {
  test("a date with no row reads as a new scheduled event; the first save creates it, audited", async () => {
    const d = pastDate();
    const fresh = await ev.getEvent(pool, d);
    assert.deepEqual([fresh.exists, fresh.status, fresh.report, fresh.checkinCount], [false, "scheduled", null, 0]);
    assert.equal(await eventRow(d), null);

    assert.deepEqual(await ev.saveEvent(actor.id, d, { status: "scheduled", location: "" }), { changed: true });
    assert.equal((await eventRow(d)).status, "scheduled");
    assert.deepEqual(await auditRows(d), [{
      actor_user_id: actor.id, action: "event.update", target_table: "events",
      details: { created: true, before: {}, after: {} },
    }]);
    // The same values again: nothing written.
    assert.deepEqual(await ev.saveEvent(actor.id, d, { status: "scheduled", location: "" }), { changed: false });
    assert.equal((await auditRows(d)).length, 1);
  });

  test("location: other needs text, which is cleared again when the location changes", async () => {
    const d = pastDate();
    await assert.rejects(ev.saveEvent(actor.id, d, { location: "other", locationOther: "   " }),
      (e) => e instanceof ValidationError && "locationOther" in e.errors);
    await assert.rejects(ev.saveEvent(actor.id, d, { location: "basement" }), (e) => "location" in e.errors);
    await assert.rejects(ev.saveEvent(actor.id, d, { status: "cancelled" }), (e) => "status" in e.errors);
    assert.equal(await eventRow(d), null, "nothing created by refused saves");

    await ev.saveEvent(actor.id, d, { location: "other", locationOther: "  Rooftop   patio " });
    assert.deepEqual(await eventRow(d), {
      status: "scheduled", location: "other", location_other: "Rooftop patio",
      cancel_reason: null, cancel_reason_other: null, cancel_announced: false,
    });
    await ev.saveEvent(actor.id, d, { location: "food_hall", locationOther: "ignored" });
    const row = await eventRow(d);
    assert.deepEqual([row.location, row.location_other], ["food_hall", null]);
    const [, second] = await auditRows(d);
    assert.deepEqual(second.details, {
      created: false,
      before: { location: "other", location_other: "Rooftop patio" },
      after: { location: "food_hall", location_other: null },
    });
  });

  test("cancel and un-cancel stay within the CHECK constraints", async () => {
    const d = pastDate();
    await assert.rejects(ev.cancelEvent(actor.id, d, { cancelReason: "" }), (e) => "cancelReason" in e.errors);
    await assert.rejects(ev.cancelEvent(actor.id, d, { cancelReason: "other", cancelReasonOther: " " }),
      (e) => "cancelReasonOther" in e.errors);

    // First save is a cancel: creates the row as cancelled.
    await ev.cancelEvent(actor.id, d, { cancelReason: "other", cancelReasonOther: "Parade", cancelAnnounced: "on" });
    assert.deepEqual(await eventRow(d), {
      status: "cancelled", location: null, location_other: null,
      cancel_reason: "other", cancel_reason_other: "Parade", cancel_announced: true,
    });
    // Changing the reason away from other clears its text.
    await ev.cancelEvent(actor.id, d, { cancelReason: "weather", cancelReasonOther: "stale", cancelAnnounced: "on" });
    let row = await eventRow(d);
    assert.deepEqual([row.cancel_reason, row.cancel_reason_other, row.cancel_announced], ["weather", null, true]);
    // A cancelled event keeps its status through the details form.
    await assert.rejects(ev.saveEvent(actor.id, d, { status: "held" }), ConflictError);
    await ev.saveEvent(actor.id, d, { location: "lobby" });
    assert.equal((await eventRow(d)).status, "cancelled");

    assert.deepEqual(await ev.uncancelEvent(actor.id, d), { changed: true });
    row = await eventRow(d);
    assert.deepEqual(row, {
      status: "scheduled", location: "lobby", location_other: null,
      cancel_reason: null, cancel_reason_other: null, cancel_announced: false,
    });
    assert.deepEqual(await ev.uncancelEvent(actor.id, d), { changed: false }, "un-cancel of a scheduled event is a no-op");
    assert.deepEqual((await auditRows(d)).map((a) => a.action),
      ["event.cancel", "event.cancel", "event.update", "event.uncancel"]);
    const uncancel = (await auditRows(d)).at(-1);
    assert.deepEqual(uncancel.details, {
      before: { status: "cancelled", cancel_reason: "weather", cancel_reason_other: null, cancel_announced: true },
      after: { status: "scheduled" },
    });
  });

  test("submitting a report moves the event to held and writes an audit row", async () => {
    const d = pastDate();
    await ev.saveEvent(actor.id, d, { location: "lobby" });
    assert.deepEqual(await ev.submitReport(actor.id, d, REPORT, { today: TODAY }), { changed: true });
    assert.equal((await eventRow(d)).status, "held");
    assert.deepEqual(await reportRow(d), {
      gives_asks_count: 31, notes: "Good turnout.\nNew faces.", bling_given: false, bling_details: null,
      source: "admin", submitted_by: actor.id,
    });
    const submit = (await auditRows(d)).at(-1);
    assert.equal(submit.action, "event_report.submit");
    assert.equal(submit.target_table, "event_reports");
    assert.deepEqual(submit.details.eventStatus, { before: "scheduled", after: "held" });

    // Edit: event_report.update with only the changed fields.
    await ev.submitReport(actor.id, d, { ...REPORT, blingGiven: "yes", blingDetails: " Ann brought Bob " }, { today: TODAY });
    const upd = (await auditRows(d)).at(-1);
    assert.equal(upd.action, "event_report.update");
    assert.deepEqual(upd.details.after, { bling_given: true, bling_details: "Ann brought Bob" });
    assert.deepEqual(await ev.submitReport(actor.id, d, { ...REPORT, blingGiven: "yes", blingDetails: "Ann brought Bob" }, { today: TODAY }),
      { changed: false });

    const got = await ev.getEvent(pool, d);
    assert.deepEqual([got.exists, got.status, got.report.givesAsksCount, got.report.by], [true, "held", 31, "Report Writer"]);
    // Held with a report: can't go back to scheduled, can't be cancelled.
    await assert.rejects(ev.saveEvent(actor.id, d, { status: "scheduled", location: "lobby" }), ConflictError);
    await assert.rejects(ev.cancelEvent(actor.id, d, { cancelReason: "weather" }), ConflictError);
    assert.equal((await eventRow(d)).status, "held");
  });

  test("a report on a date with no row creates the event as held", async () => {
    const d = pastDate();
    await ev.submitReport(actor.id, d, REPORT, { today: TODAY });
    assert.equal((await eventRow(d)).status, "held");
    assert.equal((await auditRows(d))[0].details.created, true);
  });

  test("report validation: count and Bling required, Bling details only with Bling, length caps", async () => {
    const d = pastDate();
    const bad = async (input, field) => assert.rejects(ev.submitReport(actor.id, d, input, { today: TODAY }),
      (e) => e instanceof ValidationError && field in e.errors, field);
    await bad({ ...REPORT, givesAsksCount: "" }, "givesAsksCount");
    await bad({ ...REPORT, givesAsksCount: "-1" }, "givesAsksCount");
    await bad({ ...REPORT, givesAsksCount: "3.5" }, "givesAsksCount");
    await bad({ ...REPORT, blingGiven: "" }, "blingGiven");
    await bad({ ...REPORT, blingGiven: "no", blingDetails: "Somebody" }, "blingDetails");
    await bad({ ...REPORT, notes: "x".repeat(ev.LIMITS.notes + 1) }, "notes");
    await bad({ ...REPORT, blingGiven: "yes", blingDetails: "x".repeat(ev.LIMITS.blingDetails + 1) }, "blingDetails");
    await assert.rejects(ev.submitReport(actor.id, "2001-02-30", REPORT, { today: TODAY }), ValidationError);
    // Zero people is a valid count.
    await ev.submitReport(actor.id, d, { ...REPORT, givesAsksCount: "0" }, { today: TODAY });
    assert.equal((await reportRow(d)).gives_asks_count, 0);
  });

  test("reports are refused on a cancelled event and on a future date", async () => {
    const d = pastDate();
    await ev.cancelEvent(actor.id, d, { cancelReason: "facility" });
    await assert.rejects(ev.submitReport(actor.id, d, REPORT, { today: TODAY }), ConflictError);
    assert.equal(await reportRow(d), null);
    assert.equal((await eventRow(d)).status, "cancelled");

    await assert.rejects(ev.submitReport(actor.id, "2026-11-18", REPORT, { today: TODAY }), ConflictError);
    // Nor can a future date be marked held by hand (it would show as held, no report).
    // A 2001 date with "today" the day before stands in for a future date.
    const f = pastDate();
    const dayBefore = new Date(Date.parse(`${f}T00:00:00Z`) - 86400_000).toISOString().slice(0, 10);
    await assert.rejects(ev.saveEvent(actor.id, f, { status: "held" }, { today: dayBefore }),
      (e) => e instanceof ConflictError && "status" in e.errors);
    assert.equal(await eventRow(f), null);
    await ev.saveEvent(actor.id, f, { status: "scheduled", location: "lobby" }, { today: dayBefore });
    assert.equal((await eventRow(f)).status, "scheduled");
    await ev.saveEvent(actor.id, f, { status: "held", location: "lobby" }, { today: f });
    assert.equal((await eventRow(f)).status, "held", "held is fine on the day itself");
    // Today itself is fine (Eastern); use a 2001 date as "today" to keep the DB tidy.
    const t = pastDate();
    await ev.submitReport(actor.id, t, REPORT, { today: t });
    assert.equal((await eventRow(t)).status, "held");
  });

  test("editing an imported report makes it the admin's", async () => {
    const d = pastDate();
    await owner.query(`insert into events (event_date, status) values ($1, 'held')`, [d]);
    await owner.query(`insert into event_reports (event_date, gives_asks_count, source) values ($1, 20, 'pre_form')`, [d]);
    await ev.submitReport(actor.id, d, { ...REPORT, givesAsksCount: "20" }, { today: TODAY });
    const r = await reportRow(d);
    assert.deepEqual([r.source, r.submitted_by, r.bling_given], ["admin", actor.id, false]);
  });

  test("a failed audit insert rolls the change back", async () => {
    const d = pastDate();
    const name = `fail_ev_${d.replace(/-/g, "")}`;
    await owner.query(`create function ${name}() returns trigger language plpgsql as $$
      begin if new.target_id = '${d}' then raise exception 'forced audit failure'; end if; return new; end $$`);
    await owner.query(`create trigger ${name} before insert on audit_log for each row execute function ${name}()`);
    try {
      await assert.rejects(ev.submitReport(actor.id, d, REPORT, { today: TODAY }), /forced audit failure/);
    } finally {
      await owner.query(`drop trigger ${name} on audit_log`);
      await owner.query(`drop function ${name}()`);
    }
    assert.equal(await eventRow(d), null);
    assert.equal(await reportRow(d), null);
  });

  test("the check-in count leaves out debug check-ins and debug attendees, and is never stored", async () => {
    const d = pastDate();
    await checkin(await attendee(), d);
    await checkin(await attendee(), d);
    await checkin(await attendee(), d, true);              // debug check-in
    await checkin(await attendee({ debug: true }), d);     // debug attendee
    assert.equal(await ev.checkinCount(pool, d), 2);
    assert.equal((await ev.getEvent(pool, d)).checkinCount, 2);
    await ev.submitReport(actor.id, d, REPORT, { today: TODAY });
    const [past] = (await ev.listPast(pool, { today: pastDate(), limit: 1 })).rows;
    assert.deepEqual([past.date, past.checkinCount], [d, 2]);
    const { rows } = await owner.query(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name in ('events', 'event_reports') and column_name ilike '%checkin%'`);
    assert.deepEqual(rows, []);
  });

  test("\"today\" is the Eastern calendar day, so report missing is decided in Eastern time", async () => {
    // 11:30 PM Monday in New York is already Tuesday in UTC.
    assert.equal(ev.todayEastern(new Date("2026-11-18T04:30:00Z")), "2026-11-17");
    assert.equal(ev.todayEastern(new Date("2026-11-18T05:30:00Z")), "2026-11-18");
    assert.equal(ev.todayEastern(new Date("2026-07-01T03:59:00Z")), "2026-06-30", "EDT is UTC-4");
    assert.equal(ev.nextTuesday("2026-11-17"), "2026-11-17");
    assert.equal(ev.nextTuesday("2026-11-18"), "2026-11-24");

    const [a, b, c, d] = [pastDate(), pastDate(), pastDate(), pastDate()];
    await ev.saveEvent(actor.id, a, { status: "scheduled" });      // past, scheduled -> missing
    await ev.submitReport(actor.id, b, REPORT, { today: TODAY });  // held
    await ev.cancelEvent(actor.id, c, { cancelReason: "weather" }); // cancelled
    await ev.saveEvent(actor.id, d, { status: "scheduled" });      // "today"

    // At 11:30 PM Eastern on day d, d is today: not missing yet (UTC would say it is).
    const instant = new Date(`${d}T23:30:00-05:00`);
    const today = ev.todayEastern(instant);
    assert.equal(today, d);
    assert.notEqual(instant.toISOString().slice(0, 10), d);
    const past = await ev.listPast(pool, { today, limit: 200 });
    const flag = Object.fromEntries(past.rows.filter((r) => [a, b, c, d].includes(r.date)).map((r) => [r.date, r.reportMissing]));
    assert.deepEqual(flag, { [a]: true, [b]: false, [c]: false });
    const missing = await ev.listPast(pool, { today, limit: 200, missingOnly: true });
    assert.ok(missing.rows.some((r) => r.date === a) && missing.rows.every((r) => r.status === "scheduled"));
    assert.equal(missing.total, await ev.reportMissingCount(pool, { today }));
    const upcoming = await ev.listUpcoming(pool, { today, limit: 1 });
    assert.equal(upcoming[0].date, d);
    // The next day, d is missing too.
    const tomorrow = await ev.reportMissingCount(pool, { today: ev.todayEastern(new Date(instant.getTime() + 3600_000)) });
    assert.equal(tomorrow, missing.total + 1);
  });
});

// ── 2. Over HTTP, through astro dev ─────────────────────────────────────────
describe("event routes over HTTP", { timeout: 300_000 }, () => {
  let server, admin, social, noRole;
  const root = fileURLToPath(new URL("../../", import.meta.url));

  before(async () => {
    const { dev } = await import("astro");
    server = await dev({ root, logLevel: "error", server: { port, host: "localhost" } });
    admin = await signedIn(["admin"]);
    social = await signedIn(["social"]);
    noRole = await signedIn([]);
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

  test("roles: admin 200, social and no role 403, signed out redirected or 401", async () => {
    const d = pastDate();
    const pages = ["/admin/events/", `/admin/events/${d}/`, `/admin/events/${d}`];
    for (const p of pages) {
      const res = await req(p, { cookie: admin.cookie });
      assert.equal(res.status, 200, p);
      assert.match(res.headers.get("content-security-policy"), /script-src 'self'/);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal((await req(p, { cookie: social.cookie })).status, 403, `social ${p}`);
      assert.equal((await req(p, { cookie: noRole.cookie })).status, 403, `no role ${p}`);
      const out = await req(p);
      assert.equal(out.status, 302, `signed out ${p}`);
      assert.match(out.headers.get("location"), /^\/login\/\?next=/);
    }
    const form = { action: "save", status: "held" };
    for (const who of [social, noRole]) {
      assert.equal((await req(`/admin/events/${d}/`, { cookie: who.cookie, method: "POST", form })).status, 403);
    }
    assert.ok([302, 401].includes((await req(`/admin/events/${d}/`, { method: "POST", form })).status));
    assert.equal(await eventRow(d), null, "nothing written");

    const socialHome = await (await req("/admin/", { cookie: social.cookie })).text();
    assert.ok(!socialHome.includes("/admin/events/"), "no events link or block for social");
  });

  test("not a real ISO date: 404", async () => {
    for (const p of ["/admin/events/2001-02-30/", "/admin/events/2001-2-3/", "/admin/events/latest/", "/admin/events/20010203/"]) {
      assert.equal((await req(p, { cookie: admin.cookie })).status, 404, p);
    }
  });

  // The themed error pages (src/lib/admin/error-page.mjs), with the private headers.
  const assertPrivate = (res, p) => {
    assert.equal(res.headers.get("cache-control"), "no-store", p);
    assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow", p);
    assert.match(res.headers.get("content-security-policy"), /script-src 'self'/, p);
    assert.match(res.headers.get("content-security-policy"), /frame-ancestors 'none'/, p);
  };
  const themed = async (res, p, heading) => {
    assert.match(res.headers.get("content-type"), /^text\/html/, p);
    const html = await res.text();
    assert.match(html, new RegExp(`<h1>${heading}</h1>`), p);
    assert.ok(!html.includes("<script"), `${p}: no script`);
    assert.match(html, /action="\/logout"/, `${p}: sign out`);
    return html;
  };

  test("no role -> /admin/ is a themed 403 that names nothing", async () => {
    const res = await req("/admin/", { cookie: noRole.cookie });
    assert.equal(res.status, 403);
    assertPrivate(res, "/admin/");
    const html = await themed(res, "/admin/", "Not allowed");
    assert.ok(!html.includes('href="/admin/"'), "no link into the app without a role");
    const d = pastDate();
    const ev = await req(`/admin/events/${d}/`, { cookie: noRole.cookie });
    assert.equal(ev.status, 403);
    const evHtml = await themed(ev, "event page", "Not allowed");
    assert.ok(!evHtml.includes(d), "the page doesn't echo the URL");
  });

  test("social -> /admin/events/ is a themed 403 with a way home", async () => {
    for (const p of ["/admin/events/", `/admin/events/${pastDate()}/`]) {
      const res = await req(p, { cookie: social.cookie });
      assert.equal(res.status, 403, p);
      assertPrivate(res, p);
      const html = await themed(res, p, "Not allowed");
      assert.match(html, /href="\/admin\/"/, "link to the admin home");
      assert.ok(!html.includes("Report") && !html.includes("Photos") && !html.includes("Sign-in board"), "nothing of the page");
    }
  });

  test("a bad date is a themed 404 (Out of Coffee); APIs and signed-out requests are unchanged", async () => {
    for (const p of ["/admin/events/2001-02-30/", "/admin/events/latest/"]) {
      const res = await req(p, { cookie: admin.cookie });
      assert.equal(res.status, 404, p);
      assertPrivate(res, p);
      const html = await themed(res, p, "This page is out of coffee");
      assert.match(html, /href="\/admin\/"/);
    }
    const out = await req("/admin/events/2001-02-30/");
    assert.equal(out.status, 302);
    assert.match(out.headers.get("location"), /^\/login\/\?next=/);
    // APIs: plain bodies, never the HTML pages.
    const api401 = await req("/api/admin/me");
    assert.equal(api401.status, 401);
    assert.deepEqual(await api401.json(), { error: "unauthorized" });
    const api403 = await req("/api/admin/me", { cookie: noRole.cookie });
    assert.equal(api403.status, 403);
    assert.deepEqual(await api403.json(), { error: "forbidden" });
    assertPrivate(api403, "/api/admin/me");
    const csv = await fetch(`${BASE}/api/admin/email-list.csv`, { method: "POST", headers: { cookie: social.cookie, origin: BASE }, redirect: "manual" });
    assert.equal(csv.status, 403);
    assert.doesNotMatch(csv.headers.get("content-type") ?? "", /html/);
    assert.ok(!(await csv.text()).includes("<html"));
  });

  test("unknown admin paths get the themed admin 404, behind the guard; unknown API paths a plain 404", async () => {
    const unknown = ["/admin/no-such-page", "/admin/no-such-page/", "/admin/events/foo/bar", `/admin/events/${pastDate()}/extra/`, "/admin/a/b/c/d"];
    for (const p of unknown) {
      for (const who of [admin, social]) {
        const res = await req(p, { cookie: who.cookie });
        assert.equal(res.status, 404, p);
        assertPrivate(res, p);
        const html = await themed(res, p, "This page is out of coffee");
        assert.match(html, /href="\/admin\/"/, `${p}: links to the admin home`);
        assert.ok(!html.includes('href="/"'), `${p}: not the public 404`);
      }
      const noRoleRes = await req(p, { cookie: noRole.cookie });
      assert.equal(noRoleRes.status, 403, `no role ${p}`);
      await themed(noRoleRes, p, "Not allowed");
      const out = await req(p);
      assert.equal(out.status, 302, `signed out ${p}`);
      assert.equal(out.headers.get("location"), `/login/?next=${encodeURIComponent(p)}`);
    }
    const post = await req("/admin/no-such-page", { cookie: admin.cookie, method: "POST", form: {} });
    assert.equal(post.status, 404);
    assert.ok(!(await post.text()).includes("<html"), "a POST gets the plain 404");

    for (const p of ["/api/admin/no-such", "/api/admin/media/uploads/extra", "/api/admin/a/b/c"]) {
      const res = await req(p, { cookie: admin.cookie });
      assert.equal(res.status, 404, p);
      assertPrivate(res, p);
      assert.match(res.headers.get("content-type"), /^application\/json/, p);
      assert.deepEqual(await res.json(), { error: "not found" });
      const posted = await fetch(`${BASE}${p}`, { method: "POST", headers: { cookie: admin.cookie, origin: BASE }, redirect: "manual" });
      assert.equal(posted.status, 404, `POST ${p}`);
      assert.equal((await req(p)).status, 401, `signed out ${p}`);
      assert.equal((await req(p, { cookie: noRole.cookie })).status, 403, `no role ${p}`);
    }
  });

  test("the catch-alls shadow no real admin route", async () => {
    const pages = ["/admin/", "/admin", "/admin/account/", "/admin/events/", `/admin/events/${pastDate()}/`, "/admin/checkins/",
      "/admin/streaks/", "/admin/email-list/", "/admin/attendees/", "/admin/users/"];
    for (const p of pages) assert.equal((await req(p, { cookie: admin.cookie })).status, 200, p);
    const me = await req("/api/admin/me", { cookie: admin.cookie });
    assert.equal(me.status, 200);
    assert.deepEqual((await me.json()).roles, ["admin"]);
  });

  test("POST without or with a foreign Origin is 403; other methods 405", async () => {
    const d = pastDate();
    for (const origin of [null, "https://evil.example"]) {
      const res = await req(`/admin/events/${d}/`, { cookie: admin.cookie, method: "POST", origin, form: { action: "save", status: "held" } });
      assert.equal(res.status, 403, `origin ${origin}`);
    }
    for (const method of ["PUT", "DELETE", "PATCH"]) {
      const res = await fetch(`${BASE}/admin/events/${d}/`, { method, headers: { cookie: admin.cookie, origin: BASE }, redirect: "manual" });
      assert.equal(res.status, 405, method);
    }
    assert.equal(await eventRow(d), null);
    assert.equal((await req(`/admin/events/${d}/`, { cookie: admin.cookie, method: "POST", form: { action: "drop" } })).status, 400);
  });

  test("first save creates the event; post/redirect/get with a fixed notice", async () => {
    const d = pastDate();
    const page = await (await req(`/admin/events/${d}/`, { cookie: admin.cookie })).text();
    assert.ok(page.includes("Not saved yet") && page.includes("Scheduled"));
    assert.ok(page.includes('class="event-media"'), "EventMedia rendered");

    const res = await req(`/admin/events/${d}/`, { cookie: admin.cookie, method: "POST",
      form: { action: "save", status: "scheduled", location: "food_hall" } });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), `/admin/events/${d}/?notice=saved`);
    assert.deepEqual([(await eventRow(d)).location, (await auditRows(d))[0].actor_user_id], ["food_hall", admin.user.id]);
    const after = await (await req(`/admin/events/${d}/?notice=saved`, { cookie: admin.cookie })).text();
    assert.ok(after.includes("Saved.") && !after.includes("Not saved yet") && after.includes("Report missing"));

    const list = await (await req("/admin/events/?missing=1", { cookie: admin.cookie })).text();
    assert.ok(list.includes(`href="/admin/events/${d}/"`) && list.includes("Report missing"));
    const home = await (await req("/admin/", { cookie: admin.cookie })).text();
    assert.ok(home.includes('href="/admin/events/"') && /\d+ reports? missing/.test(home) && home.includes("/admin/events/?missing=1"));
  });

  test("report over HTTP: 303, event held, audit row; invalid input 400 with messages by the fields", async () => {
    const d = pastDate();
    const bad = await req(`/admin/events/${d}/`, { cookie: admin.cookie, method: "POST",
      form: { action: "report", givesAsksCount: "lots", blingGiven: "no", blingDetails: "Pat", notes: "kept <b>" } });
    assert.equal(bad.status, 400);
    const html = await bad.text();
    assert.ok(html.includes("Enter a whole number") && html.includes("Leave Bling details empty"));
    assert.ok(html.includes("kept &lt;b&gt;"), "the typed notes are re-filled, escaped");
    assert.equal(await eventRow(d), null);

    const ok = await req(`/admin/events/${d}/`, { cookie: admin.cookie, method: "POST",
      form: { action: "report", givesAsksCount: "27", blingGiven: "yes", blingDetails: "Pat brought Sam", notes: "" } });
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.get("location"), `/admin/events/${d}/?notice=report`);
    assert.equal((await eventRow(d)).status, "held");
    const [audit] = await auditRows(d);
    assert.deepEqual([audit.action, audit.actor_user_id], ["event_report.submit", admin.user.id]);

    const cancel = await req(`/admin/events/${d}/`, { cookie: admin.cookie, method: "POST", form: { action: "cancel", cancelReason: "weather" } });
    assert.equal(cancel.status, 409);
  });

  test("cancel and un-cancel over HTTP", async () => {
    const d = pastDate();
    const c = await req(`/admin/events/${d}/`, { cookie: admin.cookie, method: "POST",
      form: { action: "cancel", cancelReason: "other_event", cancelAnnounced: "on" } });
    assert.equal(c.headers.get("location"), `/admin/events/${d}/?notice=cancelled`);
    const page = await (await req(`/admin/events/${d}/`, { cookie: admin.cookie })).text();
    assert.ok(page.includes("Un-cancel") && page.includes("No report for a cancelled event"));
    const u = await req(`/admin/events/${d}/`, { cookie: admin.cookie, method: "POST", form: { action: "uncancel" } });
    assert.equal(u.headers.get("location"), `/admin/events/${d}/?notice=uncancelled`);
    assert.deepEqual(await eventRow(d), {
      status: "scheduled", location: null, location_other: null,
      cancel_reason: null, cancel_reason_other: null, cancel_announced: false,
    });
  });

  test("the list's open-a-date form redirects to the event page; a bad date stays on the list", async () => {
    const go = await req("/admin/events/?date=2001-05-01", { cookie: admin.cookie });
    assert.equal(go.status, 303);
    assert.equal(go.headers.get("location"), "/admin/events/2001-05-01/");
    const bad = await req("/admin/events/?date=2001-13-01", { cookie: admin.cookie });
    assert.equal(bad.status, 200);
    assert.ok((await bad.text()).includes("is not a date"));
    const paged = await req("/admin/events/?page=999", { cookie: admin.cookie });
    assert.equal(paged.status, 200);
  });
});
