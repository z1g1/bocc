// Held (GLOSSARY.md; ticket #52, parent #49), against the throwaway database (npm run test:db):
// a week is Held for the BOCC series when it has a real (non-debug) Check-in or its Event
// is Reported, and never when its Event is Cancelled. Streaks count Held Events, so they
// follow, read as checkin_writer with only its own grants.
//
// The Reported join is for the series' check-in event id 'bocc' only, so these fixtures
// use 'bocc' and Tuesdays in 1998, which no other test file uses. They're committed (the
// streaks are read from a second connection) and removed before and after the file.
// Other files' 'bocc' weeks are all later, so the assertions avoid current_streak.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { CHECKIN_URL, OWNER_URL, connect, unique } from "./helpers.mjs";

const SERIES = "bocc";
// Tuesdays. Mondays (the ISO week the views key on) are one day earlier.
const W = {
  checkins1: "1998-03-03",    // real check-ins, no Event row          -> Held
  cancelled: "1998-03-10",    // Cancelled Event, real check-ins       -> not Held
  debugOnly: "1998-03-17",    // debug check-ins only, no Event row    -> not Held
  empty: "1998-03-24",        // nothing at all                        -> not Held, bridged
  checkins2: "1998-03-31",    // real check-ins, Scheduled Event       -> Held
  reported: "1998-04-07",     // Reported Event, no check-ins          -> Held
  checkins3: "1998-04-14",    // real check-ins, Reported Event        -> Held
};
const monday = (tuesday) => {
  const d = new Date(`${tuesday}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

let owner, writer;
const fx = {};

async function attendee(name) {
  const { rows: [a] } = await owner.query(
    `insert into attendees (email, name, ok_to_email) values ($1, $2, false) returning id`,
    [`${unique("held")}@example.com`, name]);
  return a.id;
}
async function checkin(attendeeId, day, { debug = false } = {}) {
  await owner.query(
    `insert into checkins (attendee_id, event_id, token, checkin_at, checkin_date, debug)
     values ($1, $2, 'tok', ($3::date + time '12:42') at time zone 'UTC', $3::date, $4)`,
    [attendeeId, SERIES, day, debug]);
}

async function clear() {
  await owner.query(`delete from checkins where event_id = $1 and checkin_date between '1998-01-01' and '1998-12-31'`, [SERIES]);
  await owner.query(`delete from events where event_date between '1998-01-01' and '1998-12-31'`);
}

before(async () => {
  owner = await connect(OWNER_URL);
  writer = await connect(CHECKIN_URL);
  await clear();
  await owner.query(`insert into events (event_date, status, cancel_reason) values ($1, 'cancelled', 'weather')`, [W.cancelled]);
  await owner.query(`insert into events (event_date) values ($1)`, [W.checkins2]);
  await owner.query(`insert into events (event_date, status) values ($1, 'reported'), ($2, 'reported')`, [W.reported, W.checkins3]);

  // Pat: came to the first two Held weeks, across a Cancelled, a debug-only and an empty week.
  fx.pat = await attendee("Pat Regular");
  for (const d of [W.checkins1, W.cancelled, W.checkins2]) await checkin(fx.pat, d);
  await checkin(fx.pat, W.debugOnly, { debug: true });
  // Quinn: missed the Reported week that had no check-ins.
  fx.quinn = await attendee("Quinn Returner");
  for (const d of [W.checkins2, W.checkins3]) await checkin(fx.quinn, d);
  // Casey: only came on the Cancelled day. Dana: only ever checked in as debug.
  fx.casey = await attendee("Casey Cancelled");
  await checkin(fx.casey, W.cancelled);
  fx.dana = await attendee("Dana Debug");
  await checkin(fx.dana, W.debugOnly, { debug: true });
});
after(async () => {
  if (owner) await clear();
  await Promise.all([owner?.end(), writer?.end()]);
});

const heldWeeks = async (db) => (await db.query(
  `select occurrence_week::text as w from held_occurrences
    where event_id = $1 and occurrence_week between '1998-01-01' and '1998-12-31' order by 1`, [SERIES]))
  .rows.map((r) => r.w);
const streakOf = async (db, attendeeId) => (await db.query(
  `select longest_streak::int as longest_streak, weeks_attended::int as weeks_attended, last_occurrence_week::text as last_week
     from streaks where attendee_id = $1 and event_id = $2`, [attendeeId, SERIES])).rows[0];

describe("Held weeks for the BOCC series", () => {
  test("a Reported Event with no Check-ins is Held", async () => {
    assert.ok((await heldWeeks(owner)).includes(monday(W.reported)));
  });

  test("a Cancelled Event is not Held, even with Check-ins", async () => {
    assert.ok(!(await heldWeeks(owner)).includes(monday(W.cancelled)));
  });

  test("debug check-ins alone don't make a week Held", async () => {
    assert.ok(!(await heldWeeks(owner)).includes(monday(W.debugOnly)));
  });

  test("exactly the weeks with a real Check-in or a Reported Event, none Cancelled", async () => {
    assert.deepEqual(await heldWeeks(owner),
      [W.checkins1, W.checkins2, W.reported, W.checkins3].map(monday));
  });
});

describe("Streaks count Held Events (read as checkin_writer)", () => {
  test("a Cancelled, a debug-only and an empty week don't break a Streak, and a Cancelled check-in isn't counted", async () => {
    assert.deepEqual(await streakOf(writer, fx.pat),
      { longest_streak: 2, weeks_attended: 2, last_week: monday(W.checkins2) });
  });

  test("a missed Reported Event with no Check-ins breaks the Streak", async () => {
    assert.deepEqual(await streakOf(writer, fx.quinn),
      { longest_streak: 1, weeks_attended: 2, last_week: monday(W.checkins3) });
  });

  test("Check-ins only on a Cancelled Event, or only debug ones, give no Streak", async () => {
    assert.equal(await streakOf(writer, fx.casey), undefined);
    assert.equal(await streakOf(writer, fx.dana), undefined);
  });

  test("checkin_writer reads Held weeks the same as the owner", async () => {
    assert.deepEqual(await heldWeeks(writer), await heldWeeks(owner));
  });
});
