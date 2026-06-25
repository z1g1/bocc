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
const { getSslConfig } = require('../netlify/functions/utils/supabase-ssl');

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
const pg = new Pool({
  connectionString: process.env.SUPABASE_CHECKIN_WRITER_URL,
  max: 1,
  ssl: getSslConfig(),
});

const log = (...args) => console.log(DRY_RUN ? '[dry-run]' : '[backfill]', ...args);

async function backfillAttendees(records) {
  log(`attendees in Airtable: ${records.length}`);
  let written = 0;
  let noEmail = 0;

  for (const r of records) {
    const email = norm(r.get('email')).toLowerCase();
    if (!email) { noEmail++; continue; }
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
  log(`attendees ${DRY_RUN ? 'would write' : 'written'}: ${written}` +
      (noEmail ? `, no-email skipped: ${noEmail}` : ''));
}

async function backfillCheckins(recordIdToEmail) {
  // Resolve each check-in's attendee by EMAIL (the natural key), not by Airtable
  // record id. This collapses duplicate-email attendee records to one Postgres
  // attendee, so their check-ins are never orphaned. See ADR 0003 / CONTEXT.md
  // ("Attendee identified by email").
  const emailToId = new Map();
  if (!DRY_RUN) {
    const { rows } = await pg.query('select id, email from attendees');
    rows.forEach((row) => emailToId.set(row.email, row.id));
  }

  const records = await airtable('checkins').select().all();
  log(`checkins in Airtable: ${records.length}`);
  let written = 0;
  let missingData = 0;
  let unresolved = 0;

  for (const r of records) {
    const linked = r.get('Attendee'); // array of Airtable attendee record ids
    const airtableAttendeeId = Array.isArray(linked) ? linked[0] : null;
    const eventId = norm(r.get('eventId'));
    const ts = r.get('checkinDate') || r._rawJson?.createdTime;

    if (!airtableAttendeeId || !eventId || !ts) {
      missingData++;
      continue;
    }

    const email = recordIdToEmail.get(airtableAttendeeId);
    if (!email) {
      console.warn(`  skip checkin ${r.id}: linked attendee ${airtableAttendeeId} has no email/record`);
      unresolved++;
      continue;
    }
    if (DRY_RUN) { written++; continue; }

    const attendeeId = emailToId.get(email);
    if (!attendeeId) {
      console.warn(`  skip checkin ${r.id}: email ${email} not in Postgres attendees`);
      unresolved++;
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
  log(`checkins ${DRY_RUN ? 'would write' : 'written'}: ${written}, ` +
      `missing-data: ${missingData}, unresolved-attendee: ${unresolved}`);
}

(async () => {
  try {
    log(`starting${DRY_RUN ? ' (no writes)' : ''}`);
    // Fetch attendees once; build Airtable record id -> email so check-ins can
    // resolve their attendee by email even when duplicate records exist.
    const attendeeRecords = await airtable('attendees').select().all();
    const recordIdToEmail = new Map();
    for (const r of attendeeRecords) {
      const email = norm(r.get('email')).toLowerCase();
      if (email) recordIdToEmail.set(r.id, email);
    }

    await backfillAttendees(attendeeRecords);
    await backfillCheckins(recordIdToEmail);
    log('done');
  } catch (err) {
    console.error('Backfill failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pg.end();
  }
})();
