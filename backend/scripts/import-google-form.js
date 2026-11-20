#!/usr/bin/env node
/**
 * One-time import: the after-event Google Form CSV → Neon `events` + `event_reports`
 * (ADR 0009 decision 6, admin app plan Phase 3).
 *
 * Dry run by default: parses the CSV, fixes and checks dates, and prints a summary
 * table (row, date, source, count, bling, location, what it would do, any fix). With
 * a database URL it also compares against what is stored. `--apply` writes, in ONE
 * transaction, and refuses to run if any row has an error.
 *
 * Runs as the database OWNER (DATABASE_URL_UNPOOLED, else DATABASE_URL), like
 * migrate.js: an operator tool, never deployed. One audit_log row (actor NULL,
 * action `event_report.import`) summarises each run that changed something; a run that
 * changes nothing writes nothing.
 *
 * Usage (from backend/; the CSV holds personal emails and names: keep it OUT of the repo):
 *   node --env-file=../.env.local scripts/import-google-form.js /path/to/form.csv          # dry run
 *   node --env-file=../.env.local scripts/import-google-form.js /path/to/form.csv --apply  # write
 *   node scripts/import-google-form.js /path/to/form.csv     # no DB env: parse and plan only
 *
 * Rules:
 *   - Headers are matched after trimming. "Email Address" is never read or stored;
 *     submitted_by is NULL.
 *   - A row with a Timestamp is source `google_form`; without one, `pre_form`.
 *   - Dates are M/D/YYYY or M/D/YY (YY = 20YY). A year below 2000 (`7/14/0026`) takes
 *     the Timestamp's year, and is refused without a Timestamp. Every fix is reported.
 *     The date may not be after the Timestamp's date. Duplicate dates are errors.
 *   - Gives and Asks: an integer, blank = NULL. Bling: Yes/No, blank = NULL. Bling
 *     details (the "who" column) mean Bling was given: a No or blank answer with
 *     details is imported as bling_given = true and listed as a fix (Zack, 2026-11-17).
 *   - A date that isn't a Tuesday is listed for information only and imported as is.
 *   - Notes: "Any notes/feedback from today?" and the cancel section's "Any notes?",
 *     joined by a blank line.
 *   - Location: "Lobby (normal)" → lobby, "Food Hall" → food_hall, blank → NULL, else
 *     other + the text. A stored location is never replaced (only filled when NULL).
 *   - "Did you have to cancel event?" = Yes → events.status cancelled, reason mapped
 *     from the answer (else `other` + the text), no report. Otherwise status `reported`
 *     plus a report.
 *   - Idempotent: a date whose report is identical is left alone; an imported report
 *     that differs is updated; a report with source `admin` is NEVER touched, and
 *     neither is an event an admin has cancelled (or a cancelled row whose date has a
 *     report).
 *
 * Exit codes: 0 ok, 1 errors (nothing written), 2 usage.
 */

const fs = require('fs');
const path = require('path');

// ── CSV (RFC 4180) ───────────────────────────────────────────────────────────

/**
 * Parse CSV text into rows of fields. Handles quoted fields with commas, doubled
 * quotes and line breaks, CRLF or LF line endings, and a UTF-8 BOM. A quote inside an
 * unquoted field is kept literally. An unterminated quoted field throws.
 * @param {string} text
 * @returns {string[][]}
 */
function parseCsv(text) {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let quoted = false; // inside a quoted field
  let wasQuoted = false;
  while (i < s.length) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"' && field === '' && !wasQuoted) { quoted = true; wasQuoted = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; wasQuoted = false; i++; continue; }
    if (c === '\r' || c === '\n') {
      row.push(field); rows.push(row); row = []; field = ''; wasQuoted = false;
      i += c === '\r' && s[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += c; i++;
  }
  if (quoted) throw new Error('CSV: unterminated quoted field');
  if (field !== '' || wasQuoted || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ── Columns ──────────────────────────────────────────────────────────────────

const COLUMNS = {
  timestamp: 'Timestamp',
  date: 'Date of Event',
  count: 'How many people counted at Gives and Asks?',
  bling: 'Did you give out the Bring a Friend Bling?',
  blingDetails: 'Who did you give it to? Who did they bring?',
  notes: 'Any notes/feedback from today?',
  cancelled: 'Did you have to cancel event?',
  cancelWhy: 'Why did you have to cancel?',
  cancelAnnounced: 'Did you post on all socials about cancellation?',
  cancelNotes: 'Any notes?',
  location: 'Where were we?',
};
// Known and deliberately ignored. The email column is never read.
const IGNORED = ['Email Address', 'Column 12'];

/** Map trimmed header names to indexes; throws on a missing or unknown column. */
function headerIndex(header) {
  const names = header.map((h) => h.trim());
  const idx = {};
  for (const [key, name] of Object.entries(COLUMNS)) {
    const i = names.indexOf(name);
    if (i === -1) throw new Error(`CSV: missing column "${name}"`);
    if (names.indexOf(name, i + 1) !== -1) throw new Error(`CSV: duplicate column "${name}"`);
    idx[key] = i;
  }
  const unknown = names.filter((n) => n !== '' && !Object.values(COLUMNS).includes(n) && !IGNORED.includes(n));
  if (unknown.length) throw new Error(`CSV: unknown column(s): ${unknown.map((n) => `"${n}"`).join(', ')}`);
  return { idx, extra: IGNORED.filter((n) => n !== 'Email Address').map((n) => names.indexOf(n)).filter((i) => i >= 0) };
}

// ── Field rules ──────────────────────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, '0');
const isRealDate = (y, m, d) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};

/** "M/D/YYYY H:MM:SS" (the Sheet's local time) → "YYYY-MM-DD", or null when blank. */
function parseTimestamp(raw) {
  const t = raw.trim();
  if (t === '') return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+\d{1,2}:\d{2}(:\d{2})?$/.exec(t);
  if (!m || !isRealDate(+m[3], +m[1], +m[2])) throw new Error(`unreadable Timestamp "${t}"`);
  return `${m[3]}-${pad(m[1])}-${pad(m[2])}`;
}

/**
 * "Date of Event" → { date, fix }. Two-digit years are 20YY. A year below 2000 takes
 * the Timestamp's year (and needs one). Throws on anything else.
 * @param {string} raw
 * @param {string|null} tsDate  the Timestamp's date, YYYY-MM-DD
 */
function parseFormDate(raw, tsDate) {
  const t = raw.trim();
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{1,4})$/.exec(t);
  if (!m) throw new Error(`unreadable date "${t}"`);
  const month = +m[1];
  const day = +m[2];
  let year = +m[3];
  let fix = null;
  if (m[3].length === 2) {
    year = 2000 + year;
  } else if (year < 2000) {
    if (!tsDate) throw new Error(`date "${t}" has year ${m[3]} and no Timestamp to fix it from`);
    year = +tsDate.slice(0, 4);
    fix = `${t} → year ${year} from the Timestamp`;
  }
  if (!isRealDate(year, month, day)) throw new Error(`not a calendar date "${t}"`);
  const date = `${year}-${pad(month)}-${pad(day)}`;
  if (fix) fix = `${t} → ${date} (year from the Timestamp)`;
  if (tsDate && date > tsDate) throw new Error(`date ${date} is after the Timestamp's date ${tsDate}`);
  return { date, fix };
}

function parseCount(raw) {
  const t = raw.trim();
  if (t === '') return null;
  if (!/^\d{1,6}$/.test(t)) throw new Error(`Gives and Asks count "${t}" is not a whole number`);
  return Number(t);
}

function parseYesNo(raw, what) {
  const t = raw.trim().toLowerCase();
  if (t === '') return null;
  if (t === 'yes') return true;
  if (t === 'no') return false;
  throw new Error(`${what} "${raw.trim()}" is not Yes/No`);
}

const LOCATION_OTHER_MAX = 200;
function parseLocation(raw) {
  const t = raw.trim().replace(/\s+/g, ' ');
  if (t === '') return { location: null, locationOther: null };
  if (/^lobby( \(normal\))?$/i.test(t)) return { location: 'lobby', locationOther: null };
  if (/^food hall$/i.test(t)) return { location: 'food_hall', locationOther: null };
  if (t.length > LOCATION_OTHER_MAX) throw new Error(`location text longer than ${LOCATION_OTHER_MAX} characters`);
  return { location: 'other', locationOther: t };
}

/**
 * The Form's free-text cancel reason → events.cancel_reason (+ text for `other`).
 * Whole words only (so "office" isn't ice and "training" isn't rain), and facility and
 * other-event wording first: "building closed for the snow" is a facility closure.
 */
function mapCancelReason(raw) {
  const t = raw.trim().replace(/\s+/g, ' ');
  if (/\b(facility|building|power|closed|closure|closing|maintenance|room|venue|space|outage)\b/i.test(t)) {
    return { reason: 'facility', reasonOther: null };
  }
  if (/\b(other event|another event|private event|conflict|conflicting|holidays?)\b/i.test(t)) {
    return { reason: 'other_event', reasonOther: null };
  }
  if (/\b(weather|snow\w*|storms?|blizzard|ice|icy|rain\w*|cold|freezing|flood\w*)\b/i.test(t)) {
    return { reason: 'weather', reasonOther: null };
  }
  return { reason: 'other', reasonOther: t === '' ? 'No reason given in the Google Form' : t.slice(0, 500) };
}

const text = (raw) => {
  const t = raw.replace(/\r\n?/g, '\n').trim();
  return t === '' ? null : t;
};

/**
 * Turn parsed CSV rows into an import plan. Pure: no database.
 * @param {string[][]} rows  header first
 * @returns {{ items: object[], errors: string[], warnings: string[], info: string[], fixes: string[] }}
 *   items: { row, date, source, status, cancel?, report?, location, locationOther, fix }
 */
function planImport(rows) {
  if (rows.length === 0) throw new Error('CSV: empty file');
  const { idx, extra } = headerIndex(rows[0]);
  const items = [];
  const errors = [];
  const warnings = [];
  const info = []; // informational only: imported as is, no action needed
  const fixes = [];
  const seen = new Map();

  rows.slice(1).forEach((cells, i) => {
    const row = i + 2; // the spreadsheet's row number (header is row 1)
    const get = (k) => (cells[idx[k]] ?? '');
    if (cells.every((c) => c.trim() === '')) return; // blank line
    try {
      const tsDate = parseTimestamp(get('timestamp'));
      const { date, fix } = parseFormDate(get('date'), tsDate);
      const source = tsDate ? 'google_form' : 'pre_form';
      if (fix) fixes.push(`row ${row}: ${fix}`);
      // Not an error (a few real events fell on other days), but worth a look for typos.
      const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
      if (weekday !== 2) info.push(`row ${row} (${date}): not a Tuesday (${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][weekday]}); imported as is`);
      for (const j of extra) {
        if ((cells[j] ?? '').trim() !== '') warnings.push(`row ${row} (${date}): an unnamed extra column has data; ignored`);
      }
      const { location, locationOther } = parseLocation(get('location'));
      const cancelled = parseYesNo(get('cancelled'), 'Cancel answer') === true;
      const notesParts = [text(get('notes')), text(get('cancelNotes'))].filter(Boolean);
      const notes = notesParts.length ? [...new Set(notesParts)].join('\n\n') : null;
      const item = { row, date, source, location, locationOther, fix };

      if (cancelled) {
        const announced = parseYesNo(get('cancelAnnounced'), 'Announced answer') === true;
        item.status = 'cancelled';
        item.cancel = { ...mapCancelReason(get('cancelWhy')), announced };
        item.cancelText = get('cancelWhy').trim().replace(/\s+/g, ' ').slice(0, 80);
        const leftover = [get('count'), get('bling'), get('blingDetails')].some((v) => v.trim() !== '') || notes;
        if (leftover) warnings.push(`row ${row} (${date}): cancelled, so its report fields and notes are not imported`);
      } else {
        const givesAsksCount = parseCount(get('count'));
        let blingGiven = parseYesNo(get('bling'), 'Bling answer');
        const blingDetails = text(get('blingDetails'));
        if (blingDetails !== null && blingGiven !== true) {
          // Zack, 2026-11-17: names in the "who" column mean Bling was given, whatever
          // the Yes/No answer says.
          const was = blingGiven === false ? 'No' : 'blank';
          blingGiven = true;
          const f = `Bling inferred from details (answer was ${was})`;
          item.fix = item.fix ? `${item.fix}; ${f}` : f;
          fixes.push(`row ${row} (${date}): ${f}`);
        }
        if (blingDetails && blingDetails.length > 1000) throw new Error('Bling details longer than 1000 characters');
        if (notes && notes.length > 4000) throw new Error('notes longer than 4000 characters');
        item.status = 'reported';
        item.report = { givesAsksCount, notes, blingGiven, blingDetails };
      }
      if (seen.has(date)) {
        errors.push(`row ${row}: duplicate date ${date} (also row ${seen.get(date)})${fix ? ' after fixing' : ''}`);
        return;
      }
      seen.set(date, row);
      items.push(item);
    } catch (err) {
      errors.push(`row ${row}: ${err.message}`);
    }
  });
  items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { items, errors, warnings, info, fixes };
}

// ── Database ─────────────────────────────────────────────────────────────────

const REPORT_FIELDS = [
  ['givesAsksCount', 'gives_asks_count'],
  ['notes', 'notes'],
  ['blingGiven', 'bling_given'],
  ['blingDetails', 'bling_details'],
];

/**
 * Decide what to do with each item given what is stored. Pure.
 * @param {object} item
 * @param {object|undefined} ev   stored events row
 * @param {object|undefined} rep  stored event_reports row
 * @returns {{ action: 'create'|'update'|'unchanged'|'skip', why?: string }}
 */
function decide(item, ev, rep, warnings) {
  if (item.status === 'cancelled') {
    if (rep) return { action: 'skip', why: 'has a report' };
    if (!ev) return { action: 'create' };
    // Never cancel an existing row that isn't cancelled already: an admin may have
    // un-cancelled it, and a re-run must not undo that.
    if (ev.status !== 'cancelled') return { action: 'skip', why: 'status changed in the database' };
    const c = item.cancel;
    const same = ev.status === 'cancelled' && ev.cancel_reason === c.reason &&
      (ev.cancel_reason_other ?? null) === c.reasonOther && ev.cancel_announced === c.announced;
    if (ev.status === 'cancelled' && !same) return { action: 'skip', why: 'already cancelled in the database' };
    return same ? { action: 'unchanged' } : { action: 'update' };
  }
  if (rep && rep.source === 'admin') return { action: 'skip', why: 'admin report' };
  if (ev && ev.status === 'cancelled') return { action: 'skip', why: 'cancelled in the database' };
  if (ev && ev.location !== null && item.location !== null &&
      (ev.location !== item.location || (ev.location_other ?? null) !== item.locationOther)) {
    warnings.push(`${item.date}: stored location kept (differs from the CSV)`);
  }
  if (!ev && !rep) return { action: 'create' };
  const eventSame = ev && ev.status === 'reported' && (ev.location !== null || item.location === null);
  const reportSame = rep && rep.source === item.source &&
    REPORT_FIELDS.every(([k, col]) => (rep[col] ?? null) === (item.report[k] ?? null));
  return eventSame && reportSame ? { action: 'unchanged' } : { action: rep ? 'update' : 'create' };
}

async function loadStored(db, dates) {
  const evs = await db.query(
    `select event_date::text as date, status, location, location_other, cancel_reason, cancel_reason_other, cancel_announced
       from public.events where event_date = any($1::date[])`, [dates]);
  const reps = await db.query(
    `select event_date::text as date, gives_asks_count, notes, bling_given, bling_details, source
       from public.event_reports where event_date = any($1::date[])`, [dates]);
  return {
    events: new Map(evs.rows.map((r) => [r.date, r])),
    reports: new Map(reps.rows.map((r) => [r.date, r])),
  };
}

async function write(db, item, ev, rep) {
  if (item.status === 'cancelled') {
    const c = item.cancel;
    await db.query(
      `insert into public.events (event_date, status, location, location_other, cancel_reason, cancel_reason_other, cancel_announced)
       values ($1::date, 'cancelled', $2, $3, $4, $5, $6)
       on conflict (event_date) do update
         set status = 'cancelled', cancel_reason = excluded.cancel_reason,
             cancel_reason_other = excluded.cancel_reason_other, cancel_announced = excluded.cancel_announced,
             location = coalesce(public.events.location, excluded.location),
             location_other = case when public.events.location is null then excluded.location_other
                                   else public.events.location_other end`,
      [item.date, item.location, item.locationOther, c.reason, c.reasonOther, c.announced]);
    return;
  }
  // Reported: the event (location only filled when unset), then the report.
  await db.query(
    `insert into public.events (event_date, status, location, location_other)
     values ($1::date, 'reported', $2, $3)
     on conflict (event_date) do update
       set status = 'reported',
           location = coalesce(public.events.location, excluded.location),
           location_other = case when public.events.location is null then excluded.location_other
                                 else public.events.location_other end`,
    [item.date, item.location, item.locationOther]);
  const r = item.report;
  await db.query(
    `insert into public.event_reports (event_date, gives_asks_count, notes, bling_given, bling_details, submitted_by, source)
     values ($1::date, $2, $3, $4, $5, null, $6)
     on conflict (event_date) do update
       set gives_asks_count = excluded.gives_asks_count, notes = excluded.notes,
           bling_given = excluded.bling_given, bling_details = excluded.bling_details,
           submitted_by = null, source = excluded.source
     where public.event_reports.source <> 'admin'`,
    [item.date, r.givesAsksCount, r.notes, r.blingGiven, r.blingDetails, item.source]);
}

// ── Output ───────────────────────────────────────────────────────────────────

function table(items) {
  const head = ['row', 'date', 'source', 'count', 'bling', 'location', 'cancel reason', 'action', 'fix'];
  const body = items.map((it) => [
    String(it.row), it.date, it.source,
    it.status === 'cancelled' ? 'CANCELLED' : it.report.givesAsksCount == null ? '' : String(it.report.givesAsksCount),
    it.report ? (it.report.blingGiven == null ? '' : it.report.blingGiven ? 'yes' : 'no') : '',
    it.location === 'other' ? 'other' : it.location ?? '',
    it.cancel ? `${it.cancel.reason} ← "${it.cancelText}"` : '',
    it.action ? `${it.action}${it.why ? ` (${it.why})` : ''}` : '',
    it.fix ?? '',
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const line = (r) => r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  return [line(head), line(widths.map((w) => '-'.repeat(w))), ...body.map(line)].join('\n');
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(argv, env, out = console) {
  const args = argv.filter((a) => !a.startsWith('--'));
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const unknown = [...flags].filter((f) => f !== '--apply');
  if (args.length !== 1 || !args[0] || unknown.length) {
    out.error('usage: import-google-form.js <form.csv> [--apply]');
    return 2;
  }
  const APPLY = flags.has('--apply');
  const mode = APPLY ? '[apply]' : '[dry-run]';
  const csvPath = args[0];

  let plan;
  try {
    plan = planImport(parseCsv(fs.readFileSync(csvPath, 'utf8')));
  } catch (err) {
    out.error(`${mode} ${err.message}`);
    return 1;
  }
  const { items, errors, warnings, info, fixes } = plan;

  const url = env.DATABASE_URL_UNPOOLED || env.DATABASE_URL;
  if (APPLY && !url) {
    out.error('Missing DATABASE_URL_UNPOOLED / DATABASE_URL (owner connection string).');
    return 1;
  }
  if (APPLY && errors.length) {
    errors.forEach((e) => out.error(`  ERROR ${e}`));
    out.error(`${mode} ${errors.length} error(s): nothing written. Fix the CSV and run again.`);
    return 1;
  }

  let client = null;
  const counts = { create: 0, update: 0, unchanged: 0, skip: 0 };
  try {
    if (url) {
      const { Client } = require('pg');
      const { toPgConfig } = require('../netlify/functions/utils/db-ssl');
      client = new Client(toPgConfig(url));
      await client.connect();
      if (APPLY) {
        await client.query('begin');
        // One import at a time, and no admin edit slips between the read and the write.
        await client.query('lock table public.events, public.event_reports in share row exclusive mode');
      }
      const stored = await loadStored(client, items.map((it) => it.date));
      for (const it of items) {
        const d = decide(it, stored.events.get(it.date), stored.reports.get(it.date), warnings);
        it.action = d.action;
        it.why = d.why;
        counts[d.action]++;
        if (APPLY && (d.action === 'create' || d.action === 'update')) {
          await write(client, it, stored.events.get(it.date), stored.reports.get(it.date));
        }
      }
      if (APPLY) {
        if (counts.create + counts.update > 0) {
          await client.query(
            `insert into public.audit_log (actor_user_id, action, target_table, target_id, details)
             values (null, 'event_report.import', 'event_reports', null, $1)`,
            [JSON.stringify({
              file: path.basename(csvPath),
              rows: items.length,
              created: counts.create,
              updated: counts.update,
              unchanged: counts.unchanged,
              skipped: counts.skip,
              fixes: fixes.length,
              dates: items.filter((it) => it.action === 'create' || it.action === 'update').map((it) => it.date),
            })]);
        }
        await client.query('commit');
      }
    }
  } catch (err) {
    if (client && APPLY) await client.query('rollback').catch(() => {});
    out.error(`${mode} failed: ${err.message}`);
    return 1;
  } finally {
    if (client) await client.end().catch(() => {});
  }

  const by = (pred) => items.filter(pred).length;
  out.log(table(items));
  out.log('');
  out.log(`${mode} rows: ${items.length + errors.length} | importable: ${items.length} | errors: ${errors.length}`);
  out.log(`${mode} source: google_form ${by((i) => i.source === 'google_form')}, pre_form ${by((i) => i.source === 'pre_form')}`);
  out.log(`${mode} status: reported ${by((i) => i.status === 'reported')}, cancelled ${by((i) => i.status === 'cancelled')}`);
  out.log(`${mode} bling: yes ${by((i) => i.report?.blingGiven === true)}, no ${by((i) => i.report?.blingGiven === false)}, blank ${by((i) => i.report && i.report.blingGiven == null)}`);
  out.log(`${mode} location: lobby ${by((i) => i.location === 'lobby')}, food_hall ${by((i) => i.location === 'food_hall')}, other ${by((i) => i.location === 'other')}, blank ${by((i) => i.location == null)}`);
  if (items.length) out.log(`${mode} dates: ${items[0].date} … ${items[items.length - 1].date}`);
  if (url) {
    out.log(`${mode} ${APPLY ? '' : 'would '}create ${counts.create}, ${APPLY ? '' : 'would '}update ${counts.update}, unchanged ${counts.unchanged}, skipped ${counts.skip}`);
  } else {
    out.log(`${mode} no DATABASE_URL: not compared with the database`);
  }
  const zero = items.filter((i) => i.report?.givesAsksCount === 0);
  out.log(`${mode} zero at Gives and Asks (imported as is): ${zero.length ? zero.map((i) => `${i.date} (row ${i.row})`).join(', ') : 'none'}`);
  out.log(`${mode} fixes: ${fixes.length}`);
  fixes.forEach((f) => out.log(`  FIX   ${f}`));
  out.log(`${mode} warnings: ${warnings.length}`);
  warnings.forEach((w) => out.log(`  WARN  ${w}`));
  out.log(`${mode} for information only (imported as is, no action needed): ${info.length}`);
  info.forEach((n) => out.log(`  INFO  ${n}`));
  if (errors.length) {
    out.log(`${mode} errors: ${errors.length}`);
    errors.forEach((e) => out.log(`  ERROR ${e}`));
    return 1;
  }
  return 0;
}

module.exports = { parseCsv, headerIndex, parseTimestamp, parseFormDate, parseCount, parseLocation, mapCancelReason, planImport, decide, main };

if (require.main === module) {
  main(process.argv.slice(2), process.env).then((code) => { process.exitCode = code; });
}
