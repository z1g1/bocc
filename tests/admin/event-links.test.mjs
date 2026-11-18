// Phase 4 event listings (ADR 0009 decision 3):
//   1. the URL rules, the Luma id and the readiness checklist (src/lib/admin/event-links-rules.mjs)
//   2. src/lib/admin/event-links.mjs as admin_app against the throwaway database
//      (npm run test:db): set creates the event, replace, clear, no-op saves, audit rows
// The HTTP side (the Listings form, readiness on the page and the lists) is in
// events-admin.test.mjs, which already runs astro dev.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { OWNER_URL, connect, unique, useAdminEnv } from "./helpers.mjs";

useAdminEnv();
const rules = await import("../../src/lib/admin/event-links-rules.mjs");
const { pool } = await import("../../src/lib/auth/auth.mjs");
const { createUser } = await import("../../src/lib/admin/users.mjs");
const el = await import("../../src/lib/admin/event-links.mjs");
const { ValidationError } = await import("../../src/lib/admin/events.mjs");

describe("URL rules", () => {
  const ok = (platform, raw, want = raw) => assert.equal(rules.normaliseLinkUrl(platform, raw), want, `${platform} ${raw}`);
  const bad = (platform, raw, re) => assert.throws(() => rules.normaliseLinkUrl(platform, raw), re, `${platform} ${raw}`);

  test("accepted hosts, per platform", () => {
    ok("luma", "https://luma.com/3yzz6fi4");
    ok("luma", "https://lu.ma/abc");
    ok("luma", "  https://www.luma.com/abc  ", "https://www.luma.com/abc");
    ok("eventbrite", "https://www.eventbrite.com/e/2004529462583");
    ok("eventbrite", "https://www.eventbrite.ca/e/bocc-tickets-123");
    ok("eventbrite", "https://www.eventbrite.co.uk/e/123?aff=x");
    ok("facebook_event", "https://www.facebook.com/events/123456/");
    ok("facebook_event", "https://www.facebook.com/share/18XDvMTve9/");
    ok("facebook_event", "https://m.facebook.com/events/1");
    ok("facebook_event", "https://fb.me/e/abc123");
    ok("linkedin_event", "https://www.linkedin.com/events/7525276081495592960");
    ok("linkedin_event", "https://linkedin.com/events/bocc-123/");
  });

  test("normalising: bare hosts and http get https, host lower-cased, fragment dropped", () => {
    ok("luma", "lu.ma/abc", "https://lu.ma/abc");
    ok("luma", "http://luma.com/abc", "https://luma.com/abc");
    ok("luma", "https://LUMA.com/AbC#x", "https://luma.com/AbC");
  });

  test("refused: wrong host, lookalikes, wrong paths, other schemes, logins, ports, spaces", () => {
    bad("luma", "", /Enter the Luma URL/);
    bad("luma", "https://evil-luma.com/abc", /isn't a link to Luma/);
    bad("luma", "https://luma.com.evil.example/abc", /isn't a link to Luma/);
    bad("luma", "https://luma.com/", /doesn't point at an event/);
    bad("luma", "ftp://luma.com/abc", /https/);
    bad("luma", "javascript:alert(1)", /https|Not a URL/);
    bad("luma", "https://user:pw@luma.com/abc", /plain link/);
    bad("luma", "https://luma.com:8443/abc", /plain link/);
    bad("luma", "https://luma.com/a b", /spaces/);
    bad("luma", `https://luma.com/${"a".repeat(500)}`, /At most 500/);
    bad("eventbrite", "https://www.eventbrite.com/o/organizer-123", /doesn't point at an event/);
    bad("eventbrite", "https://www.eventbrite.xyz/e/1", /isn't a link to Eventbrite/);
    bad("facebook_event", "https://www.facebook.com/bocc", /doesn't point at an event/);
    bad("facebook_event", "https://facebook.com.evil.example/events/1", /isn't a link to Facebook/);
    bad("linkedin_event", "https://www.linkedin.com/company/bocc", /doesn't point at an event/);
    bad("linkedin_event", "https://luma.com/abc", /isn't a link to LinkedIn/);
    assert.throws(() => rules.normaliseLinkUrl("tiktok", "https://x"), /Unknown platform/);
  });

  test("Luma id: evt-… or blank", () => {
    assert.equal(rules.normaliseLumaId(" evt-vszu1Of0V65R2CD "), "evt-vszu1Of0V65R2CD");
    assert.equal(rules.normaliseLumaId(""), null);
    assert.equal(rules.normaliseLumaId(undefined), null);
    for (const v of ["vszu1Of0V65R2CD", "evt-", "evt-a b", "evt-<x>", `evt-${"a".repeat(97)}`]) {
      assert.throws(() => rules.normaliseLumaId(v), /evt-/, v);
    }
  });

  test("readiness: four listings, the embed id, the public page, social later", () => {
    const empty = rules.readiness({ date: "2081-03-04", status: "scheduled" }, {});
    assert.deepEqual([empty.listings, empty.total, empty.lumaId, empty.ready], [0, 4, false, false]);
    assert.deepEqual(empty.items.map((i) => [i.key, i.ok]), [
      ["luma", false], ["eventbrite", false], ["facebook_event", false], ["linkedin_event", false],
      ["luma_id", false], ["public_page", true], ["social", null],
    ]);
    assert.equal(empty.items.find((i) => i.key === "public_page").href, "/events/2081-03-04/");
    assert.equal(empty.items.find((i) => i.key === "social").label, "social channels (Phase 5)");

    const link = (url, externalId = null) => ({ url, externalId });
    const noId = rules.readiness({ date: "2081-03-04", status: "scheduled" }, {
      luma: link("https://luma.com/a"), eventbrite: link("https://www.eventbrite.com/e/1"),
      facebook_event: link("https://fb.me/e/1"), linkedin_event: link("https://www.linkedin.com/events/1"),
    });
    assert.deepEqual([noId.listings, noId.lumaId, noId.ready], [4, false, false]);
    assert.match(noId.items.find((i) => i.key === "luma_id").note, /no embed id/);
    const full = rules.readiness({ date: "2081-03-04", status: "scheduled" }, {
      luma: link("https://luma.com/a", "evt-1"), eventbrite: link("https://www.eventbrite.com/e/1"),
      facebook_event: link("https://fb.me/e/1"), linkedin_event: link("https://www.linkedin.com/events/1"),
    });
    assert.equal(full.ready, true);
    // The public page follows src/pages/events/[date].astro: no events row = 404.
    const cancelled = rules.readiness({ date: "2081-03-04", status: "cancelled" }, {});
    const pub = cancelled.items.find((i) => i.key === "public_page");
    assert.deepEqual([pub.ok, pub.href], [false, "/events/2081-03-04/"]);
    assert.match(pub.note, /cancelled notice/);
    const unsaved = rules.readiness({ date: "2081-03-04", status: "scheduled", exists: false }, {});
    const pub2 = unsaved.items.find((i) => i.key === "public_page");
    assert.deepEqual([pub2.ok, pub2.href], [false, undefined]);
    assert.match(pub2.note, /404 until the event is saved/);
  });
});

describe("event-links module (admin_app)", () => {
  let owner, actor;
  let n = 0;
  const date = () => new Date(Date.UTC(2082, 0, 3 + 7 * n++)).toISOString().slice(0, 10);
  const linkRows = (d) => owner.query(
    `select platform, url, external_id from event_links where event_date = $1 order by platform`, [d]).then((r) => r.rows);
  const audits = (d) => owner.query(
    `select actor_user_id, action, target_table, details from audit_log where target_id = $1 and target_table = 'event_links' order by id`,
    [d]).then((r) => r.rows);

  before(async () => {
    owner = await connect(OWNER_URL);
    actor = await createUser({ email: `${unique("links")}@example.com`, name: "Links Admin", password: "correct horse battery staple" });
  });
  after(async () => { await owner?.end(); await pool.end(); });

  test("set on a date with no event creates it (scheduled) in the same transaction, audited", async () => {
    const d = date();
    assert.deepEqual(await el.setLink(actor.id, d, "luma", { url: "lu.ma/abc", externalId: " evt-AbC123 " }), { changed: true });
    assert.equal((await owner.query(`select status from events where event_date = $1`, [d])).rows[0].status, "scheduled");
    assert.deepEqual(await linkRows(d), [{ platform: "luma", url: "https://lu.ma/abc", external_id: "evt-AbC123" }]);
    assert.deepEqual(await audits(d), [{
      actor_user_id: actor.id, action: "event_link.set", target_table: "event_links",
      details: { platform: "luma", created: true, before: null, after: { url: "https://lu.ma/abc", external_id: "evt-AbC123" } },
    }]);
    // The same again: nothing written.
    assert.deepEqual(await el.setLink(actor.id, d, "luma", { url: "https://lu.ma/abc", externalId: "evt-AbC123" }), { changed: false });
    assert.equal((await audits(d)).length, 1);

    const links = await el.getLinks(pool, d);
    assert.deepEqual(Object.keys(links), ["luma", "eventbrite", "facebook_event", "linkedin_event"]);
    assert.equal(links.luma.externalId, "evt-AbC123");
    assert.equal(links.eventbrite, null);
  });

  test("replace, then clear, each audited with before and after; an existing event's status is untouched", async () => {
    const d = date();
    await owner.query(`insert into events (event_date, status, cancel_reason) values ($1, 'cancelled', 'weather')`, [d]);
    await el.setLink(actor.id, d, "eventbrite", { url: "https://www.eventbrite.com/e/1", externalId: "evt-ignored" });
    await el.setLink(actor.id, d, "eventbrite", { url: "https://www.eventbrite.com/e/2" });
    assert.deepEqual(await linkRows(d), [{ platform: "eventbrite", url: "https://www.eventbrite.com/e/2", external_id: null }],
      "only Luma stores an external id");
    assert.deepEqual(await el.clearLink(actor.id, d, "eventbrite"), { changed: true });
    assert.deepEqual(await el.clearLink(actor.id, d, "eventbrite"), { changed: false });
    assert.deepEqual(await linkRows(d), []);
    assert.equal((await owner.query(`select status from events where event_date = $1`, [d])).rows[0].status, "cancelled");
    const rows = await audits(d);
    assert.deepEqual(rows.map((r) => r.action), ["event_link.set", "event_link.set", "event_link.delete"]);
    assert.deepEqual(rows[1].details, {
      platform: "eventbrite", created: false,
      before: { url: "https://www.eventbrite.com/e/1", external_id: null },
      after: { url: "https://www.eventbrite.com/e/2", external_id: null },
    });
    assert.deepEqual(rows[2].details, { platform: "eventbrite", before: { url: "https://www.eventbrite.com/e/2", external_id: null } });
  });

  test("Luma without an id is allowed; bad input is a ValidationError and writes nothing", async () => {
    const d = date();
    await el.setLink(actor.id, d, "luma", { url: "https://luma.com/x", externalId: "" });
    assert.deepEqual((await el.getLinks(pool, d)).luma.externalId, null);
    const before = await audits(d);
    await assert.rejects(el.setLink(actor.id, d, "luma", { url: "https://evil.example/x", externalId: "nope" }),
      (e) => e instanceof ValidationError && "url" in e.errors && "externalId" in e.errors);
    await assert.rejects(el.setLink(actor.id, d, "myspace", { url: "https://luma.com/x" }), (e) => "platform" in e.errors);
    await assert.rejects(el.clearLink(actor.id, d, "myspace"), (e) => "platform" in e.errors);
    await assert.rejects(el.setLink(actor.id, "2082-02-30", "luma", { url: "https://luma.com/x" }), (e) => "date" in e.errors);
    const fresh = date();
    await assert.rejects(el.setLink(actor.id, fresh, "linkedin_event", { url: "https://www.linkedin.com/in/someone" }));
    assert.equal((await owner.query(`select 1 from events where event_date = $1`, [fresh])).rowCount, 0, "no event created");
    assert.deepEqual(await audits(d), before);
  });

  test("linkSummaries: listings count and the Luma id, per date", async () => {
    const [a, b, c] = [date(), date(), date()];
    await el.setLink(actor.id, a, "luma", { url: "https://luma.com/a", externalId: "evt-a" });
    await el.setLink(actor.id, a, "eventbrite", { url: "https://www.eventbrite.com/e/1" });
    await el.setLink(actor.id, b, "luma", { url: "https://luma.com/b" });
    const m = await el.linkSummaries(pool, [a, b, c]);
    assert.deepEqual([m.get(a), m.get(b), m.get(c)], [{ listings: 2, lumaId: true }, { listings: 1, lumaId: false }, { listings: 0, lumaId: false }]);
    assert.equal((await el.linkSummaries(pool, [])).size, 0);
  });
});
