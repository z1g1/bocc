// The CLI ledger import (backend/scripts/import-linkedin-ledger.js, issue #28):
//   1. the mapping of the CLI's ledger.json entries onto `linkedin_events` rows, as a function
//   2. the script end to end against the throwaway database (npm run test:db), as the
//      owner, with the fixture ledger (tests/admin/fixtures/linkedin-ledger.json, in the
//      CLI's own format): dry run writes nothing, --apply imports once with one audit
//      row, a second --apply changes nothing, pending entries are skipped and reported,
//      a stored row that disagrees is a conflict.
// The HTTP check (an imported week shows Posted, create refused) is in linkedin-live.test.mjs.
// Dates: 2064 (no other file uses it).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OWNER_URL, connect } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const SCRIPT = fileURLToPath(new URL("../../backend/scripts/import-linkedin-ledger.js", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/linkedin-ledger.json", import.meta.url));
const imp = require(SCRIPT);

const LOBBY = "Please join me at Buffalo Open Coffee Club";
const FOOD_HALL = "Please join me at Buffalo Open Coffee Club. This week the event will be in the Seneca One Food hall vs our normal lobby location";

describe("mapping the CLI ledger", () => {
  test("posted and created entries become rows; pending is skipped and reported", async () => {
    const p = await imp.planLedger(readFileSync(FIXTURE, "utf8"));
    assert.deepEqual(p.errors, []);
    assert.deepEqual(p.skipped, [{ date: "2064-01-22", status: "pending", reason: p.skipped[0]?.reason }]);
    assert.match(p.skipped[0].reason, /outcome unknown/);
    assert.deepEqual(p.rows.map((r) => [r.date, r.status]), [["2064-01-01", "posted"], ["2064-01-08", "posted"], ["2064-01-15", "created"]]);
    assert.deepEqual(p.rows[0], {
      date: "2064-01-01",
      status: "posted",
      name: "Buffalo Open Coffee Club for 1/1",
      commentary: LOBBY, // older entries have no commentary: the CLI posted the default
      location: "lobby",
      linkedinEventId: "7249812613549670401", // all 19 digits, never a JS number
      eventUrl: "https://www.linkedin.com/events/buffaloopencoffeeclubfor1-17249812613549670401/",
      postUrn: "urn:li:ugcPost:7511865991627468801",
      postUrl: "https://www.linkedin.com/feed/update/urn:li:ugcPost:7511865991627468801/",
      attemptedAt: "2063-12-27T15:58:12.104233+00:00",
      eventCreatedAt: "2063-12-27T15:58:14.551902+00:00",
      postedAt: "2063-12-27T15:58:15.900118+00:00",
    });
    assert.deepEqual([p.rows[1].location, p.rows[1].commentary, p.rows[1].postUrl],
      ["food_hall", FOOD_HALL, "https://www.linkedin.com/feed/update/urn:li:share:7511865991627468808/"]);
    assert.deepEqual([p.rows[2].postUrn, p.rows[2].postUrl, p.rows[2].postedAt], [null, null, null]);
  });

  test("bad entries are errors, not rows: a numeric id, an unknown status, a bad URL or URN, a bad date", async () => {
    const good = JSON.parse(readFileSync(FIXTURE, "utf8")).events["2064-01-01"];
    // A 19-digit id as a JSON number: written by hand so JSON.stringify can't round it first.
    const text = `{"events": {
      "2064-01-01": ${JSON.stringify(good).replace('"event_id":"7249812613549670401"', '"event_id":7249812613549670401')},
      "2064-01-08": ${JSON.stringify({ ...good, status: "forgotten" })},
      "2064-01-15": ${JSON.stringify({ ...good, url: "https://evil.example/events/1/" })},
      "2064-01-22": ${JSON.stringify({ ...good, post_urn: "urn:li:activity:1" })},
      "2064-02-30": ${JSON.stringify(good)}
    }}`;
    const p = await imp.planLedger(text);
    assert.deepEqual(p.rows, []);
    assert.equal(p.errors.length, 5);
    assert.match(p.errors[0], /2064-01-01: event_id must be a JSON string/);
    assert.match(p.errors[1], /2064-01-08: unknown status "forgotten"/);
    assert.match(p.errors[2], /2064-01-15: url not a LinkedIn event page/);
    assert.match(p.errors[3], /2064-01-22: post_urn not a post URN/);
    assert.match(p.errors[4], /2064-02-30: not a date/);
    await assert.rejects(imp.planLedger("not json"), /not JSON/);
    await assert.rejects(imp.planLedger(`{"weeks": {}}`), /expected \{ "events"/);
  });
});
