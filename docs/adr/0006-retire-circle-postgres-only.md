# ADR 0006 — Retire Circle; Postgres is the only data store

- **Status:** Accepted
- **Date:** 2026-11-07
- **Deciders:** Zack Glick
- **Supersedes:** ADR 0002 (the enforcement endpoints no longer exist) and the `airtable`
  rollback mode from ADR 0005.

## Context

The Circle.so subscription behind the 716.social community has ended. Until now every real
check-in called Circle (invite the attendee, bump a counter), and a weekly job used Circle to
find members without profile photos, DM them, and deactivate repeat offenders. That job kept
its warning records in Airtable.

## Decision

- **No code talks to Circle.** The Circle clients, the check-in sync, and the Circle secrets
  are removed.
- **Profile photo enforcement is removed**, including the weekly cron and manual endpoint. It
  only ever acted on Circle members, so it has nothing left to act on. The Airtable warning
  code goes with it.
- **Neon Postgres is the only place new data is written.** The `CHECKIN_STORE` flag and the
  Airtable check-in path are removed. The Airtable base was already full, so that rollback
  could not record anything. `CHECKIN_DB_URL` is now the only required secret.
- **The website stops sending people to 716.social:** the post-check-in redirect points to
  716coffee.club (`website/_data/sponsor.yml`), the footer link is gone, and the privacy policy
  no longer describes community invites.

## Consequences

- A check-in now has no third-party dependency beyond Neon, and no longer sends attendee
  names or emails to an outside service.
- The Airtable base remains a read-only archive. `scripts/backfill-from-airtable.js` is kept
  for reference and parity checks, so `airtable` is a backend dev dependency only.
- `attendees.ok_to_email` in Postgres is now the record of who agreed to hear from BOCC.
- The removed code stays in git history if a community platform returns. A replacement would
  be a new decision, not a revert.
- Older docs in `docs/backend/` (epics, stories, tasks, summaries) describe the Circle era.
  They are left as history and do not reflect the current system.
