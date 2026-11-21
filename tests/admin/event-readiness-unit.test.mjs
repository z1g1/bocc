// Event readiness (#59, GLOSSARY "Event readiness"), pure: no database, no network.
//   node --test tests/admin/event-readiness-unit.test.mjs
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { eventReadiness } from "../../src/lib/admin/event-readiness.mjs";
import { linkedInFollowUp } from "../../src/lib/linkedin/rules.mjs";

const DATE = "2081-03-04";
const link = (url) => ({ url, externalId: null });
const ALL = {
  luma: link("https://luma.com/a"), eventbrite: link("https://www.eventbrite.com/e/1"),
  facebook_event: link("https://fb.me/e/1"), linkedin_event: link("https://www.linkedin.com/events/1/"),
};
const scheduled = (over = {}) => ({ date: DATE, status: "scheduled", exists: true, location: "lobby", ...over });
const cancelled = (over = {}) => ({ date: DATE, status: "cancelled", exists: true, location: null, cancelAnnounced: false, ...over });
const bullet = (r, key) => r.bullets.find((b) => b.key === key);
const LOGO = { source: "default", image16x9: { path: "/assets/images/brand/bocc-logo-wide-16x9.png" } };
const EVENT_URL = "https://www.linkedin.com/events/7249812613549670400/";
const posted = (over = {}) => ({
  status: "posted", location: "lobby", imageSource: "default", imageRef: LOGO.image16x9.path,
  eventUrl: EVENT_URL, cancelledOnLinkedInAt: null, ...over,
});

describe("Event readiness: a Scheduled Event", () => {
  test("requires the five Listings, counted x/5, the missing ones under it", () => {
    const none = eventReadiness(scheduled(), {});
    const l = bullet(none, "listings");
    assert.deepEqual([l.label, l.ok], ["Listings 1/5", false]);
    assert.deepEqual(l.items.map((i) => [i.key, i.ok]), [
      ["luma", false], ["eventbrite", false], ["facebook_event", false], ["linkedin_event", false],
    ], "only the missing ones; the public page is up");
    assert.equal(none.publicHref, `/events/${DATE}/`);
    assert.equal(none.ok, false);

    const full = eventReadiness(scheduled(), ALL);
    assert.deepEqual([bullet(full, "listings").label, bullet(full, "listings").ok, bullet(full, "listings").items], ["Listings 5/5", true, []]);
    assert.equal(full.ok, true);
  });

  test("an unsaved date is Scheduled with no Location; its public page is a 404 until saved", () => {
    const r = eventReadiness({ date: DATE, status: "scheduled", exists: false, location: null }, {});
    assert.equal(r.kind, "scheduled");
    assert.equal(bullet(r, "listings").label, "Listings 0/5");
    const pub = bullet(r, "listings").items.find((i) => i.key === "public_page");
    assert.deepEqual([pub.ok, pub.href, r.publicHref], [false, undefined, undefined]);
    assert.match(pub.note, /404 until the event is saved/);
    assert.deepEqual([bullet(r, "location").label, bullet(r, "location").ok], ["Location: not set (Lobby assumed)", false]);
  });

  test("requires the Location, explicitly set: not set (Lobby assumed) until chosen", () => {
    const unset = eventReadiness(scheduled({ location: null }), ALL);
    assert.deepEqual([bullet(unset, "location").label, bullet(unset, "location").ok, unset.ok], ["Location: not set (Lobby assumed)", false, false]);
    for (const [location, locationOther, label] of [
      ["lobby", null, "Location: Lobby"],
      ["food_hall", null, "Location: Food hall"],
      ["other", "Room 5, 3rd floor", "Location: Other (Room 5, 3rd floor)"],
    ]) {
      const r = eventReadiness(scheduled({ location, locationOther }), ALL);
      assert.deepEqual([bullet(r, "location").label, bullet(r, "location").ok, r.ok], [label, true, true], location);
    }
  });
});

describe("Event readiness: the LinkedIn Listing", () => {
  const LISTING = "https://www.linkedin.com/events/7000000000000000000/";
  const li = (ledger, ev = scheduled()) => linkedInFollowUp({ ledger, event: ev, eventImage: LOGO });
  const liPart = (links, linkedIn) => {
    const r = eventReadiness(scheduled(), { ...ALL, linkedin_event: links }, { linkedIn });
    return { r, item: bullet(r, "listings").items.find((i) => i.key === "linkedin_event") };
  };

  test("posted from the app (the app saves the URL with the post): done, nothing listed", () => {
    const { r, item } = liPart(link(EVENT_URL), li(posted()));
    assert.equal(item, undefined);
    assert.deepEqual([bullet(r, "listings").label, r.ok], ["Listings 5/5", true]);
  });

  test("created on LinkedIn but its post not out yet (no URL saved): missing, pointing at the LinkedIn event section", () => {
    for (const ledger of [null, posted({ status: "pending", eventUrl: null }), posted({ status: "created" })]) {
      const { r, item } = liPart(null, li(ledger));
      assert.equal(item.ok, false, String(ledger?.status));
      assert.match(item.note, /not posted yet/);
      assert.equal(item.href, "?tab=info#h-linkedin");
      assert.deepEqual([bullet(r, "listings").label, r.ok], ["Listings 4/5", false]);
    }
  });

  test("made outside the app (a URL saved, no posted LinkedIn event in the app): done, with a caution line", () => {
    for (const ledger of [null, posted({ status: "pending", eventUrl: null })]) {
      const { r, item } = liPart(link(LISTING), li(ledger));
      assert.deepEqual([item.ok, item.caution, item.href], [true, true, LISTING], String(ledger?.status));
      assert.match(item.note, /created manually outside the app/);
      assert.deepEqual([bullet(r, "listings").label, bullet(r, "listings").ok, r.ok], ["Listings 5/5", true, true], "a caution doesn't block");
    }
  });

  test("LinkedIn drift blocks Event readiness: a red line under the Listings pointing at the LinkedIn section", () => {
    const r = eventReadiness(scheduled({ location: "food_hall" }), ALL, { linkedIn: li(posted(), scheduled({ location: "food_hall" })) });
    const drift = bullet(r, "listings").items.find((i) => i.key === "linkedin_drift");
    assert.equal(drift.ok, false);
    assert.match(drift.label, /^LinkedIn is out of date/);
    assert.equal(drift.href, "?tab=info#h-linkedin");
    assert.deepEqual([bullet(r, "listings").label, bullet(r, "listings").ok, r.ok], ["Listings 5/5", false, false]);
  });
});

describe("Event readiness: a Cancelled Event", () => {
  const li = (ledger, ev) => linkedInFollowUp({ ledger, event: ev, eventImage: LOGO });

  test("requires the cancellation to have gone out; no Listings, no Location, no Event Image", () => {
    const r = eventReadiness(cancelled(), {}, { eventImage: LOGO, linkedIn: li(null, cancelled()) });
    assert.equal(r.kind, "cancelled");
    assert.deepEqual(r.bullets.map((b) => b.key), ["cancellation"]);
    const c = bullet(r, "cancellation");
    assert.deepEqual([c.label, c.ok, r.ok], ["Cancellation: not announced on all socials yet", false, false]);
    const out = eventReadiness(cancelled({ cancelAnnounced: true }), {}, { linkedIn: li(null, cancelled()) });
    assert.deepEqual([bullet(out, "cancellation").label, bullet(out, "cancellation").ok, out.ok], ["Cancellation: announced on all socials", true, true]);
  });

  test("requires no LinkedIn cancellation due: a red line until Done on LinkedIn", () => {
    const ev = cancelled({ cancelAnnounced: true });
    const due = eventReadiness(ev, {}, { linkedIn: li(posted(), ev) });
    assert.deepEqual(bullet(due, "cancellation").items, [{ key: "linkedin_cancel", label: "Cancel the LinkedIn event on LinkedIn", ok: false, href: "?tab=info#h-linkedin" }]);
    assert.deepEqual([bullet(due, "cancellation").ok, due.ok], [false, false]);
    const done = eventReadiness(ev, {}, { linkedIn: li(posted({ cancelledOnLinkedInAt: new Date() }), ev) });
    assert.deepEqual([bullet(done, "cancellation").items, done.ok], [[], true]);
  });
});

describe("Event readiness: the tag for the events list and the admin home page", () => {
  test("Ready, or what is missing", () => {
    assert.deepEqual(eventReadiness(scheduled(), ALL).tag, { label: "Ready", ok: true });
    assert.deepEqual(eventReadiness(scheduled({ location: null }), { luma: ALL.luma }).tag, { label: "2/5 listings · Location not set", ok: false });
    assert.deepEqual(eventReadiness(scheduled(), { luma: ALL.luma }).tag, { label: "2/5 listings", ok: false });
    assert.deepEqual(eventReadiness(scheduled({ location: null }), ALL).tag, { label: "Location not set", ok: false });
    const drift = scheduled({ location: "food_hall" });
    assert.deepEqual(eventReadiness(drift, ALL, { linkedIn: linkedInFollowUp({ ledger: posted(), event: drift, eventImage: LOGO }) }).tag,
      { label: "LinkedIn out of date", ok: false });
    assert.deepEqual(eventReadiness(cancelled(), {}).tag, { label: "Cancellation not announced", ok: false });
    const ev = cancelled({ cancelAnnounced: true });
    assert.deepEqual(eventReadiness(ev, {}, { linkedIn: linkedInFollowUp({ ledger: posted(), event: ev, eventImage: LOGO }) }).tag,
      { label: "Cancel on LinkedIn", ok: false });
    assert.deepEqual(eventReadiness(ev, {}).tag, { label: "Ready", ok: true });
  });
});

describe("Event readiness: the Event Image, information only", () => {
  test("Default (BOCC logo) or Custom, never blocking", () => {
    const img = (source) => bullet(eventReadiness(scheduled(), ALL, { eventImage: { source } }), "event_image");
    assert.deepEqual([img("default").label, img("default").info], ["Event Image: Default (BOCC logo)", true]);
    assert.equal(img("uploaded").label, "Event Image: Custom");
    assert.equal(img("referenced").label, "Event Image: Custom");
    assert.equal(eventReadiness(scheduled(), ALL, { eventImage: { source: "default" } }).ok, true, "the default doesn't block");
    assert.equal(bullet(eventReadiness(scheduled(), ALL), "event_image"), undefined, "no line without an Event Image");
  });
});
