// Luma sync (ADR 0014, spec #70, ticket #73), against the throwaway database (npm run test:db):
//   1. pure rules: the displayed status, unfinished, the Error note, the email line, the
//      launch date, the email role's allowlist and nav
//   2. src/lib/admin/luma-sync.mjs as admin_app with an injected clock in past years
//      (2011-2014) so other tests' data doesn't interfere (and these check-ins never
//      become anyone's "latest check-in day"): who is in a sync, every displayed
//      status rule, oldest unfinished first (never Upcoming or pre-launch), the holiday
//      stand-down, Done marking everyone On Luma in the same transaction, Error kept
//      being handed out, the audit rows
//   3. over HTTP (astro dev, the real clock, LUMA_SYNC_LAUNCH_DATE set to the latest
//      Tuesday): the email role's fence, social+email, Origin, post/redirect/get, Error
//      refused without a note, and the agent-facing markup with no other personal data
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
const { todayEastern } = await import("../../src/lib/admin/events.mjs");
const { isHolidayWeek } = await import("../../src/lib/holiday-weeks.mjs");
const rules = await import("../../src/lib/admin/luma-sync-rules.mjs");
const lumaSync = await import("../../src/lib/admin/luma-sync.mjs");
const lumaSyncPages = await import("../../src/lib/admin/luma-sync-pages.mjs");
const { mayReach, EMAIL_PATHS, ROLE_PATHS } = await import("../../src/lib/admin/roles.mjs");
const { navLinksFor, EMAIL_LINKS, SOCIAL_LINKS } = await import("../../src/lib/admin/nav.mjs");

const PASSWORD = "correct horse battery staple";
let owner, actor;

const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** The first Tuesday on or after `date`. */
const tuesday = (date) => {
  let d = date;
  while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 2) d = addDays(d, 1);
  return d;
};
/** Mid-day Eastern on `date`. */
const noon = (date) => new Date(`${date}T17:00:00Z`);

let checkinSeq = 0; // each check-in a second after the last, so check-in order is stable
/**
 * One Attendee, made as the owner. checkins: [date] or [{ date, debug }].
 * @returns {Promise<{ id: string, email: string, name: string }>}
 */
async function person({ okToEmail = true, debug = false, checkins = [], beforeLaunch = false, name } = {}) {
  const email = `${unique("luma")}@example.com`;
  const n = name ?? `Lu ${unique("Ma")}`;
  const { rows: [a] } = await owner.query(
    `insert into attendees (email, name, phone, business_name, ok_to_email, debug, on_luma_before_launch)
     values ($1, $2, '716-555-0142', 'Secret Biz Co', $3, $4, $5) returning id`,
    [email, n, okToEmail, debug, beforeLaunch]);
  for (const c of checkins) {
    const { date, debug: cd = false } = typeof c === "string" ? { date: c } : c;
    await owner.query(
      `insert into checkins (attendee_id, event_id, token, checkin_date, checkin_at, debug)
       values ($1, 'bocc', 'tok', $2::date,
               ($2::date + time '12:00') at time zone 'America/New_York' + interval '1 second' * $4, $3)`,
      [a.id, date, cd, ++checkinSeq]);
  }
  return { id: a.id, email, name: n };
}

const onLumaAt = (id) => owner.query("select on_luma_at from attendees where id = $1", [id]).then((r) => r.rows[0].on_luma_at);
const syncRow = (d) => owner.query("select status, note, updated_by from luma_syncs where event_date = $1", [d]).then((r) => r.rows[0] ?? null);
const audits = (d) => owner.query(
  `select actor_user_id, action, target_table, details from audit_log
    where target_table = 'luma_syncs' and target_id = $1 order by id`, [d]).then((r) => r.rows);

let ipCounter = 0;
const nextIp = () => `198.23.${Math.floor(++ipCounter / 250)}.${ipCounter % 250 + 1}`;
async function signedIn(roles) {
  const user = await createUser({ email: `${unique("ls")}@example.com`, name: "Luma Sync Test", password: PASSWORD });
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
  actor = await createUser({ email: `${unique("lumaadmin")}@example.com`, name: "Luma Admin", password: PASSWORD });
});
after(async () => { await owner?.end(); await pool.end(); });

// ── 1. Pure rules ───────────────────────────────────────────────────────────
describe("rules", () => {
  test("displayed status: Cancelled, Error, a late joiner reopening Done, Nothing to add", () => {
    const ds = rules.displayedStatus;
    assert.equal(ds({ stored: null, people: 0 }), "nothing_to_add");
    assert.equal(ds({ stored: null, people: 2 }), "todo");
    assert.equal(ds({ stored: "todo", people: 0 }), "nothing_to_add");
    assert.equal(ds({ stored: "nothing_to_add", people: 1 }), "todo");
    assert.equal(ds({ stored: "done", people: 0 }), "done");
    assert.equal(ds({ stored: "done", people: 1 }), "todo", "a late joiner reopens Done");
    assert.equal(ds({ stored: "error", people: 0 }), "error", "Error stays until Done");
    assert.equal(ds({ stored: "error", people: 3 }), "error");
    for (const stored of [null, "todo", "done", "error"]) {
      assert.equal(ds({ stored, people: 4, cancelled: true }), "nothing_to_add", `Cancelled over ${stored}`);
    }
    assert.deepEqual(rules.LUMA_SYNC_STATUSES.filter(rules.isUnfinished), ["todo", "error"]);
    assert.deepEqual(Object.values(rules.LUMA_SYNC_STATUS_LABELS), ["To do", "Nothing to add", "Done", "Error"]);
    assert.deepEqual(rules.lumaSyncStatus({ stored: "done", people: 1 }), { status: "todo", statusLabel: "To do", unfinished: true });
    assert.deepEqual(rules.lumaSyncStatus({ stored: "done", people: 0 }), { status: "done", statusLabel: "Done", unfinished: false });
  });

  test("Error note, email line, launch date, Luma people URL", () => {
    assert.match(rules.errorNoteProblem(""), /Write what went wrong/);
    assert.match(rules.errorNoteProblem("   \n"), /Write what went wrong/);
    assert.match(rules.errorNoteProblem(undefined), /Write what went wrong/);
    assert.match(rules.errorNoteProblem("x".repeat(rules.NOTE_MAX + 1)), /2000 characters/);
    assert.equal(rules.errorNoteProblem(` ${"x".repeat(rules.NOTE_MAX)} `), null);
    assert.equal(rules.emailLine([{ email: "a@x.com" }, { email: "b@y.org" }]), "a@x.com b@y.org");
    assert.equal(rules.emailLine([]), "");
    assert.equal(rules.lumaSyncLaunchDate({}), rules.LUMA_SYNC_LAUNCH_DATE);
    assert.equal(rules.lumaSyncLaunchDate({ LUMA_SYNC_LAUNCH_DATE: "2066-01-05" }), "2066-01-05");
    assert.equal(rules.lumaSyncLaunchDate({ LUMA_SYNC_LAUNCH_DATE: "soon" }), rules.LUMA_SYNC_LAUNCH_DATE);
    assert.equal(rules.LUMA_PEOPLE_URL, "https://luma.com/calendar/manage/cal-v2LiFTJpdPAP6rW/people");
  });

  test("the email role reaches only the Luma sync pages; social+email the union; admin everything", () => {
    assert.equal(ROLE_PATHS.email, EMAIL_PATHS);
    const luma = ["/admin/luma-sync/", "/admin/luma-sync/next/"];
    const base = ["/admin/", "/admin/account/", "/api/admin/me"];
    const social = ["/admin/social/next/", "/api/admin/social/next"];
    const never = ["/admin/email-list/", "/api/admin/email-list.csv", "/api/admin/email-list/opt-out", "/admin/attendees/",
      "/admin/events/", "/admin/events/2066-03-02/", "/admin/checkins/", "/admin/streaks/", "/admin/users/", "/admin/luma-syncx/",
      "/api/admin/luma-sync/next"];
    for (const p of [...luma, ...base]) assert.equal(mayReach(["email"], p), true, p);
    for (const p of [...social, ...never]) assert.equal(mayReach(["email"], p), false, p);
    for (const p of [...luma, ...base, ...social]) assert.equal(mayReach(["social", "email"], p), true, p);
    for (const p of never) assert.equal(mayReach(["social", "email"], p), false, p);
    for (const p of luma) assert.equal(mayReach(["social"], p), false, p);
    for (const p of [...luma, ...never]) assert.equal(mayReach(["admin"], p), true, p);
  });

  test("nav: email sees only Luma sync; social+email both; admin all", () => {
    assert.deepEqual(navLinksFor(["email"]).map((l) => l.label), ["Luma sync"]);
    assert.deepEqual(navLinksFor(["social", "email"]).map((l) => l.href), [...SOCIAL_LINKS, ...EMAIL_LINKS].map((l) => l.href));
    assert.ok(navLinksFor(["admin"]).some((l) => l.href === "/admin/luma-sync/next/"));
  });

  test("noticeText after the redirect", () => {
    const q = (s) => new URLSearchParams(s);
    assert.equal(lumaSyncPages.noticeText(q("notice=done&date=2066-03-02&people=2")), "Marked the Luma sync for 2066-03-02 Done. 2 people are now On Luma.");
    assert.equal(lumaSyncPages.noticeText(q("notice=done&date=2066-03-02&people=1")), "Marked the Luma sync for 2066-03-02 Done. 1 person is now On Luma.");
    assert.equal(lumaSyncPages.noticeText(q("notice=error&date=2066-03-02")), "Marked the Luma sync for 2066-03-02 Error.");
    assert.equal(lumaSyncPages.noticeText(q("notice=error&date=<b>")), null);
    assert.equal(lumaSyncPages.noticeText(q("")), null);
  });
});

// ── 2. The module, as admin_app, injected clock ─────────────────────────────
describe("luma-sync.mjs (admin_app, injected clock)", () => {
  test("who is in a sync: first non-debug Check-in only, Email list only, not On Luma; opt-outs drop off", async () => {
    const T = tuesday("2011-03-01");
    const launch = addDays(T, -14);
    const opts = { today: addDays(T, 1), launch };
    const first = await person({ checkins: [T], name: "Ann First" });
    const returning = await person({ checkins: [addDays(T, -7), T] });
    const debugEarlier = await person({ checkins: [{ date: addDays(T, -7), debug: true }, T], name: "Bea Debugbefore" });
    const noEmail = await person({ okToEmail: false, checkins: [T] });
    const tester = await person({ debug: true, checkins: [T] });
    const already = await person({ beforeLaunch: true, checkins: [T] });
    const onlyDebug = await person({ checkins: [{ date: T, debug: true }] });
    const later = await person({ checkins: [addDays(T, 7)] });

    const s = await lumaSync.getLumaSync(pool, T, opts);
    assert.deepEqual(s.people.map((p) => p.id).sort(), [first.id, debugEarlier.id].sort());
    assert.deepEqual(Object.keys(s.people[0]).sort(), ["email", "id", "name"], "name and email only");
    assert.deepEqual(s.joined.map((p) => p.id).sort(), [first.id, debugEarlier.id, already.id].sort(), "joined includes On Luma");
    const j = s.joined.find((p) => p.id === already.id);
    assert.deepEqual([j.dateAdded, j.onLumaSince, j.onLumaBeforeLaunch], [T, null, true]);
    assert.equal(s.status, "todo");
    for (const p of [returning, noEmail, tester, onlyDebug, later]) assert.ok(!s.people.some((x) => x.id === p.id));

    await owner.query("update attendees set ok_to_email = false where id = $1", [first.id]);
    const after = await lumaSync.getLumaSync(pool, T, opts);
    assert.deepEqual(after.people.map((p) => p.id), [debugEarlier.id], "an opt-out drops off at once");
  });

  test("displayed status: no row, Cancelled, Done, a late joiner reopening Done, Error until Done", async () => {
    const T = tuesday("2011-05-01");
    const opts = { today: addDays(T, 1), launch: addDays(T, -7), now: noon(addDays(T, 1)) };
    assert.equal((await lumaSync.getLumaSync(pool, T, opts)).status, "nothing_to_add", "nobody and no row");
    const a = await person({ checkins: [T] });
    let s = await lumaSync.getLumaSync(pool, T, opts);
    assert.deepEqual([s.status, s.statusLabel, s.unfinished, s.stored], ["todo", "To do", true, null]);

    const r = await lumaSync.markDone(actor.id, T, opts);
    assert.deepEqual([r.people, r.before, r.attendeeIds], [1, null, [a.id]]);
    s = await lumaSync.getLumaSync(pool, T, opts);
    assert.deepEqual([s.status, s.people.length, s.stored.status], ["done", 0, "done"]);

    const late = await person({ checkins: [T] });
    s = await lumaSync.getLumaSync(pool, T, opts);
    assert.deepEqual([s.status, s.stored.status, s.people.map((p) => p.id)], ["todo", "done", [late.id]], "a late joiner reopens Done");

    await lumaSync.markError(actor.id, T, "  late@example.com missing  ", opts);
    s = await lumaSync.getLumaSync(pool, T, opts);
    assert.deepEqual([s.status, s.note], ["error", "late@example.com missing"]);
    await owner.query("update attendees set ok_to_email = false where id = $1", [late.id]);
    assert.equal((await lumaSync.getLumaSync(pool, T, opts)).status, "error", "Error stays Error with nobody left");
    await lumaSync.markDone(actor.id, T, opts);
    s = await lumaSync.getLumaSync(pool, T, opts);
    assert.deepEqual([s.status, s.note], ["done", "late@example.com missing"], "the note is kept as history");

    // A Cancelled Event is always Nothing to add, and can't be marked.
    const C = addDays(T, -7);
    await person({ checkins: [C] });
    await owner.query(`insert into events (event_date, status, cancel_reason) values ($1, 'cancelled', 'weather')`, [C]);
    s = await lumaSync.getLumaSync(pool, C, opts);
    assert.deepEqual([s.status, s.cancelled, s.people.length], ["nothing_to_add", true, 1]);
    await assert.rejects(lumaSync.markDone(actor.id, C, opts), (e) => e.status === 409 && /Cancelled/.test(e.errors.date));
    await assert.rejects(lumaSync.markError(actor.id, C, "x", opts), (e) => e.status === 409);
    assert.equal(await syncRow(C), null);
  });

  test("oldest unfinished first; never Upcoming or pre-launch; Error is handed out again", async () => {
    const T1 = tuesday("2012-02-01");
    const [T0, T2, T3, T4] = [addDays(T1, -7), addDays(T1, 7), addDays(T1, 14), addDays(T1, 21)];
    const today = addDays(T3, 1); // the Wednesday after T3: T4 is Upcoming
    const opts = { today, launch: T1, now: noon(today) };
    await person({ checkins: [T0] }); // before launch
    const b = await person({ checkins: [T2] });
    const c1 = await person({ checkins: [T3] });
    const c2 = await person({ checkins: [T3] });
    await person({ checkins: [T4] }); // Upcoming

    let next = await lumaSync.findNextLumaSync(pool, opts);
    assert.equal(next.state, "sync");
    assert.equal(next.sync.date, T2, "T1 has nobody to add; T0 is before launch");
    assert.deepEqual(next.sync.people.map((p) => p.id), [b.id]);
    await lumaSync.markDone(actor.id, T2, opts);

    next = await lumaSync.findNextLumaSync(pool, opts);
    assert.equal(next.sync.date, T3);
    assert.deepEqual(next.sync.people.map((p) => p.id), [c1.id, c2.id], "in check-in order");
    await lumaSync.markError(actor.id, T3, `${c2.email} missing`, opts);
    next = await lumaSync.findNextLumaSync(pool, opts);
    assert.deepEqual([next.sync.date, next.sync.status, next.sync.note], [T3, "error", `${c2.email} missing`], "Error is handed out again");

    await lumaSync.markDone(actor.id, T3, opts);
    next = await lumaSync.findNextLumaSync(pool, opts);
    assert.deepEqual(next, { state: "stand_down", today, holiday: false, message: "Nothing to add, stand down." });

    // Today's Event is handed out (up to and including today); the next day's isn't.
    next = await lumaSync.findNextLumaSync(pool, { ...opts, today: T4 });
    assert.equal(next.sync.date, T4);
    // Upcoming and pre-launch Events can't be marked either.
    await assert.rejects(lumaSync.markDone(actor.id, T4, opts), (e) => e.status === 409 && /hasn't happened/.test(e.errors.date));
    await assert.rejects(lumaSync.markDone(actor.id, T0, opts), (e) => e.status === 409 && /before/.test(e.errors.date));
    await assert.rejects(lumaSync.markDone(actor.id, addDays(T1, 1), opts), (e) => e.status === 404, "a Wednesday is not an Event");
    await assert.rejects(lumaSync.markDone(actor.id, "2012-02-30", opts), (e) => e.status === 400);
  });

  test("the holiday break: stand down and say so; a holiday Tuesday is an Event only with a saved row", async () => {
    const H = tuesday("2013-12-22");
    assert.ok(isHolidayWeek(H));
    const opts = { today: H, launch: addDays(H, -7), now: noon(H) };
    await person({ checkins: [H] });
    let next = await lumaSync.findNextLumaSync(pool, opts);
    assert.equal(next.state, "stand_down");
    assert.equal(next.holiday, true);
    assert.match(next.message, /^Nothing to add, stand down\. It's the holiday break \(December 22 to January 4\)/);
    assert.equal((await lumaSync.getLumaSync(pool, H, opts)).applies, false);

    await owner.query("insert into events (event_date) values ($1)", [H]); // the override
    next = await lumaSync.findNextLumaSync(pool, opts);
    assert.equal(next.sync?.date, H, "a saved row on a holiday date is an Event");
  });

  test("Done marks everyone listed On Luma in the same transaction; only the ids the agent saw; audited", async () => {
    const T = tuesday("2014-03-01");
    const now = noon(addDays(T, 0));
    const opts = { today: T, launch: T, now };
    const a = await person({ checkins: [T] });
    const b = await person({ checkins: [T] });
    const joinedSince = await person({ checkins: [T] });

    // A failed audit insert rolls the On Luma marks back.
    const name = "fail_luma_sync_audit";
    await owner.query(`create function ${name}() returns trigger language plpgsql as $$
      begin if new.target_id = '${T}' then raise exception 'forced audit failure'; end if; return new; end $$`);
    await owner.query(`create trigger ${name} before insert on audit_log for each row execute function ${name}()`);
    try {
      await assert.rejects(lumaSync.markDone(actor.id, T, { ...opts, attendeeIds: [a.id, b.id] }), /forced audit failure/);
    } finally {
      await owner.query(`drop trigger ${name} on audit_log`);
      await owner.query(`drop function ${name}()`);
    }
    assert.equal(await onLumaAt(a.id), null);
    assert.equal(await syncRow(T), null);

    const r = await lumaSync.markDone(actor.id, T, { ...opts, attendeeIds: [a.id, b.id, a.id] });
    assert.deepEqual([r.people, r.attendeeIds], [2, [a.id, b.id].sort()]);
    assert.equal((await onLumaAt(a.id)).getTime(), now.getTime());
    assert.equal((await onLumaAt(b.id)).getTime(), now.getTime());
    assert.equal(await onLumaAt(joinedSince.id), null, "not on the page the agent saw: still to add");
    assert.deepEqual(await syncRow(T), { status: "done", note: null, updated_by: actor.id });
    const s = await lumaSync.getLumaSync(pool, T, opts);
    assert.deepEqual([s.status, s.people.map((p) => p.id)], ["todo", [joinedSince.id]]);

    await assert.rejects(lumaSync.markError(actor.id, T, "  ", opts), (e) => e.status === 400 && /Write what went wrong/.test(e.errors.note));
    const e = await lumaSync.markError(actor.id, T, `${joinedSince.email} not found`, opts);
    assert.deepEqual(e, { date: T, note: `${joinedSince.email} not found`, people: 1, before: "done" });
    const marked = await lumaSync.markDone(actor.id, T, opts);
    assert.deepEqual([marked.people, marked.before], [1, "error"]);
    assert.equal((await onLumaAt(a.id)).getTime(), now.getTime(), "never touched again");

    assert.deepEqual(await audits(T), [
      { actor_user_id: actor.id, action: "luma_sync.done", target_table: "luma_syncs",
        details: { people: 2, attendeeIds: [a.id, b.id].sort(), before: null } },
      { actor_user_id: actor.id, action: "luma_sync.error", target_table: "luma_syncs",
        details: { people: 1, note: `${joinedSince.email} not found`, before: "done" } },
      { actor_user_id: actor.id, action: "luma_sync.done", target_table: "luma_syncs",
        details: { people: 1, attendeeIds: [joinedSince.id], before: "error" } },
    ]);
  });

  test("the Error push (#74): one push after Error is saved, none on Done, a failed push still saves", async () => {
    const T = tuesday("2014-06-01");
    const opts = { today: addDays(T, 1), launch: addDays(T, -7), now: noon(addDays(T, 1)) };
    const a = await person({ checkins: [T] });
    const env = { SOCIAL_ALERT_NTFY_TOPIC: "bocc-secret-topic", BETTER_AUTH_URL: "https://716coffee.club" };
    const post = (form, ntfy) => lumaSyncPages.handleLumaSyncPost(new Request("http://x/", {
      method: "POST", body: new URLSearchParams(form),
    }), actor.id, "/admin/luma-sync/next/", { ...opts, ntfy });
    const quiet = async (fn) => {
      const { log, info, error } = console;
      console.log = console.info = console.error = () => {};
      try { return await fn(); } finally { Object.assign(console, { log, info, error }); }
    };

    // The push happens after the commit: the fetch sees the Error already stored.
    const calls = [];
    const f = async (url, init) => { calls.push({ url, body: JSON.parse(init.body), row: await syncRow(T) }); return new Response("{}"); };
    const r = await quiet(() => post({ action: "error", date: T, note: "  Luma refused the import  " }, { env, fetch: f }));
    assert.equal(r.response.status, 303);
    assert.equal(calls.length, 1, "exactly one push");
    assert.equal(calls[0].url, "https://ntfy.sh/");
    assert.equal(calls[0].row.status, "error", "sent after the commit");
    assert.match(calls[0].body.title, /^BOCC Luma sync: Error for /);
    assert.ok(calls[0].body.message.startsWith("Luma refused the import"));
    assert.equal(calls[0].body.click, `https://716coffee.club/admin/events/${T}/`);

    // Done never pushes.
    const d = await quiet(() => post({ action: "done", date: T, attendeeId: a.id }, { env, fetch: f }));
    assert.equal(d.response.status, 303);
    assert.equal(calls.length, 1, "Done sends no push");

    // A failing push is logged, the Error is still saved and the page still redirects.
    await person({ checkins: [T] });
    const failing = async () => { throw new TypeError("network down"); };
    const e = await quiet(() => post({ action: "error", date: T, note: "second try failed" }, { env, fetch: failing }));
    assert.equal(e.response.status, 303);
    assert.deepEqual([(await syncRow(T)).status, (await syncRow(T)).note], ["error", "second try failed"]);

    // No topic: nothing sent, nothing thrown.
    const g = async () => { throw new Error("must not be called"); };
    const n = await quiet(() => post({ action: "error", date: T, note: "no topic" }, { env: {}, fetch: g }));
    assert.equal(n.response.status, 303);
    assert.equal((await syncRow(T)).note, "no topic");
  });
});

// ── 3. Over HTTP, through astro dev ─────────────────────────────────────────
describe("the Luma sync page over HTTP", { timeout: 300_000 }, () => {
  let server, admin, email, social, both, norole;
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const today = todayEastern();
  // The latest Tuesday outside the holiday break, on or before today: the launch, so
  // that Tuesday's sync is the oldest the page can hand out.
  const T = (() => {
    let d = today;
    while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 2 || isHolidayWeek(d)) d = addDays(d, -1);
    return d;
  })();
  let p1, p2;

  before(async () => {
    process.env.LUMA_SYNC_LAUNCH_DATE = T;
    const { dev } = await import("astro");
    server = await dev({ root, logLevel: "error", server: { port, host: "localhost" }, devToolbar: { enabled: false } });
    admin = await signedIn(["admin"]);
    email = await signedIn(["email"]);
    social = await signedIn(["social"]);
    both = await signedIn(["social", "email"]);
    norole = await signedIn([]);
    p1 = await person({ checkins: [T], name: "Zed <b>First</b>" });
    p2 = await person({ checkins: [T], name: "Yan Second" });
  });
  after(async () => { await server?.stop(); delete process.env.LUMA_SYNC_LAUNCH_DATE; });

  const req = (path, { cookie, method = "GET", form, origin = BASE } = {}) => {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    let body;
    if (method === "POST") {
      if (origin) headers.origin = origin;
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = form instanceof URLSearchParams ? form.toString() : new URLSearchParams(form ?? {}).toString();
    }
    return fetch(`${BASE}${path}`, { method, headers, body, redirect: "manual" });
  };
  const inner = (html, tag, id) => new RegExp(`<${tag} id="${id}"[^>]*>([\\s\\S]*?)</${tag}>`).exec(html)?.[1] ?? null;
  const PAGE = "/admin/luma-sync/next/";
  /** The page's HTML without Astro's scoped-style attributes. */
  const body = async (res) => (await res.text()).replace(/ data-astro-cid-\w+/g, "");

  test("the email role reaches only the Luma sync pages", async () => {
    const r = await req(PAGE);
    assert.equal(r.status, 302);
    assert.match(r.headers.get("location"), /^\/login\/\?next=/);
    assert.equal((await req(PAGE, { cookie: norole.cookie })).status, 403);

    for (const p of ["/admin/", "/admin/account/", PAGE, "/api/admin/me"]) {
      assert.equal((await req(p, { cookie: email.cookie })).status, 200, p);
      assert.equal((await req(p, { cookie: admin.cookie })).status, 200, `admin ${p}`);
    }
    const idx = await req("/admin/luma-sync/", { cookie: email.cookie });
    assert.equal(idx.status, 302);
    assert.equal(idx.headers.get("location"), PAGE);

    for (const p of ["/admin/email-list/", "/admin/attendees/", `/admin/attendees/${p1.id}/`, "/admin/events/", `/admin/events/${T}/`,
      "/admin/checkins/", "/admin/streaks/", "/admin/users/", "/admin/social/next/", "/api/admin/email-list.csv", "/api/admin/social/next"]) {
      assert.equal((await req(p, { cookie: email.cookie })).status, 403, p);
    }
    for (const [p, form] of [["/api/admin/email-list.csv", {}], ["/api/admin/email-list/opt-out", { attendeeId: p1.id }],
      [`/admin/events/${T}/`, { action: "event", status: "scheduled" }], [`/admin/attendees/${p1.id}/`, { name: "Changed" }]]) {
      assert.equal((await req(p, { cookie: email.cookie, method: "POST", form })).status, 403, p);
    }
    assert.equal((await owner.query("select ok_to_email from attendees where id = $1", [p1.id])).rows[0].ok_to_email, true);

    const home = await (await req("/admin/", { cookie: email.cookie })).text();
    assert.ok(home.includes(`href="${PAGE}"`), "the Luma sync link");
    for (const p of ["/admin/social/", "/admin/email-list/", "/admin/events/", "/admin/attendees/", "/admin/users/"]) {
      assert.ok(!home.includes(`href="${p}`), `no link to ${p}`);
    }
    assert.equal((await req(PAGE, { cookie: social.cookie })).status, 403, "social alone is refused");
    const adminHome = await (await req("/admin/", { cookie: admin.cookie })).text();
    assert.ok(adminHome.includes(`href="${PAGE}"`), "admins see the Luma sync link too");
  });

  test("social+email reaches both sets of pages, and still not the data views", async () => {
    for (const p of [PAGE, "/admin/social/next/", "/admin/social/verify/", "/api/admin/social/next"]) {
      assert.equal((await req(p, { cookie: both.cookie })).status, 200, p);
    }
    for (const p of ["/admin/email-list/", "/admin/attendees/", "/admin/events/", "/api/admin/email-list.csv"]) {
      assert.equal((await req(p, { cookie: both.cookie })).status, 403, p);
    }
    const home = await (await req("/admin/", { cookie: both.cookie })).text();
    assert.ok(home.includes(`href="${PAGE}"`) && home.includes('href="/admin/social/next/"'));
  });

  test("the agent page: markup, Origin, Error needs a note, PRG, then stand down", async () => {
    const res = await req(PAGE, { cookie: email.cookie });
    assert.equal(res.status, 200);
    const html = await body(res);
    assert.ok(html.includes(`id="event-date" data-date="${T}"`), "the oldest unfinished sync");
    assert.ok(html.includes('id="status" data-status="todo"') && html.includes(">To do</dd>"));
    assert.ok(html.includes(`href="${rules.LUMA_PEOPLE_URL}"`));
    assert.ok(html.includes(`<tr data-email="${p1.email}"><td>Zed &lt;b&gt;First&lt;/b&gt;</td><td>${p1.email}</td></tr>`), "escaped name and email");
    const line = inner(html, "pre", "emails");
    const emails = line.split(" ");
    assert.ok(emails.includes(p1.email) && emails.includes(p2.email) && !/[,\n]/.test(line), "one space-separated line");
    assert.ok(emails.indexOf(p1.email) < emails.indexOf(p2.email));
    assert.ok(/<button type="submit" id="button-done">Mark Done<\/button>/.test(html));
    assert.ok(/<button type="submit" id="button-error">Mark Error<\/button>/.test(html));
    assert.ok(html.includes('<label for="note">Error note'));
    assert.ok(!html.includes("716-555-0142") && !html.includes("Secret Biz Co"), "no phone or business name");
    assert.ok(!/<script(?![^>]*\bsrc=)/.test(html), "no inline script");
    for (const p of ["/admin/attendees", "/admin/email-list", "/admin/events"]) assert.ok(!html.includes(`href="${p}`), p);

    const wrong = await req(PAGE, { cookie: email.cookie, method: "POST", origin: "https://evil.example", form: { action: "error", date: T, note: "x" } });
    assert.equal(wrong.status, 403);
    const noOrigin = await req(PAGE, { cookie: email.cookie, method: "POST", origin: null, form: { action: "error", date: T, note: "x" } });
    assert.equal(noOrigin.status, 403);
    assert.equal(await syncRow(T), null);

    const noNote = await req(PAGE, { cookie: email.cookie, method: "POST", form: { action: "error", date: T, note: "  " } });
    assert.equal(noNote.status, 400);
    assert.ok((await body(noNote)).includes('id="note-error">Write what went wrong'));
    assert.equal(await syncRow(T), null);
    assert.equal((await req(PAGE, { cookie: email.cookie, method: "POST", form: { action: "nope", date: T } })).status, 400);

    const err = await req(PAGE, { cookie: email.cookie, method: "POST", form: { action: "error", date: T, note: `${p2.email} missing` } });
    assert.equal(err.status, 303);
    assert.equal(err.headers.get("location"), `${PAGE}?notice=error&date=${T}`);
    assert.deepEqual(await syncRow(T), { status: "error", note: `${p2.email} missing`, updated_by: email.user.id });
    const [audit] = await audits(T);
    assert.deepEqual([audit.actor_user_id, audit.action], [email.user.id, "luma_sync.error"]);
    const back = await body(await req(`${PAGE}?notice=error&date=${T}`, { cookie: email.cookie }));
    assert.ok(back.includes(`Marked the Luma sync for ${T} Error.`));
    assert.ok(back.includes('data-status="error"') && inner(back, "pre", "previous-error-note") === `${p2.email} missing`);
    assert.ok(back.includes('id="next-step" data-step="stop"'), "stop after marking Error, not loop");
    const plain = await body(await req(PAGE, { cookie: email.cookie }));
    assert.ok(plain.includes(`data-date="${T}"`) && plain.includes('data-step="add"'), "the Error is still handed out");

    // Mark Done with the people the page listed, then loop until stand down (another test
    // file's check-in today can add a sync of today's).
    let page = plain;
    for (let i = 0; i < 10 && page.includes('id="form-done"'); i++) {
      const form = new URLSearchParams({ action: "done", date: /id="event-date" data-date="([\d-]+)"/.exec(page)[1] });
      for (const [, id] of page.matchAll(/name="attendeeId" value="([0-9a-f-]+)"/g)) form.append("attendeeId", id);
      const done = await req(PAGE, { cookie: email.cookie, method: "POST", form });
      assert.equal(done.status, 303);
      assert.match(done.headers.get("location"), /^\/admin\/luma-sync\/next\/\?notice=done&date=[\d-]+&people=\d+$/);
      page = await body(await req(done.headers.get("location"), { cookie: email.cookie }));
      assert.ok(page.includes('id="notice"') && page.includes("now On Luma."));
    }
    assert.ok(await onLumaAt(p1.id) && await onLumaAt(p2.id), "everyone listed is On Luma");
    assert.equal((await syncRow(T)).status, "done");
    assert.ok(page.includes('<h2 id="h-stand-down">Nothing to add, stand down.</h2>'));
    assert.ok(page.includes(`data-holiday="${isHolidayWeek(today)}"`));
    assert.ok(!page.includes('id="form-done"'));
  });
});
