// The Luma sync section on the Admin event page's Post Event tab (ADR 0014, spec #70,
// ticket #75), over HTTP through astro dev against the throwaway database (npm run test:db):
//   - the section on every Event: To do with everyone who joined (On Luma or not, with
//     Date added and On Luma), Cancelled (Nothing to add, no button), Upcoming (read-only),
//     Error (its note), before launch and a date that isn't an Event
//   - the manual Done: Origin-checked, admin only (social and email refused), audited as
//     the Admin, marks the people On Luma, 303 to ?tab=post; refused (409) for Cancelled
//     and Upcoming Events
// Dates: a random run of Tuesdays in 2017-2019 (launch 2016-01-05), so other test files'
// data and a re-run against a database left up don't interfere; Upcoming from 2045.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
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
const LAUNCH = "2016-01-05";
process.env.LUMA_SYNC_LAUNCH_DATE = LAUNCH;

const { pool } = await import("../../src/lib/auth/auth.mjs");
const { handleAuthRequest } = await import("../../src/lib/auth/handler.mjs");
const { withAudit } = await import("../../src/lib/admin/db.mjs");
const { createUser, grantRole } = await import("../../src/lib/admin/users.mjs");
const { isHolidayWeek } = await import("../../src/lib/holiday-weeks.mjs");
const ls = await import("../../src/lib/admin/luma-sync.mjs");

const PASSWORD = "correct horse battery staple";
const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** A random Tuesday from `start` (a Tuesday), with the next `weeks` Tuesdays outside the holiday break too. */
function tuesdays(start, span, weeks) {
  for (;;) {
    const t = addDays(start, 7 * randomInt(0, span));
    const run = Array.from({ length: weeks }, (_, i) => addDays(t, 7 * i));
    if (!run.some(isHolidayWeek)) return run;
  }
}
const [T, C, E] = tuesdays("2017-01-03", 150, 3);
const [U] = tuesdays("2045-01-03", 200, 1);
const PRE = tuesdays("2015-01-06", 40, 1)[0];

let owner;
let checkinSeq = 0;
async function person({ checkins = [], beforeLaunch = false, onLumaAt = null, name } = {}) {
  const email = `${unique("lumaev")}@example.com`;
  const n = name ?? `Ev ${unique("Pe")}`;
  const { rows: [a] } = await owner.query(
    `insert into attendees (email, name, phone, business_name, ok_to_email, on_luma_before_launch, on_luma_at)
     values ($1, $2, '716-555-0142', 'Biz Co', true, $3, $4) returning id`, [email, n, beforeLaunch, onLumaAt]);
  for (const d of checkins) {
    await owner.query(
      `insert into checkins (attendee_id, event_id, token, checkin_date, checkin_at)
       values ($1, 'bocc', 'tok', $2::date, ($2::date + time '12:00') at time zone 'America/New_York' + interval '1 second' * $3)`,
      [a.id, d, ++checkinSeq]);
  }
  return { id: a.id, email, name: n };
}
const onLuma = (id) => owner.query("select on_luma_at from attendees where id = $1", [id]).then((r) => r.rows[0].on_luma_at);
const syncRow = (d) => owner.query("select status, note, updated_by from luma_syncs where event_date = $1", [d]).then((r) => r.rows[0] ?? null);
const audits = (d) => owner.query(
  `select actor_user_id, action, details from audit_log where target_table = 'luma_syncs' and target_id = $1 order by id`, [d])
  .then((r) => r.rows);

let ipCounter = 0;
const nextIp = () => `198.24.${Math.floor(++ipCounter / 250)}.${ipCounter % 250 + 1}`;
async function signedIn(roles) {
  const user = await createUser({ email: `${unique("lse")}@example.com`, name: "Luma Event Test", password: PASSWORD });
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

describe("the Luma sync section on the Admin event page", { timeout: 300_000 }, () => {
  let server, admin, email, social, both;
  const root = fileURLToPath(new URL("../../", import.meta.url));

  before(async () => {
    owner = await connect(OWNER_URL);
    const { dev } = await import("astro");
    server = await dev({ root, logLevel: "error", server: { port, host: "localhost" }, devToolbar: { enabled: false } });
    admin = await signedIn(["admin"]);
    email = await signedIn(["email"]);
    social = await signedIn(["social"]);
    both = await signedIn(["social", "email"]);
  });
  after(async () => { await server?.stop(); await owner?.end(); await pool.end(); });

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
  const page = (d) => `/admin/events/${d}/`;
  const html = async (res) => (await res.text()).replace(/ data-astro-cid-\w+/g, "");
  const get = async (d, tab = "post") => {
    const res = await req(`${page(d)}?tab=${tab}`, { cookie: admin.cookie });
    assert.equal(res.status, 200, `GET ${d}`);
    return html(res);
  };
  const row = (h, id) => new RegExp(`<tr data-attendee="${id}">([\\s\\S]*?)</tr>`).exec(h)?.[1] ?? null;
  const DONE = { action: "luma_sync_done" };

  test("To do: everyone who joined, On Luma or not; the manual Done is Origin-checked, admin only, audited, PRG to ?tab=post", async () => {
    const p1 = await person({ checkins: [T], name: "Zed <b>First</b>" });
    const p2 = await person({ checkins: [T] });
    const already = await person({ checkins: [T], beforeLaunch: true });
    const recorded = await person({ checkins: [T], onLumaAt: new Date(`${T}T22:00:00Z`) });
    const returning = await person({ checkins: [addDays(T, -7), T] });

    const h = await get(T);
    assert.ok(h.includes('id="h-luma-sync"'));
    assert.ok(h.includes('id="luma-sync-status" data-status="todo">To do</strong>'));
    for (const p of [p1, p2, already, recorded]) assert.ok(row(h, p.id), `${p.email} listed`);
    assert.equal(row(h, returning.id), null, "a returning Attendee didn't join at this Event");
    assert.ok(row(h, p1.id).includes(">Zed &lt;b&gt;First&lt;/b&gt;</a></td>"), "escaped name");
    assert.ok(row(h, p1.id).includes(`<td>${p1.email}</td><td>${T}</td><td>Not yet</td>`), "email, Date added, On Luma");
    assert.ok(row(h, already.id).includes("<td>Before launch</td>"));
    assert.match(row(h, recorded.id), /<td>On Luma since [^<]+<\/td>/);
    assert.ok(h.includes('<button type="submit" id="button-luma-sync-done">Mark Done (handled by hand)</button>'));
    assert.ok(!(await get(T, "info")).includes('id="h-luma-sync"'), "only on the Post Event tab");

    // Refusals: no change at all.
    assert.equal((await req(page(T), { cookie: admin.cookie, method: "POST", form: DONE, origin: "https://evil.example" })).status, 403);
    assert.equal((await req(page(T), { cookie: admin.cookie, method: "POST", form: DONE, origin: null })).status, 403);
    for (const u of [social, email, both]) {
      assert.equal((await req(page(T), { cookie: u.cookie, method: "POST", form: DONE })).status, 403);
      assert.equal((await req(`${page(T)}?tab=post`, { cookie: u.cookie })).status, 403);
    }
    assert.equal((await req(page(T), { method: "POST", form: DONE })).status, 302, "signed out: to the login page");
    assert.equal(await syncRow(T), null);
    assert.equal(await onLuma(p1.id), null);

    const res = await req(page(T), { cookie: admin.cookie, method: "POST", form: DONE });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), `${page(T)}?tab=post&notice=luma_sync_done#luma-sync`);
    assert.deepEqual(await syncRow(T), { status: "done", note: null, updated_by: admin.user.id });
    assert.ok(await onLuma(p1.id) && await onLuma(p2.id), "the listed people are On Luma");
    assert.equal((await onLuma(recorded.id)).toISOString(), new Date(`${T}T22:00:00Z`).toISOString(), "never touched again");
    assert.equal(await onLuma(already.id), null, "Before launch stays as it was");
    const [audit, ...more] = await audits(T);
    assert.equal(more.length, 0);
    assert.deepEqual([audit.actor_user_id, audit.action, audit.details.people, audit.details.before],
      [admin.user.id, "luma_sync.done", 2, null]);
    assert.deepEqual(audit.details.attendeeIds, [p1.id, p2.id].sort());

    const back = await html(await req(res.headers.get("location"), { cookie: admin.cookie }));
    assert.ok(back.includes("Luma sync marked Done."));
    assert.ok(back.includes('aria-current="page">Post Event'));
    assert.ok(back.includes('data-status="done">Done</strong>'));
    assert.match(row(back, p1.id), /<td>On Luma since [^<]+<\/td>/);
    assert.ok(!back.includes('id="form-luma-sync-done"'), "nothing left to mark");
  });

  test("Error: the note, and the manual Done clears it", async () => {
    const p = await person({ checkins: [E] });
    await ls.markError(admin.user.id, E, `${p.email} <missing>`);
    const h = await get(E);
    assert.ok(h.includes('data-status="error">Error</strong>'));
    assert.ok(h.includes(`<pre id="luma-sync-note">${p.email} &lt;missing&gt;</pre>`));
    assert.ok(h.includes('id="form-luma-sync-done"'));
    assert.equal((await req(page(E), { cookie: admin.cookie, method: "POST", form: DONE })).status, 303);
    assert.equal((await syncRow(E)).status, "done");
    assert.ok(await onLuma(p.id));
    assert.ok(!(await get(E)).includes('id="luma-sync-note"'), "the note shows only while Error");
  });

  test("Cancelled: Nothing to add, still lists who joined, no button, Done refused", async () => {
    const p = await person({ checkins: [C] });
    await owner.query(`insert into events (event_date, status, cancel_reason) values ($1, 'cancelled', 'weather')`, [C]);
    const h = await get(C);
    assert.ok(h.includes('data-status="nothing_to_add">Nothing to add</strong>'));
    assert.ok(h.includes("the Event was Cancelled"));
    assert.ok(row(h, p.id));
    assert.ok(!h.includes('id="form-luma-sync-done"'));
    const res = await req(page(C), { cookie: admin.cookie, method: "POST", form: DONE });
    assert.equal(res.status, 409);
    const refused = await html(res);
    assert.ok(refused.includes("was Cancelled") && refused.includes('aria-current="page">Post Event'));
    assert.equal(await syncRow(C), null);
    assert.equal(await onLuma(p.id), null);
  });

  test("Upcoming: read-only; before launch and a non-Event date: no sync", async () => {
    const h = await get(U);
    assert.ok(h.includes('id="h-luma-sync"') && h.includes('data-status="nothing_to_add"'));
    assert.ok(h.includes('id="luma-sync-readonly"'));
    assert.ok(!h.includes('id="form-luma-sync-done"'));
    assert.equal((await req(page(U), { cookie: admin.cookie, method: "POST", form: DONE })).status, 409);
    assert.equal(await syncRow(U), null);

    const pre = await get(PRE);
    assert.ok(pre.includes(`Events before ${LAUNCH} don't have one.`) && !pre.includes('id="luma-sync-status"'));
    assert.equal((await req(page(PRE), { cookie: admin.cookie, method: "POST", form: DONE })).status, 409);

    const wed = addDays(T, 1);
    assert.ok((await get(wed)).includes("There is no Event on this date"));
    assert.equal((await req(page(wed), { cookie: admin.cookie, method: "POST", form: DONE })).status, 404);
  });
});
