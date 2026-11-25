// The admin section nav (src/lib/admin/nav.mjs) and the themed error pages that show
// it. Pure checks, no database (runs inside npm run test:db with the others).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_LINKS, EMAIL_LINKS, ROLE_LINKS, ROLE_TITLES, SOCIAL_LINKS, currentHref, homeSectionsFor, navLinksFor, sectionNavHtml } from "../../src/lib/admin/nav.mjs";
import { ROLES, ROLE_PATHS } from "../../src/lib/admin/roles.mjs";
import { errorPageHtml } from "../../src/lib/admin/error-page.mjs";

const FAKE_SOCIAL = [{ href: "/admin/social/", label: "Work order" }];

describe("section nav links", () => {
  test("admin gets every link; social only the social ones; no role nothing", () => {
    assert.deepEqual(navLinksFor(["admin"]).map((l) => l.href), [...ADMIN_LINKS, ...SOCIAL_LINKS, ...EMAIL_LINKS].map((l) => l.href));
    assert.deepEqual(navLinksFor(["social"]), [...SOCIAL_LINKS]);
    assert.deepEqual(navLinksFor([]), []);
    assert.deepEqual(navLinksFor(["admin"], { social: FAKE_SOCIAL }).map((l) => l.label),
      ["Events", "Check-ins", "Active streaks", "Email list", "Attendees", "Users", "Work order", "Luma sync"]);
    assert.deepEqual(navLinksFor(["social"], { social: FAKE_SOCIAL }), FAKE_SOCIAL);
    assert.equal(navLinksFor(["admin", "social"], { social: FAKE_SOCIAL }).length, ADMIN_LINKS.length + 1 + EMAIL_LINKS.length, "no duplicates");
  });

  test("links are keyed by role; several roles see the union with no duplicates; admin sees all", () => {
    assert.equal(ROLE_LINKS.admin, ADMIN_LINKS);
    assert.equal(ROLE_LINKS.social, SOCIAL_LINKS);
    assert.equal(ROLE_LINKS.email, EMAIL_LINKS);
    const shared = { href: "/admin/shared/", label: "Shared" };
    const links = {
      admin: [{ href: "/admin/events/", label: "Events" }],
      social: [{ href: "/admin/social/", label: "Work order" }, shared],
      email: [{ href: "/admin/luma-sync/", label: "Luma sync" }, shared],
    };
    assert.deepEqual(navLinksFor(["social", "email"], links).map((l) => l.href),
      ["/admin/social/", "/admin/shared/", "/admin/luma-sync/"]);
    assert.deepEqual(navLinksFor(["email"], links).map((l) => l.href), ["/admin/luma-sync/", "/admin/shared/"]);
    assert.deepEqual(navLinksFor(["admin"], links).map((l) => l.href),
      ["/admin/events/", "/admin/social/", "/admin/shared/", "/admin/luma-sync/"]);
    assert.deepEqual(navLinksFor(["nobody"], links), []);
  });

  test("social is never shown a link to attendee, check-in, streak, email-list or user data", () => {
    const hrefs = navLinksFor(["social"]).map((l) => l.href).join(" ");
    for (const p of ["attendees", "checkins", "streaks", "email-list", "users", "events"]) assert.ok(!hrefs.includes(p), p);
  });

  test("every role has links, a home heading and (but admin) an allowlist", () => {
    assert.deepEqual(Object.keys(ROLE_LINKS), [...ROLES]);
    assert.deepEqual(Object.keys(ROLE_TITLES), [...ROLES]);
    assert.deepEqual(Object.keys(ROLE_PATHS), ROLES.filter((r) => r !== "admin"));
  });

  test("the admin home's sections: one per held role, admin all, in ROLE_LINKS order", () => {
    const view = (roles) => homeSectionsFor(roles).map((s) => [s.title, s.links.map((l) => l.href)]);
    assert.deepEqual(view(["admin"]), [
      ["Admin", ADMIN_LINKS.map((l) => l.href)],
      ["Social", SOCIAL_LINKS.map((l) => l.href)],
      ["Luma sync", EMAIL_LINKS.map((l) => l.href)],
    ]);
    assert.deepEqual(view(["social"]), [["Social", SOCIAL_LINKS.map((l) => l.href)]]);
    assert.deepEqual(view(["email"]), [["Luma sync", ["/admin/luma-sync/next/"]]]);
    assert.deepEqual(view(["email", "social"]), [["Social", SOCIAL_LINKS.map((l) => l.href)], ["Luma sync", ["/admin/luma-sync/next/"]]]);
    assert.deepEqual(homeSectionsFor([]), []);
    assert.deepEqual(homeSectionsFor(["social"], { social: [] }), [], "a role with no links gets no empty section");
  });

  test("the current section is matched by path prefix", () => {
    const links = navLinksFor(["admin"]);
    assert.equal(currentHref("/admin/events/", links), "/admin/events/");
    assert.equal(currentHref("/admin/events", links), "/admin/events/");
    assert.equal(currentHref("/admin/events/2026-11-24/", links), "/admin/events/");
    assert.equal(currentHref("/admin/attendees/123e4567-e89b-12d3-a456-426614174000", links), "/admin/attendees/");
    assert.equal(currentHref("/admin/", links), null);
    assert.equal(currentHref("/admin/account/", links), null);
    assert.equal(currentHref("/admin/eventsx/", links), null, "a whole segment, not a string prefix");
    assert.equal(currentHref(null, links), null);
  });

  test("HTML: one aria-current, no script, empty for no links", () => {
    const html = sectionNavHtml(["admin"], "/admin/checkins/");
    assert.match(html, /^<nav class="sections" aria-label="Admin sections"><ul>/);
    assert.equal(html.match(/aria-current/g).length, 1);
    assert.match(html, /<a href="\/admin\/checkins\/" aria-current="page">Check-ins<\/a>/);
    assert.ok(!html.includes("<script"));
    assert.equal(sectionNavHtml(["admin"], "/admin/").includes("aria-current"), false);
    assert.equal(sectionNavHtml([], "/admin/events/"), "");
    const social = sectionNavHtml(["social"], "/admin/social/", { social: FAKE_SOCIAL });
    assert.equal(social, '<nav class="sections" aria-label="Admin sections"><ul><li><a href="/admin/social/" aria-current="page">Work order</a></li></ul></nav>');
  });
});

describe("error pages show the same section nav", () => {
  const user = { email: "a@example.com" };
  test("a user with a role gets the nav their roles allow, with no current item", () => {
    for (const status of [403, 404]) {
      const html = errorPageHtml(status, { user, roles: ["admin"] });
      assert.ok(html.includes(sectionNavHtml(["admin"])), `${status}: same markup as the layout`);
      assert.doesNotMatch(html, /<a [^>]*aria-current/, `${status}: says nothing about the URL`);
    }
    const social = errorPageHtml(403, { user, roles: ["social"] });
    assert.ok(!social.includes("/admin/events/") && !social.includes("/admin/attendees/"));
  });
  test("no role, or signed out: no section nav", () => {
    assert.ok(!errorPageHtml(403, { user, roles: [] }).includes('class="sections"'));
    assert.ok(!errorPageHtml(404).includes('class="sections"'));
  });
});
