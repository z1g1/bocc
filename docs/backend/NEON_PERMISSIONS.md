# Neon Permissions

Required roles, grants, and key handling for BOCC's Neon Postgres check-in store.
Follows the root `CLAUDE.md` policy: **least privilege, never the owner/admin credential
in the app, document the exact permissions, verify with the restricted role.**
Decision context: ADR 0003 (Postgres data model), ADR 0004 (streaks), ADR 0005 (Neon host).

- Project: `young-queen-80162551`, branch `production`, database `neondb`, region `us-east-2`
- Migrations: `backend/db/migrations/*.sql`, applied by `npm run migrate`

## Identities (principle of least privilege)

| Identity | Used by | Privileges | Where the credential lives |
|---|---|---|---|
| `checkin_writer` | check-in Netlify function; backfill script | `USAGE` on `public`; `SELECT, INSERT` on `attendees`, `checkins`; `SELECT` on `held_occurrences`, `streaks` | Netlify env `CHECKIN_DB_URL`; locally `.env.backfill` (gitignored, mode 600) |
| `neondb_owner` | operator only: `npm run migrate` | owner of schema objects, creates roles | local `.env.local` from `neon link` (gitignored). **Never in Netlify.** |
| Neon API key (project-scoped) | operator only: `neon` CLI | Editor on this one project, no org actions | `~/.config/neon/api-key` (mode 600), outside the repo. Revoke when idle. |

`checkin_writer` has **no** `UPDATE`, `DELETE`, DDL, or access to `schema_migrations`.
RLS is enabled on `attendees` and `checkins`, and both views are `security_invoker`,
so they run with the caller's grants. The browser never talks to Postgres; it POSTs
to `/.netlify/functions/checkin`.

## Connection

- Use the **pooled** endpoint (`ep-…-pooler.<region>.aws.neon.tech`). Netlify Functions
  open short-lived connections, and the pooler absorbs that churn.
- Format: `postgresql://checkin_writer:<hex-password>@ep-…-pooler.us-east-2.aws.neon.tech/neondb`
- Use a hex password (`openssl rand -hex 32`), so no URL-encoding is needed.
- Neon scales compute to zero after 5 idle minutes. The first connection after idle wakes it
  (a brief cold start). The project is **never paused for inactivity** on the free plan.

## TLS (verify-full, never disabled)

`netlify/functions/utils/db-ssl.js` sets `ssl: { rejectUnauthorized: true }` and verifies
Neon's publicly trusted certificate against Node's default trust store. Any `sslmode` in
the URL is stripped in code so the connection string can't weaken TLS. `DB_CA_CERT` (PEM)
is an optional override; a malformed value fails closed.

## Environment variables

| Var | Where | Purpose |
|---|---|---|
| `CHECKIN_DB_URL` | Netlify (required) | pooled `checkin_writer` URL |
| `CHECKIN_STORE` | Netlify (optional) | `postgres` (default) or `airtable` (rollback only) |
| `DB_POOL_MAX` | Netlify (optional) | pool size per function instance, default `1` |
| `DB_CA_CERT` | optional | PEM CA override |
| `DATABASE_URL`, `DATABASE_URL_UNPOOLED` | local `.env.local` only | owner, for migrations |

## Rotating the checkin_writer password

1. As owner: `alter role checkin_writer password '<new hex>';`
2. Update `CHECKIN_DB_URL` in Netlify, then trigger a redeploy (env changes need one).
3. Update or delete the local `.env.backfill`.

## Verification checklist

Run as `checkin_writer`. All verified 2026-09-12:

- [x] `select current_user` → `checkin_writer`
- [x] `select count(*) from attendees` / `from streaks` → succeeds
- [x] `insert into attendees …` → succeeds (test ran inside a rolled-back transaction)
- [x] `delete from checkins` → permission denied
- [x] `update attendees …` → permission denied
- [x] `select * from schema_migrations` → permission denied
- [x] `create table …` → permission denied for schema public
- [ ] Netlify env holds only `CHECKIN_DB_URL` (no owner URL, no Neon API key)
- [ ] `npm run backfill:verify` reports parity with Airtable
