// The per-role path allowlists (src/lib/admin/roles.mjs ROLE_PATHS, mayReach). Pure
// checks, no database (runs inside npm run test:db with the others).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { BASE_PATHS, ROLE_PATHS, SOCIAL_PATHS, mayReach } from "../../src/lib/admin/roles.mjs";

// A second non-admin role that doesn't exist yet (the email role arrives with the Luma
// sync): its own pages plus the shared base paths.
const TEST_PATHS = Object.freeze({
  social: SOCIAL_PATHS,
  email: Object.freeze([...BASE_PATHS, /^\/admin\/luma-sync(\/|$)/, /^\/api\/admin\/luma-sync(\/|$)/]),
});

describe("per-role path allowlists", () => {
  test("the default map has the social allowlist, and no admin entry (admin reaches everything)", () => {
    assert.equal(ROLE_PATHS.social, SOCIAL_PATHS);
    assert.equal(ROLE_PATHS.admin, undefined);
    for (const r of BASE_PATHS) assert.ok(SOCIAL_PATHS.includes(r), "social includes the base paths");
  });

  test("a user with two non-admin roles reaches the union of both allowlists", () => {
    const social = ["/admin/social/next/", "/api/admin/social/next"];
    const email = ["/admin/luma-sync/next/", "/api/admin/luma-sync/done"];
    const base = ["/admin/", "/admin/account/", "/api/admin/me"];
    const neither = ["/admin/events/", "/admin/email-list/", "/api/admin/email-list.csv", "/admin/attendees/", "/admin/users/"];

    for (const p of [...social, ...email, ...base]) assert.equal(mayReach(["social", "email"], p, TEST_PATHS), true, p);
    for (const p of neither) assert.equal(mayReach(["social", "email"], p, TEST_PATHS), false, p);

    for (const p of [...social, ...base]) assert.equal(mayReach(["social"], p, TEST_PATHS), true, p);
    for (const p of email) assert.equal(mayReach(["social"], p, TEST_PATHS), false, p);
    for (const p of [...email, ...base]) assert.equal(mayReach(["email"], p, TEST_PATHS), true, p);
    for (const p of social) assert.equal(mayReach(["email"], p, TEST_PATHS), false, p);
  });

  test("admin reaches everything; no role and unknown roles nothing", () => {
    for (const p of ["/admin/events/", "/admin/luma-sync/", "/admin/nope"]) {
      assert.equal(mayReach(["admin"], p, TEST_PATHS), true, p);
      assert.equal(mayReach(["admin", "email"], p, TEST_PATHS), true, p);
    }
    assert.equal(mayReach([], "/admin/", TEST_PATHS), false);
    assert.equal(mayReach(["nobody"], "/admin/", TEST_PATHS), false);
    assert.equal(mayReach(["constructor"], "/admin/"), false, "no prototype keys");
  });
});
