// The event-links import (backend/scripts/import-event-links.js, plan Phase 4):
//   1. the README table and YAML parsers and the merge, as functions
//   2. the script end to end against the throwaway database (npm run test:db), as the
//      owner: dry run writes nothing, --apply writes once with one audit row and never
//      touches an existing event's status, a second --apply changes nothing, conflicts
//      refuse --apply unless --prefer-db.
// Every file here is synthetic (2083 dates).
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
const SCRIPT = fileURLToPath(new URL("../../backend/scripts/import-event-links.js", import.meta.url));
const imp = require(SCRIPT);

// 2083-01-05, -12, -19 and -26 are Tuesdays.
const YAML = `# comment
"2083-01-05": { url: "https://luma.com/aaa", id: evt-AAA111 }
"2083-01-12": { url: "https://luma.com/bbb", id: evt-BBB222 }
"2083-01-19": { url: "https://lu.ma/ccc" }
`;
const README = `# Social

Some text | with a pipe.

## Event URLS
| Date | Luma URL | LinkedIn | Facebook | EventBrite |
|------|----------|----------|----------|------------|
| Tue, Jan 5, 2083 | https://luma.com/aaa | https://www.linkedin.com/events/111 | https://www.facebook.com/share/abc/ | https://www.eventbrite.com/e/111 |
| Tue, Jan 12, 2083 | https://luma.com/bbb | | | https://www.eventbrite.com/e/222 |
| Tue, Jan 19, 2083 | | | | |
| Tue, Jan 26, 2083 | https://luma.com/ddd | | | |

## Next section
`;

describe("parsers and plan", () => {
  test("README dates: weekday optional but checked", () => {
    assert.equal(imp.parseReadmeDate("Tue, Nov 10, 2026"), "2026-11-10");
    assert.equal(imp.parseReadmeDate("Dec 1, 2026"), "2026-12-01");
    assert.equal(imp.parseReadmeDate("Tuesday, February 16, 2027"), "2027-02-16");
    assert.throws(() => imp.parseReadmeDate("Wed, Nov 10, 2026"), /tue/);
    assert.throws(() => imp.parseReadmeDate("Tue, Feb 30, 2027"), /not a calendar date/);
    assert.throws(() => imp.parseReadmeDate("2026-11-10"), /unreadable/);
  });

  test("the table: columns by header, blank cells = no link, rows end at the table", () => {
    const errors = [];
    const rows = imp.parseReadme(README, errors);
    assert.deepEqual(errors, []);
    assert.deepEqual(rows.map((r) => r.date), ["2083-01-05", "2083-01-12", "2083-01-19", "2083-01-26"]);
    assert.deepEqual(rows[1].links, { luma: "https://luma.com/bbb", eventbrite: "https://www.eventbrite.com/e/222" });
    assert.deepEqual(rows[2].links, {});
    assert.throws(() => imp.parseReadme("# no table\n", []), /no table/);
  });

  test("the plan merges both files and checks them with the admin's rules", async () => {
    const p = await imp.planImport(YAML, README);
    assert.deepEqual([p.errors, p.mismatches], [[], []]);
    assert.deepEqual([...p.dates.keys()], ["2083-01-05", "2083-01-12", "2083-01-19", "2083-01-26"]);
    assert.deepEqual(p.dates.get("2083-01-05"), {
      luma: { url: "https://luma.com/aaa", externalId: "evt-AAA111" },
      linkedin_event: { url: "https://www.linkedin.com/events/111", externalId: null },
      facebook_event: { url: "https://www.facebook.com/share/abc/", externalId: null },
      eventbrite: { url: "https://www.eventbrite.com/e/111", externalId: null },
    });
    assert.deepEqual(p.dates.get("2083-01-19"), { luma: { url: "https://lu.ma/ccc", externalId: null } });
    assert.deepEqual(p.dates.get("2083-01-26"), { luma: { url: "https://luma.com/ddd", externalId: null } });
    assert.ok(p.info.some((i) => /2083-01-19: Luma has no evt- id/.test(i)));
    assert.ok(p.info.some((i) => /2083-01-19: Luma URL only in the YAML/.test(i)));
    assert.ok(p.info.some((i) => /2083-01-26: Luma URL only in the README/.test(i)));
  });

  test("mismatches and bad input are reported", async () => {
    const p = await imp.planImport(
      `"2083-01-05": { url: "https://luma.com/zzz", id: evt-AAA111 }\n"2083-01-12": { url: "https://evil.example/x", id: nope }\n"2083-13-01": { url: "https://luma.com/q" }\n`,
      README.replace("https://www.eventbrite.com/e/222", "https://www.eventbrite.com/o/org").replace("Tue, Jan 26, 2083", "Wed, Jan 26, 2083"));
    assert.deepEqual(p.mismatches, ["2083-01-05: Luma URL differs: YAML https://luma.com/zzz, README https://luma.com/aaa"]);
    assert.ok(p.errors.some((e) => /YAML 2083-01-12 id: .*evt-/.test(e)));
    assert.ok(p.errors.some((e) => /YAML 2083-01-12 Luma: That isn't a link to Luma/.test(e)));
    assert.ok(p.errors.some((e) => /YAML 2083-13-01: not a date/.test(e)));
    assert.ok(p.errors.some((e) => /README line \d+ Eventbrite: .*doesn't point at an event/.test(e)));
    assert.ok(p.errors.some((e) => /Wed, Jan 26, 2083.*tue/.test(e)));
    const dup = await imp.planImport(YAML, README.replace("Tue, Jan 12, 2083", "Tue, Jan 5, 2083"));
    assert.ok(dup.errors.some((e) => /duplicate date 2083-01-05/.test(e)));
  });

  test("decide: insert, unchanged, fill the id, conflict", () => {
    const p = { url: "https://luma.com/a", externalId: "evt-a" };
    assert.equal(imp.decide(p, undefined), "insert");
    assert.equal(imp.decide(p, { url: "https://luma.com/a", external_id: "evt-a" }), "unchanged");
    assert.equal(imp.decide(p, { url: "https://luma.com/a", external_id: null }), "fill_id");
    assert.equal(imp.decide({ ...p, externalId: null }, { url: "https://luma.com/a", external_id: "evt-a" }), "unchanged");
    assert.equal(imp.decide(p, { url: "https://luma.com/a", external_id: "evt-b" }), "conflict");
    assert.equal(imp.decide(p, { url: "https://luma.com/other", external_id: "evt-a" }), "conflict");
  });
});

describe("import script against the database", () => {
  let owner, dir;
  const DATES = ["2083-01-05", "2083-01-12", "2083-01-19", "2083-01-26"];
  const env = (withDb = true) => ({
    PATH: process.env.PATH,
    ...(withDb ? { DATABASE_URL: OWNER_URL, DB_CA_CERT: readFileSync(process.env.DB_CA_CERT_FILE, "utf8") } : {}),
  });
  const write = (name, text) => { const p = join(dir, name); writeFileSync(p, text); return p; };
  const run = (yaml, readme, flags = [], withDb = true) => {
    const r = spawnSync(process.execPath, [SCRIPT, "--yaml", yaml, "--readme", readme, ...flags], { env: env(withDb), encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const snapshot = async () => {
    const e = await owner.query(`select event_date::text, status, updated_at from events where event_date = any($1::date[]) order by 1`, [DATES]);
    const l = await owner.query(`select event_date::text, platform, url, external_id, updated_at from event_links
                                  where event_date = any($1::date[]) order by 1, 2`, [DATES]);
    return { events: e.rows, links: l.rows };
  };
  const importAudits = () => owner.query(
    `select actor_user_id, target_table, details from audit_log where action = 'event_link.import' order by id`).then((r) => r.rows);

  before(async () => {
    owner = await connect(OWNER_URL);
    dir = mkdtempSync(join(tmpdir(), "bocc-links-import-"));
    // 2083-01-12 already exists, held, with its Luma link stored without the id.
    await owner.query(`insert into events (event_date, status) values ('2083-01-12', 'held')`);
    await owner.query(`insert into event_links (event_date, platform, url) values ('2083-01-12', 'luma', 'https://luma.com/bbb')`);
  });
  after(async () => {
    rmSync(dir, { recursive: true, force: true });
    await owner?.end();
  });

  test("usage and refusals", () => {
    assert.equal(spawnSync(process.execPath, [SCRIPT], { env: env(), encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [SCRIPT, "--yaml", "x"], { env: env(), encoding: "utf8" }).status, 2);
    const y = write("y.yml", YAML), r = write("r.md", README);
    assert.equal(spawnSync(process.execPath, [SCRIPT, "--yaml", y, "--readme", r, "--force"], { env: env(), encoding: "utf8" }).status, 2);
    const noDb = run(y, r, ["--apply"], false);
    assert.equal(noDb.code, 1);
    assert.match(noDb.err, /Missing DATABASE_URL/);
    const mismatch = run(write("bad.yml", YAML.replace("luma.com/aaa", "luma.com/zzz")), r, ["--apply"]);
    assert.equal(mismatch.code, 1);
    assert.match(mismatch.err, /Luma URL differs/);
    assert.match(mismatch.err, /nothing written/);
  });

  test("without a database: the plan only", () => {
    const r = run(write("y.yml", YAML), write("r.md", README), [], false);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /\[dry-run\] dates: 4 \(2083-01-05 … 2083-01-26\)/);
    assert.match(r.out, /links: luma 4, eventbrite 2, facebook_event 1, linkedin_event 1; luma with evt- id 2/);
    assert.match(r.out, /not compared with the database/);
  });

  test("dry run: compares with the database and writes nothing", async () => {
    const before = await snapshot();
    const r = run(write("y.yml", YAML), write("r.md", README));
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^date\s+event\s+luma\s+luma id\s+eventbrite\s+facebook\s+linkedin/m);
    assert.match(r.out, /2083-01-12\s+exists\s+add id\s+yes\s+add/);
    assert.match(r.out, /events: would create 3, existing 1 \(status never touched\)/);
    assert.match(r.out, /links: would insert 7, would fill id 1, unchanged 0, conflicts 0/);
    assert.deepEqual(await snapshot(), before);
  });

  test("--apply writes once with one audit row; existing status untouched; a second --apply changes nothing", async () => {
    const auditsBefore = (await importAudits()).length;
    const y = write("y.yml", YAML), rd = write("r.md", README);
    const first = run(y, rd, ["--apply"]);
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, /\[apply\] events: create 3, existing 1/);
    assert.match(first.out, /\[apply\] links: insert 7, fill id 1, unchanged 0, conflicts 0/);
    const snap = await snapshot();
    assert.deepEqual(snap.events.map((e) => [e.event_date, e.status]),
      [["2083-01-05", "scheduled"], ["2083-01-12", "held"], ["2083-01-19", "scheduled"], ["2083-01-26", "scheduled"]]);
    assert.equal(snap.links.length, 8);
    assert.deepEqual(snap.links.find((l) => l.event_date === "2083-01-12" && l.platform === "luma").external_id, "evt-BBB222");
    const audits = await importAudits();
    assert.equal(audits.length, auditsBefore + 1);
    const a = audits.at(-1);
    assert.deepEqual([a.actor_user_id, a.target_table], [null, "event_links"]);
    assert.deepEqual(
      [a.details.yaml, a.details.readme, a.details.eventsCreated, a.details.linksInserted, a.details.idsFilled, a.details.changedDates],
      ["y.yml", "r.md", 3, 7, 1, DATES]);

    const second = run(y, rd, ["--apply"]);
    assert.equal(second.code, 0, second.err);
    assert.match(second.out, /links: insert 0, fill id 0, unchanged 8, conflicts 0/);
    assert.deepEqual(await snapshot(), snap);
    assert.equal((await importAudits()).length, auditsBefore + 1, "no audit row for a run that changed nothing");
  });

  test("a stored link that differs is a conflict: --apply refused, --prefer-db keeps it and imports the rest", async () => {
    await owner.query(`update event_links set url = 'https://www.eventbrite.com/e/999' where event_date = '2083-01-05' and platform = 'eventbrite'`);
    await owner.query(`delete from event_links where event_date = '2083-01-26'`);
    const before = await snapshot();
    const y = write("y.yml", YAML), rd = write("r.md", README);
    const dry = run(y, rd);
    assert.equal(dry.code, 0);
    assert.match(dry.out, /CONFLICT 2083-01-05 eventbrite: stored https:\/\/www\.eventbrite\.com\/e\/999, import https:\/\/www\.eventbrite\.com\/e\/111/);
    const refused = run(y, rd, ["--apply"]);
    assert.equal(refused.code, 1);
    assert.match(refused.err, /1 conflict\(s\): nothing written/);
    assert.deepEqual(await snapshot(), before);

    const kept = run(y, rd, ["--apply", "--prefer-db"]);
    assert.equal(kept.code, 0, kept.err);
    assert.match(kept.out, /links: insert 1, fill id 0, unchanged 6, conflicts 1 \(kept as stored: --prefer-db\)/);
    const after = await snapshot();
    assert.equal(after.links.find((l) => l.event_date === "2083-01-05" && l.platform === "eventbrite").url, "https://www.eventbrite.com/e/999");
    assert.ok(after.links.some((l) => l.event_date === "2083-01-26" && l.platform === "luma"));
    assert.equal((await importAudits()).at(-1).details.conflictsKept, 1);
  });
});
