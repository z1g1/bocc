// Pure rules behind photo uploads and the sign-in board photo import (ADR 0010). No
// database, storage or browser: the browser helpers (public/js/admin-media-lib.js,
// served as /js/admin-media-lib.js) and the import's matching (scripts/signin-photos/
// match.mjs). All inputs are synthetic.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  ACCEPTED_TYPES, DISPLAY_EDGE, THUMB_EDGE, UNREADABLE_MESSAGE, checkFile, fitWithin, formatBytes,
  normalizeType, uploadRequestBody, MAX_ORIGINAL_BYTES, compose16x9, IMAGE_16X9_BACKGROUND,
  checkEventImage, eventImageRequestBody,
} from "../../public/js/admin-media-lib.js";
import {
  filenameDate, importId, isTuesday, matchPhotos, parseOverrides, resolvePlan, tuesdayOnOrBefore, formatTable,
} from "../../scripts/signin-photos/match.mjs";

describe("browser helpers: file checks", () => {
  test("the MIME type decides, not the file name", () => {
    assert.deepEqual(checkFile({ name: "a.heic", type: "image/jpeg", size: 10 }), { ok: true, contentType: "image/jpeg" });
    assert.deepEqual(checkFile({ name: "a.jpg", type: "image/png", size: 10 }), { ok: true, contentType: "image/png" });
    assert.equal(checkFile({ name: "photo.jpg", type: "image/gif", size: 10 }).ok, false);
    assert.equal(checkFile({ name: "photo.jpg", type: "text/html", size: 10 }).ok, false);
    assert.deepEqual(ACCEPTED_TYPES, ["image/jpeg", "image/png"]);
  });

  test("HEIC and type-less files get the 'can't be read' message", () => {
    for (const type of ["image/heic", "image/heif", "image/heic-sequence", ""]) {
      const r = checkFile({ name: "IMG_1.HEIC", type, size: 10 });
      assert.equal(r.ok, false, type);
      assert.ok(r.message.endsWith(UNREADABLE_MESSAGE), r.message);
    }
    assert.match(UNREADABLE_MESSAGE, /can't be read in this browser\. Upload from your iPhone, or export the photo as JPEG\./);
  });

  test("JPEG aliases are normalised; size limits apply", () => {
    assert.equal(normalizeType("image/JPG"), "image/jpeg");
    assert.equal(normalizeType("image/pjpeg; q=1"), "image/jpeg");
    assert.equal(checkFile({ type: "image/jpeg", size: 0 }).ok, false);
    assert.equal(checkFile({ type: "image/jpeg", size: MAX_ORIGINAL_BYTES }).ok, true);
    const big = checkFile({ name: "big.jpg", type: "image/jpeg", size: MAX_ORIGINAL_BYTES + 1 });
    assert.equal(big.ok, false);
    assert.match(big.message, /limit is 25\.0 MB/);
    assert.equal(formatBytes(900), "900 bytes");
    assert.equal(formatBytes(4096), "4 KB");
  });
});

describe("browser helpers: target sizes", () => {
  test("long edge 1600 / 400, aspect kept, whole pixels", () => {
    assert.deepEqual(fitWithin(4032, 3024, DISPLAY_EDGE), { width: 1600, height: 1200 });
    assert.deepEqual(fitWithin(3024, 4032, DISPLAY_EDGE), { width: 1200, height: 1600 });
    assert.deepEqual(fitWithin(5712, 4284, DISPLAY_EDGE), { width: 1600, height: 1200 });
    assert.deepEqual(fitWithin(8064, 6048, DISPLAY_EDGE), { width: 1600, height: 1200 }); // 48 MP
    assert.deepEqual(fitWithin(1600, 1200, THUMB_EDGE), { width: 400, height: 300 });
    assert.deepEqual(fitWithin(5000, 5000, 1600), { width: 1600, height: 1600 });
    assert.deepEqual(fitWithin(1170, 2532, 1600), { width: 739, height: 1600 }); // 739.3
  });

  test("never upscales; very thin images keep at least 1px", () => {
    assert.deepEqual(fitWithin(640, 480, 1600), { width: 640, height: 480 });
    assert.deepEqual(fitWithin(1600, 900, 1600), { width: 1600, height: 900 });
    assert.deepEqual(fitWithin(20000, 3, 400), { width: 400, height: 1 });
    assert.throws(() => fitWithin(0, 10, 400));
  });

  test("the request body never claims publicly usable for a sign-in board photo", () => {
    const base = { eventDate: "2026-11-24", original: { contentType: "image/jpeg", size: 9 }, display: { size: 5 }, thumb: { size: 2 } };
    assert.equal(uploadRequestBody({ ...base, kind: "signin_board", publiclyUsable: true }).publiclyUsable, false);
    assert.equal(uploadRequestBody({ ...base, kind: "social_photo", publiclyUsable: true }).publiclyUsable, true);
    assert.deepEqual(uploadRequestBody({ ...base, kind: "social_photo" }).display, { contentType: "image/jpeg", size: 5 });
  });
});

describe("browser helpers: the Event Image's 16:9 version, on the beans background (ticket #40)", () => {
  // Where the image goes on the 1920x1080 "Just the Beans" background: full height,
  // centred, never cropped. Draw with ctx.drawImage(src, dx, dy, dw, dh).
  test("the background is the checked-in 1920x1080 Just the Beans image", () => {
    assert.equal(IMAGE_16X9_BACKGROUND, "/assets/images/brand/just-the-beans-16x9.jpg");
    assert.deepEqual(compose16x9(2000, 2000).canvas, { width: 1920, height: 1080 });
  });
  test("a square image fills the height, centred", () => {
    assert.deepEqual(compose16x9(2000, 2000), { canvas: { width: 1920, height: 1080 }, dx: 420, dy: 0, dw: 1080, dh: 1080 });
  });
  test("a small square image is scaled up to the full height", () => {
    assert.deepEqual(compose16x9(480, 480), { canvas: { width: 1920, height: 1080 }, dx: 420, dy: 0, dw: 1080, dh: 1080 });
  });
  test("a portrait phone photo fills the height, narrower, centred", () => {
    // 3024x4032 at 1080 high is 810 wide.
    assert.deepEqual(compose16x9(3024, 4032), { canvas: { width: 1920, height: 1080 }, dx: 555, dy: 0, dw: 810, dh: 1080 });
  });
  test("a 4:3 landscape photo still fits at full height", () => {
    assert.deepEqual(compose16x9(4032, 3024), { canvas: { width: 1920, height: 1080 }, dx: 240, dy: 0, dw: 1440, dh: 1080 });
  });
  test("an exact 16:9 image covers the background", () => {
    assert.deepEqual(compose16x9(1280, 720), { canvas: { width: 1920, height: 1080 }, dx: 0, dy: 0, dw: 1920, dh: 1080 });
  });
  test("a landscape image wider than 16:9 is scaled down to fit the width, centred vertically", () => {
    assert.deepEqual(compose16x9(3000, 1000), { canvas: { width: 1920, height: 1080 }, dx: 0, dy: 220, dw: 1920, dh: 640 });
  });
  test("results are whole pixels; an odd leftover pixel goes to the right or bottom", () => {
    // 1001x1000 at 1080 high is 1081.08 wide -> 1081, leaving 839: 419 left, 420 right.
    assert.deepEqual(compose16x9(1001, 1000), { canvas: { width: 1920, height: 1080 }, dx: 419, dy: 0, dw: 1081, dh: 1080 });
    // 3000x1001 at 1920 wide is 640.64 high -> 641, leaving 439: 219 top, 220 bottom.
    assert.deepEqual(compose16x9(3000, 1001), { canvas: { width: 1920, height: 1080 }, dx: 0, dy: 219, dw: 1920, dh: 641 });
    for (const [w, h] of [[1234, 987], [987, 1234], [4999, 7], [7, 4999], [3333, 1111]]) {
      const r = compose16x9(w, h);
      for (const k of ["dx", "dy", "dw", "dh"]) assert.ok(Number.isInteger(r[k]) && r[k] >= 0, `${w}x${h} ${k}=${r[k]}`);
      assert.ok(r.dx + r.dw <= 1920 && r.dy + r.dh <= 1080, `${w}x${h} stays on the background`);
      assert.ok(r.dw === 1920 || r.dh === 1080, `${w}x${h} touches two edges`);
    }
  });
  test("refuses non-positive sizes", () => {
    assert.throws(() => compose16x9(0, 10));
  });
});

describe("browser helpers: Event Image checks (PNG or JPEG, at least 480x270, at most 8 MiB)", () => {
  const MiB = 1024 * 1024;
  const img = (over = {}) => ({ name: "cover.png", type: "image/png", size: 500_000, width: 2000, height: 2000, ...over });

  test("a square PNG or JPEG within the limits passes with no warning", () => {
    assert.deepEqual(checkEventImage(img()), { ok: true, contentType: "image/png", warning: null });
    assert.deepEqual(checkEventImage(img({ type: "image/jpg", width: 480, height: 480, size: 8 * MiB })),
      { ok: true, contentType: "image/jpeg", warning: null });
  });

  test("another type is refused", () => {
    for (const type of ["image/gif", "image/webp", "image/heic", ""]) {
      const r = checkEventImage(img({ type }));
      assert.equal(r.ok, false, type);
      assert.match(r.message, /PNG or JPEG/);
    }
  });

  test("over 8 MiB or empty is refused", () => {
    const big = checkEventImage(img({ size: 8 * MiB + 1 }));
    assert.equal(big.ok, false);
    assert.match(big.message, /limit is 8\.0 MB/);
    assert.equal(checkEventImage(img({ size: 0 })).ok, false);
  });

  test("smaller than 480x270 is refused, either edge", () => {
    for (const [width, height] of [[479, 1000], [1000, 269], [400, 225]]) {
      const r = checkEventImage(img({ width, height }));
      assert.equal(r.ok, false, `${width}x${height}`);
      assert.match(r.message, /at least 480×270/);
    }
  });

  test("not square is allowed with a warning: the Event Image should be 1:1", () => {
    for (const [width, height] of [[1920, 1080], [3024, 4032], [2002, 2000]]) {
      const r = checkEventImage(img({ width, height }));
      assert.equal(r.ok, true);
      assert.match(r.warning, new RegExp(`${width}×${height}, not square`));
      assert.match(r.warning, /1:1/);
    }
    // Within a pixel of square counts as square.
    assert.equal(checkEventImage(img({ width: 2001, height: 2000 })).warning, null);
  });

  test("the request body declares the original's size and dimensions and the three copies", () => {
    assert.deepEqual(eventImageRequestBody({
      eventDate: "2026-11-24", original: { contentType: "image/png", size: 9, width: 2000, height: 2000 },
      display: { size: 5 }, thumb: { size: 2 }, cover: { size: 4 },
    }), {
      eventDate: "2026-11-24", kind: "event_image",
      original: { contentType: "image/png", size: 9, width: 2000, height: 2000 },
      display: { contentType: "image/jpeg", size: 5 }, thumb: { contentType: "image/jpeg", size: 2 },
      cover: { contentType: "image/jpeg", size: 4 },
    });
  });
});

describe("photo import: dates and matching", () => {
  test("file-name dates", () => {
    assert.equal(filenameDate("12-3-2024.HEIC"), "2024-12-03");
    assert.equal(filenameDate("10-29-2024-02.HEIC"), "2024-10-29");
    assert.equal(filenameDate("08-27-2024.jpg"), "2024-08-27");
    assert.equal(filenameDate("IMG_2267 2.HEIC"), null);
    assert.equal(filenameDate("13-01-2024.HEIC"), null, "no month 13");
    assert.equal(filenameDate("02-30-2024.HEIC"), null, "no Feb 30");
    assert.equal(filenameDate("2024-12-03.HEIC"), null, "only MM-DD-YYYY");
  });

  test("Tuesdays", () => {
    assert.ok(isTuesday("2024-11-05"));
    assert.ok(!isTuesday("2024-11-06"));
    assert.equal(tuesdayOnOrBefore("2026-03-27"), "2026-03-24"); // Friday
    assert.equal(tuesdayOnOrBefore("2026-03-24"), "2026-03-24"); // Tuesday itself
    assert.equal(tuesdayOnOrBefore("2026-03-23"), "2026-03-17"); // Monday
  });

  const events = ["2024-09-03", "2024-09-10", "2024-11-05", "2026-03-24", "2026-04-07", "2026-06-02"];
  const one = (photo, opts = { eventDates: events }) => matchPhotos([photo], opts)[0];

  test("a clean file-name match is certain", () => {
    const r = one({ name: "09-10-2024.HEIC", capture: "2024-09-10T08:46:07" });
    assert.deepEqual([r.matched, r.reason, r.flags, r.uncertain], ["2024-09-10", "file name", [], false]);
  });

  test("file name vs capture date: within a day is fine, more is flagged", () => {
    assert.equal(one({ name: "09-10-2024.HEIC", capture: "2024-09-11T00:30:00" }).uncertain, false);
    const r = one({ name: "09-03-2024.HEIC", capture: "2024-09-09T21:45:36" });
    assert.equal(r.matched, "2024-09-03");
    assert.ok(r.flags.includes("file name and capture date differ by 6 days"));
    assert.ok(r.flags.includes("taken 6 days after the event"));
    const before = one({ name: "11-05-2024.HEIC", capture: "2024-10-29T08:00:00" });
    assert.ok(before.flags.includes("file name and capture date differ by 7 days"));
  });

  test("a file-name date that isn't a Tuesday is flagged", () => {
    const r = one({ name: "11-06-2024.HEIC", capture: "2024-11-06T08:00:00" });
    assert.ok(r.flags.includes("file-name date is a Wednesday"));
    assert.ok(r.flags.includes("no events row for this date"));
  });

  test("IMG_ files: the most recent event on or before the capture date", () => {
    const r = one({ name: "IMG_2209.HEIC", capture: "2026-03-27T16:24:43" });
    assert.deepEqual([r.matched, r.reason], ["2026-03-24", "capture date: event on or before"]);
    assert.ok(r.flags.includes("taken 3 days after the event"));
    const sameDay = one({ name: "IMG_1.HEIC", capture: "2026-04-07T09:13:05" });
    assert.deepEqual([sameDay.matched, sameDay.uncertain], ["2026-04-07", false]);
  });

  test("IMG_ files with no event that week fall back to the Tuesday on or before", () => {
    // 2026-05-27 is a Wednesday; the last event (2026-04-07) is weeks earlier.
    const r = one({ name: "IMG_9.HEIC", capture: "2026-05-27T08:00:00" });
    assert.deepEqual([r.matched, r.reason], ["2026-05-26", "capture date: Tuesday on or before"]);
    assert.ok(r.flags.includes("no events row for this date"));
    // An event later in the week than the capture date is never chosen.
    const early = one({ name: "IMG_8.HEIC", capture: "2026-06-01T08:00:00" });
    assert.equal(early.matched, "2026-05-26");
  });

  test("no date at all needs an override; events not checked flags everything", () => {
    const r = one({ name: "IMG_2892.JPG", capture: null });
    assert.deepEqual([r.matched, r.uncertain], [null, true]);
    assert.ok(r.flags.includes("no date: needs an override"));
    const unchecked = one({ name: "09-10-2024.HEIC", capture: "2024-09-10T08:00:00" }, {});
    assert.deepEqual(unchecked.flags, ["events not checked"]);
  });

  test("two photos for one date are both listed as uncertain", () => {
    const rows = matchPhotos([
      { name: "10-29-2024-01.HEIC", capture: "2024-10-29T09:42:51" },
      { name: "10-29-2024-02.HEIC", capture: "2024-10-29T09:42:48" },
      { name: "11-05-2024.HEIC", capture: "2024-11-05T08:41:27" },
    ], { eventDates: [...events, "2024-10-29"] });
    assert.deepEqual(rows.map((r) => r.uncertain), [true, true, false]);
    assert.ok(rows[0].flags.includes("2 photos for this date"));
    assert.match(formatTable(rows), /\? 10-29-2024-01\.HEIC .* 2 photos for this date/);
  });

  test("override file: dates, skip, names with spaces, comments; bad lines refused", () => {
    const o = parseOverrides("# confirmed by Zack\nIMG_2267 2.HEIC,2026-04-07\n\n11-06-2024.HEIC,skip\r\n");
    assert.deepEqual([...o], [["IMG_2267 2.HEIC", "2026-04-07"], ["11-06-2024.HEIC", "skip"]]);
    assert.throws(() => parseOverrides("a.HEIC,2026-02-30"), /line 1/);
    assert.throws(() => parseOverrides("a.HEIC"), /line 1/);
    assert.throws(() => parseOverrides("a.HEIC,skip\na.HEIC,2026-01-06"), /listed twice/);
  });

  test("apply refuses unless every uncertain row is confirmed, and every override is a real file", () => {
    const rows = matchPhotos([
      { name: "09-10-2024.HEIC", sha256: "a".repeat(64), capture: "2024-09-10T08:00:00" },
      { name: "IMG_2892.JPG", sha256: "b".repeat(64), capture: null },
      { name: "11-06-2024.HEIC", sha256: "c".repeat(64), capture: "2024-11-26T08:39:16" },
    ], { eventDates: events });
    assert.throws(() => resolvePlan(rows, new Map()), /uncertain and not confirmed: IMG_2892\.JPG, 11-06-2024\.HEIC/);
    assert.throws(() => resolvePlan(rows, new Map([["IMG_2892.JPG", "2026-09-08"], ["11-06-2024.HEIC", "skip"], ["nope.HEIC", "skip"]])),
      /not in the import: nope\.HEIC/);
    const { plan, skipped } = resolvePlan(rows, new Map([["IMG_2892.JPG", "2026-09-08"], ["11-06-2024.HEIC", "skip"]]));
    assert.deepEqual(skipped, ["11-06-2024.HEIC"]);
    assert.deepEqual(plan.map((p) => [p.name, p.date, p.overridden]),
      [["09-10-2024.HEIC", "2024-09-10", false], ["IMG_2892.JPG", "2026-09-08", true]]);
  });

  test("identical files under different names are flagged, and only one may be imported", () => {
    const same = "d".repeat(64);
    const rows = matchPhotos([
      { name: "09-10-2024.HEIC", sha256: same, capture: "2024-09-10T08:00:00" },
      { name: "09-10-2024 copy.HEIC", sha256: same, capture: "2024-09-10T08:00:00" },
      { name: "09-03-2024.HEIC", sha256: "e".repeat(64), capture: "2024-09-03T08:00:00" },
    ], { eventDates: events });
    assert.ok(rows[0].flags.includes("same bytes as 09-10-2024 copy.HEIC"));
    assert.ok(rows[1].flags.includes("same bytes as 09-10-2024.HEIC"));
    assert.ok(!rows[2].flags.some((f) => f.startsWith("same bytes")));
    const both = new Map([["09-10-2024.HEIC", "2024-09-10"], ["09-10-2024 copy.HEIC", "2024-09-10"]]);
    assert.throws(() => resolvePlan(rows, both), /same bytes, skip all but one: 09-10-2024\.HEIC, 09-10-2024 copy\.HEIC/);
    const { plan, skipped } = resolvePlan(rows, new Map([["09-10-2024.HEIC", "2024-09-10"], ["09-10-2024 copy.HEIC", "skip"]]));
    assert.deepEqual([plan.map((p) => p.name), skipped], [["09-10-2024.HEIC", "09-03-2024.HEIC"], ["09-10-2024 copy.HEIC"]]);
  });

  test("import ids are stable UUIDs derived from the file hash", () => {
    const h = "0123456789abcdef".repeat(4);
    const id = importId(h);
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(importId(h), id);
    assert.notEqual(importId("f".repeat(64)), id);
    assert.throws(() => importId("XYZ"));
  });
});
