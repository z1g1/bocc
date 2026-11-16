// The shared Better Auth instance, the guard and the data-layer seam, running as
// admin_app against the throwaway database.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BASE_URL, OWNER_URL, connect, seedAttendee, unique, useAdminEnv } from "./helpers.mjs";

useAdminEnv();
const { auth, pool } = await import("../../src/lib/auth/auth.mjs");
const { handleAuthRequest } = await import("../../src/lib/auth/handler.mjs");
const { withAudit, writeAudit } = await import("../../src/lib/admin/db.mjs");
const { createUser, setUserPassword, grantRole, revokeRole, getUserRoles, listUsersWithRoles } =
  await import("../../src/lib/admin/users.mjs");
const { loadAdminContext } = await import("../../src/lib/admin/session.mjs");
const { guardRequest } = await import("../../src/lib/admin/guard.mjs");
const { requireRole } = await import("../../src/lib/admin/roles.mjs");

const PASSWORD = "correct horse battery staple";
let owner;

before(async () => { owner = await connect(OWNER_URL); });
after(async () => { await owner?.end(); await pool.end(); });

// Sign-in is limited to 5 per minute per IP, so each request gets its own fake IP
// unless a test pins one.
let ipCounter = 0;
const nextIp = () => `203.0.${113 + Math.floor(++ipCounter / 250)}.${ipCounter % 250 + 1}`;

const authRequest = (path, body, { ip = nextIp(), origin = BASE_URL, cookie, headers = {} } = {}) =>
  handleAuthRequest(new Request(`${BASE_URL}/api/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-nf-client-connection-ip": ip,
      ...(origin ? { origin } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  }));

const cookieFrom = (res) =>
  res.headers.getSetCookie().map((c) => c.split(";")[0]).filter((c) => !c.endsWith("=")).join("; ");

async function signIn(email, password = PASSWORD, opts) {
  const res = await authRequest("/sign-in/email", { email, password }, opts);
  return { res, cookie: cookieFrom(res) };
}

async function makeUser(roles = []) {
  const email = `${unique("user")}@example.com`;
  const user = await createUser({ email, name: "Test User", password: PASSWORD });
  for (const r of roles) await withAudit(null, (c) => grantRole(c, user.id, r), { action: "test.grant" });
  return user;
}

describe("Better Auth configuration", () => {
  test("public sign-up is refused, over HTTP and server-side", async () => {
    const res = await authRequest("/sign-up/email", { email: "x@example.com", password: PASSWORD, name: "X" });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "EMAIL_PASSWORD_SIGN_UP_DISABLED");
    await assert.rejects(auth.api.signUpEmail({ body: { email: "y@example.com", password: PASSWORD, name: "Y" } }));
  });

  test("password sign-in sets a 30-day session cookie and records the Netlify client IP", async () => {
    const user = await makeUser(["admin"]);
    const { res, cookie } = await signIn(user.email, PASSWORD, { ip: "198.51.100.7", headers: { "x-forwarded-for": "10.9.9.9" } });
    assert.equal(res.status, 200);
    const set = res.headers.getSetCookie().find((c) => c.startsWith("better-auth.session_token="));
    assert.match(set, /HttpOnly/i);
    assert.match(set, /SameSite=Lax/i);
    assert.match(set, /Max-Age=2592000/);
    const { rows: [s] } = await owner.query(
      `select "ipAddress", extract(epoch from ("expiresAt" - now()))::int as secs from auth.session where "userId" = $1`, [user.id]);
    assert.equal(s.ipAddress, "198.51.100.7");
    assert.ok(Math.abs(s.secs - 30 * 86400) < 120, `expires in ~30 days, got ${s.secs}s`);
    assert.ok(cookie.includes("better-auth.session_token="));
  });

  test("a sign-in from another origin is refused", async () => {
    const user = await makeUser(["admin"]);
    const { res } = await signIn(user.email, PASSWORD, { origin: "https://evil.example" });
    assert.equal(res.status, 403);
  });

  test("sign-in is rate limited per client IP, in the database, and X-Forwarded-For doesn't help", async () => {
    const ip = "192.0.2.77";
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const { res } = await signIn("nobody@example.com", "wrong password!!", { ip, headers: { "x-forwarded-for": `10.0.0.${i}` } });
      statuses.push(res.status);
    }
    assert.deepEqual(statuses.slice(0, 5).every((s) => s === 401), true, `first five: ${statuses}`);
    assert.equal(statuses[5], 429);
    const { rows } = await owner.query(`select count(*)::int as n from auth."rateLimit" where key like $1`, [`%${ip}%`]);
    assert.ok(rows[0].n >= 1, "counter stored in auth.rateLimit");
  });

  test("the admin plugin's HTTP endpoints are blocked, and refuse even without the block", async () => {
    const user = await makeUser(["admin"]);
    const { cookie } = await signIn(user.email);
    const blocked = await authRequest("/admin/create-user", { email: "z@example.com", password: PASSWORD, name: "Z" }, { cookie });
    assert.equal(blocked.status, 404);
    // Straight to Better Auth: an app admin has no plugin role, so the plugin says no.
    const direct = await auth.handler(new Request(`${BASE_URL}/api/auth/admin/set-role`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL, cookie, "x-nf-client-connection-ip": "203.0.113.99" },
      body: JSON.stringify({ userId: user.id, role: "admin" }),
    }));
    assert.equal(direct.status, 403);
  });
});

describe("guard and roles", () => {
  const url = (p) => new URL(`${BASE_URL}${p}`);

  test("no session: pages redirect to /login/, APIs get 401", async () => {
    const page = await guardRequest(url("/admin/checkins?x=1"), new Headers());
    assert.equal(page.response.status, 302);
    assert.equal(page.response.headers.get("location"), "/login/?next=%2Fadmin%2Fcheckins%3Fx%3D1");
    const api = await guardRequest(url("/api/admin/attendees"), new Headers());
    assert.equal(api.response.status, 401);
  });

  test("a session with no role gets 403 and nothing else", async () => {
    const user = await makeUser([]);
    const { cookie } = await signIn(user.email);
    const r = await guardRequest(url("/admin/"), new Headers({ cookie }));
    assert.equal(r.response.status, 403);
    assert.equal(await r.response.text(), "Forbidden");
    const api = await guardRequest(url("/api/admin/x"), new Headers({ cookie }));
    assert.equal(api.response.status, 403);
  });

  test("roles come from user_roles; requireRole enforces them per route", async () => {
    const social = await makeUser(["social"]);
    const { cookie } = await signIn(social.email);
    const r = await guardRequest(url("/admin/"), new Headers({ cookie }));
    assert.equal(r.response, null);
    assert.deepEqual(r.roles, ["social"]);
    assert.equal(r.user.id, social.id);
    const locals = { user: r.user, roles: r.roles };
    assert.equal(requireRole(locals, "admin", "social"), null);
    assert.equal(requireRole(locals, "admin").status, 403, "social is denied admin (attendee) routes");
    assert.equal(requireRole({}, "admin").status, 401);
    // The plugin's own role column is ignored even if someone sets it.
    await owner.query(`update auth."user" set role = 'admin' where id = $1`, [social.id]);
    const again = await loadAdminContext(new Headers({ cookie }));
    assert.deepEqual(again.roles, ["social"]);
  });

  test("the sliding session is extended after a day and the cookie is re-issued", async () => {
    const user = await makeUser(["admin"]);
    const { cookie } = await signIn(user.email);
    const fresh = await loadAdminContext(new Headers({ cookie }));
    assert.equal(fresh.setCookies.length, 0, "no refresh within updateAge");
    await owner.query(`update auth.session set "expiresAt" = now() + interval '28 days' where "userId" = $1`, [user.id]);
    const later = await loadAdminContext(new Headers({ cookie }));
    assert.ok(later.user);
    const { rows: [s] } = await owner.query(
      `select extract(epoch from ("expiresAt" - now()))::int as secs from auth.session where "userId" = $1`, [user.id]);
    assert.ok(s.secs > 29.9 * 86400, `expiry slid forward to ~30 days, got ${s.secs}s`);
    assert.ok(later.setCookies.some((c) => c.startsWith("better-auth.session_token=") && /Max-Age=2592000/.test(c)),
      "the middleware gets a fresh cookie to forward");
  });
});

describe("withAudit", () => {
  test("commits the change and its audit row together", async () => {
    const seed = await seedAttendee(owner);
    const actor = await makeUser(["admin"]);
    await withAudit(actor.id, (c) => c.query("update attendees set ok_to_email = false where id = $1", [seed.attendeeId]),
      { action: "attendee.opt_out", targetTable: "attendees", targetId: seed.attendeeId, details: { via: "test" } });
    const { rows: [a] } = await owner.query("select ok_to_email from attendees where id = $1", [seed.attendeeId]);
    assert.equal(a.ok_to_email, false);
    const { rows } = await owner.query("select actor_user_id, action, details from audit_log where target_id = $1", [seed.attendeeId]);
    assert.deepEqual(rows, [{ actor_user_id: actor.id, action: "attendee.opt_out", details: { via: "test" } }]);
  });

  test("rolls the change back when the callback throws", async () => {
    const seed = await seedAttendee(owner);
    await assert.rejects(withAudit(null, async (c) => {
      await c.query("update attendees set name = 'Changed' where id = $1", [seed.attendeeId]);
      throw new Error("boom");
    }, { action: "attendee.update", targetId: seed.attendeeId }), /boom/);
    const { rows: [a] } = await owner.query("select name from attendees where id = $1", [seed.attendeeId]);
    assert.equal(a.name, "Seed Person");
    const { rows } = await owner.query("select 1 from audit_log where target_id = $1", [seed.attendeeId]);
    assert.equal(rows.length, 0);
  });

  test("rolls the change back when the audit insert fails", async () => {
    const seed = await seedAttendee(owner);
    await assert.rejects(withAudit(null,
      (c) => c.query("update attendees set name = 'Changed' where id = $1", [seed.attendeeId]),
      { action: "" }), /needs an action/);
    const { rows: [a] } = await owner.query("select name from attendees where id = $1", [seed.attendeeId]);
    assert.equal(a.name, "Seed Person");
  });

  test("a refused statement (DELETE) rolls back and leaves the pool usable", async () => {
    const seed = await seedAttendee(owner);
    await assert.rejects(withAudit(null, (c) => c.query("delete from checkins where id = $1", [seed.checkinId]),
      { action: "checkin.delete" }), /permission denied/);
    const { rows } = await pool.query("select count(*)::int as n from checkins where id = $1", [seed.checkinId]);
    assert.equal(rows[0].n, 1);
  });

  test("audit entries can be computed from the result; writeAudit works on the pool", async () => {
    const out = await withAudit(null, async () => ({ id: "abc" }), (r) => ({ action: "test.result", targetId: r.id }));
    assert.deepEqual(out, { id: "abc" });
    const row = await writeAudit(pool, null, { action: "test.direct" });
    assert.ok(row.id);
  });
});

describe("user admin seam", () => {
  test("setUserPassword changes the password and revokes sessions", async () => {
    const user = await makeUser(["admin"]);
    const { cookie } = await signIn(user.email);
    assert.ok((await loadAdminContext(new Headers({ cookie }))).user);
    await setUserPassword(user.id, "a brand new long password");
    assert.equal((await loadAdminContext(new Headers({ cookie }))).user, null, "old session revoked");
    assert.equal((await signIn(user.email, PASSWORD, { ip: "203.0.113.50" })).res.status, 401);
    assert.equal((await signIn(user.email, "a brand new long password", { ip: "203.0.113.51" })).res.status, 200);
    await assert.rejects(setUserPassword(user.id, "short"), /at least 12/);
    await assert.rejects(createUser({ email: `${unique("short")}@example.com`, name: "S", password: "elevenchars" }), /too short/);
  });

  test("grant, revoke, list roles", async () => {
    const user = await makeUser([]);
    assert.equal(await withAudit(null, (c) => grantRole(c, user.id, "social"), { action: "user_role.grant" }), true);
    assert.equal(await withAudit(null, (c) => grantRole(c, user.id, "social"), { action: "user_role.grant" }), false);
    assert.deepEqual(await getUserRoles(pool, user.id), ["social"]);
    const listed = (await listUsersWithRoles()).find((u) => u.id === user.id);
    assert.deepEqual(listed.roles, ["social"]);
    assert.equal(await withAudit(null, (c) => revokeRole(c, user.id, "social"), { action: "user_role.revoke" }), true);
    assert.deepEqual(await getUserRoles(pool, user.id), []);
    await assert.rejects(withAudit(null, (c) => grantRole(c, user.id, "owner"), { action: "x" }), /unknown role/);
  });
});

describe("create-admin CLI", () => {
  const script = fileURLToPath(new URL("../../scripts/create-admin.mjs", import.meta.url));
  const run = (args, input) => spawnSync(process.execPath, [script, ...args], {
    input, encoding: "utf8",
    env: { ...process.env, ADMIN_DB_URL: process.env.ADMIN_DB_URL, BETTER_AUTH_URL: BASE_URL },
  });

  test("creates the user, the admin role and an audit row; never prints the password", async () => {
    const email = `${unique("cli")}@example.com`;
    const pw = "cli password that is long";
    const r = run(["--email", email, "--name", "CLI Admin", "--password-stdin"], pw);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes(pw) && !r.stderr.includes(pw));
    const { rows: [u] } = await owner.query(`select id from auth."user" where email = $1`, [email]);
    assert.deepEqual(await getUserRoles(pool, u.id), ["admin"]);
    const { rows: audit } = await owner.query("select action, actor_user_id, details from audit_log where target_id = $1", [u.id]);
    assert.deepEqual(audit, [{ action: "user.create", actor_user_id: null, details: { email, role: "admin", via: "create-admin CLI" } }]);
    assert.equal((await signIn(email, pw, { ip: "203.0.113.60" })).res.status, 200);

    const dup = run(["--email", email, "--name", "Again", "--password-stdin"], pw);
    assert.notEqual(dup.status, 0);
    assert.match(dup.stderr, /already exists/i);
  });

  test("refuses a short password and an unknown role", () => {
    const short = run(["--email", `${unique("cli")}@example.com`, "--name", "X", "--password-stdin"], "short");
    assert.notEqual(short.status, 0);
    assert.match(short.stderr, /too short/i);
    const role = run(["--email", "a@example.com", "--name", "X", "--role", "owner", "--password-stdin"], "x");
    assert.notEqual(role.status, 0);
    assert.match(role.stderr, /--role must be one of/);
  });
});
