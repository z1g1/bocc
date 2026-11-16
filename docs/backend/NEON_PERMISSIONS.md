# Neon Permissions

Required roles, grants, and key handling for BOCC's Neon Postgres check-in store.
Follows the root `CLAUDE.md` policy: **least privilege, never the owner/admin credential
in the app, document the exact permissions, verify with the restricted role.**
Decision context: ADR 0003 (Postgres data model), ADR 0004 (streaks), ADR 0005 (Neon host),
ADR 0008 (admin login, roles and the `admin_app` identity).

- Project: `young-queen-80162551`, branch `production`, database `neondb`, region `us-east-2`
- Migrations: `backend/db/migrations/*.sql`, applied by `npm run migrate`

## Identities (principle of least privilege)

| Identity | Used by | Privileges | Where the credential lives |
|---|---|---|---|
| `checkin_writer` | check-in Netlify function; backfill script | `USAGE` on `public`; `SELECT, INSERT` on `attendees`, `checkins`; `SELECT` on `held_occurrences`, `streaks` | Netlify env `CHECKIN_DB_URL`; locally `.env.backfill` (gitignored, mode 600) |
| `admin_app` | admin app (`/admin/*`, `/api/admin/*`) and Better Auth (`/api/auth/*`), in the Astro SSR function; the `create-admin` CLI | see "admin_app" below | Netlify env `ADMIN_DB_URL`; locally `.env.admin` (gitignored, mode 600) |
| `neondb_owner` | operator only: `npm run migrate` | owner of schema objects, creates roles | local `.env.local` from `neon link` (gitignored). **Never in Netlify.** |
| Neon API key (project-scoped) | operator only: `neon` CLI | Editor on this one project, no org actions | `~/.config/neon/api-key` (mode 600), outside the repo. Revoke when idle. |

`checkin_writer` has **no** `UPDATE`, `DELETE`, DDL, or access to `schema_migrations`.
RLS is enabled on `attendees` and `checkins`, and both views are `security_invoker`,
so they run with the caller's grants. The browser never talks to Postgres; it POSTs
to `/.netlify/functions/checkin`. `checkin_writer` has no access to the `auth` schema,
`user_roles` or `audit_log` (migration `20261116120000_admin_auth.sql` revokes them from
`public`).

### admin_app

Created `NOLOGIN NOINHERIT` by migration `20261116120000_admin_auth.sql`; the operator gives it
`LOGIN` and a password out of band (below). Its grants, exactly:

| Object | Privileges |
|---|---|
| schema `auth` | `USAGE` |
| all tables in `auth` (Better Auth: `user`, `session`, `account`, `verification`, `passkey`, `rateLimit`) | `SELECT, INSERT, UPDATE, DELETE` (no DDL; tables added to `auth` later need their own grant) |
| schema `public` | `USAGE` |
| `attendees`, `checkins`, `held_occurrences`, `streaks` | `SELECT` |
| `attendees` columns `ok_to_email`, `name`, `business_name`, `phone` | `UPDATE` (no other column) |
| `user_roles` | `SELECT, INSERT, DELETE` (no `UPDATE`) |
| `audit_log` | `SELECT, INSERT`; `USAGE` on `audit_log_id_seq` |

RLS policies `admin_app_select` (attendees, checkins) and `admin_app_update` (attendees) let it
see every row; there is deliberately no INSERT or DELETE policy. It has **no** `INSERT` or
`DELETE` on attendee or check-in data, no DDL and no `schema_migrations`. `audit_log` is
append-only twice over: no `UPDATE`/`DELETE`/`TRUNCATE` grant, and a trigger refuses those
statements even for the owner. Roles live only in `user_roles`; the Better Auth admin plugin's
`role` column is never read.

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
| `DB_POOL_MAX` | Netlify (optional) | pool size per function instance, default `1` |
| `DB_CA_CERT` | optional | PEM CA override |
| `DATABASE_URL`, `DATABASE_URL_UNPOOLED` | local `.env.local` only | owner, for migrations |
| `ADMIN_DB_URL` | Netlify (required for the admin app) | pooled `admin_app` URL |
| `BETTER_AUTH_SECRET` | Netlify (required for the admin app) | at least 32 characters (`openssl rand -hex 32`); signs session cookies. Its own value per context |
| `BETTER_AUTH_URL` | Netlify (required for the admin app) | the site origin, no path. Production `https://716coffee.club`; Branch deploys `https://dev--bocc-backend.netlify.app`; local `http://localhost:4321`. Passkeys (`rpID`) and the admin CSRF check are bound to it |
| `ADMIN_DB_POOL_MAX` | Netlify (optional) | `admin_app` pool size per function instance, default `3` |

The four admin variables are read only by on-demand admin routes and the `create-admin` CLI
(`src/lib/auth/env.mjs` fails fast listing every missing one). The static build and the
check-in function need none of them. Locally they live in the gitignored `.env.admin` (mode
600), read by `npm run dev:admin` and `npm run create-admin`.

**Netlify contexts.** Free plans can't narrow a variable's scopes or give the `dev` branch its
own value (Netlify reserves `dev` as a keyword). So each admin variable gets a **Production**
value and a **Branch deploys** value, and the same non-production values go in **Deploy
Previews**. A deploy preview has its own host, so login won't work there (the origin check and
passkeys are bound to `BETTER_AUTH_URL`); staging is the `dev` branch deploy. No non-production
context ever holds the production `ADMIN_DB_URL` or `BETTER_AUTH_SECRET`.

## Rotating the checkin_writer password

1. As owner: `alter role checkin_writer password '<new hex>';`
2. Update `CHECKIN_DB_URL` in Netlify, then trigger a redeploy (env changes need one).
3. Update or delete the local `.env.backfill`.

## Rotating the admin_app password

1. As owner, on the branch concerned (`production` or `dev`, never both with one value):
   `alter role admin_app password '<new hex>';`
2. Update that context's `ADMIN_DB_URL` in Netlify (Production, or Branch deploys + Deploy
   Previews), then trigger a redeploy (env changes need one).
3. Update the local `.env.admin` if it points at that branch.

Existing login sessions are unaffected (they live in `auth.session`). Rotating
`BETTER_AUTH_SECRET` is separate: it invalidates every session cookie, so everyone signs in again.

## Staging: the `dev` branch

Staging is a Neon `dev` branch copied from `production`, served to the `dev` Netlify branch
deploy (see `docs/admin/ADMIN_APP_PLAN.md`). It holds real attendee data, so it gets the same
care as production.

**Passwords.** On the free plan a new branch starts with its parent's role passwords
("the branch will have the same Postgres roles and passwords as the parent branch",
https://neon.com/docs/manage/branches). Leaving them would put production credentials in
staging. Tested 2026-11-16 on throwaway branches:
- `ALTER ROLE … PASSWORD` on a child branch leaves the parent's password unchanged.
- A "reset from parent" **keeps** the child's own password. The reset docs don't promise this,
  so the check below runs after every reset anyway.

When `dev` is created, run once as `neondb_owner` **on `dev`**, with a fresh
`openssl rand -hex 32` for each role:

```sql
alter role checkin_writer password '<new hex>';
```

**admin_app on `dev`.** The role only exists once migration `20261116120000_admin_auth.sql` has
run on the branch, and it is created `NOLOGIN`. So after `npm run migrate` against `dev`, run
once as `neondb_owner` **on `dev`**, with its own `openssl rand -hex 32` (never production's):

```sql
alter role admin_app login password '<new hex>';
```

This is a one-time step: a reset from parent keeps the child's own password (tested above).
Production gets the same statement with a different password after its own migration. Until
production has been migrated, don't reset `dev`: the reset would take `dev` back to a schema
without the admin tables, and you would migrate and set the password again.

Put the pooled `dev` URL in Netlify as the **Branch deploys** and **Deploy Previews** values of
`CHECKIN_DB_URL` (Production keeps its own). Netlify reserves `dev` as a keyword, so it can't
have a branch-specific value, and Free plans can't narrow variable scopes; both are fine, since
no non-production deploy should hold the production credential. Never print the URL.
Done 2026-11-16 (Neon `dev` branch created, `checkin_writer` rotated there; a debug check-in
from the `dev` deploy landed on `dev` and not on production).

After any reset of `dev`, check that production's `checkin_writer` **and `admin_app`** passwords
are refused on `dev` (expect `28P01 password authentication failed`). If either is accepted, run
its `alter role` statement again.

**Object Storage.** A storage credential "is scoped to a branch and valid for that branch and
all its descendants" (https://neon.com/docs/storage/authentication). A production credential
therefore also works on `dev`, so staging gets **its own credential, created on `dev`**, and
production's is never given to the `dev` deploy.

**Shared limits.** `dev` uses the same 100 CU-hours and 5 GB of transfer a month as production.
If staging uses them up, production's compute is suspended too (SQLSTATE `53000`).

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

Run as `checkin_writer` once `20261116120000_admin_auth.sql` is applied (on `dev`, then
`production`):

- [ ] `select * from auth."user"` → permission denied for schema auth
- [ ] `select * from user_roles` / `from audit_log` → permission denied

Run as `admin_app` on `dev`, then on `production`, inside `begin; … rollback;`:

- [ ] `select current_user` → `admin_app`
- [ ] `select count(*) from attendees` / `checkins` / `streaks` / `auth."user"` → succeeds
- [ ] `update attendees set name = name where false` → succeeds;
      `update attendees set email = email where false` → permission denied
- [ ] `insert into attendees (email) values ('x@example.com')` → permission denied
- [ ] `delete from attendees` / `delete from checkins` → permission denied
- [ ] `insert into audit_log (action) values ('verify')` and `select … from audit_log` → succeed
- [ ] `update audit_log set action = 'x'` / `delete from audit_log` / `truncate audit_log` →
      permission denied (and the trigger stops even the owner)
- [ ] `update user_roles set role = role` → permission denied
- [ ] `select * from schema_migrations` → permission denied; `create table t (x int)` →
      permission denied for schema public
- [ ] Netlify holds only `ADMIN_DB_URL` for the admin app's database access (no owner URL)

`npm run test:db` asserts all of the above against a throwaway Postgres with the real
migrations (`tests/admin/permissions.test.mjs`); this list is for the real Neon branches.
