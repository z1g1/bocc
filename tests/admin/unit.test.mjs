// Pure checks that need no database: env validation, pg TLS config, path rules,
// response headers. (Runs inside npm run test:db with the others.)
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readAdminEnv } from "../../src/lib/auth/env.mjs";
import { toAdminPgConfig } from "../../src/lib/auth/pg-config.mjs";
import { isPrivatePath, isProtectedPath, safeNext } from "../../src/lib/admin/guard.mjs";
import { adminCsp, withPrivateHeaders } from "../../src/lib/admin/headers.mjs";

const good = {
  ADMIN_DB_URL: "postgresql://admin_app:x@ep-x-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require",
  BETTER_AUTH_SECRET: "a".repeat(64),
  BETTER_AUTH_URL: "https://716coffee.club",
};

describe("readAdminEnv", () => {
  test("lists every problem at once", () => {
    assert.throws(() => readAdminEnv({}), (e) =>
      /ADMIN_DB_URL/.test(e.message) && /BETTER_AUTH_SECRET/.test(e.message) && /BETTER_AUTH_URL/.test(e.message));
  });
  test("derives the passkey rpID from the base URL", () => {
    assert.equal(readAdminEnv(good).rpID, "716coffee.club");
    assert.equal(readAdminEnv({ ...good, BETTER_AUTH_URL: "https://dev--bocc-backend.netlify.app" }).rpID, "dev--bocc-backend.netlify.app");
    assert.equal(readAdminEnv({ ...good, BETTER_AUTH_URL: "http://localhost:4321" }).baseURL, "http://localhost:4321");
  });
  test("refuses http off localhost, paths, short secrets", () => {
    assert.throws(() => readAdminEnv({ ...good, BETTER_AUTH_URL: "http://716coffee.club" }), /https/);
    assert.throws(() => readAdminEnv({ ...good, BETTER_AUTH_URL: "https://716coffee.club/admin" }), /no path/);
    assert.throws(() => readAdminEnv({ ...good, BETTER_AUTH_SECRET: "short" }), /32/);
    assert.throws(() => readAdminEnv({ ...good, ADMIN_DB_POOL_MAX: "0" }), /POOL_MAX/);
    assert.throws(() => readAdminEnv({ ...good, ADMIN_DB_POOL_MAX: "1" }), /POOL_MAX/);
  });
});

describe("toAdminPgConfig", () => {
  test("verify-full TLS for Neon, sslmode stripped", () => {
    const c = toAdminPgConfig(good.ADMIN_DB_URL, { max: 2 }, {});
    assert.deepEqual(c.ssl, { rejectUnauthorized: true });
    assert.ok(!c.connectionString.includes("sslmode"));
    assert.equal(c.max, 2);
  });
  test("no TLS only for loopback hosts", () => {
    assert.equal(toAdminPgConfig("postgresql://u:p@localhost:5432/db", {}, {}).ssl, false);
    assert.equal(toAdminPgConfig("postgresql://u:p@127.0.0.1:5432/db", {}, {}).ssl, false);
    assert.deepEqual(toAdminPgConfig("postgresql://u:p@localhost.evil.example/db", {}, {}).ssl, { rejectUnauthorized: true });
  });
  test("a malformed DB_CA_CERT fails closed", () => {
    assert.throws(() => toAdminPgConfig(good.ADMIN_DB_URL, {}, { DB_CA_CERT: "nope" }), /PEM/);
  });
});

describe("paths", () => {
  test("protected and private prefixes", () => {
    for (const p of ["/admin", "/admin/", "/admin/account/", "/api/admin/x"]) assert.ok(isProtectedPath(p), p);
    for (const p of ["/", "/administer", "/checkin/bocc", "/login/", "/api/auth/session", "/events/2026-11-17/"]) {
      assert.ok(!isProtectedPath(p), p);
    }
    for (const p of ["/login/", "/login", "/logout", "/api/auth/sign-in/email", "/admin/"]) assert.ok(isPrivatePath(p), p);
    for (const p of ["/", "/checkin/bocc", "/about/", "/loginx"]) assert.ok(!isPrivatePath(p), p);
  });
  test("safeNext only allows /admin paths", () => {
    assert.equal(safeNext("/admin/checkins?x=1"), "/admin/checkins?x=1");
    for (const bad of [undefined, "", "https://evil.example/admin", "//evil.example/admin", "/administer", "/admin\\..\\x", "/login/"]) {
      assert.equal(safeNext(bad), "/admin/", String(bad));
    }
  });
});

describe("private headers", () => {
  test("noindex, no-store, first-party CSP, cookies forwarded", () => {
    const res = withPrivateHeaders(new Response("x"), { setCookies: ["a=1; Path=/", "b=2; Path=/"] });
    assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("content-security-policy"), adminCsp());
    assert.deepEqual(res.headers.getSetCookie(), ["a=1; Path=/", "b=2; Path=/"]);
    assert.ok(!/https?:/.test(adminCsp()), "no third-party origins");
    assert.match(adminCsp(), /frame-ancestors 'none'/);
    assert.ok(!/script-src[^;]*unsafe-inline/.test(adminCsp()), "no inline scripts in production");
  });
  test("works on immutable redirect responses", () => {
    const res = withPrivateHeaders(Response.redirect("http://localhost/login/", 302));
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
  });
});
