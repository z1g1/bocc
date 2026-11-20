# Neon Permissions

Required roles, grants, and key handling for BOCC's Neon Postgres check-in store.
Follows the root `CLAUDE.md` policy: **least privilege, never the owner/admin credential
in the app, document the exact permissions, verify with the restricted role.**
Decision context: ADR 0003 (Postgres data model), ADR 0004 (streaks), ADR 0005 (Neon host),
ADR 0008 (admin login, roles and the `admin_app` identity), ADR 0009 (events), ADR 0010 (media
in Neon Object Storage).

- Project: `young-queen-80162551`, branch `production`, database `neondb`, region `us-east-2`
- Migrations: `backend/db/migrations/*.sql`, applied by the "Migrate and deploy" GitHub workflow before each `dev`/`main` deploy ([DEPLOYS.md](DEPLOYS.md)); `npm run migrate` is the manual fallback

## Identities (principle of least privilege)

| Identity | Used by | Privileges | Where the credential lives |
|---|---|---|---|
| `checkin_writer` | check-in Netlify function; backfill script | `USAGE` on `public`; `SELECT, INSERT` on `attendees`, `checkins`; `SELECT` on `held_occurrences`, `streaks` | Netlify env `CHECKIN_DB_URL`; locally `.env.backfill` (gitignored, mode 600) |
| `admin_app` | admin app (`/admin/*`, `/api/admin/*`) and Better Auth (`/api/auth/*`), in the Astro SSR function; the `create-admin` CLI | see "admin_app" below | Netlify env `ADMIN_DB_URL`; locally `.env.admin` (gitignored, mode 600) |
| `site_reader` | public `/events/YYYY-MM-DD/` pages and `/sitemap.xml`, rendered on request in the Astro SSR function (ADR 0009 decision 4) | `USAGE` on `public`; `SELECT` on `events`, `event_links` only | Netlify env `SITE_DB_URL` (secret) |
| `social_checker` | the Thursday social check, a Netlify scheduled function (`backend/netlify/functions/social-check.mjs`, ADR 0011 decision 5) | `USAGE` on `public`; `SELECT` on `events`, `event_links`, `social_plans`, `social_media_posts`; `SELECT (id, event_date, kind, status)` on `event_media`; `SELECT (user_id, expires_at, display_name)` on `linkedin_authentications`; the same on the deprecated compatibility views `social_posts`, `social_post_channels`, `linkedin_connections` (see "Contract later"); nothing in `auth` | Netlify env `SOCIAL_CHECK_DB_URL` (secret) |
| `neondb_owner` | the "Migrate and deploy" workflow; operator fallback `npm run migrate` | owner of schema objects, creates roles | GitHub environment secret `NEON_OWNER_URL` (`dev`, `production`); locally `.env.local` from `neon link` (gitignored, points at production). **Never in Netlify.** |
| Storage credential (one per branch) | admin app: presigned media URLs (`src/lib/admin/storage.mjs`); `scripts/storage-cors.mjs` | `storage:read`, `storage:write` on the branch it was made on and its descendants. Not a Postgres role | Netlify env `STORAGE_ACCESS_KEY_ID` / `STORAGE_SECRET_ACCESS_KEY`; see "Storage" |
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
| `events`, `event_reports` | `SELECT, INSERT, UPDATE` (migration `20261118120000_events_media.sql`; covers `events.event_image_media_id`, the Event Image picked from a Photo from Event, migration `20261128120000_event_image_reference.sql`, no new grant) |
| `event_media` | `SELECT, INSERT, UPDATE, DELETE` (the app deletes the objects too; covers the Event Image kind and its 16:9 Event Image `image_16x9_key`, migration `20261125120000_event_image.sql`, and `image_16x9_outdated`, migration `20261202120000_event_media_cover_outdated.sql`, both renamed from `cover_*` by migration `20261203120000_glossary_rename_expand.sql`, no new grant) |
| `event_links` | `SELECT, INSERT, UPDATE, DELETE` (migration `20261121120000_event_links_site_reader.sql`; DELETE clears a wrong listing, recorded by its audit row: ADR 0008 decision 6, amended 2026-11-18) |
| `social_plans` (was `social_posts`), `social_media_posts` (was `social_post_channels`) | `SELECT, INSERT, UPDATE` (migration `20261122120000_social_posts.sql`, tables renamed by `20261203120000_glossary_rename_expand.sql`; no DELETE: a Social plan is never removed (set its Plan status back to To do instead); covers the Thumbnail `thumbnail_media_id` (was `cover_media_id`), migration `20261127120000_social_post_cover.sql`, no new grant, and the post `status` that replaced `ready`, migration `20261201120000_social_post_status.sql`, which restates the table grants and keeps the deprecated `ready` column for now: see "Contract later" below) |
| `linkedin_authentications` (was `linkedin_connections`) | `SELECT, INSERT, UPDATE, DELETE` (migration `20261124120000_linkedin_connections.sql`, renamed by `20261203120000_glossary_rename_expand.sql`, ADR 0012; one row per Admin's LinkedIn authentication, the access token AES-256-GCM encrypted under `LINKEDIN_TOKEN_KEY`; DELETE is Remove LinkedIn authentication) |
| `social_posts`, `social_post_channels`, `linkedin_connections` (views) | DEPRECATED compatibility views under the old table names, with the same privileges as their tables (see "Contract later: the glossary rename") |
| `linkedin_events` | `SELECT, INSERT, UPDATE` (migration `20261129120000_linkedin_events.sql`, ADR 0012; the LinkedIn event ledger. No DELETE: allow-retry *retires* a stuck `pending` row, which frees the date through a partial unique index on `event_date where status <> 'retired'`; a trigger allows only forward status moves. `post_claimed_at`, migration `20261130120000_linkedin_events_post_claim.sql`, is the one-Publish-at-a-time claim; no new grant) |

RLS policies `admin_app_select` (attendees, checkins) and `admin_app_update` (attendees) let it
see every row; there is deliberately no INSERT or DELETE policy. It has **no** `INSERT` or
`DELETE` on attendee or check-in data, no DDL and no `schema_migrations`. `audit_log` is
append-only twice over: no `UPDATE`/`DELETE`/`TRUNCATE` grant, and a trigger refuses those
statements even for the owner. Roles live only in `user_roles`; the Better Auth admin plugin's
`role` column is never read.

The Phase 3 tables (`events`, `event_reports`, `event_media`) have no RLS, like `user_roles` and
`audit_log`: their rows aren't split between users, so the grants are the whole policy. Nothing
else is granted on them: `checkin_writer` and `public` get nothing, and Supabase-style `anon` /
`authenticated` roles are revoked if they exist. `event_links` (Phase 4) is the same, plus
`site_reader`'s SELECT. `social_plans` and `social_media_posts` (Phase 5) are the same, with
no `site_reader` grant. `linkedin_authentications` (Phase 6) is granted to `admin_app` only:
`site_reader` and `checkin_writer` get nothing; `social_checker` gets a column grant on
`user_id`, `expires_at` and `display_name` only, for the Thursday expiry alert (migration
`20261126120000_social_checker_linkedin.sql`), never the token or member URN. The database holds only ciphertext; the key
is in Netlify env, never in Postgres. `linkedin_events` (Phase 6) is
`admin_app` only, and without DELETE.

**Contract later: `social_posts.ready`.** Migration `20261201120000_social_post_status.sql`
is expand-only: it adds and backfills `status` and drops the old `social_posts_ready_ck`, but
keeps the `ready` column (and the table grants that cover it), marked deprecated, so the code
live before the deploy keeps working between migrate and deploy. The current code never reads
or writes `ready`. A follow-up migration drops the column after the production release.
The glossary rename (below) carries `ready` through: it stays on `social_plans` and in the
`social_posts` view until #44 drops it.

**Contract later: the glossary rename.** Migration `20261203120000_glossary_rename_expand.sql`
(#50, parent #49) gives the schema GLOSSARY.md's names in one transaction:
`social_posts` -> `social_plans` (`cover_media_id` -> `thumbnail_media_id`, `cover_note` ->
`thumbnail_timecode`), `social_post_channels` -> `social_media_posts`, `linkedin_connections`
-> `linkedin_authentications`, `event_reports.gives_asks_count` -> `attendee_count`,
`event_media.cover_key` / `cover_outdated` -> `image_16x9_key` / `image_16x9_outdated`, and
it lets `events.status` be `reported` and `event_media.kind` be `event_photo`. Constraints, indexes and triggers are renamed to
match; grants follow the renamed tables, so every role keeps the same privileges. It is
expand-only, so the code live between migrate and deploy keeps working:

- **Views under the old table names**, exposing the old column names: `social_posts`,
  `social_post_channels` (`security_invoker`) and `linkedin_connections` (owner's rights,
  because an invoker view would need `social_checker` to read every column of the table,
  and it may read only `user_id`, `expires_at`, `display_name`; it also exposes `xmax`,
  which the old connect code reads). Each is a single-table view, so reads, writes, `ON
  CONFLICT` and `FOR UPDATE` pass through. Their grants are the tables' grants:
  `admin_app` `SELECT, INSERT, UPDATE` on the two social views and `SELECT, INSERT, UPDATE,
  DELETE` on `linkedin_connections`; `social_checker` `SELECT` on the two social views and
  `SELECT (user_id, expires_at, display_name)` on `linkedin_connections`; nothing for
  `site_reader` or `checkin_writer`.
- **Shadow columns** under the old names on the tables that keep theirs:
  `event_reports.gives_asks_count`, `event_media.cover_key`, `event_media.cover_outdated`. A
  BEFORE trigger keeps each equal to its new column, whichever one a statement writes. They
  are covered by `admin_app`'s table-level grants; `social_checker`'s `event_media` column
  grant doesn't include them.
- **Old values**: the `events.status` and `event_media.kind` CHECKs accept both the old and
  the new value. The value switch itself (backfill `held` -> `reported` and `social_photo`
  -> `event_photo`, plus a BEFORE trigger rewriting an old-value write for the old code)
  can't be aliased the way a name can: old code that filters on `held` would silently find
  nothing. So it ships as its own migration with the code that reads the new value (#51
  for `reported`, #54 for `event_photo`), in the same release.
- The LinkedIn token's associated data stays the literal `linkedin_connections:<user id>`
  (`src/lib/linkedin/crypto.mjs`), so stored tokens still decrypt.

After production runs the new code, a contract migration drops the three views, the shadow
columns, the compat triggers and their functions (`event_reports_glossary_compat`,
`event_media_glossary_compat`, and the value-mapping triggers #51 and #54 add), and tightens
the two CHECKs to the new values only (and drops `social_plans.ready` if #44 hasn't).

### site_reader

Created `NOLOGIN NOINHERIT` by migration `20261121120000_event_links_site_reader.sql`; the
operator gives it `LOGIN` and a password out of band, like `admin_app` (see "Staging" below).
Kept apart from `admin_app` so public traffic never holds the admin's credentials. Its grants,
exactly:

| Object | Privileges |
|---|---|
| schema `public` | `USAGE` |
| `events`, `event_links` | `SELECT` |

Nothing else: no reports, media, attendees, check-ins, `audit_log` or `auth`. The
table-level `SELECT` on `events` also covers `events.event_image_media_id` (Phase 6, the
Event Image picked from a Photo from Event). That is an opaque uuid: `site_reader` can't
read `event_media`, so it can't turn it into an object key, a URL or anything else, and the
public pages don't use it. Reviewed and kept (2026-11-19) rather than replaced by a column
grant that every new `events` column would then have to extend. Its URL
(`SITE_DB_URL`) is the **pooled** `site_reader` URL, its own value per Netlify context, marked
secret.

### social_checker

Created `NOLOGIN NOINHERIT` by migration `20261123120000_social_checker.sql`. The operator gives
it `LOGIN` and a password out of band, like `site_reader` (see "Staging" below).

It is used only by the Thursday social check, which reads the next Tuesday's work order and
sends an ntfy push (ADR 0011 decision 5, amended 2026-11-18). It is kept apart from
`admin_app` because the check only reads. A leaked `SOCIAL_CHECK_DB_URL` exposes the work
order and nothing else, and changes nothing.

Its grants, exactly:

| Object | Privileges |
|---|---|
| schema `public` | `USAGE` |
| `events`, `event_links`, `social_plans`, `social_media_posts` (and the deprecated views `social_posts`, `social_post_channels`) | `SELECT` (on `social_plans` this includes `status`, the Plan status, restated by migration `20261201120000_social_post_status.sql`: the Thursday check counts `ready`, `posted` and `error` as ready) |
| `event_media` columns `id`, `event_date`, `kind`, `status` | `SELECT` (enough to tell whether the attached promo video is ready; no object keys, sizes or uploader) |
| `linkedin_authentications` columns `user_id`, `expires_at`, `display_name` (and the same columns of the deprecated view `linkedin_connections`) | `SELECT` (the LinkedIn expiry alert, #24, names the LinkedIn authentication by its LinkedIn display name; never the token, member URN or scope) |

`events` table-wide includes `event_image_media_id` (Phase 6). With its `event_media` column
grant, `social_checker` can tell which photo row (date, kind, status) an event picked as its
Event Image, and nothing more: no object keys, sizes or uploader. Reviewed and kept
(2026-11-19): it is not sensitive and the check doesn't use it.

Nothing else: no attendees, check-ins, reports, `audit_log`, `user_roles`, nothing in the
`auth` schema (not even `USAGE`), and no writes. Its URL (`SOCIAL_CHECK_DB_URL`) is the **pooled** `social_checker` URL. It has its own
value per Netlify context and is marked secret.

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
| `ADMIN_DB_POOL_MAX` | Netlify (optional) | `admin_app` pool size per function instance, default `3`, minimum `2` (a password reset holds one connection while Better Auth uses another) |
| `SITE_DB_URL` | Netlify (required for the public `/events/YYYY-MM-DD/` pages and `/sitemap.xml`, ADR 0009) | pooled `site_reader` URL. Its own value per context, like `ADMIN_DB_URL`. Without it those pages answer 503 (no-store); the rest of the site is static and unaffected. Read only by `src/lib/site/db.mjs`, at first use |
| `SITE_DB_POOL_MAX` | Netlify (optional) | `site_reader` pool size per function instance, default `2`, from `1` to `10` |
| `SOCIAL_CHECK_DB_URL` | Netlify (required for the Thursday social check) | pooled `social_checker` URL, its own value per context, secret. If it is missing, the check logs the problem and pushes a "check failed" alert. Read only by `src/lib/social-alert/run.mjs` |
| `SOCIAL_ALERT_NTFY_TOPIC` | Netlify (optional; no alerts without it) | the private ntfy topic the Thursday check publishes to. **Secret**: anyone who knows it can read and post to it. Use a long random name (e.g. `bocc-` + `openssl rand -hex 16`), a different one per context. Never logged. Unset: the check logs and stops |
| `SOCIAL_ALERT_NTFY_SERVER` | Netlify (optional) | ntfy server, default `https://ntfy.sh`; https only. Not secret |
| `LINKEDIN_CLIENT_ID` | Netlify (both contexts; LinkedIn is off without the three) | the existing LinkedIn app's client id. Not secret |
| `LINKEDIN_CLIENT_SECRET` | Netlify (both contexts) | the LinkedIn app's client secret. **Secret**; sent only in the token request's body |
| `LINKEDIN_TOKEN_KEY` | Netlify (both contexts) | `openssl rand -hex 32` (or base64 of 32 bytes), a **different value per context**. **Secret**. Encrypts the stored LinkedIn tokens and signs the OAuth `state` cookie. Changing it makes every stored connection unreadable: everyone reconnects |
| `LINKEDIN_LIVE` | Netlify (**Production only**) | `1` lets the app call LinkedIn's write endpoints; unset everywhere else (dry run, ADR 0012 decision 5). Any other value fails fast |

| `STORAGE_ENDPOINT` | Netlify (optional; media is off without it) | the branch's S3 endpoint, see "Storage". Not secret |
| `STORAGE_BUCKET` | Netlify (optional) | `bocc-media`. Not secret |
| `STORAGE_REGION` | Netlify (optional) | `us-east-2` (the default). Not secret |
| `STORAGE_ACCESS_KEY_ID` | Netlify (optional) | the credential's `token_id` (`nak_live_…`) |
| `STORAGE_SECRET_ACCESS_KEY` | Netlify (optional) | the credential's `s3_secret_access_key` (`nsk_live_…`). **Secret** |
| `STORAGE_FORCE_PATH_STYLE` | Netlify (optional) | default `true`; leave unset (Neon is path-style only) |

The four admin variables are read only by on-demand admin routes and the `create-admin` CLI
(`src/lib/auth/env.mjs` fails fast listing every missing one). The static build and the
check-in function need none of them. Locally they live in the gitignored `.env.admin` (mode
600), read by `npm run dev:admin` and `npm run create-admin`.

The `LINKEDIN_*` variables are read by `src/lib/linkedin/env.mjs` at first use. With none set,
LinkedIn is simply off (the page says so). A partial or invalid set fails fast, listing every
problem by name, never by value. The OAuth redirect URL is `${BETTER_AUTH_URL}/api/admin/linkedin/callback`:
add `https://716coffee.club/api/admin/linkedin/callback` and
`https://dev--bocc-backend.netlify.app/api/admin/linkedin/callback` (and
`http://localhost:4321/api/admin/linkedin/callback` for local testing) to the LinkedIn app's
Authorized redirect URLs.

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

## Rotating the social_checker password, or the ntfy topic

1. As owner, on the branch concerned: `alter role social_checker password '<new hex>';`
2. Update that context's `SOCIAL_CHECK_DB_URL` in Netlify, then trigger a redeploy.

A new ntfy topic means a new `SOCIAL_ALERT_NTFY_TOPIC`, a redeploy, and subscribing to the new
topic in the ntfy app. Unsubscribe from the old one too: ntfy.sh keeps no access list, so a
leaked topic can only be retired.

## Rotating the site_reader password

1. As owner, on the branch concerned (`production` or `dev`, never both with one value):
   `alter role site_reader password '<new hex>';`
2. Update that context's `SITE_DB_URL` in Netlify, then trigger a redeploy. Until then the event
   pages answer 503 once their cached copies expire.

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

**site_reader on `dev`.** The same one-time step once migration
`20261121120000_event_links_site_reader.sql` has run on `dev` (the role is created `NOLOGIN`),
with its own `openssl rand -hex 32`; production gets a different password after its migration:

```sql
alter role site_reader login password '<new hex>';
```

**social_checker on `dev`.** The same one-time step once migration
`20261123120000_social_checker.sql` has run on `dev`, with its own `openssl rand -hex 32`
(production gets a different one):

```sql
alter role social_checker login password '<new hex>';
```

After any reset of `dev`, check that production's `checkin_writer`, `admin_app`, `site_reader`
**and `social_checker`** passwords are refused on `dev` (expect `28P01 password authentication failed`). If either is accepted, run
its `alter role` statement again.

**Object Storage.** A storage credential "is scoped to a branch and valid for that branch and
all its descendants" (https://neon.com/docs/storage/authentication). A production credential
therefore also works on `dev`, so staging gets **its own credential, created on `dev`**, and
production's is never given to the `dev` deploy. Buckets, CORS and the Netlify variables are under "Storage" below.

**Shared limits.** `dev` uses the same 100 CU-hours and 5 GB of transfer a month as production.
If staging uses them up, production's compute is suspended too (SQLSTATE `53000`).

## Storage (media bucket, ADR 0010)

One **private** bucket, `bocc-media`, per Neon branch that serves a deploy. There is no public
bucket. Browsers never hold a storage credential: the admin hands out presigned URLs for one
object and one method (PUT 5 minutes, GET 10 minutes by default), after checking the user's role
(`src/lib/admin/storage.mjs`). Object keys are built by the server
(`events/<date>/<uuid>/{original,display,thumb}.<ext>`), never from a filename.

| Branch | Bucket | `STORAGE_ENDPOINT` | Netlify context |
|---|---|---|---|
| `production` (`br-noisy-poetry-a5q2e3cd`) | `bocc-media` | `https://br-noisy-poetry-a5q2e3cd.storage.c-1.us-east-2.aws.neon.tech` | Production |
| `dev` (`br-falling-butterfly-a54mukj8`) | `bocc-media` | `https://br-falling-butterfly-a54mukj8.storage.c-1.us-east-2.aws.neon.tech` | Branch deploys (and Deploy Previews) |

**Endpoint, region, addressing** (verified on `dev` 2026-11-17 with `scripts/storage-cors.mjs
smoke`): the endpoint is per branch, `https://<branch-id>.storage.c-1.us-east-2.aws.neon.tech`.
The `c-1` cell is required: without it the host still resolves but answers `NoSuchBucket`.
Requests are path-style only (`<endpoint>/<bucket>/<key>`) and SigV4 only; the signing region is
`us-east-2` (Neon also accepted a request signed for `us-east-1`, so it doesn't appear to check
the region; use `us-east-2` anyway). The access key id is the credential's `token_id` (`nak_live_…`), not its
`api_token`. The production endpoint follows the same pattern (same project and cell) but has
not been called yet.

**Buckets and branches.** A child branch sees the buckets and objects its parent had when it
was created ("branches inherit the parent's objects at the moment of forking", no data copied).
A bucket created on `production` **after** `dev` existed is **not** visible on `dev`, so each
branch got its own `bocc-media` (2026-11-17). A reset of `dev` from its parent would presumably
replace `dev`'s storage with production's; check the bucket and its CORS rule after any reset.

**Credentials.** Storage credentials are separate from Postgres roles. A credential "is scoped
to a branch and valid for that branch and all its descendants"
(https://neon.com/docs/storage/authentication), so a production credential would also work on
`dev`. Each branch therefore has **its own** credential, made on that branch, with scopes
`storage:read` and `storage:write` (`neon credentials create`; its secret is shown once).
Production's credential is never given to a non-production context.

**Netlify.** Set the five `STORAGE_*` variables (table under "Environment variables") with a
**Production** value from the `production` branch and a **Branch deploys** value (also used for
Deploy Previews) from `dev`. Mark only `STORAGE_SECRET_ACCESS_KEY` as a **secret**. The endpoint,
bucket and region appear in this repo, and Netlify's secret scanning fails a build when a value
marked secret is found in the repo or the build output, so they must not be marked secret.
Without the variables the admin still works and shows media as switched off. Env changes need a
redeploy.

**CORS.** A new Neon bucket starts with a wide-open rule (seen on `dev` 2026-11-17: origin `*`,
methods GET/PUT/POST/HEAD/DELETE, any header). Replace it, per branch, with one rule:

| Field | Value |
|---|---|
| AllowedOrigin | production: `https://716coffee.club`; `dev`: `https://dev--bocc-backend.netlify.app` and `http://localhost:4321` |
| AllowedMethod | `PUT`, `GET`, `HEAD` |
| AllowedHeader | `content-type` |
| MaxAgeSeconds | `3000` |

```sh
# env file with the branch's STORAGE_* values (mode 600, outside the repo or gitignored)
node --env-file=<file> scripts/storage-cors.mjs set https://716coffee.club   # PutBucketCors
node --env-file=<file> scripts/storage-cors.mjs get                         # check
node --env-file=<file> scripts/storage-cors.mjs smoke https://716coffee.club  # PUT/GET/HEAD/DELETE under smoke/
```

Done on `dev` 2026-11-17: rule set as above; the smoke test passed (preflight from the staging
origin allowed and from another origin refused with 403; a PUT with the wrong content type or
size refused with 403; GET, HEAD and DELETE worked; nothing left in the bucket). Production's
bucket still has Neon's default rule until its release.

The admin CSP adds the endpoint's origin to `img-src`, `media-src` (the promo video player) and `connect-src` only when storage is
configured (`src/lib/admin/headers.mjs`).

**Media (operations).** Photo uploads (`src/lib/admin/media.mjs`) presign their PUTs for
15 minutes, not the 5-minute default, because a phone sends three files one after another.
- *Unfinished uploads:* a row stays `pending` until the browser's `complete` call finds all
  three objects. Pending rows over a day old are listed on their event page with a delete
  button; there is no cron.
- *Orphaned objects:* deleting a photo removes the row first, then the objects. If an object
  delete fails, the function log (Netlify → Logs → Functions → ssr) has a line
  `[admin] media delete <id>: … still in the bucket: <keys>`. Remove those keys by hand with
  the branch's storage credential. They are private and unreferenced, so this is cleanup only.
- *Sign-in board photo import* (`scripts/signin-photos/import.mjs`, one time): it needs the
  owner URL (`.env.local`) and the branch's `STORAGE_*` values (a separate env file), and it
  writes only with `--apply --confirm <file>`. Its originals are the untouched HEIC files
  (`original.heic`, `image/heic`), which the database allows for `signin_board` only
  (migration `20261119120000`). Run migrations on the branch before the import.

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

Run as `admin_app` once `20261118120000_events_media.sql` is applied, inside `begin; … rollback;`:

- [ ] `select count(*) from events` / `event_reports` / `event_media` → succeeds
- [ ] `delete from events` / `delete from event_reports` → permission denied;
      `delete from event_media where false` → succeeds
- [ ] `truncate event_media` → permission denied
- [ ] as `checkin_writer`: `select * from events` → permission denied

Run as `social_checker` once `20261123120000_social_checker.sql` is applied, inside
`begin; … rollback;`:

- [ ] `select count(*) from social_posts` / `social_post_channels` / `events` / `event_links` →
      succeeds
- [ ] `select id, kind, status from event_media limit 1` → succeeds;
      `select original_key from event_media limit 1` → permission denied
- [ ] `select 1 from attendees limit 1` / `from event_reports` → permission denied
- [ ] `update social_post_channels set status = status` → permission denied
- [ ] once `20261126120000_social_checker_linkedin.sql` is applied:
      `select user_id, expires_at, display_name from linkedin_authentications` → succeeds;
      `select token_ciphertext from linkedin_authentications` / `select member_urn from
      linkedin_authentications` → permission denied; `select id, name from auth."user"` →
      permission denied for schema auth

`npm run test:db` asserts all of the above against a throwaway Postgres with the real
migrations (`tests/admin/permissions.test.mjs`); this list is for the real Neon branches.
