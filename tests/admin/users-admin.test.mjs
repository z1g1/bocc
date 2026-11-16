// /admin/users/ end to end without Astro: the middleware's guard, then usersPage()
// (src/lib/admin/users-actions.mjs), which is all the page does. Runs as admin_app
// against the throwaway database (npm run test:db).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { BASE_URL, OWNER_URL, connect, unique, useAdminEnv } from "./helpers.mjs";

useAdminEnv();
const { pool } = await import("../../src/lib/auth/auth.mjs");
const { handleAuthRequest } = await import("../../src/lib/auth/handler.mjs");
const { withAudit } = await import("../../src/lib/admin/db.mjs");
const { createUser, grantRole, getUserRoles } = await import("../../src/lib/admin/users.mjs");
const { guardRequest } = await import("../../src/lib/admin/guard.mjs");
const { usersPage } = await import("../../src/lib/admin/users-actions.mjs");
const { checkOrigin } = await import("../../src/lib/admin/csrf.mjs");

const PASSWORD = "correct horse battery staple";
let owner;

before(async () => { owner = await connect(OWNER_URL); });
after(async () => { await owner?.end(); await pool.end(); });

let ipCounter = 0;
const nextIp = () => `198.18.${Math.floor(++ipCounter / 250)}.${ipCounter % 250 + 1}`;

async function signIn(email, password = PASSWORD) {
  const res = await handleAuthRequest(new Request(`${BASE_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE_URL, "x-nf-client-connection-ip": nextIp() },
    body: JSON.stringify({ email, password }),
  }));
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).filter((c) => !c.endsWith("=")).join("; ");
  return { status: res.status, cookie };
}

async function makeUser(roles = []) {
  const user = await createUser({ email: `${unique("ua")}@example.com`, name: "UA User", password: PASSWORD });
  for (const r of roles) await withAudit(null, (c) => grantRole(c, user.id, r), { action: "test.grant" });
  return user;
}

async function signedIn(roles) {
  const user = await makeUser(roles);
  const { cookie } = await signIn(user.email);
  return { user, cookie };
}

/** What the middleware plus src/pages/admin/users/index.astro do for one request. */
async function serve({ method = "GET", cookie, origin = BASE_URL, body, query = "" } = {}) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  if (origin) headers.set("origin", origin);
  const init = { method, headers };
  if (body) {
    headers.set("content-type", "application/x-www-form-urlencoded");
    init.body = new URLSearchParams(body).toString();
  }
  const request = new Request(`${BASE_URL}/admin/users/${query}`, init);
  const g = await guardRequest(new URL(request.url), request.headers);
  if (g.response) return { response: g.response };
  return usersPage(request, { user: g.user, session: g.session, roles: g.roles });
}

const auditFor = async (targetId, action) => (await owner.query(
  "select actor_user_id, action, target_table, details from audit_log where target_id = $1 and ($2::text is null or action = $2) order by id",
  [targetId, action ?? null])).rows;

describe("access", () => {
  test("no session: GET and POST redirect to the login page", async () => {
    for (const method of ["GET", "POST"]) {
      const r = await serve({ method, body: method === "POST" ? { action: "grant" } : undefined });
      assert.equal(r.response.status, 302, method);
      assert.equal(r.response.headers.get("location"), "/login/?next=%2Fadmin%2Fusers%2F");
    }
  });

  test("signed in without a role: 403", async () => {
    const { cookie } = await signedIn([]);
    assert.equal((await serve({ cookie })).response.status, 403);
  });

  test("social: 403 on GET and POST, and nothing changes", async () => {
    const { user, cookie } = await signedIn(["social"]);
    assert.equal((await serve({ cookie })).response.status, 403);
    const r = await serve({ method: "POST", cookie, body: { action: "grant", userId: user.id, role: "admin" } });
    assert.equal(r.response.status, 403);
    assert.deepEqual(await getUserRoles(pool, user.id), ["social"]);
    assert.deepEqual(await auditFor(user.id, "user_role.grant"), []);
  });

  test("admin: the list shows every user with their roles", async () => {
    const { user, cookie } = await signedIn(["admin"]);
    const other = await makeUser(["social"]);
    const r = await serve({ cookie, query: "?done=granted" });
    assert.equal(r.response, null);
    assert.equal(r.status, 200);
    assert.equal(r.notice, "Role granted.");
    const byId = new Map(r.users.map((u) => [u.id, u]));
    assert.deepEqual(byId.get(user.id).roles, ["admin"]);
    assert.deepEqual(byId.get(other.id).roles, ["social"]);
    assert.equal((await serve({ cookie, query: "?done=<script>" })).notice, null, "only fixed notices");
  });

  test("other methods: 405", async () => {
    const { cookie } = await signedIn(["admin"]);
    assert.equal((await serve({ method: "PUT", cookie })).response.status, 405);
  });
});

describe("Origin check", () => {
  test("a POST from another origin, or with no Origin, is refused and changes nothing", async () => {
    const { cookie } = await signedIn(["admin"]);
    const target = await makeUser([]);
    for (const origin of ["https://evil.example", "null", "http://localhost:4322", null /* no header */]) {
      const r = await serve({ method: "POST", cookie, origin, body: { action: "grant", userId: target.id, role: "admin" } });
      assert.equal(r.response.status, 403, String(origin));
    }
    assert.deepEqual(await getUserRoles(pool, target.id), []);
    assert.deepEqual(await auditFor(target.id), []);
  });

  test("checkOrigin matches the exact origin", () => {
    const req = (origin) => new Request(`${BASE_URL}/admin/users/`, { method: "POST", headers: origin ? { origin } : {} });
    assert.equal(checkOrigin(req(BASE_URL), { origin: BASE_URL }), null);
    assert.equal(checkOrigin(req(`${BASE_URL}.evil.example`), { origin: BASE_URL }).status, 403);
    assert.equal(checkOrigin(req(), { origin: BASE_URL }).status, 403);
    assert.equal(checkOrigin(req(BASE_URL), { origin: "" }).status, 403);
  });
});

describe("create", () => {
  test("creates the user with the role and one audit row, without the password", async () => {
    const { user: actor, cookie } = await signedIn(["admin"]);
    const email = `${unique("new")}@example.com`;
    const pw = "a new user's long password";
    const r = await serve({ method: "POST", cookie, body: { action: "create", email: ` ${email.toUpperCase()} `, name: " New Person ", password: pw, role: "social" } });
    assert.equal(r.response.status, 303);
    assert.equal(r.response.headers.get("location"), "/admin/users/?done=created");
    const { rows: [u] } = await owner.query(`select id, name from auth."user" where email = $1`, [email]);
    assert.equal(u.name, "New Person");
    assert.deepEqual(await getUserRoles(pool, u.id), ["social"]);
    assert.deepEqual(await auditFor(u.id), [{
      actor_user_id: actor.id, action: "user.create", target_table: "auth.user",
      details: { email, name: "New Person", role: "social" },
    }]);
    assert.equal((await signIn(email, pw)).status, 200);
  });

  test("duplicate email, short password, bad role and bad email are refused without a trace", async () => {
    const { cookie } = await signedIn(["admin"]);
    const existing = await makeUser([]);
    const before = (await owner.query("select count(*)::int as n from audit_log")).rows[0].n;
    const cases = [
      [{ email: existing.email, password: PASSWORD, role: "social" }, 409, /already exists/],
      [{ email: `${unique("s")}@example.com`, password: "short", role: "social" }, 400, /too short/],
      [{ email: `${unique("r")}@example.com`, password: PASSWORD, role: "owner" }, 400, /Role must be/],
      [{ email: "not-an-email", password: PASSWORD, role: "admin" }, 400, /valid email/],
      [{ email: `${unique("n")}@example.com`, password: PASSWORD, role: "admin", name: "" }, 400, /name/],
    ];
    for (const [body, status, msg] of cases) {
      const r = await serve({ method: "POST", cookie, body: { action: "create", name: "X", ...body } });
      assert.equal(r.response, null, JSON.stringify(body));
      assert.equal(r.status, status, JSON.stringify(body));
      assert.match(r.error, msg);
      assert.equal(r.form.email, body.email, "the form is re-filled");
      assert.ok(!JSON.stringify(r.form).includes(body.password), "but never with the password");
    }
    const after = (await owner.query("select count(*)::int as n from audit_log")).rows[0].n;
    assert.equal(after, before);
    for (const [body] of cases.slice(1)) {
      const { rows } = await owner.query(`select 1 from auth."user" where email = $1`, [body.email]);
      assert.equal(rows.length, 0, body.email);
    }
  });

  test("if the role/audit transaction fails, the new auth user is removed again", async () => {
    const { cookie } = await signedIn(["admin"]);
    const email = `${unique("undo")}@example.com`;
    await owner.query("revoke insert on public.audit_log from admin_app");
    try {
      await assert.rejects(serve({ method: "POST", cookie, body: { action: "create", email, name: "Undo", password: PASSWORD, role: "admin" } }),
        /permission denied/);
    } finally {
      await owner.query("grant insert on public.audit_log to admin_app");
    }
    const { rows } = await owner.query(`select 1 from auth."user" where email = $1`, [email]);
    assert.equal(rows.length, 0);
  });
});

describe("password reset", () => {
  test("sets the password, revokes their sessions, audits without the password", async () => {
    const { user: actor, cookie } = await signedIn(["admin"]);
    const { user: target, cookie: targetCookie } = await signedIn(["social"]);
    assert.equal((await serve({ cookie: targetCookie })).response.status, 403, "target's session works (social)");
    const pw = "a reset password, long enough";
    const r = await serve({ method: "POST", cookie, body: { action: "reset", userId: target.id, password: pw } });
    assert.equal(r.response.status, 303);
    assert.equal(r.response.headers.get("location"), "/admin/users/?done=reset");
    assert.ok(!r.response.headers.get("location").includes(pw));
    assert.equal((await serve({ cookie: targetCookie })).response.status, 302, "their old session is gone");
    assert.equal((await signIn(target.email, PASSWORD)).status, 401);
    assert.equal((await signIn(target.email, pw)).status, 200);
    assert.deepEqual(await auditFor(target.id, "user.password_reset"), [{
      actor_user_id: actor.id, action: "user.password_reset", target_table: "auth.user", details: { sessionsRevoked: true },
    }]);
  });

  test("a short password or unknown user is refused and not audited", async () => {
    const { cookie } = await signedIn(["admin"]);
    const target = await makeUser([]);
    const short = await serve({ method: "POST", cookie, body: { action: "reset", userId: target.id, password: "short" } });
    assert.equal(short.status, 400);
    assert.match(short.error, /too short/);
    const missing = await serve({ method: "POST", cookie, body: { action: "reset", userId: "no-such-user", password: PASSWORD } });
    assert.equal(missing.status, 404);
    assert.deepEqual(await auditFor(target.id), []);
    assert.deepEqual(await auditFor("no-such-user"), []);
  });
});

describe("roles", () => {
  test("grant and revoke each write one audit row; a no-op writes none", async () => {
    const { user: actor, cookie } = await signedIn(["admin"]);
    const target = await makeUser([]);
    const post = (action, role) => serve({ method: "POST", cookie, body: { action, userId: target.id, role } });

    assert.equal((await post("grant", "social")).response.headers.get("location"), "/admin/users/?done=granted");
    assert.equal((await post("grant", "social")).response.headers.get("location"), "/admin/users/?done=unchanged");
    assert.deepEqual(await getUserRoles(pool, target.id), ["social"]);
    assert.equal((await post("revoke", "social")).response.headers.get("location"), "/admin/users/?done=revoked");
    assert.equal((await post("revoke", "social")).response.headers.get("location"), "/admin/users/?done=unchanged");
    assert.deepEqual(await getUserRoles(pool, target.id), []);
    assert.deepEqual(await auditFor(target.id), [
      { actor_user_id: actor.id, action: "user_role.grant", target_table: "user_roles", details: { role: "social" } },
      { actor_user_id: actor.id, action: "user_role.revoke", target_table: "user_roles", details: { role: "social" } },
    ]);
    const bad = await post("grant", "owner");
    assert.equal(bad.status, 400);
    const gone = await serve({ method: "POST", cookie, body: { action: "grant", userId: "no-such-user", role: "social" } });
    assert.equal(gone.status, 404);
    assert.equal((await serve({ method: "POST", cookie, body: { action: "delete", userId: target.id } })).response.status, 400);
  });

  describe("last-admin guard", () => {
    // Other test files leave admins behind. Park every admin row but ours for these
    // tests (as the owner) and put them back afterwards.
    let parked = [];
    const park = async (keep) => {
      const { rows } = await owner.query(
        "delete from user_roles where role = 'admin' and not (user_id = any($1)) returning user_id", [keep]);
      parked.push(...rows.map((r) => r.user_id));
    };
    after(async () => {
      for (const id of parked) {
        await owner.query("insert into user_roles (user_id, role) values ($1, 'admin') on conflict do nothing", [id]);
      }
    });
    const adminCount = async () =>
      (await owner.query("select count(*)::int as n from user_roles where role = 'admin'")).rows[0].n;

    test("the only admin can't remove their own admin role", async () => {
      const { user, cookie } = await signedIn(["admin", "social"]);
      await park([user.id]);
      assert.equal(await adminCount(), 1);
      const r = await serve({ method: "POST", cookie, body: { action: "revoke", userId: user.id, role: "admin" } });
      assert.equal(r.status, 409);
      assert.match(r.error, /last admin/);
      assert.deepEqual(await getUserRoles(pool, user.id), ["admin", "social"]);
      assert.deepEqual(await auditFor(user.id, "user_role.revoke"), []);
      // Their other role can still go.
      const s = await serve({ method: "POST", cookie, body: { action: "revoke", userId: user.id, role: "social" } });
      assert.equal(s.response.status, 303);
    });

    test("with two admins, one may remove the other or themself, but not both at once", async () => {
      const a = await signedIn(["admin"]);
      const b = await signedIn(["admin"]);
      await park([a.user.id, b.user.id]);
      assert.equal(await adminCount(), 2);
      // Each removes the other at the same moment: the table lock lets exactly one win.
      const results = await Promise.all([
        serve({ method: "POST", cookie: a.cookie, body: { action: "revoke", userId: b.user.id, role: "admin" } }),
        serve({ method: "POST", cookie: b.cookie, body: { action: "revoke", userId: a.user.id, role: "admin" } }),
      ]);
      const ok = results.filter((r) => r.response?.status === 303).length;
      // The loser is refused by the guard (if it already lost its role) or by the count.
      const refused = results.filter((r) => r.status === 409 || r.response?.status === 403).length;
      assert.deepEqual({ ok, refused }, { ok: 1, refused: 1 });
      assert.equal(await adminCount(), 1);

      // The survivor makes a new admin, then removes their own admin role.
      const survivor = (await getUserRoles(pool, a.user.id)).includes("admin") ? a : b;
      const c = await makeUser([]);
      await serve({ method: "POST", cookie: survivor.cookie, body: { action: "grant", userId: c.id, role: "admin" } });
      const self = await serve({ method: "POST", cookie: survivor.cookie, body: { action: "revoke", userId: survivor.user.id, role: "admin" } });
      assert.equal(self.response.status, 303);
      assert.deepEqual(await getUserRoles(pool, c.id), ["admin"]);
      assert.equal(await adminCount(), 1);
      parked.push(c.id); // keep it as an admin after these tests too
    });
  });
});

describe("audit details never contain a password", () => {
  test("no audit row written by these tests mentions any password used", async () => {
    const { rows } = await owner.query(
      `select count(*)::int as n from audit_log
        where details::text ilike any($1) or details::text ~* 'password'`,
      [["%correct horse battery staple%", "%a new user's long password%", "%a reset password, long enough%"]]);
    // 'password' appears in no key either: reset rows say sessionsRevoked, not password.
    assert.equal(rows[0].n, 0);
  });
});
