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

module.exports = { planLedger };
