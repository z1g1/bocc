// The Google Form CSV import (backend/scripts/import-google-form.js, plan Phase 3):
//   1. the parser and the date fixes, as pure functions
//   2. the script end to end against the throwaway database (npm run test:db), as the
//      owner: dry run writes nothing, --apply writes once with one audit row, a second
//      --apply changes nothing, admin reports are never overwritten.
// Every CSV here is synthetic (2081 dates, made-up names); the real export holds
// personal data and never enters the repo.
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
const SCRIPT = fileURLToPath(new URL("../../backend/scripts/import-google-form.js", import.meta.url));
const imp = require(SCRIPT);

const HEADER = "Timestamp,Date of Event,How many people counted at Gives and Asks?,Did you give out the Bring a Friend Bling?," +
  "Who did you give it to? Who did they bring? ,Any notes/feedback from today?,Email Address,Did you have to cancel event?," +
  "Why did you have to cancel?,Did you post on all socials about cancellation?,Any notes?,Where were we?,Column 12";
const csv = (...rows) => [HEADER, ...rows].join("\r\n") + "\r\n";

// Rows (spreadsheet row numbers 2..): 2081-01-07 etc. are Tuesdays.
const GOOD = csv(
  `1/7/2081 15:53:09,1/7/2081,40,No,,,host@example.com,,,,,Lobby (normal),`,
  `1/15/2081 12:24:39,1/14/0081,31,Yes,"Cecelia, Muhammed","Busy, ""great"" day\nSecond line",host@example.com,No,,,Coffee ran out,Food Hall,`,
  `1/22/2081 8:00:00,1/21/2081,,,,,host@example.com,Yes,Snow storm,Yes,,Lobby (normal),`,
  `1/29/2081 11:00:00,1/28/2081,12,No,,,host@example.com,No,,,,Rooftop patio,`,
  `,2/4/81,0,No,Someone,,,,,,,,`,
  `,2/11/81,25,,Pat brought Sam,,,,,,,,`,
  `,2/18/2081,33,,,,,,,,,,`,
  ``,
);

describe("CSV parser and date rules", () => {
  test("quoted fields with commas, doubled quotes and line breaks; CRLF; BOM; trailing-space header", () => {
    const rows = imp.parseCsv(`﻿a,b ,c\r\n"x, y","say ""hi""","two\r\nlines"\r\n,,\n1,2,3`);
    assert.deepEqual(rows, [["a", "b ", "c"], ["x, y", 'say "hi"', "two\r\nlines"], ["", "", ""], ["1", "2", "3"]]);
    assert.throws(() => imp.parseCsv('a,"open\n'), /unterminated/);
    assert.deepEqual(imp.parseCsv('a,b"c\n'), [["a", 'b"c']], "a quote inside an unquoted field is literal");
    const { idx } = imp.headerIndex(imp.parseCsv(HEADER)[0]);
    assert.equal(idx.blingDetails, 4, "matched after trimming");
    assert.throws(() => imp.headerIndex(["Timestamp"]), /missing column/);
    assert.throws(() => imp.headerIndex([...imp.parseCsv(HEADER)[0], "Surprise"]), /unknown column/);
  });

  test("dates: M/D/YYYY, M/D/YY as 20YY, and years below 2000 fixed from the Timestamp", () => {
    assert.deepEqual(imp.parseFormDate("6/23/2026", null), { date: "2026-06-23", fix: null });
    assert.deepEqual(imp.parseFormDate("1/13/26", null), { date: "2026-01-13", fix: null });
    assert.deepEqual(imp.parseFormDate("7/14/0026", "2026-07-14"),
      { date: "2026-07-14", fix: "7/14/0026 → 2026-07-14 (year from the Timestamp)" });
    assert.deepEqual(imp.parseFormDate("8/18/0016", "2026-08-21"),
      { date: "2026-08-18", fix: "8/18/0016 → 2026-08-18 (year from the Timestamp)" });
    assert.throws(() => imp.parseFormDate("7/14/0026", null), /no Timestamp/);
    assert.throws(() => imp.parseFormDate("8/25/2026", "2026-08-24"), /after the Timestamp/);
    assert.throws(() => imp.parseFormDate("2/30/2026", null), /not a calendar date/);
    assert.throws(() => imp.parseFormDate("2026-02-03", null), /unreadable/);
    assert.equal(imp.parseTimestamp("8/26/2026 20:49:16"), "2026-08-26");
    assert.equal(imp.parseTimestamp(" "), null);
    assert.throws(() => imp.parseTimestamp("yesterday"), /unreadable Timestamp/);
  });

  test("the plan: sources, fixes, cancel, location, notes, Bling details, zero counts", () => {
    const { items, errors, warnings, fixes } = imp.planImport(imp.parseCsv(GOOD));
    assert.deepEqual(errors, []);
    assert.deepEqual(fixes, [
      "row 3: 1/14/0081 → 2081-01-14 (year from the Timestamp)",
      "row 6 (2081-02-04): Bling inferred from details (answer was No)",
      "row 7 (2081-02-11): Bling inferred from details (answer was blank)",
    ]);
    const by = Object.fromEntries(items.map((i) => [i.date, i]));
    assert.deepEqual(Object.keys(by), ["2081-01-07", "2081-01-14", "2081-01-21", "2081-01-28", "2081-02-04", "2081-02-11", "2081-02-18"]);
    assert.deepEqual(items.map((i) => i.source), ["google_form", "google_form", "google_form", "google_form", "pre_form", "pre_form", "pre_form"]);
    assert.deepEqual(by["2081-01-14"].report, {
      givesAsksCount: 31, blingGiven: true, blingDetails: "Cecelia, Muhammed",
      notes: 'Busy, "great" day\nSecond line\n\nCoffee ran out',
    });
    assert.equal(by["2081-01-14"].location, "food_hall");
    assert.deepEqual([by["2081-01-21"].status, by["2081-01-21"].cancel, by["2081-01-21"].report],
      ["cancelled", { reason: "weather", reasonOther: null, announced: true }, undefined]);
    assert.deepEqual([by["2081-01-28"].location, by["2081-01-28"].locationOther], ["other", "Rooftop patio"]);
    // Names in the "who" column mean Bling was given, whatever the Yes/No answer says.
    assert.deepEqual(by["2081-02-04"].report, { givesAsksCount: 0, blingGiven: true, blingDetails: "Someone", notes: null });
    assert.equal(by["2081-02-04"].fix, "Bling inferred from details (answer was No)");
    assert.deepEqual([by["2081-02-11"].report.blingGiven, by["2081-02-11"].report.blingDetails], [true, "Pat brought Sam"]);
    assert.deepEqual([by["2081-02-18"].report.blingGiven, by["2081-02-18"].location], [null, null]);
    assert.deepEqual(warnings, []);
    // The email column is never carried into the plan.
    assert.ok(!JSON.stringify(items).includes("host@example.com"));
  });

  test("a date that isn't a Tuesday is imported as is and listed for information only", () => {
    const { items, errors, warnings, info } = imp.planImport(imp.parseCsv(csv(`,4/21/2024,53,,,,,,,,,,`)));
    assert.deepEqual([errors, warnings, items.map((i) => i.date)], [[], [], ["2024-04-21"]]);
    assert.deepEqual(info, ["row 2 (2024-04-21): not a Tuesday (Sun); imported as is"]);
  });

  test("errors: duplicates after fixing, unfixable years, bad numbers", () => {
    const { items, errors } = imp.planImport(imp.parseCsv(csv(
      `7/14/2026 11:14:07,7/14/0026,31,No,,,,,,,,,`,
      `7/15/2026 9:00:00,7/14/2026,30,No,,,,,,,,,`,
      `,7/21/0026,10,No,,,,,,,,,`,
      `,7/28/26,many,No,,,,,,,,,`,
      `,8/4/26,5,Maybe,,,,,,,,,`,
    )));
    assert.deepEqual(items.map((i) => i.date), ["2026-07-14"]);
    assert.equal(errors.length, 4);
    assert.match(errors[0], /row 3: duplicate date 2026-07-14 \(also row 2\)/);
    assert.match(errors[1], /row 4: .*no Timestamp/);
    assert.match(errors[2], /row 5: .*not a whole number/);
    assert.match(errors[3], /row 6: .*not Yes\/No/);
  });

  test("cancel reasons map to the CHECK's values, else other with the text", () => {
    assert.deepEqual(imp.mapCancelReason("Ice on the roads"), { reason: "weather", reasonOther: null });
    assert.deepEqual(imp.mapCancelReason("Building closed"), { reason: "facility", reasonOther: null });
    assert.deepEqual(imp.mapCancelReason("Another event in the lobby"), { reason: "other_event", reasonOther: null });
    assert.deepEqual(imp.mapCancelReason("Host sick"), { reason: "other", reasonOther: "Host sick" });
    // Whole words only: no weather hiding inside other words.
    for (const t of ["Office move", "Short notice", "Police activity", "Staff training"]) {
      assert.deepEqual(imp.mapCancelReason(t), { reason: "other", reasonOther: t }, t);
    }
    assert.deepEqual(imp.mapCancelReason("Heavy rain"), { reason: "weather", reasonOther: null });
    assert.deepEqual(imp.mapCancelReason("Snowstorm"), { reason: "weather", reasonOther: null });
    // Facility and holiday wording wins over weather words.
    assert.deepEqual(imp.mapCancelReason("Building closed for the snow"), { reason: "facility", reasonOther: null });
    assert.deepEqual(imp.mapCancelReason("Holiday week, cold too"), { reason: "other_event", reasonOther: null });
    assert.deepEqual(imp.mapCancelReason(""), { reason: "other", reasonOther: "No reason given in the Google Form" });
  });
});

describe("import script against the database", () => {
  let owner, dir;
  const env = () => ({
    PATH: process.env.PATH,
    DATABASE_URL: OWNER_URL,
    DB_CA_CERT: readFileSync(process.env.DB_CA_CERT_FILE, "utf8"),
  });
  const run = (file, ...flags) => {
    const r = spawnSync(process.execPath, [SCRIPT, file, ...flags], { env: env(), encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const write = (name, text) => { const p = join(dir, name); writeFileSync(p, text); return p; };
  const DATES = ["2081-01-07", "2081-01-14", "2081-01-21", "2081-01-28", "2081-02-04", "2081-02-11", "2081-02-18"];
  const snapshot = async () => {
    const e = await owner.query(`select event_date::text, status, location, location_other, cancel_reason, cancel_announced, updated_at
                                   from events where event_date = any($1::date[]) order by 1`, [DATES]);
    const r = await owner.query(`select event_date::text, gives_asks_count, notes, bling_given, bling_details, source, submitted_by, updated_at
                                   from event_reports where event_date = any($1::date[]) order by 1`, [DATES]);
    return { events: e.rows, reports: r.rows };
  };
  const importAudits = () => owner.query(
    `select actor_user_id, details from audit_log where action = 'event_report.import' order by id`).then((r) => r.rows);

  before(async () => {
    owner = await connect(OWNER_URL);
    dir = mkdtempSync(join(tmpdir(), "bocc-import-test-"));
    // An admin already filed 2081-02-18 by hand: the import must leave it alone.
    await owner.query(`insert into events (event_date, status, location) values ('2081-02-18', 'reported', 'lobby')`);
    await owner.query(`insert into event_reports (event_date, gives_asks_count, bling_given, source) values ('2081-02-18', 99, false, 'admin')`);
  });
  after(async () => {
    rmSync(dir, { recursive: true, force: true });
    await owner?.end();
  });

  test("usage and refusals", () => {
    assert.equal(run("").code, 2);
    const bad = write("bad.csv", csv(`,7/21/0026,10,No,,,,,,,,,`));
    const r = run(bad, "--apply");
    assert.equal(r.code, 1);
    assert.match(r.err, /no Timestamp/);
    assert.match(r.err, /nothing written/);
  });

  test("dry run: a summary table and counts, no writes, no email in the output", async () => {
    const before = await snapshot();
    const r = run(write("form.csv", GOOD));
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^row\s+date\s+source\s+count\s+bling\s+location\s+cancel reason\s+action\s+fix/m);
    assert.match(r.out, /\[dry-run\] would create 6, would update 0, unchanged 0, skipped 1/);
    assert.match(r.out, /2081-02-18\s+pre_form\s+33\s+skip \(admin report\)/);
    assert.match(r.out, /zero at Gives and Asks \(imported as is\): 2081-02-04 \(row 6\)/);
    assert.match(r.out, /FIX\s+row 3: 1\/14\/0081 → 2081-01-14/);
    assert.match(r.out, /2081-01-21\s+google_form\s+CANCELLED\s+lobby\s+weather ← "Snow storm"\s+create/);
    assert.match(r.out, /FIX\s+row 6 \(2081-02-04\): Bling inferred from details/);
    assert.ok(!r.out.includes("host@example.com") && !r.out.includes("Cecelia") && !r.out.includes("Someone"),
      "no emails or names printed");
    assert.deepEqual(await snapshot(), before);
  });

  test("--apply writes once with one audit row; a second --apply changes nothing", async () => {
    const auditsBefore = (await importAudits()).length;
    const first = run(write("form.csv", GOOD), "--apply");
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, /\[apply\] create 6, update 0, unchanged 0, skipped 1/);

    const { events, reports } = await snapshot();
    const ev = Object.fromEntries(events.map((e) => [e.event_date, e]));
    const rep = Object.fromEntries(reports.map((r) => [r.event_date, r]));
    assert.deepEqual([ev["2081-01-14"].status, ev["2081-01-14"].location], ["reported", "food_hall"]);
    assert.deepEqual([ev["2081-01-21"].status, ev["2081-01-21"].cancel_reason, ev["2081-01-21"].cancel_announced], ["cancelled", "weather", true]);
    assert.equal(rep["2081-01-21"], undefined, "no report for a cancelled event");
    assert.deepEqual([ev["2081-01-28"].location, ev["2081-01-28"].location_other], ["other", "Rooftop patio"]);
    assert.deepEqual([rep["2081-01-14"].source, rep["2081-01-14"].submitted_by, rep["2081-01-14"].bling_details],
      ["google_form", null, "Cecelia, Muhammed"]);
    assert.deepEqual([rep["2081-02-04"].source, rep["2081-02-04"].gives_asks_count, rep["2081-02-04"].bling_given, rep["2081-02-04"].bling_details],
      ["pre_form", 0, true, "Someone"]);
    assert.deepEqual([rep["2081-02-18"].source, rep["2081-02-18"].gives_asks_count], ["admin", 99], "admin report untouched");
    const audits = await importAudits();
    assert.equal(audits.length, auditsBefore + 1);
    assert.equal(audits.at(-1).actor_user_id, null);
    assert.deepEqual([audits.at(-1).details.created, audits.at(-1).details.updated, audits.at(-1).details.skipped], [6, 0, 1]);
    assert.ok(!JSON.stringify(audits.at(-1)).includes("@"), "no email in the audit row");

    const snap = await snapshot();
    const second = run(write("form.csv", GOOD), "--apply");
    assert.equal(second.code, 0, second.err);
    assert.match(second.out, /\[apply\] create 0, update 0, unchanged 6, skipped 1/);
    assert.deepEqual(await snapshot(), snap, "nothing changed, not even updated_at");
    assert.equal((await importAudits()).length, auditsBefore + 1, "no audit row for a run that changed nothing");
  });

  test("a changed CSV updates imported reports but never an admin's edit or un-cancel", async () => {
    // An admin edits one imported report: it becomes source admin.
    await owner.query(`update event_reports set gives_asks_count = 41, source = 'admin' where event_date = '2081-01-07'`);
    // An admin un-cancels the imported cancellation: a re-run must not cancel it again.
    await owner.query(`update events set status = 'scheduled', cancel_reason = null, cancel_reason_other = null,
                         cancel_announced = false where event_date = '2081-01-21'`);
    const changed = GOOD.replace("1/29/2081 11:00:00,1/28/2081,12,", "1/29/2081 11:00:00,1/28/2081,13,")
      .replace("1/7/2081 15:53:09,1/7/2081,40,", "1/7/2081 15:53:09,1/7/2081,45,");
    const r = run(write("form2.csv", changed), "--apply");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /\[apply\] create 0, update 1, unchanged 3, skipped 3/);
    assert.match(r.out, /2081-01-21 .*skip \(status changed in the database\)/);
    const { rows: [unc] } = await owner.query(`select status, cancel_reason from events where event_date = '2081-01-21'`);
    assert.deepEqual(unc, { status: "scheduled", cancel_reason: null });
    const { rows } = await owner.query(
      `select event_date::text as d, gives_asks_count as n, source from event_reports where event_date in ('2081-01-07', '2081-01-28') order by 1`);
    assert.deepEqual(rows, [{ d: "2081-01-07", n: 41, source: "admin" }, { d: "2081-01-28", n: 13, source: "google_form" }]);
  });
});
