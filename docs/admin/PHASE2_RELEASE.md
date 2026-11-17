# Phase 2 release: login, roles and data views

Operator runbook for Zack. Staging first (Neon `dev` + the `dev` branch deploy, 0 credits), then
production (Neon `production` + `main`, 15 credits). Background: [ADR 0008](../adr/0008-admin-auth-better-auth.md),
[the plan](ADMIN_APP_PLAN.md) (Phase 2), roles and env vars in
[NEON_PERMISSIONS.md](../backend/NEON_PERMISSIONS.md). Tick the plan's boxes yourself once each
part is checked.

Rules for every step: never print a connection string, password or secret (pipe or paste it
straight into its destination); never give a non-production context a production value.

## Before you start

- `cd backend && npm test` (152 pass), `npm run test:db` (needs Docker) and `npm run build` at
  the repo root all pass on `dev`.
- Migration `20261116120000_admin_auth.sql` is additive (new `auth` schema, `user_roles`,
  `audit_log`, the `admin_app` role). The code running in production today never touches it, so
  migrating before the deploy is safe.

## Staging

1. **Migrate Neon `dev`** (as `neondb_owner`). `npm run migrate` reads `../.env.local`, which
   points at production, and `migrate.js` prefers `DATABASE_URL_UNPOOLED`. Node's
   `--env-file` doesn't override a variable that is already set, so pass `dev`'s owner URL in
   that variable for this one command:

   ```bash
   cd backend
   DATABASE_URL_UNPOOLED="$(neon connection-string dev --role-name neondb_owner --database-name neondb)" npm run migrate:status
   DATABASE_URL_UNPOOLED="$(neon connection-string dev --role-name neondb_owner --database-name neondb)" npm run migrate
   ```

   (Or copy `dev`'s direct owner URL from the Neon console into the variable the same way.)
   Expect exactly one new migration, `20261116120000_admin_auth.sql`.

2. **Set the `admin_app` password on `dev`**, as owner on `dev`, with a fresh
   `openssl rand -hex 32` that is used nowhere else. The migration creates the role `NOLOGIN`,
   so this step also enables login:

   ```sql
   alter role admin_app login password '<new hex>';
   ```

   One-time: a reset from parent keeps `dev`'s own password. Don't reset `dev` until production
   is migrated too (see NEON_PERMISSIONS.md).

3. **Verify the grants on `dev`**: the `admin_app` and `checkin_writer` items of the verification
   checklist in NEON_PERMISSIONS.md.

4. **Netlify env, Branch deploys and Deploy Previews** (Free plan: no per-branch values, no
   narrower scopes):

   | Variable | Value |
   |---|---|
   | `ADMIN_DB_URL` | `dev`'s **pooled** `admin_app` URL |
   | `BETTER_AUTH_SECRET` | a new `openssl rand -hex 32`, staging only |
   | `BETTER_AUTH_URL` | `https://dev--bocc-backend.netlify.app` |
   | `ADMIN_DB_POOL_MAX` | optional; leave unset (default 3) |

   Login only works on the `dev` branch deploy; deploy previews have their own host.
   Mark `ADMIN_DB_URL` and `BETTER_AUTH_SECRET` as secret, but **not** `BETTER_AUTH_URL`: it is a
   public URL that appears throughout the repo, so Netlify's secrets scanner fails the build
   (found 2026-11-17). Netlify can't unmark a secret; delete and recreate the variable.

5. **Your staging login.** Put the same three values in the gitignored `.env.admin` at the repo
   root (mode 600), then `npm run create-admin` (prompts for email, name and password; role
   `admin` by default).

6. **Push `dev`** (`git push origin dev`) and wait for the branch deploy. Netlify posts no GitHub
   status for branch deploys, so check it in the UI. Then on `https://dev--bocc-backend.netlify.app`:
   - [ ] `/login/`: password sign-in lands on `/admin/`.
   - [ ] `/admin/account/`: add a passkey, sign out, sign in with the passkey alone.
   - [ ] `/admin/users/`: create a `social` test user and a second test user; reset a password
         (the user's open session is signed out); grant and remove roles; removing the last
         admin role is refused. Each change has an `audit_log` row, and no row contains a
         password.
   - [ ] A user with **no role** (remove the second test user's only role): `/admin/` → 403
         with nothing else on the page.
   - [ ] As the `social` user: `/admin/` works; `/admin/users/`, `/admin/checkins/`,
         `/admin/streaks/`, `/admin/email-list/`, `/admin/attendees/…` and
         `/api/admin/email-list.csv` → 403.
   - [ ] Signed out: `/admin/` → 302 to `/login/?next=…`; `/api/admin/me` → 401.
   - [ ] Admin pages send `X-Robots-Tag: noindex`, `Cache-Control: no-store` and the strict CSP.
   - [ ] `/checkin/bocc` and `/checkin/bocc?token=…` → 200 with no redirect, page unchanged.
   - [ ] One check-in POST to `/.netlify/functions/checkin` with `debug: "1"` → 200, and the row
         lands on Neon **`dev`** (`debug = true`), not production.
   - [ ] **`/events/<an expired date>/` still 302s to `/`.** The adapter's SSR function now
         serves paths that match no file, so check the `netlify.toml` redirect still wins.
   - [ ] An unknown path (e.g. `/no-such-page`) → the custom 404 page, status 404.
   - [ ] Public pages (`/`, `/about/`, an `/events/YYYY-MM-DD/` page) unchanged, still with
         Google Analytics; no admin headers on them.

   Clean up: remove the test users' roles (deleting accounts isn't in the UI yet).

## Production

7. **Migrate Neon `production`** before merging (as owner; `.env.local` already points there):
   `cd backend && npm run migrate:status && npm run migrate`. Expect the same single migration.

8. **Set the `admin_app` password on `production`**, as owner on `production`, with a new
   `openssl rand -hex 32` (different from `dev`'s):
   `alter role admin_app login password '<new hex>';`

9. **Verify the grants on `production`** (same checklist), and that production's `admin_app`
   password is refused on `dev` (expect `28P01`).

10. **Netlify env, Production context:** `ADMIN_DB_URL` (production's pooled `admin_app` URL),
    `BETTER_AUTH_SECRET` (a new value, never staging's), `BETTER_AUTH_URL` =
    `https://716coffee.club`. `ADMIN_DB_POOL_MAX` optional.

11. **Your production login.** Point `.env.admin` at the production values, run
    `npm run create-admin`, then point `.env.admin` back at `dev` (or delete it).

12. **Merge and push** (15 credits): `git checkout main && git pull && git merge dev &&
    git push origin main`, then back to `dev`.

13. **Check https://716coffee.club**: repeat step 6's list with production in place of `dev`
    (the debug check-in row lands on **production**), plus:
    - [ ] **Passkey `rpID`**: passkeys from the `dev` host don't carry over. Add one at
          `/admin/account/` on 716coffee.club, sign out, and sign in with it alone.

**Rollback:** Netlify → Deploys → the previous production deploy → "Publish deploy". Leave the
migration in place: it is additive and the old code ignores it. To lock the admin app out
without a deploy, `alter role admin_app nologin;` on the branch concerned.
