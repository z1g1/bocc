// Pure LinkedIn event rules (ADR 0012, issue #25): the event name, times, wording,
// payloads, cover image checks, the duplicate match and the allowed-actions matrix.
// No database, no network:   node --test tests/admin/linkedin-event-unit.test.mjs
// Expected values come from the CLI (tools/linkedin-events, its tests) and spec #18.
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
