# Phase 3 release: events, reports and media

Operator runbook for Zack. Staging first (Neon `dev` + the `dev` branch deploy, 0 credits),
then production (Neon `production` + `main`, 15 credits). Background: [ADR 0009](../adr/0009-events-in-postgres.md),
[ADR 0010](../adr/0010-media-in-neon-object-storage.md), [the plan](ADMIN_APP_PLAN.md) (Phase 3),
grants, buckets and env vars in [NEON_PERMISSIONS.md](../backend/NEON_PERMISSIONS.md) ("Storage").

Rules for every step: never print a connection string, credential or secret; never give a
non-production context a production value. The Google Form CSV and the sign-in photos hold
personal data: keep them out of the repo.

## Before you start

- `cd backend && npm test` (152), `npm run test:db` (194, needs Docker) and `npm run build`
  pass on `dev`.
- Migrations `20261118120000_events_media.sql` and `20261119120000_media_heic_originals.sql`
  are additive. Production's current code never touches them, so migrating before the deploy
  is safe.
- Buckets (done 2026-11-17): a private `bocc-media` on `production` and a separate one on
  `dev` (a bucket made on `production` after `dev` existed does not appear on `dev`). Each
  branch has its own `storage:read`/`storage:write` credential. CORS: `dev` allows the
  staging origin and localhost; `production` allows only `https://716coffee.club`.

## Staging (done 2026-11-17, except the on-device checks)

1. [x] Migrate Neon `dev` (owner URL of `dev` in `DATABASE_URL_UNPOOLED`, as in Phase 2).
2. [x] Netlify, **Branch deploys** and **Deploy Previews** contexts: `STORAGE_ENDPOINT`,
   `STORAGE_BUCKET`, `STORAGE_REGION` (`us-east-2`), `STORAGE_ACCESS_KEY_ID` (the credential's
   `token_id`), `STORAGE_FORCE_PATH_STYLE` (`true`), and `STORAGE_SECRET_ACCESS_KEY` (the only
   one marked **secret**; the others appear in the repo and would trip the secrets scanner).
3. [x] Push `dev`.
4. [x] Imports on `dev`: the Google Form CSV (135 events with reports; a re-run changes
   nothing) and the sign-in photos (45, plus a `held` event for 2024-11-12).
5. On https://dev--bocc-backend.netlify.app/admin/events/:
   - [ ] the list shows no "report missing" for past dates; old reports read correctly
   - [ ] imported photos: thumbnail, display copy, "Download original" downloads the HEIC;
         2024-11-26 and 2024-11-12 look right (swapped file names)
   - [ ] a future date: location saves; cancel with a reason, then un-cancel; `held` and a
         report are refused
   - [ ] **iPhone Safari:** upload a sign-in board photo and a social photo, mark the social
         one publicly usable, delete one (closes the Phase 0 mobile presigned-PUT check)
   - [ ] **Chrome on a phone:** the same upload. A HEIC picked in desktop Chrome gets the
         "can't be read in this browser" message
   - [ ] as the `social` user: `/admin/events/` and the media APIs → 403
   - [ ] `/checkin/bocc` unchanged; one check-in POST with `debug: "1"` lands on `dev`
   - [ ] public pages unchanged; `/events/<an expired date>/` still 302s to `/`

## Production

6. **Migrate Neon `production`** (owner; `.env.local` points there):
   `cd backend && npm run migrate:status && npm run migrate`. Expect exactly the two migrations
   above. Check the grants: `admin_app` has SELECT/INSERT/UPDATE on `events`, `event_reports`,
   `event_media`, plus DELETE on `event_media` only.
7. **Netlify, Production context:** the same six `STORAGE_*` variables with **production's**
   bucket endpoint (`https://br-noisy-poetry-a5q2e3cd.storage.c-1.us-east-2.aws.neon.tech`)
   and production's credential. Only `STORAGE_SECRET_ACCESS_KEY` is secret.
8. **Imports on production**, as the owner (`--env-file=../.env.local` from `backend/`):
   - Google Form: dry run, check the summary matches staging (135 create, 4 fixes, 0 errors),
     then `--apply`, then a dry run again (expect 135 unchanged).
   - Sign-in photos: dry run with `--confirm signin-confirm.csv` against production's events,
     then `--apply` with production's storage env file and a new empty `--work-dir`. Expect 45
     imported and 2024-11-12 created as `held`.
9. **Merge and push** (15 credits): `git checkout main && git pull && git merge dev &&
   git push origin main`, then back to `dev`.
10. **Check https://716coffee.club**: repeat step 5's list with production in place of `dev`
    (the debug check-in row lands on **production**), plus:
    - [ ] the admin CSP's `img-src`/`connect-src` name production's bucket host, not `dev`'s
    - [ ] one real upload from your iPhone, then delete it
    - [ ] the Neon console's storage figure after the imports (Phase 0: whether `dev`'s objects
          count toward the 5 GB)

**Rollback:** Netlify → Deploys → the previous production deploy → "Publish deploy". Leave the
migrations and imported rows in place: they are additive and the old code ignores them. To
switch media off without a deploy, delete the production `STORAGE_*` variables (the admin then
shows "storage not configured") or revoke the credential with `neon credentials revoke`.
