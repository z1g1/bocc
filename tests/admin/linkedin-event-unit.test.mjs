// Pure LinkedIn event rules (ADR 0012, issue #25): the event name, times, wording,
// payloads, 16:9 Event Image checks, the duplicate match and the allowed-actions matrix.
// No database, no network:   node --test tests/admin/linkedin-event-unit.test.mjs
// Expected values come from the retired CLI (tools/linkedin-events, its tests, in git history) and spec #18.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as rules from "../../src/lib/linkedin/rules.mjs";

describe("eventName: full month and ordinal day (decision on #25)", () => {
  const cases = {
    "2026-10-06": "Buffalo Open Coffee Club for October 6th",
    "2026-09-01": "Buffalo Open Coffee Club for September 1st",
    "2026-06-02": "Buffalo Open Coffee Club for June 2nd",
    "2026-02-03": "Buffalo Open Coffee Club for February 3rd",
    "2026-08-04": "Buffalo Open Coffee Club for August 4th",
    "2026-08-11": "Buffalo Open Coffee Club for August 11th",
    "2026-05-12": "Buffalo Open Coffee Club for May 12th",
    "2026-10-13": "Buffalo Open Coffee Club for October 13th",
    "2026-07-21": "Buffalo Open Coffee Club for July 21st",
    "2026-09-22": "Buffalo Open Coffee Club for September 22nd",
    "2026-06-23": "Buffalo Open Coffee Club for June 23rd",
    "2026-03-31": "Buffalo Open Coffee Club for March 31st",
  };
  for (const [date, name] of Object.entries(cases)) {
    it(`${date} -> ${name}`, () => assert.equal(rules.eventName(date), name));
  }
});

const NORMAL_DESCRIPTION = "Join us on October 6th for Buffalo Open Coffee Club, Your First Free Entrepreneurial Step in Buffalo. "
  + "A free, no-frills coffee meetup for the people building & running businesses in the 716.";
const FOOD_HALL_TEXT = "Please join me at Buffalo Open Coffee Club. This week the event will be in the Seneca One Food hall vs our normal lobby location";
const ADDRESS = { line1: "1 Seneca St", city: "Buffalo", geographicArea: "New York", postalCode: "14203", country: "US" };

describe("buildEventSpec: wording chosen by location only", () => {
  for (const location of ["lobby", null, undefined]) {
    it(`${location} gets the normal description, venue note and commentary`, () => {
      const r = rules.buildEventSpec({ date: "2026-10-06", location });
      assert.equal(r.ok, true);
      assert.deepEqual(r.spec, {
        date: "2026-10-06",
        location: location ?? null,
        name: "Buffalo Open Coffee Club for October 6th",
        description: NORMAL_DESCRIPTION,
        venueDetails: "BOCC is right in the lobby, please come up the escalators",
        commentary: "Please join me at Buffalo Open Coffee Club",
        startsAt: 1791286200000,
        endsAt: 1791291600000,
      });
    });
  }

  it("food_hall gets the food-hall text as description and commentary, and the food-hall venue note", () => {
    const { spec } = rules.buildEventSpec({ date: "2026-10-06", location: "food_hall" });
    assert.equal(spec.description, FOOD_HALL_TEXT);
    assert.equal(spec.commentary, FOOD_HALL_TEXT);
    assert.equal(spec.venueDetails, "This week BOCC is in the Seneca One Food hall, not the lobby");
    assert.equal(spec.location, "food_hall");
  });

  it("other is refused with a clear message", () => {
    const r = rules.buildEventSpec({ date: "2026-10-06", location: "other" });
    assert.equal(r.ok, false);
    assert.equal(r.refusal.code, "location_other");
    assert.match(r.refusal.message, /location is "Other"/i);
  });
});

describe("payloads", () => {
  const { spec } = rules.buildEventSpec({ date: "2026-10-06", location: "lobby" });

  it("event: exactly the CLI's keys, always LISTED, the BOCC organizer, the cover asset", () => {
    assert.deepEqual(rules.buildEventPayload(spec, "urn:li:digitalmediaAsset:D55"), {
      organizer: "urn:li:organization:89993057",
      name: { localized: { en_US: "Buffalo Open Coffee Club for October 6th" } },
      description: { localized: { en_US: { rawText: NORMAL_DESCRIPTION } } },
      startsAt: 1791286200000,
      type: {
        inPerson: {
          endsAt: 1791291600000,
          url: "https://luma.com/716coffeeclub",
          address: ADDRESS,
          venueDetails: { localized: { en_US: { rawText: "BOCC is right in the lobby, please come up the escalators" } } },
        },
      },
      discoveryMode: "LISTED",
      backgroundImage: "urn:li:digitalmediaAsset:D55",
    });
  });

  it("food hall, after the DST change: the times and the food-hall venue note", () => {
    const fh = rules.buildEventSpec({ date: "2026-11-03", location: "food_hall" }).spec;
    const p = rules.buildEventPayload(fh, "urn:li:digitalmediaAsset:X");
    assert.equal(p.name.localized.en_US, "Buffalo Open Coffee Club for November 3rd");
    assert.equal(p.startsAt, Date.parse("2026-11-03T12:30:00Z"));
    assert.equal(p.type.inPerson.endsAt, Date.parse("2026-11-03T14:00:00Z"));
    assert.equal(p.type.inPerson.venueDetails.localized.en_US.rawText, "This week BOCC is in the Seneca One Food hall, not the lobby");
    assert.equal(p.description.localized.en_US.rawText, FOOD_HALL_TEXT);
  });

  it("image upload: owned by the member", () => {
    assert.deepEqual(rules.buildImageUploadPayload("urn:li:person:me"), { initializeUploadRequest: { owner: "urn:li:person:me" } });
  });

  it("member post: PUBLIC, main feed, referencing the event, published", () => {
    assert.deepEqual(rules.buildPostPayload("urn:li:person:me", "7249812613549670400", "Please join me at Buffalo Open Coffee Club"), {
      author: "urn:li:person:me",
      commentary: "Please join me at Buffalo Open Coffee Club",
      visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      content: { reference: { id: "urn:li:event:7249812613549670400" } },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    });
  });
});

describe("findDuplicates: same name (new or old CLI style) or same Eastern day", () => {
  const { spec } = rules.buildEventSpec({ date: "2026-10-06", location: "lobby" });
  const li = (id, name, startsAt) => ({ id, name: { localized: { en_US: name } }, startsAt });
  const OTHER_DAY = Date.parse("2026-10-13T11:30:00Z");

  it("matches the new name, case-insensitively", () => {
    const e = li("1", "buffalo open coffee club for OCTOBER 6TH", OTHER_DAY);
    assert.deepEqual(rules.findDuplicates([e], spec).map((x) => x.id), ["1"]);
  });
  it("matches the CLI's old 10/6 name", () => {
    const e = li("2", "Buffalo Open Coffee Club for 10/6", OTHER_DAY);
    assert.deepEqual(rules.findDuplicates([e], spec).map((x) => x.id), ["2"]);
  });
  it("matches anything on the same Eastern day, whatever its name or hour", () => {
    // 2026-10-06 23:30 EDT is 03:30Z on the 7th: still the 6th in Buffalo.
    const late = li("3", "Something else", Date.parse("2026-10-07T03:30:00Z"));
    const early = li("4", "Another", Date.parse("2026-10-06T04:30:00Z"));
    assert.deepEqual(rules.findDuplicates([late, early], spec).map((x) => x.id), ["3", "4"]);
  });
  it("ignores other names on other days, and the day before in Eastern time", () => {
    const dayBefore = li("5", "x", Date.parse("2026-10-06T03:30:00Z")); // 23:30 on the 5th, EDT
    const other = li("6", "Buffalo Open Coffee Club for 10/13", OTHER_DAY);
    assert.deepEqual(rules.findDuplicates([dayBefore, other, { id: "7" }], spec), []);
  });
});

/** The start of a PNG: signature and IHDR with the given size (the checks read only that). */
function png(width, height, pad = 0) {
  const b = Buffer.alloc(33 + pad);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}
/** A JPEG: SOI, an APP0 segment, then SOF0 with the size. */
function jpeg(width, height) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.alloc(19);
  sof.set([0xff, 0xc0, 0x00, 0x11, 0x08]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

describe("checkImage16x9: PNG/JPEG by magic bytes, 480x270 minimum, 8 MiB cap, 16:9 warning", () => {
  it("a 1920x1080 PNG passes with no warning", () => {
    assert.deepEqual(rules.checkImage16x9(png(1920, 1080)), { ok: true, contentType: "image/png", width: 1920, height: 1080, bytes: 33, errors: [], warnings: [] });
  });
  it("a JPEG is read from its SOF segment", () => {
    const r = rules.checkImage16x9(jpeg(1280, 720));
    assert.equal(r.ok, true);
    assert.equal(r.contentType, "image/jpeg");
    assert.deepEqual([r.width, r.height], [1280, 720]);
  });
  it("refuses anything else, whatever it claims to be", () => {
    const r = rules.checkImage16x9(Buffer.from("GIF89a........"));
    assert.equal(r.ok, false);
    assert.match(r.errors[0], /PNG or JPEG/);
  });
  it("refuses smaller than 480x270", () => {
    const r = rules.checkImage16x9(png(479, 270));
    assert.equal(r.ok, false);
    assert.match(r.errors.join(" "), /480×270/);
  });
  it("refuses over 8 MiB", () => {
    const r = rules.checkImage16x9(png(1920, 1080, 8 * 1024 * 1024));
    assert.equal(r.ok, false);
    assert.match(r.errors.join(" "), /8 MiB/);
  });
  it("refuses more than 36,152,320 pixels", () => {
    assert.equal(rules.checkImage16x9(png(8000, 4600)).ok, false);
  });
  it("the checked-in 16:9 logo default passes with no warning", async () => {
    const { readFile } = await import("node:fs/promises");
    const bytes = await readFile(new URL("../../public/assets/images/brand/bocc-logo-wide-16x9.png", import.meta.url));
    const r = rules.checkImage16x9(bytes);
    assert.deepEqual([r.ok, r.width, r.height, r.warnings], [true, 1920, 1080, []]);
  });
  it("warns, but passes, when the ratio is more than 5% off 16:9 (the CLI's 2:1 default)", () => {
    const r = rules.checkImage16x9(png(1280, 640));
    assert.equal(r.ok, true);
    assert.match(r.warnings[0], /16:9/);
    assert.deepEqual(rules.checkImage16x9(png(1300, 720)).warnings, []);
  });
  it("its messages name the 16:9 Event Image, never the cover", () => {
    const msgs = [
      ...rules.checkImage16x9(Buffer.from("GIF89a........")).errors,
      ...rules.checkImage16x9(png(479, 270, 8 * 1024 * 1024)).errors,
      ...rules.checkImage16x9(png(8000, 4600)).errors,
      ...rules.checkImage16x9(png(1280, 640)).warnings,
      rules.REFUSALS.image,
    ];
    assert.equal(msgs.length, 6);
    for (const m of msgs) {
      assert.match(m, /16:9 Event Image/);
      assert.doesNotMatch(m, /cover/i);
    }
  });
});

describe("allowedActions: state x date x cancelled x location x LinkedIn authentication x environment", () => {
  const NOW = new Date("2026-10-02T16:00:00Z"); // the CLI tests' clock: the Friday before
  const base = {
    date: "2026-10-06", now: NOW, event: { status: "scheduled", location: "lobby" },
    ledger: null, authentication: { level: "ok" }, live: true,
  };
  const codes = (over) => rules.allowedActions({ ...base, ...over }).refusals.map((r) => r.code);

  it("an upcoming scheduled event, authenticated, nothing in the ledger: create, live", () => {
    assert.deepEqual(rules.allowedActions(base), { action: "create", mode: "live", refusals: [] });
  });
  it("dry run everywhere LINKEDIN_LIVE isn't set", () => {
    assert.equal(rules.allowedActions({ ...base, live: false }).mode, "dry_run");
  });
  it("refuses once the start time has passed (7:30 Eastern on the day)", () => {
    assert.deepEqual(codes({ now: new Date("2026-10-06T11:29:00Z") }), []);
    assert.deepEqual(codes({ now: new Date("2026-10-06T11:30:00Z") }), ["past"]);
    assert.deepEqual(codes({ date: "2026-09-29" }), ["past"]);
  });
  it("refuses a cancelled event and location other; null and food_hall are fine", () => {
    assert.deepEqual(codes({ event: { status: "cancelled", location: "lobby" } }), ["cancelled"]);
    assert.deepEqual(codes({ event: { status: "scheduled", location: "other" } }), ["location_other"]);
    assert.deepEqual(codes({ event: { status: "scheduled", location: null } }), []);
    assert.deepEqual(codes({ event: { status: "scheduled", location: "food_hall" } }), []);
  });
  it("live: refuses no LinkedIn authentication and an expired one; amber is fine", () => {
    assert.deepEqual(codes({ authentication: null }), ["no_authentication"]);
    assert.deepEqual(codes({ authentication: { level: "red" } }), ["expired"]);
    assert.deepEqual(codes({ authentication: { level: "amber" } }), []);
  });
  it("dry run: no LinkedIn authentication is not a refusal (the duplicate check is skipped)", () => {
    assert.deepEqual(codes({ live: false, authentication: null }), []);
    assert.deepEqual(codes({ live: false, authentication: { level: "red" } }), []);
  });
  it("says LinkedIn authentication, never connection (GLOSSARY.md)", () => {
    const msg = (over) => rules.allowedActions({ ...base, ...over }).refusals[0].message;
    assert.equal(msg({ authentication: null }), "Authenticate with LinkedIn first.");
    assert.equal(msg({ authentication: { level: "red" } }), "Your LinkedIn authentication has expired. Re-authenticate with LinkedIn first.");
    for (const m of Object.values(rules.REFUSALS)) {
      assert.doesNotMatch(m, /connect|Publish event/i, m);
    }
  });
  it("lists every refusal at once", () => {
    assert.deepEqual(codes({ date: "2026-09-29", event: { status: "cancelled", location: "other" }, authentication: null }),
      ["past", "cancelled", "location_other", "no_authentication"]);
  });
  it("a ledger row for the date: create is refused and the row's recovery is offered", () => {
    const at = (status, over = {}) => rules.allowedActions({ ...base, ...over, ledger: { status } });
    assert.deepEqual(at("pending"), { action: "allow_retry", mode: "live", refusals: [{ code: "ledger", message: rules.REFUSALS.ledger }] });
    assert.equal(at("created").action, "publish_retry");
    assert.equal(at("posted").action, "none");
    assert.deepEqual(at("posted").refusals.map((r) => r.code), ["ledger"]);
    // Allow-retry doesn't care about the date or the event's state.
    assert.equal(at("pending", { date: "2026-09-29", event: { status: "cancelled", location: "other" } }).action, "allow_retry");
  });
  it("a created row: Publish the LinkedIn post is refused like create once past or cancelled, and without a live LinkedIn authentication", () => {
    const at = (over) => rules.allowedActions({ ...base, ...over, ledger: { status: "created" } }).refusals.map((r) => r.code);
    assert.deepEqual(at({}), ["ledger"]);
    assert.deepEqual(at({ now: new Date("2026-10-06T11:30:00Z") }), ["ledger", "past"]);
    assert.deepEqual(at({ event: { status: "cancelled", location: "lobby" } }), ["ledger", "cancelled"]);
    // The post doesn't carry the location: "other" doesn't block it.
    assert.deepEqual(at({ event: { status: "scheduled", location: "other" } }), ["ledger"]);
    assert.deepEqual(at({ authentication: null }), ["ledger", "no_authentication"]);
    assert.deepEqual(at({ authentication: null, live: false }), ["ledger"]);
  });
});

describe("publishRefusals: the server's check for one Publish the LinkedIn post request", () => {
  const ctx = {
    date: "2026-10-06", now: new Date("2026-10-02T16:00:00Z"), event: { status: "scheduled", location: "lobby" },
    ledger: { status: "created" }, authentication: { level: "ok" }, live: true,
  };
  const codes = (over, req = { confirm: "live" }) => rules.publishRefusals({ ...ctx, ...over }, req).map((r) => r.code);
  it("a created row, confirmed, upcoming: allowed", () => assert.deepEqual(codes({}), []));
  it("requires confirm=live", () => assert.deepEqual(codes({}, {}), ["confirm"]));
  it("only a created row", () => {
    assert.deepEqual(codes({ ledger: null }), ["not_created"]);
    assert.deepEqual(codes({ ledger: { status: "pending" } }), ["not_created"]);
    assert.deepEqual(codes({ ledger: { status: "posted" } }), ["not_created"]);
  });
  it("refuses past dates, cancelled events and a missing or expired live LinkedIn authentication", () => {
    assert.deepEqual(codes({ date: "2026-09-29" }), ["past"]);
    assert.deepEqual(codes({ event: { status: "cancelled", location: null } }), ["cancelled"]);
    assert.deepEqual(codes({ authentication: { level: "red" } }), ["expired"]);
    assert.deepEqual(codes({ date: "2026-09-29" }, {}), ["confirm", "past"]);
  });
});

describe("createRefusals: the server's check for one create request", () => {
  const ctx = {
    date: "2026-10-06", now: new Date("2026-10-02T16:00:00Z"), event: { status: "scheduled", location: "lobby" },
    ledger: null, authentication: { level: "ok" }, live: false,
  };
  it("requires confirm=live, in dry run too", () => {
    assert.deepEqual(rules.createRefusals(ctx, { confirm: "live" }), []);
    for (const confirm of [undefined, null, "", "yes", "LIVE"]) {
      assert.deepEqual(rules.createRefusals(ctx, { confirm }).map((r) => r.code), ["confirm"]);
    }
  });
  it("adds the matrix's refusals, and the ledger when there's a row", () => {
    assert.deepEqual(rules.createRefusals({ ...ctx, ledger: { status: "posted" } }, { confirm: "live" }).map((r) => r.code), ["ledger"]);
    assert.deepEqual(rules.createRefusals({ ...ctx, event: { status: "cancelled", location: null } }, {}).map((r) => r.code), ["confirm", "cancelled"]);
  });
});

describe("eventWindow: Tuesday 7:30-9:00 America/New_York as UTC epoch ms", () => {
  it("matches the CLI fixture for 2026-10-06 (EDT)", () => {
    assert.deepEqual(rules.eventWindow("2026-10-06"), { startsAt: 1791286200000, endsAt: 1791291600000 });
  });
  it("is 11:30Z in EDT and 12:30Z in EST, either side of the November DST change", () => {
    const before = rules.eventWindow("2026-10-27");
    const after = rules.eventWindow("2026-11-03");
    assert.equal(new Date(before.startsAt).toISOString(), "2026-10-27T11:30:00.000Z");
    assert.equal(new Date(before.endsAt).toISOString(), "2026-10-27T13:00:00.000Z");
    assert.equal(new Date(after.startsAt).toISOString(), "2026-11-03T12:30:00.000Z");
    assert.equal(new Date(after.endsAt).toISOString(), "2026-11-03T14:00:00.000Z");
  });
  it("and either side of the March change", () => {
    assert.equal(new Date(rules.eventWindow("2027-03-09").startsAt).toISOString(), "2027-03-09T12:30:00.000Z");
    assert.equal(new Date(rules.eventWindow("2027-03-16").startsAt).toISOString(), "2027-03-16T11:30:00.000Z");
  });
});
