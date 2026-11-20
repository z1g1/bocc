#!/usr/bin/env node
/**
 * One-time import: the event listings → Neon `events` + `event_links` (ADR 0009 decision 6,
 * admin app plan Phase 4). Two sources, both given as explicit paths because they are
 * deleted from the repo after the import:
 *   --yaml    src/data/luma_events.yml: "YYYY-MM-DD": { url: <Luma URL>, id: evt-… }
 *   --readme  docs/social/README.md: the "Event URLS" table,
 *             | Date | Luma URL | LinkedIn | Facebook | EventBrite |, dates like
 *             `Tue, Nov 10, 2026`, a blank cell = no link
 * For production, read them from git history, e.g.
 *   git show 829155c:src/data/luma_events.yml > /tmp/luma_events.yml
 *   git show 829155c:docs/social/README.md   > /tmp/social-README.md
 *
 * Dry run by default: parses both files, cross-checks the Luma URLs and prints a table
 * (one row per date: is the event new, and what happens to each listing) plus counts.
 * With a database URL it also compares against what is stored. `--apply` writes, in
 * ONE transaction, and refuses to run while there are errors, or conflicts unless
 * `--prefer-db`.
 *
 * Runs as the database OWNER (DATABASE_URL_UNPOOLED, else DATABASE_URL), like
 * migrate.js: an operator tool, never deployed. One audit_log row (actor NULL, action
 * `event_link.import`) summarises a run that changed something; a run that changes
 * nothing writes nothing, so running it again is safe.
 *
 * Usage (from backend/):
 *   node scripts/import-event-links.js --yaml <luma_events.yml> --readme <README.md>    # plan only, no DB
 *   node --env-file=../.env.local scripts/import-event-links.js --yaml … --readme …    # dry run vs the DB
 *   node --env-file=../.env.local scripts/import-event-links.js --yaml … --readme … --apply [--prefer-db]
 *
 * Rules:
 *   - URLs and the Luma id are checked with the admin's own rules
 *     (src/lib/admin/event-links-rules.mjs): a URL the admin would refuse is an error.
 *   - Luma comes from both files. The YAML gives the URL and the evt- id, the README the
 *     URL. Both URLs present and different (after normalising) is an error (a mismatch);
 *     a URL in only one file is used and listed for information.
 *   - Dates: YAML keys YYYY-MM-DD; README dates "Tue, Nov 10, 2026" (the weekday, when
 *     given, must match). A duplicate date in one file is an error.
 *   - Events: a date with no `events` row gets one, `scheduled`. An existing row is never
 *     touched (its status in particular).
 *   - Links, per (date, platform):
 *       none stored                                  insert
 *       stored, same URL and id                      unchanged
 *       stored, same URL, no id; the import has one  fill the id
 *       stored, same URL and id; the import has none unchanged (the stored id is kept)
 *       anything else                                CONFLICT: never overwritten. --apply
 *                                                    is refused while conflicts exist;
 *                                                    --prefer-db keeps the stored value
 *                                                    and imports the rest
 *     Links stored for platforms or dates the import doesn't mention are left alone.
 *
 * Exit codes: 0 ok, 1 errors or a refused --apply (nothing written), 2 usage.
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const RULES_PATH = path.join(__dirname, '../../src/lib/admin/event-links-rules.mjs');
let rulesPromise;
/** The admin's URL rules (ESM, loaded once). */
const loadRules = () => (rulesPromise ??= import(pathToFileURL(RULES_PATH).href));

const PLATFORM_ORDER = ['luma', 'eventbrite', 'facebook_event', 'linkedin_event'];
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

function isoOk(s) {
  const m = ISO.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.toISOString().slice(0, 10) === s;
}

// ── Parsing ─────────────────────────────────────────────────────────────────

/**
 * luma_events.yml → [{ date, url, id }]. Throws on a file that isn't a mapping.
 * Per-entry problems go to `errors`.
 */
function parseYaml(text, errors) {
  const YAML = require('yaml');
  const doc = YAML.parse(text);
  if (doc == null) return [];
  if (typeof doc !== 'object' || Array.isArray(doc)) throw new Error('YAML: expected a mapping of date: { url, id }');
  const out = [];
  for (const [key, v] of Object.entries(doc)) {
    if (!isoOk(key)) { errors.push(`YAML ${key}: not a date (YYYY-MM-DD)`); continue; }
    if (!v || typeof v !== 'object' || Array.isArray(v)) { errors.push(`YAML ${key}: expected { url, id }`); continue; }
    const unknown = Object.keys(v).filter((k) => k !== 'url' && k !== 'id');
    if (unknown.length) errors.push(`YAML ${key}: unknown key(s) ${unknown.join(', ')}`);
    out.push({
      date: key,
      url: v.url == null ? '' : String(v.url),
      id: v.id == null ? '' : String(v.id),
    });
  }
  return out;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** "Tue, Nov 10, 2026" → "2026-11-10". The weekday is optional but must match. Throws. */
function parseReadmeDate(raw) {
  const s = raw.trim();
  const m = /^(?:([A-Za-z]{3,9})\.?,?\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (!m) throw new Error(`unreadable date "${s}"`);
  const month = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
  if (month < 0) throw new Error(`unreadable month in "${s}"`);
  const d = new Date(Date.UTC(+m[4], month, +m[3]));
  if (d.getUTCMonth() !== month || d.getUTCDate() !== +m[3]) throw new Error(`not a calendar date "${s}"`);
  if (m[1]) {
    const wd = DAYS.indexOf(m[1].slice(0, 3).toLowerCase());
    if (wd < 0) throw new Error(`unreadable weekday in "${s}"`);
    if (wd !== d.getUTCDay()) throw new Error(`"${s}": that date is a ${DAYS[d.getUTCDay()]}`);
  }
  return d.toISOString().slice(0, 10);
}

const splitRow = (line) => {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c) => c.trim());
};

/** Header cell → platform (or 'date'). */
function columnFor(h) {
  const s = h.toLowerCase();
  if (s === 'date') return 'date';
  if (s.includes('luma')) return 'luma';
  if (s.includes('eventbrite')) return 'eventbrite';
  if (s.includes('facebook')) return 'facebook_event';
  if (s.includes('linkedin')) return 'linkedin_event';
  return null;
}

/**
 * The README's URL table → [{ date, line, links: { platform: url } }]. The table is the
 * first one whose header has a Date column and a Luma column. Throws if there is none.
 */
function parseReadme(text, errors) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => {
    if (!l.trim().startsWith('|')) return false;
    const cols = splitRow(l).map(columnFor);
    return cols.includes('date') && cols.includes('luma');
  });
  if (start < 0) throw new Error('README: no table with Date and Luma columns');
  const header = splitRow(lines[start]);
  const cols = header.map(columnFor);
  header.forEach((h, i) => { if (!cols[i]) errors.push(`README line ${start + 1}: unknown column "${h}"`); });
  if (!/^\s*\|?\s*:?-{3,}/.test(lines[start + 1] ?? '')) throw new Error(`README line ${start + 2}: expected the table's |---| line`);
  const out = [];
  for (let i = start + 2; i < lines.length && lines[i].trim().startsWith('|'); i++) {
    const cells = splitRow(lines[i]);
    const lineNo = i + 1;
    if (cells.length !== header.length) { errors.push(`README line ${lineNo}: ${cells.length} cells, expected ${header.length}`); continue; }
    let date = null;
    const links = {};
    cells.forEach((c, j) => {
      if (cols[j] === 'date') {
        try { date = parseReadmeDate(c); } catch (e) { errors.push(`README line ${lineNo}: ${e.message}`); }
      } else if (cols[j] && c !== '') links[cols[j]] = c;
    });
    if (date) out.push({ date, line: lineNo, links });
  }
  return out;
}

// ── Plan ────────────────────────────────────────────────────────────────────

/**
 * Merge both sources into one link per (date, platform), checked with the admin's rules.
 * @returns {Promise<{ dates: Map<string, Record<string, { url: string, externalId: string|null }>>,
 *                      errors: string[], mismatches: string[], info: string[] }>}
 */
async function planImport(yamlText, readmeText) {
  const rules = await loadRules();
  const errors = [], mismatches = [], info = [];
  const yamlRows = parseYaml(yamlText, errors);
  const readmeRows = parseReadme(readmeText, errors);
  const dates = new Map();
  const slot = (d) => { if (!dates.has(d)) dates.set(d, {}); return dates.get(d); };
  const norm = (platform, raw, where) => {
    try { return rules.normaliseLinkUrl(platform, raw); } catch (e) { errors.push(`${where} ${rules.PLATFORMS[platform]}: ${e.message} (${raw})`); return null; }
  };

  const yamlByDate = new Map();
  for (const r of yamlRows) {
    if (yamlByDate.has(r.date)) { errors.push(`YAML ${r.date}: duplicate date`); continue; }
    yamlByDate.set(r.date, r);
  }
  const readmeByDate = new Map();
  for (const r of readmeRows) {
    if (readmeByDate.has(r.date)) { errors.push(`README line ${r.line}: duplicate date ${r.date} (also line ${readmeByDate.get(r.date).line})`); continue; }
    readmeByDate.set(r.date, r);
  }

  for (const [date, r] of yamlByDate) {
    let externalId = null;
    try { externalId = rules.normaliseLumaId(r.id); } catch (e) { errors.push(`YAML ${date} id: ${e.message} (${r.id})`); }
    if (r.url === '') {
      errors.push(`YAML ${date}: no url`);
      continue;
    }
    const url = norm('luma', r.url, `YAML ${date}`);
    if (url) slot(date).luma = { url, externalId };
    if (!externalId && url) info.push(`${date}: Luma has no evt- id in the YAML (the public page will have no RSVP embed; not a readiness item since #42)`);
  }
  for (const [date, r] of readmeByDate) {
    const s = slot(date);
    for (const [platform, raw] of Object.entries(r.links)) {
      const url = norm(platform, raw, `README line ${r.line}`);
      if (!url) continue;
      if (platform === 'luma' && s.luma) {
        if (s.luma.url !== url) mismatches.push(`${date}: Luma URL differs: YAML ${s.luma.url}, README ${url}`);
        continue;
      }
      if (platform === 'luma') info.push(`${date}: Luma URL only in the README (no evt- id)`);
      s[platform] = { url, externalId: null };
    }
    if (yamlByDate.has(date) && !r.links.luma) info.push(`${date}: Luma URL only in the YAML`);
  }
  for (const date of yamlByDate.keys()) {
    if (!readmeByDate.has(date)) info.push(`${date}: in the YAML but not the README table`);
  }
  // Drop dates left empty by errors; keep date order.
  const sorted = new Map([...dates].filter(([, l]) => Object.keys(l).length).sort(([a], [b]) => (a < b ? -1 : 1)));
  return { dates: sorted, errors, mismatches, info };
}

/**
 * What to do with one planned link, given what is stored.
 * @returns {'insert'|'unchanged'|'fill_id'|'conflict'}
 */
function decide(planned, stored) {
  if (!stored) return 'insert';
  if (stored.url !== planned.url) return 'conflict';
  const s = stored.external_id ?? null, p = planned.externalId ?? null;
  if (s === p || p === null) return 'unchanged';
  if (s === null) return 'fill_id';
  return 'conflict';
}

async function loadStored(db, dates) {
  const list = [...dates];
  const ev = await db.query(`select event_date::text as date from public.events where event_date = any($1::date[])`, [list]);
  const ln = await db.query(
    `select event_date::text as date, platform, url, external_id from public.event_links where event_date = any($1::date[])`, [list]);
  const links = new Map();
  for (const r of ln.rows) links.set(`${r.date}/${r.platform}`, r);
  return { events: new Set(ev.rows.map((r) => r.date)), links };
}

// ── Output ──────────────────────────────────────────────────────────────────

const CODE = { insert: 'add', unchanged: 'same', fill_id: 'add id', conflict: 'CONFLICT', planned: 'yes' };

function table(rows) {
  const head = ['date', 'event', 'luma', 'luma id', 'eventbrite', 'facebook', 'linkedin'];
  const body = rows.map((r) => [
    r.date, r.event,
    ...PLATFORM_ORDER.map((p, i) => {
      const c = r.cells[p] ? CODE[r.cells[p]] : '';
      return i === 0 ? [c, r.lumaId ? 'yes' : r.cells.luma ? 'no' : ''] : [c];
    }).flat(),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (r) => r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  return [line(head), line(widths.map((w) => '-'.repeat(w))), ...body.map(line)].join('\n');
}

// ── Main ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { apply: false, preferDb: false, yaml: null, readme: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--prefer-db') opts.preferDb = true;
    else if ((a === '--yaml' || a === '--readme') && argv[i + 1] && !argv[i + 1].startsWith('--')) opts[a.slice(2)] = argv[++i];
    else return null;
  }
  return opts.yaml && opts.readme ? opts : null;
}

async function main(argv, env, out = console) {
  const opts = parseArgs(argv);
  if (!opts) {
    out.error('usage: import-event-links.js --yaml <luma_events.yml> --readme <README.md> [--apply] [--prefer-db]');
    return 2;
  }
  const mode = opts.apply ? '[apply]' : '[dry-run]';

  let plan;
  try {
    plan = await planImport(fs.readFileSync(opts.yaml, 'utf8'), fs.readFileSync(opts.readme, 'utf8'));
  } catch (err) {
    out.error(`${mode} ${err.message}`);
    return 1;
  }
  const { dates, errors, mismatches, info } = plan;
  const problems = [...errors, ...mismatches];

  const url = env.DATABASE_URL_UNPOOLED || env.DATABASE_URL;
  if (opts.apply && !url) {
    out.error('Missing DATABASE_URL_UNPOOLED / DATABASE_URL (owner connection string).');
    return 1;
  }
  if (opts.apply && problems.length) {
    problems.forEach((e) => out.error(`  ERROR ${e}`));
    out.error(`${mode} ${problems.length} error(s): nothing written. Fix the files and run again.`);
    return 1;
  }

  const rows = [];
  const counts = { eventsNew: 0, eventsExisting: 0, insert: 0, unchanged: 0, fill_id: 0, conflict: 0 };
  const conflicts = [];
  let refused = false;
  let client = null;
  try {
    let stored = null;
    if (url) {
      const { Client } = require('pg');
      const { toPgConfig } = require('../netlify/functions/utils/db-ssl');
      client = new Client(toPgConfig(url));
      await client.connect();
      if (opts.apply) {
        await client.query('begin');
        // One import at a time, and no admin edit slips between the read and the write.
        await client.query('lock table public.events, public.event_links in share row exclusive mode');
      }
      stored = await loadStored(client, dates.keys());
    }
    for (const [date, links] of dates) {
      const row = { date, event: '', cells: {}, lumaId: Boolean(links.luma?.externalId) };
      if (stored) {
        const isNew = !stored.events.has(date);
        row.event = isNew ? 'new' : 'exists';
        counts[isNew ? 'eventsNew' : 'eventsExisting']++;
      }
      for (const p of PLATFORM_ORDER) {
        if (!links[p]) continue;
        if (!stored) { row.cells[p] = 'planned'; continue; }
        const s = stored.links.get(`${date}/${p}`);
        const action = decide(links[p], s);
        row.cells[p] = action;
        counts[action]++;
        if (action === 'conflict') {
          conflicts.push(`${date} ${p}: stored ${s.url}${s.external_id ? ` (${s.external_id})` : ''}, import ${links[p].url}${links[p].externalId ? ` (${links[p].externalId})` : ''}`);
        }
      }
      rows.push(row);
    }

    if (opts.apply) {
      if (conflicts.length && !opts.preferDb) {
        refused = true;
        await client.query('rollback');
      } else {
        const changedDates = new Set();
        for (const r of rows) {
          if (r.event === 'new') {
            await client.query(`insert into public.events (event_date) values ($1::date)`, [r.date]);
            changedDates.add(r.date);
          }
          for (const p of PLATFORM_ORDER) {
            const l = dates.get(r.date)[p];
            if (r.cells[p] === 'insert') {
              await client.query(
                `insert into public.event_links (event_date, platform, url, external_id) values ($1::date, $2, $3, $4)`,
                [r.date, p, l.url, l.externalId]);
              changedDates.add(r.date);
            } else if (r.cells[p] === 'fill_id') {
              const res = await client.query(
                `update public.event_links set external_id = $4
                  where event_date = $1::date and platform = $2 and url = $3 and external_id is null`,
                [r.date, p, l.url, l.externalId]);
              if (res.rowCount !== 1) throw new Error(`${r.date} ${p}: the stored link changed during the import`);
              changedDates.add(r.date);
            }
          }
        }
        if (changedDates.size) {
          await client.query(
            `insert into public.audit_log (actor_user_id, action, target_table, target_id, details)
             values (null, 'event_link.import', 'event_links', null, $1)`,
            [JSON.stringify({
              yaml: path.basename(opts.yaml),
              readme: path.basename(opts.readme),
              dates: rows.length,
              eventsCreated: counts.eventsNew,
              linksInserted: counts.insert,
              idsFilled: counts.fill_id,
              unchanged: counts.unchanged,
              conflictsKept: counts.conflict,
              preferDb: opts.preferDb,
              changedDates: [...changedDates],
            })]);
        }
        await client.query('commit');
      }
    }
  } catch (err) {
    if (client && opts.apply) await client.query('rollback').catch(() => {});
    out.error(`${mode} failed: ${err.message}`);
    return 1;
  } finally {
    if (client) await client.end().catch(() => {});
  }

  out.log(table(rows));
  out.log('');
  const per = PLATFORM_ORDER.map((p) => `${p} ${rows.filter((r) => r.cells[p]).length}`).join(', ');
  out.log(`${mode} dates: ${rows.length}${rows.length ? ` (${rows[0].date} … ${rows[rows.length - 1].date})` : ''}`);
  out.log(`${mode} links: ${per}; luma with evt- id ${rows.filter((r) => r.lumaId).length}`);
  if (url) {
    const would = opts.apply && !refused ? '' : 'would ';
    out.log(`${mode} events: ${would}create ${counts.eventsNew}, existing ${counts.eventsExisting} (status never touched)`);
    out.log(`${mode} links: ${would}insert ${counts.insert}, ${would}fill id ${counts.fill_id}, unchanged ${counts.unchanged}, conflicts ${counts.conflict}${opts.preferDb && counts.conflict ? ' (kept as stored: --prefer-db)' : ''}`);
  } else {
    out.log(`${mode} no DATABASE_URL: not compared with the database`);
  }
  out.log(`${mode} Luma URL mismatches (YAML vs README): ${mismatches.length}`);
  mismatches.forEach((m) => out.log(`  MISMATCH ${m}`));
  out.log(`${mode} conflicts with stored links: ${conflicts.length}`);
  conflicts.forEach((c) => out.log(`  CONFLICT ${c}`));
  out.log(`${mode} for information only: ${info.length}`);
  info.forEach((n) => out.log(`  INFO  ${n}`));
  if (errors.length) {
    out.log(`${mode} errors: ${errors.length}`);
    errors.forEach((e) => out.log(`  ERROR ${e}`));
  }
  if (refused) {
    out.error(`${mode} ${conflicts.length} conflict(s): nothing written. Fix them in the admin, or run again with --prefer-db to keep the stored links.`);
    return 1;
  }
  return problems.length ? 1 : 0;
}

module.exports = { parseYaml, parseReadme, parseReadmeDate, planImport, decide, main };

if (require.main === module) {
  main(process.argv.slice(2), process.env).then((code) => { process.exitCode = code; });
}
