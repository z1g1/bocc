// LinkedIn drift and cancellation rules (ADR 0012, issue #27), pure: no database, no
// network. Runs on its own:
//   node --test tests/admin/linkedin-drift-unit.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { linkedInFollowUp } from "../../src/lib/linkedin/rules.mjs";

const EVENT_URL = "https://www.linkedin.com/events/7249812613549670400/";
const LOGO = { source: "default", mediaId: null, eventDate: null, image16x9: { path: "/assets/images/brand/bocc-logo-wide-16x9.png", contentType: "image/png" } };
const UPLOADED = { source: "uploaded", mediaId: "m1", eventDate: "2078-01-04", image16x9: { key: "events/2078-01-04/m1/cover.jpg", contentType: "image/jpeg" } };
const PICKED = { source: "referenced", mediaId: "m2", eventDate: "2077-12-28", image16x9: { key: "events/2077-12-28/m2/cover.jpg", contentType: "image/jpeg" } };

/** A posted ledger row as the use-case reads it, sent with the lobby wording and the logo. */
const posted = (over = {}) => ({
  status: "posted", location: "lobby", imageSource: "default", imageRef: LOGO.image16x9.path,
  eventUrl: EVENT_URL, cancelledOnLinkedInAt: null, ...over,
});
const scheduled = (location = "lobby") => ({ status: "scheduled", location });

describe("linkedInFollowUp: drift", () => {
  it("shows nothing when the location and image are what was sent", () => {
    const f = linkedInFollowUp({ ledger: posted(), event: scheduled(), eventImage: LOGO });
    assert.equal(f.drift, null);
    assert.equal(f.cancel, null);
    assert.equal(f.eventUrl, EVENT_URL);
  });

  it("sent with no location set and still unset (or lobby): the lobby wording either way, no drift", () => {
    assert.equal(linkedInFollowUp({ ledger: posted({ location: null }), event: scheduled(null), eventImage: LOGO }).drift, null);
    assert.equal(linkedInFollowUp({ ledger: posted({ location: null }), event: scheduled("lobby"), eventImage: LOGO }).drift, null);
    assert.equal(linkedInFollowUp({ ledger: posted(), event: scheduled(null), eventImage: LOGO }).drift, null);
  });

  it("flags a location change, with a message and the link to the LinkedIn section", () => {
    const f = linkedInFollowUp({ ledger: posted(), event: scheduled("food_hall"), eventImage: LOGO });
    assert.deepEqual(f.drift.changes, ["location"]);
    assert.match(f.drift.message, /^LinkedIn is out of date/);
    assert.match(f.drift.message, /location/);
    assert.equal(f.drift.href, "?tab=info#h-linkedin", "the Event Info tab's LinkedIn section");
    assert.equal(f.eventUrl, EVENT_URL);
    assert.notEqual(linkedInFollowUp({ ledger: posted({ location: "food_hall" }), event: scheduled("other"), eventImage: LOGO }).drift, null);
  });

  it("flags an Event Image change: a different source, or another photo", () => {
    const up = linkedInFollowUp({ ledger: posted(), event: scheduled(), eventImage: UPLOADED });
    assert.deepEqual(up.drift.changes, ["image"]);
    assert.match(up.drift.message, /Event Image/);
    const sentPicked = posted({ imageSource: "referenced", imageRef: PICKED.image16x9.key });
    assert.equal(linkedInFollowUp({ ledger: sentPicked, event: scheduled(), eventImage: PICKED }).drift, null);
    const other = { ...PICKED, mediaId: "m3", image16x9: { key: "events/2077-12-28/m3/cover.jpg", contentType: "image/jpeg" } };
    assert.deepEqual(linkedInFollowUp({ ledger: sentPicked, event: scheduled(), eventImage: other }).drift.changes, ["image"]);
    assert.deepEqual(linkedInFollowUp({ ledger: sentPicked, event: scheduled(), eventImage: { ...PICKED, image16x9: null } }).drift.changes, ["image"]);
  });

  it("names both changes", () => {
    const f = linkedInFollowUp({ ledger: posted(), event: scheduled("food_hall"), eventImage: UPLOADED });
    assert.deepEqual(f.drift.changes, ["location", "image"]);
    assert.match(f.drift.message, /location and the Event Image/);
  });

  it("an imported row with no image recorded only checks the location", () => {
    const imported = posted({ imageSource: null, imageRef: null });
    assert.equal(linkedInFollowUp({ ledger: imported, event: scheduled(), eventImage: UPLOADED }).drift, null);
    assert.deepEqual(linkedInFollowUp({ ledger: imported, event: scheduled("food_hall"), eventImage: UPLOADED }).drift.changes, ["location"]);
  });

  it("never posted (no row, pending, created): nothing at all", () => {
    for (const ledger of [null, posted({ status: "pending", eventUrl: null }), posted({ status: "created" })]) {
      const f = linkedInFollowUp({ ledger, event: { status: "cancelled", location: "food_hall" }, eventImage: UPLOADED });
      assert.deepEqual(f, { eventUrl: null, drift: null, cancel: null }, String(ledger?.status));
    }
  });
});

describe("linkedInFollowUp: cancellation", () => {
  const cancelled = { status: "cancelled", location: "food_hall" };

  it("a cancelled event with a posted row: the cancel item, due, and no drift notice", () => {
    const f = linkedInFollowUp({ ledger: posted(), event: cancelled, eventImage: UPLOADED });
    assert.deepEqual(f.cancel, { due: true, doneAt: null, message: "Cancel the LinkedIn event on LinkedIn", href: "?tab=info#h-linkedin" });
    assert.equal(f.eventUrl, EVENT_URL);
    assert.equal(f.drift, null);
  });

  it("ticked Done on LinkedIn: not due any more, with when", () => {
    const at = new Date("2078-01-02T15:00:00Z");
    const f = linkedInFollowUp({ ledger: posted({ cancelledOnLinkedInAt: at }), event: cancelled, eventImage: LOGO });
    assert.equal(f.cancel.due, false);
    assert.equal(f.cancel.doneAt, at);
  });

  it("not cancelled: no cancel item", () => {
    assert.equal(linkedInFollowUp({ ledger: posted(), event: scheduled(), eventImage: LOGO }).cancel, null);
  });
});

