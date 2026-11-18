# Phase 4 release: event pages from the database

Operator runbook for Zack. Staging first (Neon `dev` + the `dev` branch deploy, 0 credits),
then production together with Phase 3 (one 15-credit deploy). Background: [ADR 0009](../adr/0009-events-in-postgres.md)
decision 4, [the plan](ADMIN_APP_PLAN.md) (Phases 0 and 4), roles and env vars in
[NEON_PERMISSIONS.md](../backend/NEON_PERMISSIONS.md).

Rules for every step: never print a connection string, credential or secret; never give a
non-production context a production value.

## What changes

- `/events/YYYY-MM-DD/` is rendered on request by the Astro SSR function, reading Neon as the
  new `site_reader` role (SELECT on `events` and `event_links` only), and cached at Netlify's
  CDN (`src/lib/site/http.mjs`):
  - `Netlify-CDN-Cache-Control: public, durable, max-age=<seconds to the next Eastern
    midnight, at most a day>, stale-while-revalidate=3600`
  - `Netlify-Cache-Tag: event-YYYY-MM-DD`
  - `Cache-Control: public, max-age=0, must-revalidate`, so browsers see a purge on the next load
- An admin save, or the first photo upload for a new date, purges `event-<date>` and
  `event-list` in one `purgeCache()` call (`src/lib/site/purge.mjs`), bounded at 3 s with no
  retry, so a slow or rate-limited (429) purge only logs and the save stays fast. Past and
  cancelled pages are tagged `event-<date>,event-list` (their "Next" link depends on other
  dates), so every purge refreshes them. Staging passes `deployAlias: "dev"` (from
  `locals.netlify.context.deploy.branch`); production passes `domain: "716coffee.club"`
  (from `context.site.url`). Anything else is refused and logged, never purged unscoped.
- A date with no `events` row is a real 404 ("Out of Coffee"), cached for 5 minutes under its
  tag. A malformed date is a 404 with `no-store`. Cancelled dates say so; past dates say "this
  one has passed" (`noindex`). Both link to the next scheduled event.
- `/sitemap.xml` is rendered on request too (tag `event-list`). `/events/` 302s to `/`.
- The `/events/* → /` 302 in `netlify.toml` is gone, and so is every reader of
  `src/data/luma_events.yml`. **Without the links import, every event page is a 404**, so the
  import runs before the deploy, on both branches.
- `SITE_DB_URL` missing, or Neon unreachable: those pages answer 503 (`no-store`) with a short
  message. Every other public page is static and unaffected.

## Before you start

- [ ] **On or after 2026-11-20: add `"@netlify/cache": "4.2.1"` to the root `package.json`
  `dependencies`** (exact pin) and run `npm install`. It is already installed, as an exact
  dependency of `@astrojs/netlify`'s `@netlify/functions@6.1.1`, and `purge.mjs` imports that
  hoisted copy. The lockfile shouldn't change beyond the new top-level entry. It was
  published 2026-11-06, so it meets the two-week rule from the 20th. Vetted: the official
  Netlify package (`netlify/primitives`, MIT), 71 KB, its one dependency
  `@netlify/runtime-utils@3.0.1` has none.

- `cd backend && npm test` (152), `npm run test:db` (needs Docker) and `npm run build` pass on
  `dev`.
- Migration `20261121120000_event_links_site_reader.sql` is additive: a new table and a new
  `NOLOGIN` role. Production's current code never touches them, so migrating before the deploy
  is safe.

## Staging

1. [ ] **Migrate Neon `dev`** (owner URL of `dev` in `DATABASE_URL_UNPOOLED`, as in Phase 2):
   `cd backend && npm run migrate:status && npm run migrate`. Expect only
   `20261121120000_event_links_site_reader.sql`.
2. [ ] **`site_reader` on `dev`**, as `neondb_owner` on `dev`, with a fresh
   `openssl rand -hex 32` (never production's):
   ```sql
   alter role site_reader login password '<new hex>';
   ```
   Then check it, as `site_reader` on `dev`: `select count(*) from events` works;
   `select 1 from event_reports limit 1` and `select 1 from attendees limit 1` fail with
   `permission denied`.
3. [ ] **Netlify, Branch deploys and Deploy Previews contexts:** `SITE_DB_URL` = the **pooled**
   `dev` URL for `site_reader` (host with `-pooler`). Mark it secret. Production gets its own
   value in step 11.
4. [ ] **Links import on `dev`** (A's `backend/scripts/import-event-links.js`, as the owner). The
   YAML and the README table are deleted from the tree, so take them from git history:
   ```sh
   git show 829155c:src/data/luma_events.yml > /tmp/luma_events.yml
   git show 829155c:docs/social/README.md    > /tmp/social-README.md
   cd backend
   node --env-file=<dev owner env> scripts/import-event-links.js --yaml /tmp/luma_events.yml --readme /tmp/social-README.md
   node --env-file=<dev owner env> scripts/import-event-links.js --yaml /tmp/luma_events.yml --readme /tmp/social-README.md --apply
   node --env-file=<dev owner env> scripts/import-event-links.js --yaml /tmp/luma_events.yml --readme /tmp/social-README.md
   ```
   The first is a dry run: expect 13 dates (2026-11-10 … 2027-02-16), links luma 13,
   eventbrite 13, facebook_event 1, linkedin_event 1, 0 mismatches, 0 conflicts, 0 errors.
   `--apply` creates the missing `events` rows as `scheduled` and never changes an existing
   row's status. It refuses while there are conflicts; fix those in the admin, or add
   `--prefer-db` to keep what is stored. The last run should report `insert 0, fill id 0`.
   Delete the two `/tmp` files afterwards.
5. [ ] **Push `dev`.**
6. [ ] On https://dev--bocc-backend.netlify.app:
   - [ ] `/events/<next Tuesday>/`: looks like before, the Luma embed works, "RSVP free" goes to
         that date's Luma page. View source: the Event JSON-LD has `sameAs` with the
         Eventbrite, Facebook and LinkedIn URLs, and the page shows no link to them
   - [ ] `curl -sI` it twice: the second answer has `cache-status: "Netlify Durable"; hit`
         (Netlify consumes `Netlify-CDN-Cache-Control` and `Netlify-Cache-Tag`, so they may not
         show), and `cache-control: public, max-age=0, must-revalidate`
   - [ ] `/events/2031-01-07/` → 404 "Out of Coffee"; `/events/nope/` → 404; `/events/` → `/`
   - [ ] a past date (e.g. last Tuesday) → "This one has passed", with a link to the next event
   - [ ] `/sitemap.xml` lists the upcoming dates, then the content pages
   - [ ] for information: `curl -sI '<event URL>?x=1'` twice. Query strings get their own CDN
         entry (Netlify keys function responses on them, and documents no header to ignore
         them), so the first is a miss. The same tags purge it, so it is never staler
   - [ ] in the admin, change the next Tuesday's location to the food hall and save. Within about
         5 s the public page shows "Food hall" (one reload, no cache-busting). Change it back.
         Netlify → Logs → Functions → `ssr`: no `[site] purge refused` or `purge failed` lines
   - [ ] cancel a future test date, check the public page says it's cancelled, then un-cancel it
   - [ ] `/checkin/bocc` unchanged; every other public page unchanged

## Production (together with Phase 3)

Phase 3's production steps ([PHASE3_RELEASE.md](PHASE3_RELEASE.md), steps 6 to 10) and these run
as one release: migrate, set roles and env vars, import, then one merge. **Phase 5 ships in the
same merge:** its production steps ([PHASE5_RELEASE.md](PHASE5_RELEASE.md), steps 8 to 14) add
two migrations to step 7, the `social_checker` role and two env vars before step 13, and the
checks after step 14, including the admin CSP's `media-src`. Production keeps
serving the old static event pages until the deploy, so nothing breaks in between.

7. [ ] **Migrate Neon `production`** (owner; `.env.local` points there):
   `cd backend && npm run migrate:status && npm run migrate`. Expect Phase 3's three migrations
   plus `20261121120000_event_links_site_reader.sql`. Check the grants: `site_reader` has
   SELECT on `events` and `event_links` and nothing else.
8. [ ] **`site_reader` on `production`**: the same `alter role site_reader login password …`
   with a **different** `openssl rand -hex 32`.
9. [ ] **The Phase 0 open item: a staging purge leaves production's copy alone.** It needs
   production serving tagged pages, so it runs right after step 13's deploy; it is listed here
   so it isn't forgotten. See step 14.
10. [ ] **Phase 3 production env and imports** (PHASE3_RELEASE.md steps 7 and 8).
11. [ ] **Netlify, Production context:** `SITE_DB_URL` = production's pooled `site_reader` URL
    (secret).
12. [ ] **Links import on production**: step 4's three commands with `--env-file=../.env.local`.
    Check the dry run's counts match staging's.
13. [ ] **Merge and push** (15 credits): `git checkout main && git pull && git merge dev &&
    git push origin main`, then back to `dev`.
14. [ ] **Check https://716coffee.club**: step 6's list with production in place of `dev`, plus
    the purge scoping check:
    1. `curl -sI https://716coffee.club/events/<next Tuesday>/` until it says
       `"Netlify Durable"; hit`. Note its `age`.
    2. On **staging**, save that date in the admin (any no-op save).
    3. Within 10 s, `curl -sI` production again: still a hit, `age` larger than before. Then the
       staging page re-renders (`age` resets there).
    4. Save the date in **production's** admin: production's page re-renders within about 5 s.
    Record the result in ADMIN_APP_PLAN.md Phase 0 (the unticked "Not yet testable" item). If
    step 3 shows production re-rendered, a staging save also clears production. That is
    harmless (one extra render from Neon, no wrong content), so no rollback: record it, and
    ADR 0009's scoping note needs amending.
    5. Also note whether `https://bocc-backend.netlify.app/events/<date>/` refreshed after the
       production save: the `domain` scope names `716coffee.club`, so that host may keep its copy
       until midnight. It isn't linked anywhere, so this is for information.

**Rollback:** Netlify → Deploys → the previous production deploy → "Publish deploy". That brings
back the static event pages and the 302. Leave the migration, the role and the imported rows in
place: they are additive and the old code ignores them.
