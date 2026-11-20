// The LinkedIn authentication (ADR 0012 decision 4, issue #23; GLOSSARY.md, #58) against
// the throwaway database (npm run test:db):
//   1. table linkedin_authentications (migration 20261124120000_linkedin_connections.sql,
//      renamed by 20261203120000): grants (admin_app all four, nobody else anything), one
//      row per user
//   2. src/lib/linkedin/linkedin.mjs as admin_app with a fake LinkedIn client: authenticate,
//      re-authenticate, remove, the token encrypted at rest, authentication status, audit
//      rows, a token stored before the rename, and no use of the old-name view
//   3. /api/admin/linkedin/{connect,callback,disconnect} and the status on the event
//      page and /admin/account/ over HTTP (astro dev): state cookie, role checks, Origin,
//      and that no token, code or state reaches a log line
// The pure rules (expiry, state signing, encryption, env, client) are in
// linkedin-unit.test.mjs and linkedin-client-unit.test.mjs.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, hkdfSync, randomBytes } from "node:crypto";
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
process.env.LINKEDIN_TOKEN_KEY = "5".repeat(64);
delete process.env.LINKEDIN_LIVE;

const { pool } = await import("../../src/lib/auth/auth.mjs");
const { handleAuthRequest } = await import("../../src/lib/auth/handler.mjs");
const { withAudit } = await import("../../src/lib/admin/db.mjs");
const { createUser, grantRole } = await import("../../src/lib/admin/users.mjs");
const li = await import("../../src/lib/linkedin/linkedin.mjs");
const { decryptToken, signState } = await import("../../src/lib/linkedin/crypto.mjs");
const { setLinkedInClientForTests } = await import("../../src/lib/linkedin/client.mjs");
const { readLinkedInEnv } = await import("../../src/lib/linkedin/env.mjs");

const PASSWORD = "correct horse battery staple";
const SITE_URL = process.env.TEST_SITE_URL;
const SOCIAL_CHECK_URL = process.env.TEST_SOCIAL_CHECK_URL;
const { config } = readLinkedInEnv();
let owner;

const newUser = () => createUser({ email: `${unique("li")}@example.com`, name: "LinkedIn Test", password: PASSWORD });
const row = (userId) => owner.query(`select * from linkedin_authentications where user_id = $1`, [userId]).then((r) => r.rows[0] ?? null);
const audits = (userId) => owner.query(
  `select actor_user_id, action, details from audit_log where target_table = 'linkedin_connections' and target_id = $1 order by id`,
  [userId]).then((r) => r.rows);

/** A state cookie as connect would set it, and the callback's matching ?state=. */
function stateFor(userId, returnTo = "account", now = new Date()) {
  return signState({ key: config.tokenKey, userId, returnTo, now });
}

before(async () => {
  owner = await connect(OWNER_URL);
});
after(async () => { await owner?.end(); await pool.end(); });

// ── 1. Migration ────────────────────────────────────────────────────────────
describe("table linkedin_authentications (migrations 20261124120000, 20261203120000)", () => {
  test("grants: admin_app SELECT, INSERT, UPDATE, DELETE; social_checker only the expiry, user link and display name (#24)", async () => {
    const { rows } = await owner.query(
      `select g.grantee || ':' || g.privilege_type as g
         from information_schema.role_table_grants g
         join pg_class c on c.relname = g.table_name and c.relnamespace = 'public'::regnamespace
        where g.table_schema = 'public' and g.table_name = 'linkedin_authentications'
          and g.grantee <> pg_get_userbyid(c.relowner)
        order by 1`);
    assert.deepEqual(rows.map((r) => r.g), ["admin_app:DELETE", "admin_app:INSERT", "admin_app:SELECT", "admin_app:UPDATE"]);
    const { rows: cols } = await owner.query(
      `select grantee || ':' || privilege_type || ':' || column_name as g from information_schema.column_privileges
        where table_schema = 'public' and table_name = 'linkedin_authentications' and grantee <> 'admin_app'
          and grantee <> (select tableowner from pg_tables where tablename = 'linkedin_authentications')
        order by 1`);
    assert.deepEqual(cols.map((r) => r.g), ["social_checker:SELECT:display_name", "social_checker:SELECT:expires_at", "social_checker:SELECT:user_id"]);
  });

  test("as each role: admin_app may read and write; checkin_writer and site_reader can't read; social_checker never the token or URN", async () => {
    const user = await newUser();
    const admin = await connect(ADMIN_URL);
    const others = await Promise.all([CHECKIN_URL, SITE_URL].filter(Boolean).map(connect));
    try {
      await inRollback(admin, async () => {
        await admin.query(
          `insert into linkedin_authentications (user_id, token_ciphertext, expires_at, member_urn, display_name)
           values ($1, $2, now() + interval '60 days', 'urn:li:person:x1', 'X')`, [user.id, Buffer.alloc(40, 1)]);
        await assertRefused(admin,
          `insert into linkedin_authentications (user_id, token_ciphertext, expires_at, member_urn, display_name)
           values ($1, $2, now(), 'urn:li:person:x2', 'Y')`, [user.id, Buffer.alloc(40, 1)], /duplicate key/);
        await assertAllowed(admin, `update linkedin_authentications set display_name = 'Z' where user_id = $1`, [user.id]);
        await assertAllowed(admin, `delete from linkedin_authentications where user_id = $1`, [user.id]);
        await assertRefused(admin, `truncate linkedin_authentications`);
      });
      for (const db of others) {
        await db.query("begin");
        await assertRefused(db, `select * from linkedin_authentications limit 1`);
        await assertRefused(db, `select user_id, expires_at from linkedin_authentications limit 1`);
        await db.query("rollback");
      }
      // The Thursday check's role: the expiry, user link and display name, never the
      // token or member URN, nothing in auth (#24; the full social_checker checks are
      // in social-alert.test.mjs).
      if (SOCIAL_CHECK_URL) {
        const checker = await connect(SOCIAL_CHECK_URL);
        try {
          await checker.query("begin");
          await assertAllowed(checker, `select user_id, expires_at, display_name from linkedin_authentications limit 1`);
          await assertRefused(checker, `select token_ciphertext from linkedin_authentications limit 1`);
          await assertRefused(checker, `select member_urn from linkedin_authentications limit 1`);
          await assertRefused(checker, `select id, name from auth."user" limit 1`);
          await assertRefused(checker, `select * from linkedin_authentications limit 1`);
          await checker.query("rollback");
        } finally { await checker.end(); }
      }
    } finally {
      await admin.end();
      await Promise.all(others.map((db) => db.end()));
    }
  });
});

// ── 2. The use-case ─────────────────────────────────────────────────────────
describe("connect, reconnect, disconnect (use-case, fake client)", () => {
  const now = new Date("2026-11-19T15:00:00Z");

  test("startConnect sends the browser to LinkedIn with a state that only this user's cookie matches", async () => {
    const { location, cookie } = li.startConnect("user-a", { returnTo: "2026-11-24", config, baseURL: BASE, now });
    const u = new URL(location);
    assert.equal(u.origin + u.pathname, "https://www.linkedin.com/oauth/v2/authorization");
    assert.equal(u.searchParams.get("redirect_uri"), `${BASE}/api/admin/linkedin/callback`);
    assert.equal(u.searchParams.get("client_id"), config.clientId);
    assert.ok(u.searchParams.get("state"));
    assert.ok(!location.includes(config.clientSecret));
    assert.equal(cookie.name, li.STATE_COOKIE);
    assert.equal(cookie.maxAge, 600);
    assert.ok(!cookie.value.includes(u.searchParams.get("state")), "the state is inside the signed payload, not in the clear");
  });

  test("finishConnect stores the token encrypted, with expiry, URN and name, and audits it", async () => {
    const user = await newUser();
    const client = createFakeLinkedInClient({ accessToken: "AQV-first-token", expiresIn: 60 * 86400, profile: { memberUrn: "urn:li:person:abc1", name: "Zack G" } });
    const { state, cookie } = stateFor(user.id, "2026-11-24", now);
    const r = await li.finishConnect(user.id, { code: "the-code", state, cookie }, { config, baseURL: BASE, client, now });
    assert.deepEqual(r, { ok: true, returnTo: "2026-11-24", notice: "connected" });
    assert.deepEqual(client.ops(), ["exchangeCode", "getProfile"]);
    assert.deepEqual(client.calls[0].args[0], { code: "the-code", redirectUri: `${BASE}/api/admin/linkedin/callback` });
    assert.equal(client.calls[1].args[0], "AQV-first-token");

    const saved = await row(user.id);
    assert.equal(saved.member_urn, "urn:li:person:abc1");
    assert.equal(saved.display_name, "Zack G");
    assert.equal(saved.expires_at.toISOString(), "2027-01-18T15:00:00.000Z");
    // Encrypted at rest: the raw bytes don't contain the token, and they decrypt with the key.
    assert.ok(!saved.token_ciphertext.includes(Buffer.from("AQV-first-token")));
    const { rows: [asText] } = await owner.query(`select row_to_json(c)::text as t from linkedin_authentications c where user_id = $1`, [user.id]);
    assert.ok(!asText.t.includes("AQV-first-token"));
    assert.equal(decryptToken(saved.token_ciphertext, { key: config.tokenKey, userId: user.id }), "AQV-first-token");
    assert.equal(await li.accessToken(pool, user.id, { config, now }), "AQV-first-token");

    const log = await audits(user.id);
    assert.equal(log.length, 1);
    assert.equal(log[0].action, "linkedin_connection.connect");
    assert.equal(log[0].actor_user_id, user.id);
    assert.equal(log[0].details.reconnect, false);
    assert.ok(!JSON.stringify(log).includes("AQV-first-token") && !JSON.stringify(log).includes("the-code"));
  });

  test("reconnecting replaces the row (still one per user) and is audited as a reconnect", async () => {
    const user = await newUser();
    const first = createFakeLinkedInClient({ accessToken: "AQV-old" });
    let s = stateFor(user.id, "account", now);
    await li.finishConnect(user.id, { code: "c1", ...s }, { config, baseURL: BASE, client: first, now });
    const later = new Date(now.getTime() + 50 * 86400_000);
    const second = createFakeLinkedInClient({ accessToken: "AQV-new", profile: { memberUrn: "urn:li:person:abc1", name: "Renamed" } });
    s = stateFor(user.id, "account", later);
    assert.equal((await li.finishConnect(user.id, { code: "c2", ...s }, { config, baseURL: BASE, client: second, now: later })).ok, true);
    const { rows } = await owner.query(`select count(*)::int as n from linkedin_authentications where user_id = $1`, [user.id]);
    assert.equal(rows[0].n, 1);
    assert.equal(await li.accessToken(pool, user.id, { config, now: later }), "AQV-new");
    assert.equal((await row(user.id)).display_name, "Renamed");
    assert.deepEqual((await audits(user.id)).map((a) => [a.action, a.details.reconnect]),
      [["linkedin_connection.connect", false], ["linkedin_connection.connect", true]]);
  });

  test("a bad or missing state, or another user's cookie, is refused before LinkedIn is called", async () => {
    const user = await newUser();
    const client = createFakeLinkedInClient();
    const s = stateFor(user.id, "account", now);
    const other = stateFor("someone-else", "account", now);
    for (const input of [
      { code: "c", state: s.state, cookie: undefined },
      { code: "c", state: undefined, cookie: s.cookie },
      { code: "c", state: "wrong", cookie: s.cookie },
      { code: "c", state: other.state, cookie: other.cookie },
    ]) {
      assert.deepEqual(await li.finishConnect(user.id, input, { config, baseURL: BASE, client, now }), { ok: false, status: 400 });
    }
    assert.deepEqual(client.calls, []);
    assert.equal(await row(user.id), null);
  });

  test("LinkedIn's error=… (the member said no), a failed exchange, or missing scopes store nothing", async () => {
    const user = await newUser();
    const s = stateFor(user.id, "2026-11-24", now);
    const opts = (client) => ({ config, baseURL: BASE, client, now });

    const c1 = createFakeLinkedInClient();
    assert.deepEqual(await li.finishConnect(user.id, { ...s, error: "user_cancelled_login" }, opts(c1)),
      { ok: false, returnTo: "2026-11-24", notice: "cancelled" });
    assert.deepEqual(c1.calls, []);

    const c2 = createFakeLinkedInClient();
    c2.fail("exchangeCode", new LinkedInError("validation", "linkedin exchange_code answered HTTP 400"));
    assert.deepEqual(await li.finishConnect(user.id, { ...s, code: "c" }, opts(c2)), { ok: false, returnTo: "2026-11-24", notice: "failed" });

    const c3 = createFakeLinkedInClient({ scope: "openid,profile" });
    assert.deepEqual(await li.finishConnect(user.id, { ...s, code: "c" }, opts(c3)), { ok: false, returnTo: "2026-11-24", notice: "scopes" });

    const c4 = createFakeLinkedInClient();
    assert.deepEqual(await li.finishConnect(user.id, { ...s }, opts(c4)), { ok: false, returnTo: "2026-11-24", notice: "failed" });

    assert.equal(await row(user.id), null);
    assert.deepEqual(await audits(user.id), []);
  });

  test("authenticationStatus: none, ok, amber under 7 days, red once expired", async () => {
    const user = await newUser();
    assert.equal(await li.authenticationStatus(pool, user.id, { now }), null);
    const s = stateFor(user.id, "account", now);
    await li.finishConnect(user.id, { code: "c", ...s }, { config, baseURL: BASE, client: createFakeLinkedInClient({ expiresIn: 10 * 86400, profile: { memberUrn: "urn:li:person:q", name: "Q Person" } }), now });
    const at = (days) => new Date(now.getTime() + days * 86400_000);
    assert.deepEqual(await li.authenticationStatus(pool, user.id, { now }), {
      name: "Q Person", memberUrn: "urn:li:person:q", expiresAt: at(10), level: "ok", daysLeft: 10,
    });
    assert.equal((await li.authenticationStatus(pool, user.id, { now: at(4) })).level, "amber");
    assert.equal((await li.authenticationStatus(pool, user.id, { now: at(11) })).level, "red");
    await assert.rejects(li.accessToken(pool, user.id, { config, now: at(11) }), (err) => err.kind === "expired");
  });

  test("disconnect deletes the row, audited; a second disconnect changes nothing", async () => {
    const user = await newUser();
    const s = stateFor(user.id, "account", now);
    await li.finishConnect(user.id, { code: "c", ...s }, { config, baseURL: BASE, client: createFakeLinkedInClient(), now });
    assert.deepEqual(await li.disconnect(user.id), { changed: true });
    assert.equal(await row(user.id), null);
    assert.deepEqual(await li.disconnect(user.id), { changed: false });
    assert.deepEqual((await audits(user.id)).map((a) => a.action), ["linkedin_connection.connect", "linkedin_connection.disconnect"]);
    await assert.rejects(li.accessToken(pool, user.id, { config, now }), (err) => err.kind === "expired");
  });

  test("a token stored before the table rename still decrypts: no re-authenticating (#58)", async () => {
    const user = await newUser();
    // Sealed by hand the way the code of 2026-11-20 did it: HKDF-SHA256 of the key with the
    // label "bocc linkedin token v1", AES-256-GCM, associated data "linkedin_connections:<user id>".
    const key = Buffer.from(hkdfSync("sha256", config.tokenKey, Buffer.alloc(0), "bocc linkedin token v1", 32));
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(`linkedin_connections:${user.id}`));
    const ct = Buffer.concat([cipher.update("AQV-from-before-the-rename", "utf8"), cipher.final()]);
    const box = Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ct]);
    await owner.query(
      `insert into linkedin_authentications (user_id, token_ciphertext, expires_at, member_urn, display_name, connected_at)
       values ($1, $2, $3, 'urn:li:person:old1', 'Old Row', $4)`,
      [user.id, box, new Date(now.getTime() + 30 * 86400_000), new Date("2026-11-01T12:00:00Z")]);
    assert.equal(await li.accessToken(pool, user.id, { config, now }), "AQV-from-before-the-rename");
    assert.equal((await li.authenticationStatus(pool, user.id, { now })).name, "Old Row");
  });

  test("works without the old linkedin_connections view (dropped by #60): authenticate, read, Thursday check, remove", async () => {
    const user = await newUser();
    await owner.query(`revoke all on linkedin_connections from admin_app, social_checker`);
    const checker = SOCIAL_CHECK_URL ? await connect(SOCIAL_CHECK_URL) : null;
    try {
      const s = stateFor(user.id, "account", now);
      const r = await li.finishConnect(user.id, { code: "c", ...s },
        { config, baseURL: BASE, client: createFakeLinkedInClient({ accessToken: "AQV-new-table" }), now });
      assert.equal(r.ok, true);
      assert.equal((await li.authenticationStatus(pool, user.id, { now })).level, "ok");
      assert.equal(await li.accessToken(pool, user.id, { config, now }), "AQV-new-table");
      if (checker) {
        const { readLinkedInAuthentications } = await import("../../src/lib/social-alert/run.mjs");
        assert.ok((await readLinkedInAuthentications(checker)).length >= 1);
      }
      assert.deepEqual(await li.disconnect(user.id), { changed: true });
      // The audit trail is unchanged by the rename: same actions, same target label.
      assert.deepEqual((await audits(user.id)).map((a) => a.action), ["linkedin_connection.connect", "linkedin_connection.disconnect"]);
    } finally {
      await checker?.end();
      await owner.query(`grant select, insert, update, delete on linkedin_connections to admin_app;
        grant select (user_id, expires_at, display_name) on linkedin_connections to social_checker`);
    }
  });
});

// ── 3. Over HTTP ────────────────────────────────────────────────────────────
let ipCounter = 0;
const nextIp = () => `198.23.${Math.floor(++ipCounter / 250)}.${ipCounter % 250 + 1}`;
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

/** The page's text a person reads: no tags, attributes, scripts or styles. */
const visibleText = (html) => html.replace(/<(script|style)\b[\s\S]*?<\/\1>/g, " ").replace(/<[^>]*>/g, " ");

/** Capture every console line written while fn runs (astro dev is in this process). */
async function captureConsole(fn) {
  const lines = [];
  const saved = {};
  for (const k of ["log", "info", "warn", "error", "debug"]) {
    saved[k] = console[k];
    console[k] = (...a) => lines.push(a.map(String).join(" "));
  }
  try { return { result: await fn(), lines }; } finally { Object.assign(console, saved); }
}

describe("the LinkedIn routes and status over HTTP", { timeout: 300_000 }, () => {
  let server, admin, social, noRole, fake;
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const D = "2088-03-07"; // an event date for the Event Info tab (2086-2088 are free, testing notes)

  before(async () => {
    const { dev } = await import("astro");
    server = await dev({ root, logLevel: "error", server: { port, host: "localhost" } });
    admin = await signedIn(["admin"]);
    social = await signedIn(["social"]);
    noRole = await signedIn([]);
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
  const stateCookieOf = (res) => res.headers.getSetCookie().find((x) => x.startsWith(`${li.STATE_COOKIE}=`)) ?? null;
  const cleared = (res) => new RegExp(`${li.STATE_COOKIE}=; .*Max-Age=0`).test(res.headers.getSetCookie().join("\n"));

  /** Connect as `who`, ready to come back through the callback with a fresh fake client. */
  async function connectVia(who, returnTo = D, fakeOpts = {}) {
    fake = createFakeLinkedInClient(fakeOpts);
    setLinkedInClientForTests(fake);
    const start = await req(`/api/admin/linkedin/connect?return=${returnTo}`, { cookie: who.cookie });
    assert.equal(start.status, 302);
    const state = new URL(start.headers.get("location")).searchParams.get("state");
    const stateCookie = stateCookieOf(start).split(";")[0];
    return { state, stateCookie, callback: (q) => req(`/api/admin/linkedin/callback?${q}`, { cookie: `${who.cookie}; ${stateCookie}` }) };
  }

  test("connect: admin is sent to LinkedIn with a signed HttpOnly state cookie; others are refused", async () => {
    const res = await req(`/api/admin/linkedin/connect?return=${D}`, { cookie: admin.cookie });
    assert.equal(res.status, 302);
    const loc = new URL(res.headers.get("location"));
    assert.equal(loc.origin + loc.pathname, "https://www.linkedin.com/oauth/v2/authorization");
    assert.equal(loc.searchParams.get("redirect_uri"), `${BASE}/api/admin/linkedin/callback`);
    assert.equal(loc.searchParams.get("scope"), "r_events rw_events openid profile w_member_social");
    const cookie = stateCookieOf(res);
    assert.match(cookie, /; HttpOnly/);
    assert.match(cookie, /; SameSite=Lax/);
    assert.match(cookie, /; Path=\/api\/admin\/linkedin\//);
    assert.match(cookie, /; Max-Age=600/);
    assert.equal(res.headers.get("cache-control"), "no-store");

    assert.equal((await req(`/api/admin/linkedin/connect?return=https://evil.example/`, { cookie: admin.cookie })).status, 400);
    assert.equal((await req(`/api/admin/linkedin/connect?return=${D}`, { cookie: social.cookie })).status, 403);
    assert.equal((await req(`/api/admin/linkedin/connect?return=${D}`, { cookie: noRole.cookie })).status, 403);
    assert.equal((await req(`/api/admin/linkedin/connect?return=${D}`)).status, 401);
  });

  test("callback: a missing or mismatched state, or another user's cookie, is a 400 and LinkedIn isn't called", async () => {
    const { state, stateCookie } = await connectVia(admin);
    const other = await signedIn(["admin"]);
    const otherFlow = await connectVia(other);
    fake = createFakeLinkedInClient();
    setLinkedInClientForTests(fake);
    for (const [q, cookie] of [
      [`code=c&state=${state}`, admin.cookie],                                          // no state cookie
      [`code=c`, `${admin.cookie}; ${stateCookie}`],                                    // no state
      [`code=c&state=not-the-state`, `${admin.cookie}; ${stateCookie}`],                // mismatch
      [`code=c&state=${otherFlow.state}`, `${admin.cookie}; ${otherFlow.stateCookie}`], // another user's cookie
    ]) {
      const res = await req(`/api/admin/linkedin/callback?${q}`, { cookie });
      assert.equal(res.status, 400, q);
      assert.ok(cleared(res), "the state cookie is cleared");
    }
    assert.deepEqual(fake.calls, []);
    assert.equal(await row(admin.user.id), null);
  });

  test("callback: only Admins reach it (social and no-role 403, signed out 401)", async () => {
    const { state, stateCookie } = await connectVia(admin);
    fake = createFakeLinkedInClient();
    setLinkedInClientForTests(fake);
    for (const who of [social, noRole]) {
      assert.equal((await req(`/api/admin/linkedin/callback?code=c&state=${state}`, { cookie: `${who.cookie}; ${stateCookie}` })).status, 403);
    }
    assert.equal((await req(`/api/admin/linkedin/callback?code=c&state=${state}`, { cookie: stateCookie })).status, 401);
    assert.deepEqual(fake.calls, []);
  });

  test("callback success: stored, back to the Event Info tab, and no code, state or token in any log line", async () => {
    const who = await signedIn(["admin"]);
    const flow = await connectVia(who, D, { accessToken: "AQV-http-secret-token", profile: { memberUrn: "urn:li:person:httpUser", name: "Http Person" } });
    const { result: res, lines } = await captureConsole(() => flow.callback(`code=AQT-http-secret-code&state=${flow.state}`));
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), `/admin/events/${D}/?tab=info&linkedin=connected#linkedin`);
    assert.ok(cleared(res), "the state cookie is cleared");
    assert.deepEqual(fake.ops(), ["exchangeCode", "getProfile"]);
    assert.equal(fake.calls[0].args[0].code, "AQT-http-secret-code");
    assert.equal((await row(who.user.id)).display_name, "Http Person");
    assert.ok(lines.length > 0, "expected the request log line");
    for (const secret of ["AQT-http-secret-code", flow.state, "AQV-http-secret-token"]) {
      assert.ok(!lines.some((l) => l.includes(secret)), `a log line contains ${secret.slice(0, 8)}…`);
    }

    // The member said no: back with a notice, nothing stored.
    const declined = await signedIn(["admin"]);
    const f2 = await connectVia(declined, "account");
    const r2 = await f2.callback(`error=user_cancelled_login&error_description=x&state=${f2.state}`);
    assert.equal(r2.status, 303);
    assert.equal(r2.headers.get("location"), "/admin/account/?linkedin=cancelled#linkedin");
    assert.equal(await row(declined.user.id), null);
  });

  test("LinkedIn authentication on the Event Info tab and /admin/account/: authenticated, amber, red with Re-authenticate; not for the social role", async () => {
    const who = await signedIn(["admin"]);
    const page = async (path) => (await req(path, { cookie: who.cookie })).text();

    let html = await page(`/admin/events/${D}/?tab=info`);
    assert.match(html, /Not authenticated with LinkedIn\./);
    assert.match(html, /href="\/api\/admin\/linkedin\/connect\?return=2088-03-07"[^>]*>Authenticate with LinkedIn</);
    assert.doesNotMatch(visibleText(html), /connect/i, "GLOSSARY.md: LinkedIn authentication, never connection");

    const flow = await connectVia(who, D, { profile: { memberUrn: "urn:li:person:statusUser", name: "Status Person" } });
    await flow.callback(`code=c&state=${flow.state}`);
    html = await page(`/admin/events/${D}/?tab=info&linkedin=connected`);
    assert.match(html, /Authenticated with LinkedIn\./);
    assert.match(html, /Authenticated as Status Person\. The LinkedIn authentication expires on [A-Z][a-z]{2} \d{1,2}, \d{4} \(in (59|60) days\)/);
    assert.match(html, /data-linkedin-level="ok"/);
    assert.match(html, />Re-authenticate</);
    assert.match(html, />Remove LinkedIn authentication</);
    assert.doesNotMatch(visibleText(html), /connect/i);
    const account = await page("/admin/account/");
    assert.match(account, /Authenticated as Status Person\. The LinkedIn authentication expires on .* \(in (59|60) days\)/);
    assert.doesNotMatch(visibleText(account), /connect/i);
    assert.match(account, /href="\/api\/admin\/linkedin\/connect\?return=account"/);

    await owner.query(`update linkedin_authentications set expires_at = now() + interval '3 days 1 hour' where user_id = $1`, [who.user.id]);
    for (const p of [`/admin/events/${D}/?tab=info`, "/admin/account/"]) {
      html = await page(p);
      assert.match(html, /data-linkedin-level="amber"/);
      assert.match(html, /class="[^"]*linkedin-amber/);
      assert.match(html, /\(in 3 days\)/);
    }

    await owner.query(`update linkedin_authentications set expires_at = now() - interval '1 day' where user_id = $1`, [who.user.id]);
    for (const p of [`/admin/events/${D}/?tab=info`, "/admin/account/"]) {
      html = await page(p);
      assert.match(html, /data-linkedin-level="red"/);
      assert.match(html, /Authenticated as Status Person\. The LinkedIn authentication expired on .*\. Re-authenticate to use LinkedIn\./);
      assert.match(html, />Re-authenticate</);
    }

    const socialAccount = await (await req("/admin/account/", { cookie: social.cookie })).text();
    assert.doesNotMatch(socialAccount, /data-linkedin-level|Authenticate with LinkedIn|id="h-linkedin"/);
  });

  test("disconnect: Origin-checked, admin only, deletes the row and links to Permitted services", async () => {
    const who = await signedIn(["admin"]);
    const flow = await connectVia(who, "account");
    await flow.callback(`code=c&state=${flow.state}`);
    assert.ok(await row(who.user.id));

    assert.equal((await req("/api/admin/linkedin/disconnect", { cookie: who.cookie, method: "POST", form: { return: "account" }, origin: "https://evil.example" })).status, 403);
    assert.equal((await req("/api/admin/linkedin/disconnect", { cookie: social.cookie, method: "POST", form: { return: "account" } })).status, 403);
    assert.equal((await req("/api/admin/linkedin/disconnect", { cookie: who.cookie, method: "POST", form: { return: "nope" } })).status, 400);
    assert.ok(await row(who.user.id));

    const res = await req("/api/admin/linkedin/disconnect", { cookie: who.cookie, method: "POST", form: { return: D } });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), `/admin/events/${D}/?tab=info&linkedin=disconnected#linkedin`);
    assert.equal(await row(who.user.id), null);
    const html = await (await req(res.headers.get("location"), { cookie: who.cookie })).text();
    assert.match(html, /LinkedIn authentication removed\./);
    assert.match(html, /href="https:\/\/www\.linkedin\.com\/psettings\/permitted-services"/);
    assert.match(html, /Not authenticated with LinkedIn\./);
  });
});
