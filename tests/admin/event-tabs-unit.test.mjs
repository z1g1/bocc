// The event page's tabs (src/lib/admin/event-tabs.mjs, ADR 0012 decision 1): which tab a
// request opens. Pure, no database. The HTTP side (rendering, redirects back to the tab,
// role fences) is in events-admin.test.mjs.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { TABS, pickTab } from "../../src/lib/admin/event-tabs.mjs";

describe("pickTab", () => {
  const noon = new Date("2026-11-24T17:00:00Z"); // Tuesday 2026-11-24, noon Eastern

  test("the three tabs, in page order, with their labels", () => {
    assert.deepEqual(Object.entries(TABS), [["info", "Event Info"], ["social", "Social plan"], ["post", "Post Event"]]);
  });

  test("an explicit, known tab wins whatever the date", () => {
    for (const date of ["2026-11-17", "2026-11-24", "2026-12-01"]) {
      for (const tab of ["info", "social", "post"]) assert.equal(pickTab(tab, date, noon), tab, `${tab} on ${date}`);
    }
  });

  test("no tab: a future date opens Event Info; today or a past date opens Post Event", () => {
    assert.equal(pickTab(null, "2026-12-01", noon), "info");
    assert.equal(pickTab(null, "2026-11-25", noon), "info");
    assert.equal(pickTab(null, "2026-11-24", noon), "post", "today");
    assert.equal(pickTab(null, "2026-11-17", noon), "post");
    assert.equal(pickTab("", "2026-12-01", noon), "info");
  });

  test("an unknown tab falls back to the date default", () => {
    for (const bad of ["INFO", "photos", "constructor", "__proto__", "toString", " info"]) {
      assert.equal(pickTab(bad, "2026-12-01", noon), "info", bad);
      assert.equal(pickTab(bad, "2026-11-17", noon), "post", bad);
    }
  });

  test("today is the Eastern day, not the UTC one", () => {
    // 2026-11-25 03:30 UTC is still Tuesday 2026-11-24, 10:30 PM EST.
    const lateTuesday = new Date("2026-11-25T03:30:00Z");
    assert.equal(pickTab(null, "2026-11-24", lateTuesday), "post", "the event day itself");
    assert.equal(pickTab(null, "2026-11-25", lateTuesday), "info", "tomorrow in Eastern time, though today in UTC");
    // 2026-11-24 04:30 UTC is Monday 2026-11-23, 11:30 PM EST: the event is tomorrow.
    assert.equal(pickTab(null, "2026-11-24", new Date("2026-11-24T04:30:00Z")), "info");
    assert.equal(pickTab(null, "2026-11-24", new Date("2026-11-24T05:00:00Z")), "post", "midnight EST");
    // In summer the boundary is 04:00 UTC (EDT).
    assert.equal(pickTab(null, "2026-07-14", new Date("2026-07-14T03:59:00Z")), "info");
    assert.equal(pickTab(null, "2026-07-14", new Date("2026-07-14T04:00:00Z")), "post");
  });

  test("now defaults to the current time", () => {
    assert.equal(pickTab(null, "2999-01-01"), "info");
    assert.equal(pickTab(null, "2001-01-02"), "post");
  });
});
