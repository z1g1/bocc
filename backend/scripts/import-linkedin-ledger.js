#!/usr/bin/env node
/**
 * One-time import: the `bocc-event` CLI's local LinkedIn ledger → Neon `linkedin_events`
 * (ADR 0012 decision 9, issue #28), so the weeks the CLI created show as Posted on their
 * event pages and the web create refuses those dates. Run it against production BEFORE the
 * first web create.
 *
 * The ledger is the CLI's JSON (tools/linkedin-events/bocc_events/ledger.py):
 *   { "events": { "YYYY-MM-DD": { status, name, attempted_at, commentary?,
 *                                 event_id, url, created_at,        (created and posted)
 *                                 post_urn, posted_at } } }          (posted)
 * Path: --ledger <file>, else $LINKEDIN_LEDGER_FILE, else
 * ${XDG_STATE_HOME:-~/.local/state}/bocc-linkedin/ledger.json (the CLI's own default).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const RULES_PATH = path.join(__dirname, '../../src/lib/linkedin/rules.mjs');
let rulesPromise;
/** The web app's LinkedIn rules (ESM, no imports of their own), loaded once. */
const loadRules = () => (rulesPromise ??= import(pathToFileURL(RULES_PATH).href));

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const EVENT_ID = /^[0-9]{1,30}$/;
const EVENT_URL = /^https:\/\/www\.linkedin\.com\/events\/[A-Za-z0-9-]+\/$/;
const POST_URN = /^urn:li:(ugcPost|share):[0-9]+$/;

function isoOk(s) {
  const m = ISO.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.toISOString().slice(0, 10) === s;
}

const isTimestamp = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v));

/**
 * The CLI ledger's text → the rows to import, the entries skipped, and errors.
 * IDs must be JSON strings: a 19-digit LinkedIn id as a JSON number has already lost
 * digits by the time JSON.parse returns, so it is an error, never imported.
 * @returns {Promise<{ rows: object[], skipped: { date: string, status: string, reason: string }[], errors: string[] }>}
 */
async function planLedger(text) {
  const rules = await loadRules();
  const errors = [], skipped = [], rows = [];
  let doc;
  try { doc = JSON.parse(text); } catch (e) { throw new Error(`ledger: not JSON (${e.message})`); }
  const events = doc?.events;
  if (!events || typeof events !== 'object' || Array.isArray(events)) throw new Error('ledger: expected { "events": { "YYYY-MM-DD": … } }');

  const lobby = rules.buildEventSpec({ date: '2000-01-04' }).spec.commentary;
  const foodHall = rules.buildEventSpec({ date: '2000-01-04', location: 'food_hall' }).spec.commentary;

  for (const date of Object.keys(events).sort()) {
    const e = events[date];
    const err = (m) => errors.push(`${date}: ${m}`);
    if (!isoOk(date)) { err('not a date (YYYY-MM-DD)'); continue; }
    if (!e || typeof e !== 'object' || Array.isArray(e)) { err('expected an entry object'); continue; }
    if (e.status === 'pending') {
      skipped.push({ date, status: 'pending', reason: 'pending in the CLI: the create\'s outcome unknown. Check LinkedIn; not imported' });
      continue;
    }
    if (e.status !== 'created' && e.status !== 'posted') { err(`unknown status ${JSON.stringify(e.status)}`); continue; }
    const before = errors.length;
    if (typeof e.name !== 'string' || e.name.length < 1 || e.name.length > 200) err('name missing or longer than 200 characters');
    const commentary = e.commentary == null || e.commentary === '' ? lobby : e.commentary;
    if (typeof commentary !== 'string' || commentary.length > 3000) err('commentary not text or longer than 3000 characters');
    if (typeof e.event_id !== 'string') err(`event_id must be a JSON string (a number loses digits): ${JSON.stringify(e.event_id)}`);
    else if (!EVENT_ID.test(e.event_id)) err(`event_id not all digits: ${e.event_id}`);
    if (typeof e.url !== 'string' || !EVENT_URL.test(e.url)) err(`url not a LinkedIn event page: ${JSON.stringify(e.url)}`);
    if (!isTimestamp(e.created_at)) err(`created_at not a timestamp: ${JSON.stringify(e.created_at)}`);
    if (e.attempted_at != null && !isTimestamp(e.attempted_at)) err(`attempted_at not a timestamp: ${JSON.stringify(e.attempted_at)}`);
    const posted = e.status === 'posted';
    if (posted) {
      if (typeof e.post_urn !== 'string' || !POST_URN.test(e.post_urn)) err(`post_urn not a post URN: ${JSON.stringify(e.post_urn)}`);
      if (!isTimestamp(e.posted_at)) err(`posted_at not a timestamp: ${JSON.stringify(e.posted_at)}`);
    }
    if (errors.length > before) continue;
    rows.push({
      date,
      status: e.status,
      name: e.name,
      commentary,
      location: commentary === foodHall ? 'food_hall' : commentary === lobby ? 'lobby' : null,
      linkedinEventId: e.event_id,
      eventUrl: e.url,
      postUrn: posted ? e.post_urn : null,
      postUrl: posted ? rules.postUrl(e.post_urn) : null,
      attemptedAt: e.attempted_at ?? e.created_at,
      eventCreatedAt: e.created_at,
      postedAt: posted ? e.posted_at : null,
    });
  }
  return { rows, skipped, errors };
}

/**
 * What to do with one planned row, given the date's active (not retired) stored row.
 * @returns {'add'|'mark_posted'|'unchanged'|'conflict'}
 */
function decide(planned, stored) {
  if (!stored) return 'add';
  if (stored.status === 'pending' || stored.linkedin_event_id !== planned.linkedinEventId) return 'conflict';
  if (stored.status === 'created' && planned.status === 'posted') return 'mark_posted';
  if (stored.status === 'posted' && planned.status === 'posted' && stored.post_urn !== planned.postUrn) return 'conflict';
  return 'unchanged'; // same status, or the stored row is further along (posted from the web)
}

async function loadStored(db, dates) {
  const ev = await db.query(`select event_date::text as date from public.events where event_date = any($1::date[])`, [dates]);
  const le = await db.query(
    `select event_date::text as date, id, status, linkedin_event_id, post_urn
       from public.linkedin_events where event_date = any($1::date[]) and status <> 'retired'`, [dates]);
  const ln = await db.query(
    `select event_date::text as date, url from public.event_links
      where platform = 'linkedin_event' and event_date = any($1::date[])`, [dates]);
  return {
    events: new Set(ev.rows.map((r) => r.date)),
    ledger: new Map(le.rows.map((r) => [r.date, r])),
    listings: new Map(ln.rows.map((r) => [r.date, r.url])),
  };
}

function defaultLedgerPath(env) {
  if (env.LINKEDIN_LEDGER_FILE) return env.LINKEDIN_LEDGER_FILE.replace(/^~(?=\/|$)/, env.HOME || os.homedir());
  const base = env.XDG_STATE_HOME || path.join(env.HOME || os.homedir(), '.local', 'state');
  return path.join(base, 'bocc-linkedin', 'ledger.json');
}

function parseArgs(argv) {
  const opts = { apply: false, preferDb: false, ledger: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--prefer-db') opts.preferDb = true;
    else if (a === '--ledger' && argv[i + 1] && !argv[i + 1].startsWith('--')) opts.ledger = argv[++i];
    else return null;
  }
  return opts;
}

const CODE = { add: 'add', mark_posted: 'mark posted', unchanged: 'same', conflict: 'CONFLICT', planned: 'yes' };

function table(rows) {
  const head = ['date', 'cli', 'event', 'ledger', 'listing'];
  const body = rows.map((r) => [r.date, r.status, r.event, CODE[r.action] ?? '', r.listing ? CODE[r.listing] ?? r.listing : '']);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (r) => r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  return [line(head), line(widths.map((w) => '-'.repeat(w))), ...body.map(line)].join('\n');
}

async function main(argv, env, out = console) {
  const opts = parseArgs(argv);
  if (!opts) {
    out.error('usage: import-linkedin-ledger.js [--ledger <ledger.json>] [--apply] [--prefer-db]');
    return 2;
  }
  const mode = opts.apply ? '[apply]' : '[dry-run]';
  const file = opts.ledger ?? defaultLedgerPath(env);

  let plan;
  try {
    plan = await planLedger(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    out.error(`${mode} ${file}: ${err.message}`);
    return 1;
  }
  const { rows: planned, skipped, errors } = plan;

  const url = env.DATABASE_URL_UNPOOLED || env.DATABASE_URL;
  if (opts.apply && !url) {
    out.error('Missing DATABASE_URL_UNPOOLED / DATABASE_URL (owner connection string).');
    return 1;
  }
  if (opts.apply && errors.length) {
    errors.forEach((e) => out.error(`  ERROR ${e}`));
    out.error(`${mode} ${errors.length} error(s): nothing written. Fix the ledger file and run again.`);
    return 1;
  }

  const rows = planned.map((p) => ({ date: p.date, status: p.status, event: '', action: 'planned', listing: '' }));
  const counts = { eventsNew: 0, eventsExisting: 0, add: 0, mark_posted: 0, unchanged: 0, conflict: 0, listingAdd: 0 };
  const conflicts = [], info = [];
  let refused = false;
  let client = null;
  try {
    if (url) {
      const { Client } = require('pg');
      const { toPgConfig } = require('../netlify/functions/utils/db-ssl');
      client = new Client(toPgConfig(url));
      await client.connect();
      if (opts.apply) {
        await client.query('begin');
        // One import at a time, and no web create slips between the read and the write.
        await client.query('lock table public.events, public.linkedin_events, public.event_links in share row exclusive mode');
      }
      const eventLinks = await import(pathToFileURL(path.join(__dirname, '../../src/lib/admin/event-links-rules.mjs')).href);
      const stored = await loadStored(client, planned.map((p) => p.date));
      planned.forEach((p, i) => {
        const row = rows[i];
        const isNew = !stored.events.has(p.date);
        row.event = isNew ? 'new' : 'exists';
        counts[isNew ? 'eventsNew' : 'eventsExisting']++;
        const s = stored.ledger.get(p.date);
        row.action = decide(p, s);
        counts[row.action]++;
        if (row.action === 'conflict') {
          conflicts.push(`${p.date}: stored ${s.status} event ${s.linkedin_event_id ?? '(none)'}${s.post_urn ? ` post ${s.post_urn}` : ''}, `
            + `CLI ${p.status} event ${p.linkedinEventId}${p.postUrn ? ` post ${p.postUrn}` : ''}`);
          return;
        }
        // A posted week has its linkedin_event listing, as a web post fills it. Never overwritten.
        const posted = p.status === 'posted' || s?.status === 'posted';
        if (!posted) return;
        const listingUrl = eventLinks.normaliseLinkUrl('linkedin_event', p.eventUrl);
        const have = stored.listings.get(p.date);
        if (have == null) { row.listing = 'add'; row.listingUrl = listingUrl; counts.listingAdd++; }
        else if (have === listingUrl) row.listing = 'same';
        else { row.listing = 'kept'; info.push(`${p.date}: the LinkedIn listing is ${have}, not ${listingUrl}: kept as stored`); }
      });

      if (opts.apply) {
        if (conflicts.length && !opts.preferDb) {
          refused = true;
          await client.query('rollback');
        } else {
          const changed = new Set();
          for (const [i, p] of planned.entries()) {
            const r = rows[i];
            if (r.action === 'conflict') continue;
            if (r.event === 'new') {
              await client.query(`insert into public.events (event_date) values ($1::date)`, [p.date]);
              changed.add(p.date);
            }
            if (r.action === 'add') {
              await client.query(
                `insert into public.linkedin_events
                   (event_date, status, name, commentary, location, linkedin_event_id, event_url, post_urn, post_url,
                    attempted_at, event_created_at, posted_at)
                 values ($1::date, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
                [p.date, p.status, p.name, p.commentary, p.location, p.linkedinEventId, p.eventUrl, p.postUrn, p.postUrl,
                  p.attemptedAt, p.eventCreatedAt, p.postedAt]);
              changed.add(p.date);
            } else if (r.action === 'mark_posted') {
              const res = await client.query(
                `update public.linkedin_events set status = 'posted', post_urn = $3, post_url = $4, posted_at = $5
                  where event_date = $1::date and status = 'created' and linkedin_event_id = $2`,
                [p.date, p.linkedinEventId, p.postUrn, p.postUrl, p.postedAt]);
              if (res.rowCount !== 1) throw new Error(`${p.date}: the stored ledger row changed during the import`);
              changed.add(p.date);
            }
            if (r.listing === 'add') {
              await client.query(
                `insert into public.event_links (event_date, platform, url, external_id) values ($1::date, 'linkedin_event', $2, null)`,
                [p.date, r.listingUrl]);
              changed.add(p.date);
            }
          }
          if (changed.size) {
            await client.query(
              `insert into public.audit_log (actor_user_id, action, target_table, target_id, details)
               values (null, 'linkedin_event.import', 'linkedin_events', null, $1)`,
              [JSON.stringify({
                ledger: path.basename(file),
                entries: planned.length + skipped.length,
                eventsCreated: counts.eventsNew,
                rowsAdded: counts.add,
                markedPosted: counts.mark_posted,
                unchanged: counts.unchanged,
                listingsAdded: counts.listingAdd,
                conflictsKept: counts.conflict,
                preferDb: opts.preferDb,
                skipped: skipped.map((s) => s.date),
                changedDates: [...changed],
              })]);
          }
          await client.query('commit');
        }
      }
    }
  } catch (err) {
    if (client && opts.apply) await client.query('rollback').catch(() => {});
    out.error(`${mode} failed: ${err.message}`);
    return 1;
  } finally {
    if (client) await client.end().catch(() => {});
  }

  const by = (s) => planned.filter((p) => p.status === s).length;
  out.log(`${mode} ledger: ${file}`);
  out.log(table(rows));
  out.log('');
  out.log(`${mode} entries: ${planned.length + skipped.length + errors.length} (posted ${by('posted')}, created ${by('created')}, pending ${skipped.length}${errors.length ? `, with errors ${errors.length}` : ''})`);
  if (url) {
    const would = opts.apply && !refused ? '' : 'would ';
    out.log(`${mode} events: ${would}create ${counts.eventsNew}, existing ${counts.eventsExisting} (status and location never touched)`);
    out.log(`${mode} ledger: ${would}add ${counts.add}, ${would}mark posted ${counts.mark_posted}, unchanged ${counts.unchanged}, conflicts ${counts.conflict}${opts.preferDb && counts.conflict ? ' (kept as stored: --prefer-db)' : ''}`);
    out.log(`${mode} listings: ${would}add ${counts.listingAdd}`);
  } else {
    out.log(`${mode} no DATABASE_URL: not compared with the database`);
  }
  out.log(`${mode} skipped (not imported): ${skipped.length}`);
  skipped.forEach((s) => out.log(`  SKIPPED ${s.date} ${s.status}: ${s.reason}`));
  out.log(`${mode} conflicts with stored ledger rows: ${conflicts.length}`);
  conflicts.forEach((c) => out.log(`  CONFLICT ${c}`));
  if (info.length) {
    out.log(`${mode} for information only: ${info.length}`);
    info.forEach((n) => out.log(`  INFO  ${n}`));
  }
  if (errors.length) {
    out.log(`${mode} errors: ${errors.length}`);
    errors.forEach((e) => out.log(`  ERROR ${e}`));
  }
  if (refused) {
    out.error(`${mode} ${conflicts.length} conflict(s): nothing written. Check LinkedIn, or run again with --prefer-db to keep the stored rows.`);
    return 1;
  }
  return errors.length ? 1 : 0;
}

module.exports = { planLedger, decide, main };

if (require.main === module) {
  main(process.argv.slice(2), process.env).then((code) => { process.exitCode = code; });
}
