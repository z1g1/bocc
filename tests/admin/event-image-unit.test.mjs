// The Event Image's pure rules (ADR 0012 decision 3): which image an event uses
// (uploaded, then a referenced photo, then the BOCC logo) and its Readiness line. No
// database or storage. All inputs are synthetic.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_EVENT_IMAGE, inUseMessage, resolveEventImage } from "../../src/lib/admin/event-image-rules.mjs";
import { readiness } from "../../src/lib/admin/event-links-rules.mjs";

const uploaded = {
  id: "11111111-1111-4111-8111-111111111111", eventDate: "2026-11-24", kind: "event_image", status: "ready",
  originalKey: "events/2026-11-24/1111/original.png", displayKey: "events/2026-11-24/1111/display.jpg",
  thumbKey: "events/2026-11-24/1111/thumb.jpg", coverKey: "events/2026-11-24/1111/cover.jpg", contentType: "image/png",
};
const photo = {
  id: "22222222-2222-4222-8222-222222222222", eventDate: "2026-11-17", kind: "social_photo", status: "ready",
  originalKey: "events/2026-11-17/2222/original.jpg", displayKey: "events/2026-11-17/2222/display.jpg",
  thumbKey: "events/2026-11-17/2222/thumb.jpg", coverKey: "events/2026-11-17/2222/cover.jpg", contentType: "image/jpeg",
};

describe("Event Image resolution: uploaded, then referenced, then the logo", () => {
  test("nothing set: the square logo, with the checked-in wide logo as its 16:9 cover", () => {
    const r = resolveEventImage({});
    assert.equal(r.source, "default");
    assert.equal(r.mediaId, null);
    assert.deepEqual(r.original, { path: "/assets/images/brand/bocc-logo-square.png", contentType: "image/png", width: 2000, height: 2000 });
    assert.deepEqual(r.display, r.original);
    assert.deepEqual(r.cover, { path: "/assets/images/brand/bocc-logo-wide-16x9.png", contentType: "image/png", width: 1920, height: 1080 });
    assert.deepEqual(resolveEventImage(), r);
    assert.deepEqual(resolveEventImage({ uploaded: null, referenced: null }), r);
  });

  test("the default's files are checked in", () => {
    for (const f of [DEFAULT_EVENT_IMAGE.original, DEFAULT_EVENT_IMAGE.cover]) {
      assert.ok(existsSync(fileURLToPath(new URL(`../../public${f.path}`, import.meta.url))), f.path);
    }
  });

  test("an uploaded image wins over a referenced photo", () => {
    const r = resolveEventImage({ uploaded, referenced: photo });
    assert.equal(r.source, "uploaded");
    assert.equal(r.mediaId, uploaded.id);
    assert.deepEqual(r.original, { key: uploaded.originalKey, contentType: "image/png" });
    assert.deepEqual(r.display, { key: uploaded.displayKey, contentType: "image/jpeg" });
    assert.deepEqual(r.thumb, { key: uploaded.thumbKey, contentType: "image/jpeg" });
    assert.deepEqual(r.cover, { key: uploaded.coverKey, contentType: "image/jpeg" });
  });

  test("a referenced photo is used when nothing is uploaded", () => {
    const r = resolveEventImage({ referenced: photo });
    assert.equal(r.source, "referenced");
    assert.equal(r.mediaId, photo.id);
    assert.equal(r.eventDate, "2026-11-17", "the photo's own event");
    assert.deepEqual(r.cover, { key: photo.coverKey, contentType: "image/jpeg" });
  });

  test("a referenced photo with no cover copy yet has cover null (never the logo's)", () => {
    const r = resolveEventImage({ referenced: { ...photo, coverKey: null } });
    assert.equal(r.source, "referenced");
    assert.equal(r.cover, null);
  });

  test("a row that isn't ready is ignored", () => {
    assert.equal(resolveEventImage({ uploaded: { ...uploaded, status: "pending" } }).source, "default");
    assert.equal(resolveEventImage({ uploaded: { ...uploaded, status: "pending" }, referenced: photo }).source, "referenced");
  });
});

describe("Readiness: the Event Image line", () => {
  const event = { date: "2026-11-24", status: "scheduled", exists: true };
  const line = (eventImage) => readiness(event, {}, null, { eventImage }).items.find((i) => i.key === "event_image");

  test("set: done, says it's uploaded", () => {
    const i = line(resolveEventImage({ uploaded }));
    assert.equal(i.label, "Event Image");
    assert.equal(i.ok, true);
    assert.match(i.note, /uploaded/);
  });
  test("a referenced photo: done, names the photo's event", () => {
    const i = line(resolveEventImage({ referenced: photo }));
    assert.equal(i.ok, true);
    assert.match(i.note, /photo from 2026-11-17/);
  });
  test("default: not a failure, says the BOCC logo is in use", () => {
    const i = line(resolveEventImage({}));
    assert.equal(i.ok, null);
    assert.match(i.note, /default: the BOCC logo/);
  });
  test("no line when the caller doesn't pass the image (other pages)", () => {
    assert.equal(readiness(event, {}, null).items.find((i) => i.key === "event_image"), undefined);
  });
});

describe("the delete refusal's message names the events using the photo", () => {
  test("one, two and three events", () => {
    assert.equal(inUseMessage(["2026-11-24"]),
      "This photo is the Event Image for 2026-11-24, so it wasn't deleted. Pick another image for that event first.");
    assert.equal(inUseMessage(["2026-11-24", "2026-12-01"]),
      "This photo is the Event Image for 2026-11-24 and 2026-12-01, so it wasn't deleted. Pick another image for those events first.");
    assert.match(inUseMessage(["2026-11-24", "2026-12-01", "2026-12-08"]), /for 2026-11-24, 2026-12-01 and 2026-12-08,/);
  });
});
