// The LinkedIn connection (ADR 0012 decision 4, issue #23) against the throwaway
// database (npm run test:db):
//   1. migration 20261124120000_linkedin_connections.sql: grants (admin_app all four,
//      nobody else anything), one row per user
//   2. src/lib/linkedin/linkedin.mjs as admin_app with a fake LinkedIn client: connect,
//      reconnect, disconnect, the token encrypted at rest, connection status, audit rows
//   3. /api/admin/linkedin/{connect,callback,disconnect} and the status on the event
//      page and /admin/account/ over HTTP (astro dev): state cookie, role checks, Origin,
//      and that no token, code or state reaches a log line
// The pure rules (expiry, state signing, encryption, env, client) are in
// linkedin-unit.test.mjs and linkedin-client-unit.test.mjs.
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
const row = (userId) => owner.query(`select * from linkedin_connections where user_id = $1`, [userId]).then((r) => r.rows[0] ?? null);
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
describe("migration 20261124120000_linkedin_connections.sql", () => {
  test("grants: admin_app SELECT, INSERT, UPDATE, DELETE, and nobody else anything", async () => {
    const { rows } = await owner.query(
      `select g.grantee || ':' || g.privilege_type as g
         from information_schema.role_table_grants g
         join pg_class c on c.relname = g.table_name and c.relnamespace = 'public'::regnamespace
        where g.table_schema = 'public' and g.table_name = 'linkedin_connections'
          and g.grantee <> pg_get_userbyid(c.relowner)
        order by 1`);
    assert.deepEqual(rows.map((r) => r.g), ["admin_app:DELETE", "admin_app:INSERT", "admin_app:SELECT", "admin_app:UPDATE"]);
    const { rows: cols } = await owner.query(
      `select grantee from information_schema.column_privileges
        where table_schema = 'public' and table_name = 'linkedin_connections' and grantee <> 'admin_app'
          and grantee <> (select tableowner from pg_tables where tablename = 'linkedin_connections')`);
    assert.deepEqual(cols, []);
  });

  test("as each role: admin_app may read and write; checkin_writer, site_reader and social_checker can't read", async () => {
    const user = await newUser();
    const admin = await connect(ADMIN_URL);
    const others = await Promise.all([CHECKIN_URL, SITE_URL, SOCIAL_CHECK_URL].filter(Boolean).map(connect));
    try {
      await inRollback(admin, async () => {
        await admin.query(
          `insert into linkedin_connections (user_id, token_ciphertext, expires_at, member_urn, display_name)
           values ($1, $2, now() + interval '60 days', 'urn:li:person:x1', 'X')`, [user.id, Buffer.alloc(40, 1)]);
        await assertRefused(admin,
          `insert into linkedin_connections (user_id, token_ciphertext, expires_at, member_urn, display_name)
           values ($1, $2, now(), 'urn:li:person:x2', 'Y')`, [user.id, Buffer.alloc(40, 1)], /duplicate key/);
        await assertAllowed(admin, `update linkedin_connections set display_name = 'Z' where user_id = $1`, [user.id]);
        await assertAllowed(admin, `delete from linkedin_connections where user_id = $1`, [user.id]);
        await assertRefused(admin, `truncate linkedin_connections`);
      });
      for (const db of others) {
        await db.query("begin");
        await assertRefused(db, `select * from linkedin_connections limit 1`);
        await assertRefused(db, `select user_id, expires_at from linkedin_connections limit 1`);
        await db.query("rollback");
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
    const { rows: [asText] } = await owner.query(`select row_to_json(c)::text as t from linkedin_connections c where user_id = $1`, [user.id]);
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
    const { rows } = await owner.query(`select count(*)::int as n from linkedin_connections where user_id = $1`, [user.id]);
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

  test("connectionStatus: none, ok, amber under 7 days, red once expired", async () => {
    const user = await newUser();
    assert.equal(await li.connectionStatus(pool, user.id, { now }), null);
    const s = stateFor(user.id, "account", now);
    await li.finishConnect(user.id, { code: "c", ...s }, { config, baseURL: BASE, client: createFakeLinkedInClient({ expiresIn: 10 * 86400, profile: { memberUrn: "urn:li:person:q", name: "Q Person" } }), now });
    const at = (days) => new Date(now.getTime() + days * 86400_000);
    assert.deepEqual(await li.connectionStatus(pool, user.id, { now }), {
      name: "Q Person", memberUrn: "urn:li:person:q", expiresAt: at(10), level: "ok", daysLeft: 10,
    });
    assert.equal((await li.connectionStatus(pool, user.id, { now: at(4) })).level, "amber");
    assert.equal((await li.connectionStatus(pool, user.id, { now: at(11) })).level, "red");
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
});
