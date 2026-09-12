# ADR 0005 — Host the check-in store on Neon instead of Supabase

- **Status:** Accepted
- **Date:** 2026-09-12
- **Deciders:** Zack Glick
- **Supersedes:** the *hosting* choice in ADR 0003. The Postgres data model, least-privilege
  role, and streak design from ADRs 0003/0004 are unchanged.

## Context

ADR 0003 moved attendees and check-ins from Airtable to Postgres, choosing Supabase as the
host. The code shipped behind a `CHECKIN_STORE` flag, but the cutover never happened:

- **Supabase's free plan pauses projects after ~7 days of low database activity.** BOCC
  is a weekly event, so the gap between one Tuesday and the next sits right at the
  threshold. The `bocc-data` project was paused just before events and needed a manual restore.
  A keep-alive cron is a workaround that depends on an undocumented activity threshold.
- Meanwhile the Airtable free base hit its 1,000-record cap, and **the week of
  2026-09-08's check-ins were not recorded.** Waiting was no longer an option.

## Decision

Host the check-in store on **Neon Postgres** (free plan, project `young-queen-80162551`):

1. **Idle behavior fits a weekly workload.** Neon scales compute to zero after 5 idle
   minutes and wakes it automatically on the next connection. There is no project-level
   inactivity pause.
2. **Nothing Supabase-specific was in use.** The adapter speaks plain Postgres through
   `pg`, and the migrations already guarded the Supabase-only roles. The move is a rename
   (`supabase-store` → `pg-store`) plus a TLS helper, with the SQL unchanged.
3. **Cut straight to Postgres.** Airtable can't accept writes, so the `dual`
   verification mode is retired. `CHECKIN_STORE` defaults to `postgres`, and `airtable`
   stays only as a rollback path. Parity is proven by `backfill --verify` instead of a
   dual-write week.
4. **Same least-privilege model:** the `checkin_writer` role has SELECT/INSERT only, and
   the owner credential is operator-only, never in Netlify. TLS is verify-full, and
   `sslmode` is stripped from URLs in code. See `docs/backend/NEON_PERMISSIONS.md`.

## Alternatives considered

- **Supabase + keep-alive scheduled query.** Least code, but it relies on Supabase counting
  synthetic queries as "user activity" (not documented) and adds a job whose silent
  failure takes check-in down.
- **Turso (libSQL/SQLite).** Always on, generous free tier. It would mean rewriting the
  adapter, the migrations, and the gaps-and-islands streak views in SQLite, and replacing
  role-based access control.
- **Netlify DB** (Neon under the hood, GA April 2026). Same engine, but billed from the
  Netlify credit pool, which build minutes already strain (15 credits/deploy of 300).
- **Upgrade Airtable.** Recurring cost and a weaker query model (see ADR 0003).

## Consequences

- The first check-in after an idle period pays a compute cold start (well under the
  handler's timeout). An optional Tuesday-morning warm-up can remove it.
- Free plan limits: 0.5 GB storage, 100 CU-hours/month. At ~1,500 check-ins/year that is
  decades of headroom.
- Point-in-time restore on the free plan covers only 6 hours. Take periodic logical
  backups (`pg_dump` as owner) if long-range recovery matters.
- `No Photo Warnings` stays in Airtable until the planned move off Circle retires
  enforcement. The Airtable base remains read-only for check-in history.
- The paused Supabase `bocc-data` project can be deleted after Neon has served one event.
