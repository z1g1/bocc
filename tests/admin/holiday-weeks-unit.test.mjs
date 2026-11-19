// The fixed holiday break (src/lib/holiday-weeks.mjs): no meeting on a Tuesday from
// December 22 through January 4. Pure, no database. events.mjs nextTuesday (which
// skips it) is tested in events-admin.test.mjs, since events.mjs needs the admin env.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { HOLIDAY_BREAK, HOLIDAY_BREAK_LABEL, isHolidayWeek } from "../../src/lib/holiday-weeks.mjs";

describe("isHolidayWeek", () => {
  test("the boundaries: 12/21 no, 12/22 yes, 1/4 yes, 1/5 no", () => {
    assert.equal(isHolidayWeek("2026-12-21"), false);
    assert.equal(isHolidayWeek("2026-12-22"), true);
    assert.equal(isHolidayWeek("2027-01-04"), true);
    assert.equal(isHolidayWeek("2027-01-05"), false);
  });

  test("every year, across the new year", () => {
    for (const y of [2025, 2026, 2027, 2028, 2031, 2099]) {
      assert.equal(isHolidayWeek(`${y}-12-21`), false, `${y}-12-21`);
      assert.equal(isHolidayWeek(`${y}-12-22`), true, `${y}-12-22`);
      assert.equal(isHolidayWeek(`${y}-12-25`), true, `${y}-12-25`);
      assert.equal(isHolidayWeek(`${y}-12-31`), true, `${y}-12-31`);
      assert.equal(isHolidayWeek(`${y}-01-01`), true, `${y}-01-01`);
      assert.equal(isHolidayWeek(`${y}-01-04`), true, `${y}-01-04`);
      assert.equal(isHolidayWeek(`${y}-01-05`), false, `${y}-01-05`);
    }
  });

  test("normal weeks are not holidays", () => {
    for (const d of ["2026-11-24", "2026-12-15", "2027-01-12", "2027-06-01", "2027-02-04", "2027-11-22"]) {
      assert.equal(isHolidayWeek(d), false, d);
    }
  });

  test("one constant, and a label from it", () => {
    assert.deepEqual(HOLIDAY_BREAK, { from: { month: 12, day: 22 }, to: { month: 1, day: 4 } });
    assert.ok(Object.isFrozen(HOLIDAY_BREAK));
    assert.equal(HOLIDAY_BREAK_LABEL, "December 22 to January 4");
  });

  test("rejects anything that isn't YYYY-MM-DD", () => {
    for (const bad of ["2026-12-2", "12/22/2026", "", null, undefined, 20261222]) {
      assert.throws(() => isHolidayWeek(bad), /YYYY-MM-DD/);
    }
  });
});
