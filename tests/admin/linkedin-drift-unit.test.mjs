// LinkedIn drift and cancellation rules (ADR 0012, issue #27), pure: no database, no
// network. Runs on its own:
//   node --test tests/admin/linkedin-drift-unit.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { linkedInFollowUp } from "../../src/lib/linkedin/rules.mjs";
import { readiness } from "../../src/lib/admin/event-links-rules.mjs";

const EVENT_URL = "https://www.linkedin.com/events/7249812613549670400/";
const LOGO = { source: "default", mediaId: null, eventDate: null, cover: { path: "/assets/images/brand/bocc-logo-wide-16x9.png", contentType: "image/png" } };
const UPLOADED = { source: "uploaded", mediaId: "m1", eventDate: "2078-01-04", cover: { key: "events/2078-01-04/m1/cover.jpg", contentType: "image/jpeg" } };
const PICKED = { source: "referenced", mediaId: "m2", eventDate: "2077-12-28", cover: { key: "events/2077-12-28/m2/cover.jpg", contentType: "image/jpeg" } };

/** A posted ledger row as the use-case reads it, sent with the lobby wording and the logo. */
const posted = (over = {}) => ({
  status: "posted", location: "lobby", imageSource: "default", imageRef: LOGO.cover.path,
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

  it("flags a location change, with a message and the event link", () => {
    const f = linkedInFollowUp({ ledger: posted(), event: scheduled("food_hall"), eventImage: LOGO });
    assert.deepEqual(f.drift.changes, ["location"]);
    assert.match(f.drift.message, /^LinkedIn is out of date/);
    assert.match(f.drift.message, /location/);
    assert.equal(f.drift.href, EVENT_URL);
    assert.notEqual(linkedInFollowUp({ ledger: posted({ location: "food_hall" }), event: scheduled("other"), eventImage: LOGO }).drift, null);
  });

  it("flags an Event Image change: a different source, or another photo", () => {
    const up = linkedInFollowUp({ ledger: posted(), event: scheduled(), eventImage: UPLOADED });
    assert.deepEqual(up.drift.changes, ["image"]);
    assert.match(up.drift.message, /Event Image/);
    const sentPicked = posted({ imageSource: "referenced", imageRef: PICKED.cover.key });
    assert.equal(linkedInFollowUp({ ledger: sentPicked, event: scheduled(), eventImage: PICKED }).drift, null);
    const other = { ...PICKED, mediaId: "m3", cover: { key: "events/2077-12-28/m3/cover.jpg", contentType: "image/jpeg" } };
    assert.deepEqual(linkedInFollowUp({ ledger: sentPicked, event: scheduled(), eventImage: other }).drift.changes, ["image"]);
    assert.deepEqual(linkedInFollowUp({ ledger: sentPicked, event: scheduled(), eventImage: { ...PICKED, cover: null } }).drift.changes, ["image"]);
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
    assert.deepEqual(f.cancel, { due: true, doneAt: null, message: "Cancel the LinkedIn event on LinkedIn", href: EVENT_URL });
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

describe("readiness: the LinkedIn lines", () => {
  const event = { date: "2078-01-04", status: "scheduled", exists: true };
  const lines = (linkedIn, ev = event) => readiness(ev, {}, null, { linkedIn }).items.filter((i) => i.key.startsWith("linkedin_") && i.key !== "linkedin_event");

  it("none without a follow-up (never posted, or no ledger read)", () => {
    assert.deepEqual(lines(undefined), []);
    assert.deepEqual(lines({ eventUrl: null, drift: null, cancel: null }), []);
    assert.deepEqual(lines({ eventUrl: EVENT_URL, drift: null, cancel: null }), []);
  });

  it("drift: a red 'LinkedIn is out of date' line linking the event", () => {
    const f = linkedInFollowUp({ ledger: posted(), event: scheduled("food_hall"), eventImage: LOGO });
    const [line] = lines(f);
    assert.equal(line.key, "linkedin_drift");
    assert.equal(line.ok, false);
    assert.match(line.label, /^LinkedIn is out of date/);
    assert.equal(line.href, EVENT_URL);
  });

  it("cancelled and not done: a red 'Cancel the LinkedIn event on LinkedIn' line; done clears it", () => {
    const ev = { ...event, status: "cancelled" };
    const [line] = lines(linkedInFollowUp({ ledger: posted(), event: ev, eventImage: LOGO }), ev);
    assert.deepEqual(line, { key: "linkedin_cancel", label: "Cancel the LinkedIn event on LinkedIn", ok: false, href: EVENT_URL });
    const done = linkedInFollowUp({ ledger: posted({ cancelledOnLinkedInAt: new Date() }), event: ev, eventImage: LOGO });
    assert.deepEqual(lines(done, ev), []);
  });
});
