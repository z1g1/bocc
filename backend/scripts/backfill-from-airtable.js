#!/usr/bin/env node
/**
 * One-time backfill: Airtable → Neon Postgres (ADR 0003 / ADR 0005).
 *
 * Copies the existing `attendees` and `checkins` into Postgres, preserving the
 * Airtable record id in `legacy_airtable_id` for provenance and idempotency.
 * Re-runnable: every insert is ON CONFLICT DO NOTHING, so running twice is safe
 * and a second run is a no-op. This same import also seeds the streak history —
 * there is no separate backport step (the streak views recompute from it).
 *
 * Runs as the least-privilege `checkin_writer` role (SELECT/INSERT is all it needs).
 *
 * Usage (from backend/; keep secrets in a gitignored env file):
 *   node --env-file=../.env.backfill scripts/backfill-from-airtable.js --dry-run  # counts only
 *   node --env-file=../.env.backfill scripts/backfill-from-airtable.js            # write
 *   node --env-file=../.env.backfill scripts/backfill-from-airtable.js --verify   # parity report
 *
 * Required env (read directly — this script does not need Circle config):
 *   AIRTABLE_API_KEY, AIRTABLE_BASE_ID, CHECKIN_DB_URL
 */

const Airtable = require('airtable');
const { Pool } = require('pg');
const { easternCheckinDate } = require('../netlify/functions/utils/eastern-week');
const { toPgConfig } = require('../netlify/functions/utils/db-ssl');

const DRY_RUN = process.argv.includes('--dry-run');
const VERIFY = process.argv.includes('--verify');

const required = ['AIRTABLE_API_KEY', 'AIRTABLE_BASE_ID', 'CHECKIN_DB_URL'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required env: ${missing.join(', ')}`);
  process.exit(1);
}

const asBool = (v) => v === true || v === 1 || v === '1' || v === 'true';
const norm = (s) => (s || '').toString().trim();

const airtable = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
const pg = new Pool(toPgConfig(process.env.CHECKIN_DB_URL, { max: 1 }));

const mode = VERIFY ? '[verify]' : DRY_RUN ? '[dry-run]' : '[backfill]';
const log = (...args) => console.log(mode, ...args);

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

async function backfillCheckins(records, recordIdToEmail) {
  // Resolve each check-in's attendee by EMAIL (the natural key), not by Airtable
  // record id. This collapses duplicate-email attendee records to one Postgres
  // attendee, so their check-ins are never orphaned. See ADR 0003 / CONTEXT.md
  // ("Attendee identified by email").
  const emailToId = new Map();
  if (!DRY_RUN) {
    const { rows } = await pg.query('select id, email from attendees');
    rows.forEach((row) => emailToId.set(row.email, row.id));
  }

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
      console.warn(`  skip checkin ${r.id}: missing attendee link, eventId, or timestamp`);
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

/**
 * Parity report: every Airtable record should be in Postgres by legacy id, except
 * (a) attendees that collapsed into an earlier record with the same email, and
 * (b) check-ins that were same-day duplicates of one already imported.
 * Exits non-zero if anything is unexplained.
 */
async function verify(attendeeRecords, checkinRecords) {
  const legacyIds = async (table) => new Set(
    (await pg.query(`select legacy_airtable_id from ${table} where legacy_airtable_id is not null`))
      .rows.map((r) => r.legacy_airtable_id)
  );
  const pgAttendeeIds = await legacyIds('attendees');
  const pgCheckinIds = await legacyIds('checkins');
  const { rows: [counts] } = await pg.query(
    'select (select count(*) from attendees) as attendees, (select count(*) from checkins) as checkins'
  );
  const pgEmails = new Set((await pg.query('select email from attendees')).rows.map((r) => r.email));

  const missingAttendees = attendeeRecords.filter((r) => {
    if (pgAttendeeIds.has(r.id)) return false;
    const email = norm(r.get('email')).toLowerCase();
    return !email || !pgEmails.has(email); // same-email duplicates are expected collapses
  });
  const missingCheckins = checkinRecords.filter((r) => !pgCheckinIds.has(r.id));

  log(`Airtable attendees: ${attendeeRecords.length} | Postgres attendees: ${counts.attendees}`);
  log(`Airtable checkins:  ${checkinRecords.length} | Postgres checkins:  ${counts.checkins}`);
  log(`attendees not in Postgres (excluding same-email collapses): ${missingAttendees.length}`);
  missingAttendees.forEach((r) => console.log(`    attendee ${r.id} email=${norm(r.get('email')) || '(none)'}`));
  log(`checkins not in Postgres by legacy id: ${missingCheckins.length}` +
      ' (same-day duplicates and skipped rows appear here)');
  missingCheckins.forEach((r) => console.log(
    `    checkin ${r.id} eventId=${norm(r.get('eventId'))} date=${r.get('checkinDate') || '(none)'}`
  ));

  if (missingAttendees.length || missingCheckins.length) process.exitCode = 2;
}

(async () => {
  try {
    log(`starting${DRY_RUN ? ' (no writes)' : ''}`);
    // Fetch once; build Airtable record id -> email so check-ins can resolve
    // their attendee by email even when duplicate records exist.
    const attendeeRecords = await airtable('attendees').select().all();
    const checkinRecords = await airtable('checkins').select().all();
    const recordIdToEmail = new Map();
    for (const r of attendeeRecords) {
      const email = norm(r.get('email')).toLowerCase();
      if (email) recordIdToEmail.set(r.id, email);
    }

    if (VERIFY) {
      await verify(attendeeRecords, checkinRecords);
    } else {
      await backfillAttendees(attendeeRecords);
      await backfillCheckins(checkinRecords, recordIdToEmail);
    }
    log('done');
  } catch (err) {
    console.error('Backfill failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pg.end();
  }
})();
