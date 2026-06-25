# ADR 0003 — Move the transactional check-in store to Supabase Postgres

- **Status:** Accepted
- **Date:** 2026-06-25
- **Deciders:** Zack Glick

## Context

BOCC's transactional data (Attendees, Check-ins) lives in an Airtable base on the
**free plan: 1,000 records per base**, shared across `attendees`, `checkins`,
`No Photo Warnings`, and a new empty `streaks` table. Check-ins are the dominant,
unbounded consumer — at ~30 attendees/week a single event series produces
~1,500 check-in records/year, so the base is already showing "Reaching plan
limits."

This surfaced while designing **weekly check-in streaks** (see ADR 0004). Streaks
are a projection of check-in *history*: detecting a broken streak requires knowing
which weeks the event was *held* (≥1 non-debug check-in by anyone) and which the
attendee attended. On Airtable's free tier that history cannot be retained — it
must be pruned to stay under 1,000 records — which would force a fragile
"increment-only" streak model that can never be recomputed from source. We were
about to build a history-derived feature on a store that cannot keep history.

Constraints that shaped the choice:
- The check-in endpoint is **public and unauthenticated** (anyone who scans the QR
  checks in) and must tolerate concurrent submissions at event start.
- The volunteers' **event schedule** already lives in Google Sheets specifically
  because >5 people edit it (Airtable's free editor cap), and that is genuinely a
  good fit for human-edited, low-frequency data.
- Circle sync, Eventbrite checkout, and the enforcement flow are independent of
  where check-ins are stored.

## Decision

Move the **transactional store** — `attendees`, `checkins`, and the derived
`occurrences`/`streaks` data — to **Supabase Postgres**. Specifically:

1. **Postgres for transactional + derived data.** 500 MB free ≈ millions of
   check-ins; history is retained, so streaks become a **recomputable SQL
   projection** (gaps-and-islands over check-ins) rather than an increment-only
   counter. The occurrence calendar becomes `SELECT DISTINCT date_trunc('week',
   …)` (optionally a materialized view), with no separately maintained table.
2. **Google Sheets stays the event *schedule*** — human-edited, low-frequency,
   many editors. It is the future *authoritative occurrence source* that can feed
   Postgres without changing streak math.
3. **Phased rollout, foundation-first:** (1) stand up the Postgres schema, migrate
   the check-in write path, backfill existing Airtable data, cut over the live
   endpoint with parity tests; (2) add streaks + celebration; (3) reminders.
4. **Least-privilege DB identity (RBAC from day one).** A dedicated Postgres role
   (e.g. `checkin_writer`) with explicit GRANTs for only the operations the
   function needs (SELECT/INSERT/UPDATE on the check-in tables; no DELETE, no DDL,
   no other schemas). RLS enabled and **deny-by-default** so the anon key can
   touch nothing. The Netlify function holds a **server-only** key; the browser
   never talks to Supabase directly. Required grants are documented in
   `docs/backend/SUPABASE_PERMISSIONS.md`. The `service_role` key is **not** used —
   it bypasses RLS and is the "full admin key" our security policy forbids.

## Alternatives considered

- **Stay on Airtable free + incremental streaks.** Build streaks with an
  increment-only counter plus a durable occurrence calendar, pruning check-ins to
  stay under the cap. Ships fastest with no migration, but knowingly builds on a
  store that hits the wall, and limits recomputability to the retained window.
  Rejected: it fixes the symptom (streaks) while leaving the foundation (check-in
  capacity) broken.
- **Upgrade Airtable to Team (~50k records).** Removes the cap with no migration,
  but keeps the weaker query model — streaks would still be computed in
  application code rather than SQL window functions — and adds recurring cost.
- **Google Sheets for check-ins too.** Rejected: Sheets is a poor transactional
  store — append races under concurrent check-ins, API write quotas, no indexes,
  full-scan dedup. Good for the schedule, wrong for the hot path.
- **Other Postgres hosts (Neon, Cloudflare D1, Firestore).** Viable, but Supabase
  is already connected to this project, gives Postgres (ideal for gaps-and-islands
  streaks) plus `pg_cron`/edge functions for the later reminders, and is a stable,
  supported platform.
- **`service_role` key for the function.** Simplest Supabase pattern, rejected as
  the day-one default — it bypasses RLS and violates least-privilege.

## Consequences

- The 1,000-record wall is removed; check-in history is retained, so **streaks are
  recomputable from source** and the increment-only workaround is dropped.
- The backend gains a new storage adapter behind the existing `utils/airtable.js`
  seam. During Phase 1 the check-in use-case (`utils/check-in.js`) is repointed at
  Postgres; its discriminated result contract is unchanged.
- A **one-time backfill** of existing Airtable attendees + check-ins into Postgres
  is required; it doubles as the seed for the initial streak backport.
- `CONTEXT.md` domain terms that currently say "the Airtable `attendees`/`checkins`
  table" will be updated to the Postgres tables as Phase 1 lands. **`No Photo
  Warnings` stays in Airtable for now** — it belongs to the Circle enforcement
  flow, not the check-in path, and is small.
- New required secret: a server-only Supabase connection/key for the scoped role
  (set in Netlify, never committed), plus `docs/backend/SUPABASE_PERMISSIONS.md`.
- A public, unauthenticated write endpoint now reaches Postgres — input validation,
  the honeypot, and same-day dedup remain the front line, and RLS + the scoped
  role bound the blast radius of the function's identity.
