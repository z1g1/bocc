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

describe("import script against the database", () => {
  let owner, dir;
  const DATES = ["2064-01-01", "2064-01-08", "2064-01-15", "2064-01-22"];
  const env = (withDb = true) => ({
    PATH: process.env.PATH,
    HOME: "/nonexistent",
    ...(withDb ? { DATABASE_URL: OWNER_URL, DB_CA_CERT: readFileSync(process.env.DB_CA_CERT_FILE, "utf8") } : {}),
  });
  const write = (name, text) => { const p = join(dir, name); writeFileSync(p, text); return p; };
  const run = (flags = [], { withDb = true, ledger = FIXTURE, extraEnv = {} } = {}) => {
    const args = ledger ? ["--ledger", ledger, ...flags] : flags;
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...env(withDb), ...extraEnv }, encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const snapshot = async () => {
    const e = await owner.query(`select event_date::text, status, location from events where event_date = any($1::date[]) order by 1`, [DATES]);
    const l = await owner.query(
      `select event_date::text, status, name, commentary, location, image_source, image_ref, linkedin_event_id, event_url,
              post_urn, post_url, created_by, attempted_at, event_created_at, posted_at, updated_at
         from linkedin_events where event_date = any($1::date[]) order by 1, created_at`, [DATES]);
    const k = await owner.query(`select event_date::text, url from event_links
                                  where platform = 'linkedin_event' and event_date = any($1::date[]) order by 1`, [DATES]);
    return { events: e.rows, ledger: l.rows, listings: k.rows };
  };
  const importAudits = () => owner.query(
    `select actor_user_id, target_table, details from audit_log where action = 'linkedin_event.import' order by id`).then((r) => r.rows);

  before(async () => {
    owner = await connect(OWNER_URL);
    dir = mkdtempSync(join(tmpdir(), "bocc-ledger-import-"));
    // A rerun on a kept database starts clean (only this file uses 2064).
    for (const t of ["linkedin_events", "event_links", "events"]) {
      await owner.query(`delete from ${t} where event_date between '2064-01-01' and '2064-12-31'`);
    }
    // 2064-01-08 already exists (food hall, held) and has its LinkedIn listing from the README import.
    await owner.query(`insert into events (event_date, status, location) values ('2064-01-08', 'held', 'food_hall')`);
    await owner.query(`insert into event_links (event_date, platform, url) values ('2064-01-08', 'linkedin_event', 'https://www.linkedin.com/events/7249812613549670408/')`);
  });
  after(async () => {
    rmSync(dir, { recursive: true, force: true });
    await owner?.end();
  });

  test("usage and refusals", () => {
    assert.equal(run(["--force"]).code, 2);
    assert.equal(run(["--ledger"], { ledger: null }).code, 2);
    const noDb = run(["--apply"], { withDb: false });
    assert.equal(noDb.code, 1);
    assert.match(noDb.err, /Missing DATABASE_URL/);
    const missing = run([], { ledger: join(dir, "nope.json") });
    assert.equal(missing.code, 1);
    assert.match(missing.err, /nope\.json/);
    const bad = run(["--apply"], { ledger: write("bad.json", `{"events": {"2064-01-01": {"status": "posted", "name": "x", "event_id": 1}}}`) });
    assert.equal(bad.code, 1);
    assert.match(bad.err, /event_id must be a JSON string/);
    assert.match(bad.err, /nothing written/);
  });

  test("the default path is the CLI's: $LINKEDIN_LEDGER_FILE, then $XDG_STATE_HOME/bocc-linkedin/ledger.json", () => {
    const viaEnv = run([], { ledger: null, withDb: false, extraEnv: { LINKEDIN_LEDGER_FILE: FIXTURE } });
    assert.equal(viaEnv.code, 0, viaEnv.err);
    assert.ok(viaEnv.out.includes(`ledger: ${FIXTURE}`));
    const viaXdg = run([], { ledger: null, withDb: false, extraEnv: { XDG_STATE_HOME: dir } });
    assert.equal(viaXdg.code, 1);
    assert.ok(viaXdg.err.includes(join(dir, "bocc-linkedin", "ledger.json")));
  });

  test("without a database: the plan only, pending skipped and reported", () => {
    const r = run([], { withDb: false });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /\[dry-run\] entries: 4 \(posted 2, created 1, pending 1\)/);
    assert.match(r.out, /SKIPPED 2064-01-22 pending/);
    assert.match(r.out, /not compared with the database/);
  });

  test("dry run: compares with the database and writes nothing", async () => {
    const before = await snapshot();
    const r = run();
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^date\s+cli\s+event\s+ledger\s+listing/m);
    assert.match(r.out, /2064-01-01\s+posted\s+new\s+add\s+add/);
    assert.match(r.out, /2064-01-08\s+posted\s+exists\s+add\s+same/);
    assert.match(r.out, /2064-01-15\s+created\s+new\s+add\s*$/m);
    assert.match(r.out, /events: would create 2, existing 1/);
    assert.match(r.out, /ledger: would add 3, would mark posted 0, unchanged 0, conflicts 0/);
    assert.match(r.out, /listings: would add 1/);
    assert.deepEqual(await snapshot(), before);
  });

  test("--apply imports once with one audit row; a second --apply changes nothing", async () => {
    const auditsBefore = (await importAudits()).length;
    const first = run(["--apply"]);
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, /\[apply\] events: create 2, existing 1/);
    assert.match(first.out, /\[apply\] ledger: add 3, mark posted 0, unchanged 0, conflicts 0/);
    assert.match(first.out, /SKIPPED 2064-01-22 pending/);
    const snap = await snapshot();
    assert.deepEqual(snap.events, [
      { event_date: "2064-01-01", status: "scheduled", location: null },
      { event_date: "2064-01-08", status: "held", location: "food_hall" },
      { event_date: "2064-01-15", status: "scheduled", location: null },
    ]);
    const [a, b, c] = snap.ledger;
    assert.equal(snap.ledger.length, 3, "the pending entry isn't imported");
    assert.deepEqual(
      [a.status, a.name, a.commentary, a.location, a.image_source, a.image_ref, a.linkedin_event_id, a.event_url, a.post_urn, a.post_url, a.created_by],
      ["posted", "Buffalo Open Coffee Club for 1/1", LOBBY, "lobby", null, null, "7249812613549670401",
        "https://www.linkedin.com/events/buffaloopencoffeeclubfor1-17249812613549670401/",
        "urn:li:ugcPost:7511865991627468801", "https://www.linkedin.com/feed/update/urn:li:ugcPost:7511865991627468801/", null]);
    assert.deepEqual([a.attempted_at, a.event_created_at, a.posted_at].map((d) => d.toISOString()),
      ["2063-12-27T15:58:12.104Z", "2063-12-27T15:58:14.551Z", "2063-12-27T15:58:15.900Z"]);
    assert.deepEqual([b.status, b.location, b.post_urn], ["posted", "food_hall", "urn:li:share:7511865991627468808"]);
    assert.deepEqual([c.status, c.linkedin_event_id, c.post_urn, c.posted_at], ["created", "7249812613549670415", null, null]);
    assert.deepEqual(snap.listings, [
      { event_date: "2064-01-01", url: "https://www.linkedin.com/events/buffaloopencoffeeclubfor1-17249812613549670401/" },
      { event_date: "2064-01-08", url: "https://www.linkedin.com/events/7249812613549670408/" },
    ]);
    const audits = await importAudits();
    assert.equal(audits.length, auditsBefore + 1);
    const audit = audits.at(-1);
    assert.deepEqual([audit.actor_user_id, audit.target_table], [null, "linkedin_events"]);
    assert.deepEqual(
      [audit.details.ledger, audit.details.eventsCreated, audit.details.rowsAdded, audit.details.listingsAdded, audit.details.skipped, audit.details.changedDates],
      ["linkedin-ledger.json", 2, 3, 1, ["2064-01-22"], ["2064-01-01", "2064-01-08", "2064-01-15"]]);

    const second = run(["--apply"]);
    assert.equal(second.code, 0, second.err);
    assert.match(second.out, /ledger: add 0, mark posted 0, unchanged 3, conflicts 0/);
    assert.match(second.out, /listings: add 0/);
    assert.deepEqual(await snapshot(), snap);
    assert.equal((await importAudits()).length, auditsBefore + 1, "no audit row for a run that changed nothing");
  });

  test("a stored row: created + CLI posted marks it posted; pending or another id is a conflict, kept with --prefer-db", async () => {
    // 2064-02-05: stored created (same id) → mark posted. 2064-02-12: stored pending → conflict.
    // 2064-02-19: stored posted with another event id → conflict. 2064-02-26: new.
    const entry = (n, status = "posted") => ({
      status, name: `Buffalo Open Coffee Club for 2/${n}`, attempted_at: "2064-01-30T16:00:00+00:00",
      created_at: "2064-01-30T16:00:01+00:00", event_id: `72498126135496${String(n).padStart(5, "0")}`,
      url: `https://www.linkedin.com/events/72498126135496${String(n).padStart(5, "0")}/`,
      ...(status === "posted" ? { post_urn: `urn:li:ugcPost:75118659916274${String(n).padStart(5, "0")}`, posted_at: "2064-01-30T16:00:02+00:00" } : {}),
    });
    const ledgerFile = write("conflicts.json", JSON.stringify({ events: {
      "2064-02-05": entry(5), "2064-02-12": entry(12), "2064-02-19": entry(19), "2064-02-26": entry(26),
    } }, null, 2));
    for (const d of ["2064-02-05", "2064-02-12", "2064-02-19"]) await owner.query(`insert into events (event_date) values ($1)`, [d]);
    const seed = (date, status, cols) => owner.query(
      `insert into linkedin_events (event_date, status, name, commentary, linkedin_event_id, event_url, event_created_at, post_urn, post_url, posted_at)
       values ($1, $2, 'web', 'web', $3, $4, $5, $6, $7, $8)`,
      [date, status, cols.id ?? null, cols.id ? `https://www.linkedin.com/events/${cols.id}/` : null, cols.id ? new Date() : null,
        cols.post ?? null, cols.post ? `https://www.linkedin.com/feed/update/${cols.post}/` : null, cols.post ? new Date() : null]);
    await seed("2064-02-05", "created", { id: entry(5).event_id });
    await seed("2064-02-12", "pending", {});
    await seed("2064-02-19", "posted", { id: "1111111111111111111", post: "urn:li:share:1" });
    const rowsFor = () => owner.query(
      `select event_date::text, status, linkedin_event_id, post_urn, name from linkedin_events
        where event_date between '2064-02-01' and '2064-02-28' order by 1`).then((r) => r.rows);
    const before = await rowsFor();

    const dry = run([], { ledger: ledgerFile });
    assert.equal(dry.code, 0, dry.err);
    assert.match(dry.out, /2064-02-05\s+posted\s+exists\s+mark posted\s+add/);
    assert.match(dry.out, /CONFLICT 2064-02-12: stored pending event \(none\), CLI posted event 7249812613549600012/);
    assert.match(dry.out, /CONFLICT 2064-02-19: stored posted event 1111111111111111111 post urn:li:share:1, CLI posted event 7249812613549600019/);
    const refused = run(["--apply"], { ledger: ledgerFile });
    assert.equal(refused.code, 1);
    assert.match(refused.err, /2 conflict\(s\): nothing written/);
    assert.deepEqual(await rowsFor(), before);

    const kept = run(["--apply", "--prefer-db"], { ledger: ledgerFile });
    assert.equal(kept.code, 0, kept.err);
    assert.match(kept.out, /ledger: add 1, mark posted 1, unchanged 0, conflicts 2 \(kept as stored: --prefer-db\)/);
    assert.deepEqual((await rowsFor()).map((r) => [r.event_date, r.status, r.linkedin_event_id, r.post_urn, r.name]), [
      ["2064-02-05", "posted", "7249812613549600005", "urn:li:ugcPost:7511865991627400005", "web"],
      ["2064-02-12", "pending", null, null, "web"],
      ["2064-02-19", "posted", "1111111111111111111", "urn:li:share:1", "web"],
      ["2064-02-26", "posted", "7249812613549600026", "urn:li:ugcPost:7511865991627400026", "Buffalo Open Coffee Club for 2/26"],
    ]);
    assert.equal((await importAudits()).at(-1).details.conflictsKept, 2);
    const again = run(["--apply", "--prefer-db"], { ledger: ledgerFile });
    assert.match(again.out, /ledger: add 0, mark posted 0, unchanged 2, conflicts 2/);
  });
});
