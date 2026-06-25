#!/usr/bin/env node
/**
 * One-time backfill: Airtable → Supabase Postgres (ADR 0003, Phase 1).
 *
 * Copies the existing `attendees` and `checkins` into Postgres, preserving the
 * Airtable record id in `legacy_airtable_id` for provenance and idempotency.
 * Re-runnable: every insert is ON CONFLICT DO NOTHING, so running twice is safe
 * and a second run is a no-op. This same import also seeds the streak history —
 * there is no separate backport step (the streak views recompute from it).
 *
 * Usage:
 *   node scripts/backfill-from-airtable.js --dry-run   # counts only, no writes
 *   node scripts/backfill-from-airtable.js             # perform the backfill
 *
 * Required env (read directly — this script does not need Circle config):
 *   AIRTABLE_API_KEY, AIRTABLE_BASE_ID, SUPABASE_CHECKIN_WRITER_URL
 */

const Airtable = require('airtable');
const { Pool } = require('pg');
const { easternCheckinDate } = require('../netlify/functions/utils/eastern-week');

const DRY_RUN = process.argv.includes('--dry-run');

const required = ['AIRTABLE_API_KEY', 'AIRTABLE_BASE_ID', 'SUPABASE_CHECKIN_WRITER_URL'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required env: ${missing.join(', ')}`);
  process.exit(1);
}

const asBool = (v) => v === true || v === 1 || v === '1' || v === 'true';
const norm = (s) => (s || '').toString().trim();

const airtable = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
const pg = new Pool({ connectionString: process.env.SUPABASE_CHECKIN_WRITER_URL, max: 1 });

const log = (...args) => console.log(DRY_RUN ? '[dry-run]' : '[backfill]', ...args);

async function backfillAttendees() {
  const records = await airtable('attendees').select().all();
  log(`attendees in Airtable: ${records.length}`);
  let written = 0;

  for (const r of records) {
    const email = norm(r.get('email')).toLowerCase();
    if (!email) {
      console.warn(`  skip attendee ${r.id}: no email`);
      continue;
    }
    if (DRY_RUN) { written++; continue; }

    const res = await pg.query(
      `insert into attendees (email, name, phone, business_name, ok_to_email, debug, legacy_airtable_id)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict do nothing
       returning id`,
      [
        email,
        norm(r.get('name')),
        norm(r.get('phone')) || null,
        norm(r.get('businessName')) || null,
        asBool(r.get('okToEmail')),
        asBool(r.get('debug')),
        r.id,
      ]
    );
    if (res.rows.length) written++;
  }
  log(`attendees ${DRY_RUN ? 'would write' : 'written'}: ${written}`);
}

async function backfillCheckins() {
  // Map Airtable attendee record id -> Postgres attendee id (via legacy_airtable_id).
  const map = new Map();
  if (!DRY_RUN) {
    const { rows } = await pg.query(
      'select id, legacy_airtable_id from attendees where legacy_airtable_id is not null'
    );
    rows.forEach((row) => map.set(row.legacy_airtable_id, row.id));
  }

  const records = await airtable('checkins').select().all();
  log(`checkins in Airtable: ${records.length}`);
  let written = 0;
  let skipped = 0;

  for (const r of records) {
    const linked = r.get('Attendee'); // array of Airtable attendee record ids
    const airtableAttendeeId = Array.isArray(linked) ? linked[0] : null;
    const eventId = norm(r.get('eventId'));
    const ts = r.get('checkinDate') || r._rawJson?.createdTime;

    if (!airtableAttendeeId || !eventId || !ts) {
      skipped++;
      continue;
    }
    if (DRY_RUN) { written++; continue; }

    const attendeeId = map.get(airtableAttendeeId);
    if (!attendeeId) {
      console.warn(`  skip checkin ${r.id}: attendee ${airtableAttendeeId} not in Postgres`);
      skipped++;
      continue;
    }

    const res = await pg.query(
      `insert into checkins (attendee_id, event_id, token, checkin_at, checkin_date, debug, legacy_airtable_id)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict do nothing
       returning id`,
      [
        attendeeId,
        eventId,
        norm(r.get('token')) || null,
        new Date(ts).toISOString(),
        easternCheckinDate(new Date(ts)),
        asBool(r.get('debug')),
        r.id,
      ]
    );
    if (res.rows.length) written++;
  }
  log(`checkins ${DRY_RUN ? 'would write' : 'written'}: ${written}, skipped: ${skipped}`);
}

(async () => {
  try {
    log(`starting${DRY_RUN ? ' (no writes)' : ''}`);
    await backfillAttendees();
    await backfillCheckins();
    log('done');
  } catch (err) {
    console.error('Backfill failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pg.end();
  }
})();
