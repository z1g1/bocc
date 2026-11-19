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

describe("Readiness: Default or Custom Cover Image", () => {
  const event = { date: "2026-11-24", status: "scheduled", exists: true };
  const cover = (eventImage) => readiness(event, {}, null, { eventImage }).listings.cover;

  test("an uploaded Event Image or a Photo from Event: Custom Cover Image", () => {
    assert.equal(cover(resolveEventImage({ uploaded })), "Custom Cover Image");
    assert.equal(cover(resolveEventImage({ referenced: photo })), "Custom Cover Image");
  });
  test("the BOCC logo default: Default Cover Image", () => {
    assert.equal(cover(resolveEventImage({})), "Default Cover Image");
  });
  test("no Event Image line any more", () => {
    const r = readiness(event, {}, null, { eventImage: resolveEventImage({ uploaded }) });
    assert.ok(![...r.listings.parts, ...r.listings.items].some((i) => i.key === "event_image"));
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

// The checked-in default files on the server (the LinkedIn upload of the logo cover).
// The Netlify SSR function bundle has no public/ directory, so the file is fetched
// from the site's own origin when it isn't on disk.
describe("readPublicAsset: disk first, then the site's own origin", async () => {
  const { readPublicAsset } = await import("../../src/lib/admin/public-asset.mjs");
  const PATH = "/assets/images/brand/bocc-logo-wide-16x9.png";
  const NOWHERE = new URL("file:///nonexistent-bundle/");

  test("reads the file from public/ when it's there (dev, tests)", async () => {
    const bytes = await readPublicAsset(PATH, { fetch: () => assert.fail("no fetch when on disk") });
    assert.deepEqual([...bytes.subarray(1, 4)], [0x50, 0x4e, 0x47]);
  });

  test("not on disk (the function bundle): GETs it from BETTER_AUTH_URL, no redirects", async () => {
    const calls = [];
    const bytes = await readPublicAsset(PATH, {
      root: NOWHERE,
      baseURL: "https://716coffee.club",
      fetch: async (url, init) => { calls.push([String(url), init.redirect]); return new Response(new Uint8Array([1, 2, 3]), { status: 200 }); },
    });
    assert.deepEqual(calls, [["https://716coffee.club/assets/images/brand/bocc-logo-wide-16x9.png", "error"]]);
    assert.deepEqual([...bytes], [1, 2, 3]);
  });

  test("a failed fetch is an error, never empty bytes", async () => {
    await assert.rejects(readPublicAsset(PATH, {
      root: NOWHERE, baseURL: "https://716coffee.club", fetch: async () => new Response("nope", { status: 404 }),
    }), /HTTP 404/);
  });

  test("refuses a path outside /assets/", async () => {
    await assert.rejects(readPublicAsset("/../package.json", {}), /refused/);
  });
});
