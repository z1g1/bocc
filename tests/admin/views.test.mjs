// Phase 2 data views (check-ins, streaks, email list, attendee corrections), against
// the throwaway database (npm run test:db):
//   1. the data modules, as admin_app: debug rows hidden, audit rows written in the
//      same transaction (a forced audit failure rolls the change back), CSV escaping
//   2. every route over HTTP through a real `astro dev` server, so the middleware,
//      requireRole, Astro's own origin check and ours all run: no session -> 302/401,
//      social -> 403, admin -> 200/303, wrong Origin -> 403
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { OWNER_URL, connect, unique, useAdminEnv } from "./helpers.mjs";

// The dev server and this process must agree on BETTER_AUTH_URL (cookies, Origin), so
// pick the port first.
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
const { latestCheckinDate, listCheckinDates, listCheckins } = await import("../../src/lib/admin/checkins.mjs");
const { listActiveStreaks } = await import("../../src/lib/admin/streaks.mjs");
const { listSubscribers, exportEmailList, optOut } = await import("../../src/lib/admin/email-list.mjs");
const { searchAttendees, getAttendee, correctAttendee, ValidationError, NotFoundError } =
  await import("../../src/lib/admin/attendees.mjs");

const PASSWORD = "correct horse battery staple";
let owner;

// ── Fixtures ────────────────────────────────────────────────────────────────
// Everything uses its own event id, so other test files' rows (event "bocc", today)
// don't change these streaks. Three held Tuesdays, 2026-10-20 / 10-27 / 11-03.
const EVENT = unique("views-event");
const WEEKS = ["2026-10-20", "2026-10-27", "2026-11-03"];
const DAY = WEEKS[2];
const fx = {};

async function attendee(owner, { name, business = "Biz", ok = true, debug = false, phone = "716-555-0100" }) {
  const email = `${unique("v")}@example.com`;
  const { rows: [a] } = await owner.query(
    `insert into attendees (email, name, phone, business_name, ok_to_email, debug)
     values ($1, $2, $3, $4, $5, $6) returning id`, [email, name, phone, business, ok, debug]);
  return { id: a.id, email, name };
}
async function checkin(owner, a, day, { debug = false, event = EVENT } = {}) {
  await owner.query(
    `insert into checkins (attendee_id, event_id, token, checkin_at, checkin_date, debug)
     values ($1, $2, 'tok', ($3::date + time '12:42') at time zone 'UTC', $3::date, $4)`, [a.id, event, day, debug]);
}
const auditRows = (targetId) =>
  owner.query("select actor_user_id, action, details from audit_log where target_id = $1 order by id", [targetId]).then((r) => r.rows);

/** Make the NEXT audit insert for this target fail, to prove the change rolls back with it. */
async function failAuditFor(targetId, fn) {
  const name = `fail_${targetId.replace(/-/g, "")}`;
  await owner.query(`create function ${name}() returns trigger language plpgsql as $$
    begin if new.target_id = '${targetId}' then raise exception 'forced audit failure'; end if; return new; end $$`);
  await owner.query(`create trigger ${name} before insert on audit_log for each row execute function ${name}()`);
  try {
    return await fn();
  } finally {
    await owner.query(`drop trigger ${name} on audit_log`);
    await owner.query(`drop function ${name}()`);
  }
}

// ── Users and sessions ──────────────────────────────────────────────────────
let ipCounter = 0;
const nextIp = () => `198.19.${Math.floor(++ipCounter / 250)}.${ipCounter % 250 + 1}`;
async function signedIn(roles) {
  const user = await createUser({ email: `${unique("vw")}@example.com`, name: "Views User", password: PASSWORD });
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
  fx.regular = await attendee(owner, { name: "Rita Regular" });              // 3 weeks: streak 3
  fx.lapsed = await attendee(owner, { name: "Larry Lapsed", ok: false });    // week 1 only: streak 0
  fx.tester = await attendee(owner, { name: "Tess Tester", debug: true });   // debug attendee
  fx.formula = await attendee(owner, { name: "=HYPERLINK(\"http://evil\",\"x\")", business: "@SUM(1)" });
  for (const w of WEEKS) await checkin(owner, fx.regular, w);
  await checkin(owner, fx.lapsed, WEEKS[0]);
  for (const w of WEEKS) await checkin(owner, fx.tester, w);                // non-debug check-ins, debug attendee
  await checkin(owner, fx.formula, DAY, { debug: true });                    // a debug check-in
  // A later test-only day: must not become the default "latest event".
  await checkin(owner, fx.formula, "2031-01-07", { debug: true, event: unique("debug-only") });
});
after(async () => { await owner?.end(); await pool.end(); });

// ── 1. Data modules ─────────────────────────────────────────────────────────
describe("check-ins module", () => {
  test("the default day is the latest day with a real check-in; test-only days don't count", async () => {
    const { rows: [r] } = await owner.query("select max(checkin_date)::text as d from checkins where debug = false");
    assert.equal(await latestCheckinDate(pool), r.d);
    assert.equal(await latestCheckinDate(pool, { includeDebug: true }), "2031-01-07");
    const dates = (await listCheckinDates(pool)).map((d) => d.date);
    assert.ok(dates.includes(DAY) && !dates.includes("2031-01-07"));
  });

  test("debug rows are hidden by default and shown with includeDebug", async () => {
    const shown = await listCheckins(pool, { date: DAY });
    const emails = shown.filter((c) => c.eventId === EVENT).map((c) => c.email);
    assert.deepEqual(emails, [fx.regular.email]);
    const all = (await listCheckins(pool, { date: DAY, includeDebug: true })).filter((c) => c.eventId === EVENT);
    assert.deepEqual(new Set(all.map((c) => c.email)), new Set([fx.regular.email, fx.tester.email, fx.formula.email]));
    assert.ok(all.filter((c) => c.email !== fx.regular.email).every((c) => c.debug));
    assert.equal(shown.find((c) => c.email === fx.regular.email).currentStreak, 3, "streak included");
    await assert.rejects(listCheckins(pool, { date: "nope" }), /YYYY-MM-DD/);
  });
});

describe("streaks module", () => {
  test("active = current streak > 0 on the event's latest held week; debug attendees left out", async () => {
    const rows = (await listActiveStreaks(pool, { eventId: EVENT }));
    assert.deepEqual(rows.map((r) => [r.email, r.currentStreak, r.longestStreak, r.weeksAttended]),
      [[fx.regular.email, 3, 3, 3]]);
  });
});

describe("email list module", () => {
  test("subscribers: ok_to_email and not debug", async () => {
    const emails = (await listSubscribers(pool)).map((s) => s.email);
    assert.ok(emails.includes(fx.regular.email));
    assert.ok(!emails.includes(fx.lapsed.email), "not opted in");
    assert.ok(!emails.includes(fx.tester.email), "debug attendee");
  });

  test("export is audited with its row count and escapes formulas", async () => {
    const { user } = await signedIn(["admin"]);
    const { rows: [{ n: before }] } = await owner.query("select count(*)::int as n from audit_log where action = 'email_list.export'");
    const { csv, rowCount } = await exportEmailList(user.id);
    const lines = csv.trimEnd().split("\r\n");
    assert.equal(lines[0], "email,name,business_name,date_added");
    assert.equal(lines.length - 1, rowCount);
    assert.ok(lines.some((l) => l.startsWith(`${fx.formula.email},"'=HYPERLINK(""http://evil"",""x"")",'@SUM(1),`)), "formula cells neutralised");
    const { rows } = await owner.query(
      "select actor_user_id, target_table, details from audit_log where action = 'email_list.export' order by id");
    assert.equal(rows.length, before + 1);
    assert.deepEqual(rows.at(-1), { actor_user_id: user.id, target_table: "attendees", details: { rowCount } });
  });

  test("opt-out: one audit row, same transaction", async () => {
    const { user } = await signedIn(["admin"]);
    const a = await attendee(owner, { name: "Olive Optout" });
    assert.deepEqual(await optOut(user.id, a.id), { wasOptedIn: true });
    assert.equal((await getAttendee(pool, a.id)).okToEmail, false);
    assert.deepEqual(await auditRows(a.id), [{
      actor_user_id: user.id, action: "attendee.opt_out",
      details: { before: { ok_to_email: true }, after: { ok_to_email: false } },
    }]);
    await assert.rejects(optOut(user.id, "123e4567-e89b-12d3-a456-426614174000"), NotFoundError);
    await assert.rejects(optOut(user.id, "not-a-uuid"), NotFoundError);
  });

  test("opt-out: a failed audit insert rolls the change back", async () => {
    const a = await attendee(owner, { name: "Rolly Back" });
    await failAuditFor(a.id, () => assert.rejects(optOut(null, a.id), /forced audit failure/));
    assert.equal((await getAttendee(pool, a.id)).okToEmail, true);
    assert.deepEqual(await auditRows(a.id), []);
  });
});

describe("attendee corrections module", () => {
  test("search hides debug attendees unless asked, and treats % and _ literally", async () => {
    assert.deepEqual((await searchAttendees(pool, { q: "Tess Tester" })).map((r) => r.id), []);
    assert.deepEqual((await searchAttendees(pool, { q: "Tess Tester", includeDebug: true })).map((r) => r.id), [fx.tester.id]);
    assert.deepEqual(await searchAttendees(pool, { q: "%_%Rita" }), []);
  });

  test("a correction writes exactly one audit row with before/after of the changed fields", async () => {
    const { user } = await signedIn(["admin"]);
    const a = await attendee(owner, { name: "Corey Rect", business: "Old Co" });
    const r = await correctAttendee(user.id, a.id, { name: " Corey  Rect ", businessName: "New Co", phone: "" });
    assert.deepEqual(r, { changed: ["business_name", "phone"] });
    const row = await getAttendee(pool, a.id);
    assert.deepEqual([row.name, row.businessName, row.phone, row.email], ["Corey Rect", "New Co", null, a.email]);
    assert.deepEqual(await auditRows(a.id), [{
      actor_user_id: user.id, action: "attendee.update",
      details: { before: { business_name: "Old Co", phone: "716-555-0100" }, after: { business_name: "New Co", phone: null } },
    }]);
    // Same values again: nothing written, no audit row.
    assert.deepEqual(await correctAttendee(user.id, a.id, { name: "Corey Rect", businessName: "New Co" }), { changed: [] });
    assert.equal((await auditRows(a.id)).length, 1);
  });

  test("invalid input and unknown ids are refused before anything is written", async () => {
    const a = await attendee(owner, { name: "Val Idate" });
    await assert.rejects(correctAttendee(null, a.id, { name: "", phone: "call me" }), (e) => e instanceof ValidationError && e.errors.length === 2);
    await assert.rejects(correctAttendee(null, "123e4567-e89b-12d3-a456-426614174000", { name: "X" }), NotFoundError);
    assert.deepEqual(await auditRows(a.id), []);
  });

  test("a failed audit insert rolls the correction back", async () => {
    const a = await attendee(owner, { name: "Ann Atomic" });
    await failAuditFor(a.id, () => assert.rejects(correctAttendee(null, a.id, { name: "Changed" }), /forced audit failure/));
    assert.equal((await getAttendee(pool, a.id)).name, "Ann Atomic");
    assert.deepEqual(await auditRows(a.id), []);
  });
});

// ── 2. Over HTTP, through astro dev ─────────────────────────────────────────
describe("routes over HTTP", { timeout: 300_000 }, () => {
  let server, admin, social;
  const root = fileURLToPath(new URL("../../", import.meta.url));

  before(async () => {
    const { dev } = await import("astro");
    server = await dev({ root, logLevel: "error", server: { port, host: "localhost" } });
    admin = await signedIn(["admin"]);
    social = await signedIn(["social"]);
  });
  after(async () => { await server?.stop(); });

  const req = (path, { cookie, method = "GET", form, origin = BASE, contentType } = {}) => {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    let body;
    if (method === "POST") {
      if (origin) headers.origin = origin;
      headers["content-type"] = contentType ?? "application/x-www-form-urlencoded";
      body = new URLSearchParams(form ?? {}).toString();
    }
    return fetch(`${BASE}${path}`, { method, headers, body, redirect: "manual" });
  };

  const pages = () => [
    "/admin/checkins/", `/admin/checkins/?date=${DAY}&debug=1`, "/admin/streaks/",
    "/admin/email-list/", "/admin/attendees/", "/admin/attendees/?q=Rita", `/admin/attendees/${fx.regular.id}/`,
  ];
  const mutations = () => [
    { path: "/api/admin/email-list.csv" },
    { path: "/api/admin/email-list/opt-out", form: { attendeeId: fx.lapsed.id } },
    { path: `/admin/attendees/${fx.lapsed.id}/`, form: { name: "Larry Lapsed" } },
  ];

  test("no session: pages redirect to /login/, mutations are refused", async () => {
    for (const p of pages()) {
      const res = await req(p);
      assert.equal(res.status, 302, p);
      assert.match(res.headers.get("location"), /^\/login\/\?next=/);
    }
    for (const m of mutations()) {
      const res = await req(m.path, { method: "POST", form: m.form });
      assert.ok([302, 401].includes(res.status), `${m.path}: ${res.status}`);
    }
  });

  test("the social role gets 403 on every data view and mutation", async () => {
    for (const p of pages()) assert.equal((await req(p, { cookie: social.cookie })).status, 403, p);
    for (const m of mutations()) {
      assert.equal((await req(m.path, { cookie: social.cookie, method: "POST", form: m.form })).status, 403, m.path);
    }
    const home = await (await req("/admin/", { cookie: social.cookie })).text();
    assert.ok(!home.includes("/admin/checkins/") && !home.includes("/admin/email-list/"), "no admin links for social");
  });

  test("admin gets 200 on every page, with the admin CSP", async () => {
    for (const p of pages()) {
      const res = await req(p, { cookie: admin.cookie });
      assert.equal(res.status, 200, p);
      assert.match(res.headers.get("content-security-policy"), /default-src 'self'/);
      assert.equal(res.headers.get("cache-control"), "no-store");
    }
    const home = await (await req("/admin/", { cookie: admin.cookie })).text();
    for (const href of ["/admin/checkins/", "/admin/streaks/", "/admin/email-list/", "/admin/attendees/"]) {
      assert.ok(home.includes(`href="${href}"`), `home links ${href}`);
    }
    assert.equal((await req("/admin/attendees/not-a-uuid/", { cookie: admin.cookie })).status, 404);
  });

  test("debug rows are hidden on the pages by default", async () => {
    const day = await (await req(`/admin/checkins/?date=${DAY}`, { cookie: admin.cookie })).text();
    assert.ok(day.includes(fx.regular.email) && !day.includes(fx.tester.email));
    const withDebug = await (await req(`/admin/checkins/?date=${DAY}&debug=1`, { cookie: admin.cookie })).text();
    assert.ok(withDebug.includes(fx.tester.email));
    const streaks = await (await req("/admin/streaks/", { cookie: admin.cookie })).text();
    assert.ok(streaks.includes("Rita Regular") && !streaks.includes("Tess Tester") && !streaks.includes("Larry Lapsed"));
    const list = await (await req("/admin/email-list/", { cookie: admin.cookie })).text();
    assert.ok(list.includes(fx.regular.email) && !list.includes(fx.tester.email) && !list.includes(fx.lapsed.email));
    assert.match(list, /<th[^>]*>Date added<\/th>/);
    assert.match(list, new RegExp(`<td[^>]*>${WEEKS[0]}</td>`), "Rita's first check-in");
  });

  test("mutations from another origin, or with none, are refused (403) and change nothing", async () => {
    const a = await attendee(owner, { name: "Cross Site" });
    const tries = [
      { path: "/api/admin/email-list.csv" },
      { path: "/api/admin/email-list/opt-out", form: { attendeeId: a.id } },
      { path: `/admin/attendees/${a.id}/`, form: { name: "Hacked" } },
    ];
    for (const t of tries) {
      for (const [origin, contentType] of [["https://evil.example", undefined], [null, undefined], ["https://evil.example", "application/json"]]) {
        const res = await req(t.path, { cookie: admin.cookie, method: "POST", form: t.form, origin, contentType });
        assert.equal(res.status, 403, `${t.path} origin=${origin} type=${contentType}`);
      }
    }
    const row = await getAttendee(pool, a.id);
    assert.deepEqual([row.name, row.okToEmail], ["Cross Site", true]);
    assert.deepEqual(await auditRows(a.id), []);
    assert.equal((await req("/api/admin/email-list.csv", { cookie: admin.cookie })).status, 404, "export is POST only");
  });

  test("CSV export over HTTP: a download, audited, formulas escaped", async () => {
    const { rows: [{ n: before }] } = await owner.query(
      "select count(*)::int as n from audit_log where action = 'email_list.export' and actor_user_id = $1", [admin.user.id]);
    const res = await req("/api/admin/email-list.csv", { cookie: admin.cookie, method: "POST" });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/csv/);
    assert.match(res.headers.get("content-disposition"), /^attachment; filename="bocc-email-list-\d{4}-\d{2}-\d{2}\.csv"$/);
    const csv = await res.text();
    assert.ok(csv.includes(`"'=HYPERLINK(`) && csv.includes(",'@SUM(1)"));
    assert.ok(!csv.includes(fx.tester.email));
    const { rows } = await owner.query(
      "select details from audit_log where action = 'email_list.export' and actor_user_id = $1 order by id", [admin.user.id]);
    assert.equal(rows.length, before + 1);
    assert.equal(rows.at(-1).details.rowCount, csv.trimEnd().split("\r\n").length - 1);
  });

  test("opt-out over HTTP: 303 back to the page, one audit row", async () => {
    const a = await attendee(owner, { name: "Http Optout" });
    const res = await req("/api/admin/email-list/opt-out", {
      cookie: admin.cookie, method: "POST", form: { attendeeId: a.id, return: "https://evil.example/" } });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/admin/?notice=opted-out", "foreign return URLs are ignored");
    assert.equal((await getAttendee(pool, a.id)).okToEmail, false);
    assert.equal((await auditRows(a.id)).length, 1);
    const back = await req("/api/admin/email-list/opt-out", {
      cookie: admin.cookie, method: "POST", form: { attendeeId: a.id, return: `/admin/attendees/${a.id}/` } });
    assert.equal(back.headers.get("location"), `/admin/attendees/${a.id}/?notice=opted-out`);
    const missing = await req("/api/admin/email-list/opt-out", { cookie: admin.cookie, method: "POST", form: { attendeeId: "x" } });
    assert.equal(missing.status, 404);
  });

  test("correction over HTTP: 303 on success, 400 with the form on invalid input", async () => {
    const a = await attendee(owner, { name: "Web Edit", business: "Before" });
    const ok = await req(`/admin/attendees/${a.id}/`, {
      cookie: admin.cookie, method: "POST", form: { name: "Web Edited", businessName: "After", phone: "(716) 555-0199" } });
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.get("location"), `/admin/attendees/${a.id}/?notice=saved`);
    const row = await getAttendee(pool, a.id);
    assert.deepEqual([row.name, row.businessName, row.phone], ["Web Edited", "After", "(716) 555-0199"]);
    const audit = await auditRows(a.id);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actor_user_id, admin.user.id);
    assert.deepEqual(audit[0].details.before, { name: "Web Edit", business_name: "Before", phone: "716-555-0100" });

    const bad = await req(`/admin/attendees/${a.id}/`, { cookie: admin.cookie, method: "POST", form: { name: "", phone: "nope" } });
    assert.equal(bad.status, 400);
    const html = await bad.text();
    assert.ok(html.includes("Name is required") && html.includes("Invalid phone number format"));
    assert.equal((await auditRows(a.id)).length, 1, "nothing more written");
  });
});
