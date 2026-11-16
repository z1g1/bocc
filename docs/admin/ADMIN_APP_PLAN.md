# Plan: BOCC admin app

Status: **Accepted** (2026-11-16). Nothing here is built yet.
Decisions: [ADR 0007](../adr/0007-astro-replaces-jekyll.md) (Astro),
[0008](../adr/0008-admin-auth-better-auth.md) (login and roles),
[0009](../adr/0009-events-in-postgres.md) (events),
[0010](../adr/0010-media-in-neon-object-storage.md) (media),
[0011](../adr/0011-social-posting-via-chrome-work-order.md) (social work order).

## Goal

- Replace the post-event Google Form.
- Show check-ins, active streaks and the email list.
- Give each event one page, `/admin/events/YYYY-MM-DD`, showing whether its links and social
  posts are ready and what was recorded afterwards.
- Turn five weekly video uploads into one, with Claude in Chrome tasks doing the platform work.

## Environments (all on free plans)

| | Production | Staging |
|---|---|---|
| Netlify | `main`, 15 credits per deploy | branch deploy of `dev`, **0 credits per build** |
| Neon | `production` branch | `dev` branch, copied from `production` |
| Chrome tasks | the real weekly runs | rehearsals |

- **A branch inherits its parent's role passwords.** Generating new ones automatically is a paid
  feature. After creating the `dev` branch, set new passwords for
  `checkin_writer` and `admin_app` on `dev`. Store them in Netlify's branch-scoped environment
  variables. Keep this as a script in `NEON_PERMISSIONS.md`.
- Staging holds real attendee data and production's Better Auth users, so it needs the same login
  protection as production.
- Neon Free: 10 branches and 100 CU-hours a month across the project, 1 GB of Postgres, and 5 GB
  of object storage.

## Phase 0: check what we haven't confirmed yet (no production code)

Each item gets a short spike on the `dev` branch deploy. A failure goes back to the ADR it came
from before anything else proceeds.

Doc checks were done on 2026-11-16 against live vendor pages. A ticked box means the docs (or our
own code) settle it. An unticked box with "**test**" still needs a hands-on spike.
**Proposed ADR changes** from these findings are listed at the end of this phase and wait for
Zack's decision.

- **Astro + Netlify** (ADR 0007, 0009)
  - [x] Versions: `astro` 7.4.12 and `@astrojs/netlify` 8.2.14 are the stable releases (both
        published 2026-11-13). Avoid the `beta`/`alpha`/`next` tags.
        [npm](https://registry.npmjs.org/astro), [npm](https://registry.npmjs.org/@astrojs/netlify)
  - [x] Static by default with per-route `export const prerender = false`, keeping
        `output: 'static'`. [Astro docs](https://docs.astro.build/en/guides/on-demand-rendering/)
  - [x] **Tested 2026-11-16** (Spike: branch `spike`, https://spike--bocc-backend.netlify.app, Neon branch `spike-auth`). The adapter and
        `backend/netlify/functions` coexist: the Astro SSR function, our CommonJS
        `spike-whoami` and the unchanged `checkin` all served from one build. Never name one of
        our functions `ssr`. Findings:
        - **The Astro project must sit at the Netlify build base (the repo root).** The adapter
          writes `.netlify/v1` under the Astro root, and Netlify only reads it from the base.
          With Astro in a subfolder the build passed but every on-demand route returned 404.
          See proposed change 6.
        - Astro 7 needs Node ≥ 22.23.4. Production still pins `NODE_VERSION = "20"`, which went
          end-of-life in April 2026. The spike used 24 (current LTS).
        - The root `package.json` can be `"type": "module"`. The functions stay CommonJS
          because `backend/package.json` has no `"type"`. All 152 backend tests pass.
        - Set `ASTRO_TELEMETRY_DISABLED=1`; Astro collects usage data by default.
        - Netlify's `CONTEXT` and `BRANCH` env vars are **null at runtime** in functions. Use
          `Astro.locals.netlify.context.deploy` (`branch`, `context`).
        - Netlify posts no GitHub status for branch deploys. Check them by URL or in the UI.
        - This dev VM's CPU (QEMU, no AVX2) can't run Astro's native compiler. Local builds
          need the WASI binding; Netlify's builders are unaffected.
        [Frameworks API](https://docs.netlify.com/build/frameworks/frameworks-api/)
  - [x] CDN caching: set `Netlify-CDN-Cache-Control: public, durable, max-age=…,
        stale-while-revalidate=…` and `Netlify-Cache-Tag` through `Astro.response.headers`.
        Don't use the adapter's `cacheOnDemandPages`, which would cache `/admin/*` for a year,
        or `Astro.cache`/`cacheNetlify()`, which are experimental.
        [Netlify caching](https://docs.netlify.com/platform/caching/)
  - [x] Purge: `purgeCache({ tags, deployAlias })` from `@netlify/cache`. It takes a few seconds
        and is limited to 2 calls per 5 s per tag. Modern (default-export) functions get the token
        automatically, but Lambda-style CommonJS functions must pass `purge_api_token`.
        **Purges cover every deploy by default**, so a purge from staging would clear production;
        always pass `deployAlias` or `domain`. Each deploy also clears its context's cache.
        [Cache API](https://docs.netlify.com/build/caching/cache-api/)
  - [x] **Tested 2026-11-16:** an on-demand page with `Netlify-CDN-Cache-Control: public,
        durable, …` and `Netlify-Cache-Tag` is served as a `"Netlify Durable"; hit`. A purge by
        tag with `deployAlias: "spike"` re-rendered it within 5 s. An unknown date returns 404.
  - [ ] **Not yet testable:** that the scoped purge leaves *production's* copy alone. Production
        has no tagged pages until Phase 4. Re-check then. Whether a purge costs credits is
        undocumented.
- **Better Auth** (ADR 0008)
  - [x] Version and license: 1.7.25 (2026-11-14), MIT. **Vercel acquired it on 2026-07-07** and
        says it stays MIT. Releases come every 1–3 days and there have been about 45 advisories,
        all fixed in 1.7.25. Pin an exact version and watch the advisories page.
        [npm](https://registry.npmjs.org/better-auth/latest),
        [LICENSE](https://github.com/better-auth/better-auth/blob/main/LICENSE.md),
        [Vercel](https://vercel.com/blog/vercel-acquires-better-auth),
        [advisories](https://github.com/better-auth/better-auth/security/advisories)
  - [x] `disableSignUp` exists, and it also blocks server-side `auth.api.signUpEmail`. The admin
        plugin's `createUser` still works, so `create-admin` must use that (or the internal
        adapter). [options](https://better-auth.com/docs/reference/options)
  - [x] 2FA plugin: the page exists, and TOTP plus backup codes need no email.
        [2FA](https://better-auth.com/docs/plugins/2fa)
  - [x] 30-day sliding sessions: `expiresIn` 30 d, `updateAge` 1 d. `getSession` **writes** to
        refresh the session. Leave `cookieCache` off so revocation is immediate.
        [sessions](https://better-auth.com/docs/concepts/session-management)
  - [x] Rate-limit counters: in memory by default, which is useless on serverless. Use
        `rateLimit.storage: "database"` (a `rateLimit` table in `auth`) and set
        `ipAddressHeaders` to Netlify's client-IP header, not `X-Forwarded-For`.
        [rate limit](https://better-auth.com/docs/concepts/rate-limit)
  - [x] Schema: use `database.schemaName: "auth"`. `search_path` doesn't survive Neon's pooler.
        `npx auth@latest generate` writes plain SQL (the old `@better-auth/cli` is unsupported).
        [Postgres adapter](https://better-auth.com/docs/adapters/postgresql),
        [CLI](https://better-auth.com/docs/concepts/cli)
  - [x] Passkeys: separate package `@better-auth/passkey`. By default a passkey is added after a
        password login, which fits our flow. [passkey](https://better-auth.com/docs/plugins/passkey)
  - [x] **Tested 2026-11-16** (Spike: branch `spike`, https://spike--bocc-backend.netlify.app, Neon branch `spike-auth`):
        - Login works in Astro on the branch deploy. The cookie is
          `__Secure-better-auth.session_token; HttpOnly; Secure; SameSite=Lax`, Max-Age 30 days.
        - `/admin` without a session redirects to `/login/`. Public sign-up is refused with
          `EMAIL_PASSWORD_SIGN_UP_DISABLED`. A sign-in from another origin is refused with
          `403 INVALID_ORIGIN`.
        - Rate limiting: after 5 attempts in 60 s, sign-in returns 429. Counters are in the
          `auth."rateLimit"` table. Sending a different `X-Forwarded-For` doesn't get around it,
          and sessions record the real client IP from `x-nf-client-connection-ip`.
        - A least-privilege `spike_auth` role (only the `auth` schema) is enough. It is denied
          attendees, check-ins and streaks.
  - [x] **Tested 2026-11-16:** `getSession` works from a separate CommonJS function through
        `await import()`, both locally and as bundled by Netlify's esbuild. **Gotcha:** the
        function refreshed the session using *its own* `expiresIn`, rewriting the expiry the
        Astro side had set. Every instance must build Better Auth from one shared config module.
  - [x] **Tested 2026-11-16 (locally):** the sliding session. With `expiresIn` 5 min and
        `updateAge` 60 s, the expiry was unchanged at 30 s and moved to now + 5 min at 70 s.
  - [x] **Tested 2026-11-16 by Zack:** a passkey added after a password login on the branch
        deploy, then used to sign in on its own. The 716coffee.club `rpID` gets its own check
        when the admin first reaches production (Phase 2), since passkeys are bound to the domain.
  - Spike cleaned up on 2026-11-16: the `spike` git branch, the `spike-auth` Neon branch and its
    role are deleted. What it proved is recorded above; the code itself was not kept.
- **Neon** (ADR 0008, 0010)
  - [x] Passwords: a child branch gets "the same Postgres roles and passwords as the parent".
        "Resets are branch-scoped", so `ALTER ROLE … PASSWORD` on `dev` should leave
        `production` alone. [branches](https://neon.com/docs/manage/branches),
        [roles](https://neon.com/docs/manage/roles)
  - [x] **Tested 2026-11-16** (neon CLI 4.17.3). We made throwaway branches `spike-pw-parent`
        (from `production`) and `spike-pw-child`, plus a throwaway role `pw_probe` that existed
        only on those branches. Then we changed the role's password on the child:
        - Before the change, the child accepted the parent's password.
        - After the change, the child accepted only the new password, and the parent still
          accepted only the old one.
        - Both branches were deleted afterwards. `production` was never written to, and a
          read-only check shows it never had the role.
  - [x] **Tested 2026-11-16:** "reset from parent" **kept** the child's changed password. The
        reset did happen: a marker table on the child was gone afterwards and the parent's data
        was back. So after creating `dev`, set new passwords **once**. A reset doesn't bring back
        production's passwords. The docs don't promise this, so the reset runbook still checks
        that production's password fails on `dev`.
        [reset](https://neon.com/docs/guides/reset-from-parent)
  - [x] Object Storage went GA on 2026-09-18, but its API endpoints are still labelled Beta. It
        supports `aws-us-east-2`, 5 GB per project, and bucket CORS through the S3 API
        (`PutBucketCors`). [changelog](https://neon.com/docs/changelog),
        [S3 compatibility](https://neon.com/docs/storage/s3-compatibility)
  - [x] Storage credentials are "scoped to a branch and valid for that branch and all its
        descendants". A production credential works on `dev`, so staging needs its own, made on
        `dev`. [auth](https://neon.com/docs/storage/authentication)
  - [ ] Whether inherited objects count toward 5 GB: undocumented. Branches read the parent's
        objects without copying, so probably not. Check the usage figure after the first upload.
  - [ ] **test:** presigned PUT from mobile Safari and Chrome, with a CORS rule on the bucket.
  - Note: `dev` shares production's 100 CU-hours and 5 GB transfer. If staging uses them up,
    production's compute is suspended (SQLSTATE `53000`). [plans](https://neon.com/docs/introduction/plans)
- **Media** (ADR 0010)
  - [x] iOS Safari turns HEIC into the first type listed in `accept`, so use
        `accept="image/jpeg,image/png"`, not `image/*`. Check the MIME type, not the extension.
        Evidence is WebKit bugs, not an Apple doc.
        [WebKit 292350](https://bugs.webkit.org/show_bug.cgi?id=292350)
  - [x] HEIC decoding: Safari 17+ only. **Chrome on desktop and Android can't decode HEIC**, so an
        iPhone HEIC uploaded from those breaks the resize step. See the proposed ADR 0010 change.
        [caniuse](https://caniuse.com/heif)
  - [x] `createImageBitmap` applies EXIF orientation by default, and canvas export drops EXIF/GPS.
        [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Window/createImageBitmap)
- **Chrome tasks** (ADR 0011)
  - [ ] **test on Modron's machine (later this week):** a scheduled task runs with nobody present.
        Anthropic's help says tasks run "as long as Chrome is open". Nothing says what happens if
        the machine sleeps, and a missed run is probably skipped.
        [Claude in Chrome](https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome)
  - [x] First comments: Meta Business Suite has no first-comment field, and LinkedIn has none
        either. TikTok Studio is unknown. The Monday verify task adds them, as planned.
        [Sked Social](https://skedsocial.com/blog/first-comment-scheduling)
  - [x] Threads links: probably clickable ("threads can include … links"), so Threads follows the
        FB caption rules. [Instagram Help](https://help.instagram.com/788669719351544/)
  - [ ] **Contradicts ADR 0011:** Business Suite does not post to Threads, and Instagram's "Share
        to Threads" only works for posts published immediately. Threads needs its own scheduling
        step. Third-party source, so confirm by hand.
        [Sprout](https://sproutsocial.com/insights/schedule-threads-posts/)
  - Notes: TikTok Studio schedules 15 min to 10 days ahead and needs a Business Account. LinkedIn
    Pages schedule 1 hour to 3 months ahead. Neither allows editing a scheduled post's content.
- [x] **LinkedIn CLI:** `tools/linkedin-events/bocc_events/config.py` pins `202609`, which is
      active until 2027-09-15. 202511 sunset on 2026-11-16, as expected.
      [LinkedIn versioning](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/migrations)

### Proposed ADR changes (waiting for Zack)

1. **ADR 0011, Threads:** add Threads as its own step in the Wednesday task, in the Threads web
   app, instead of relying on the share from Business Suite.
2. **ADR 0010, HEIC from non-Safari browsers:** if the browser can't decode a photo, refuse it
   with a clear message ("upload from your iPhone, or export as JPEG"). Don't add a WASM HEIC
   decoder in the MVP, since that is a new dependency to vet.
3. **ADR 0008, roles:** keep `user_roles` as the only place roles live. Use the admin plugin only
   for `createUser` and password resets, and never read its `role` column. Add the `rateLimit`
   table to the `auth` migration.
4. **ADR 0009, purge:** every purge passes `deployAlias` (or `domain`). The function that purges
   is written in the modern default-export style, so Netlify supplies the token.
5. **`NEON_PERMISSIONS.md`:** staging gets its own storage credential, made on `dev`. The
   password script runs once when `dev` is created. After any reset, the runbook only checks
   that production's password fails on `dev` (tested: a reset keeps `dev`'s own passwords).

6. **ADR 0007, layout:** the Astro project lives at the repo root (the Netlify build base), not
   in `website/`. The root `package.json` becomes the Astro app plus the functions' runtime
   dependencies. `backend/` keeps its own CommonJS `package.json`. Production's
   `NODE_VERSION` moves from 20 (end-of-life) to 24 as part of the port.
7. **ADR 0008, shared config:** one module builds the Better Auth instance for every caller
   (Astro routes, CommonJS functions, the `create-admin` CLI), so session settings can't drift.

## Phase 1: Astro port (released on its own, ADR 0007)

- [ ] Astro project replaces `website/`, with every page ported and no visual changes
- [ ] `checkin/bocc.html` and `js/checkin.js` copied byte for byte
- [ ] `bocc-afternoon` retired
- [ ] Event pages still built at build time from `luma_events.yml` (they move to the database in
      Phase 4)
- [ ] Release checks:
  - output file list matches the old `_site`
  - JSON-LD and CSP unchanged
  - `llms.txt` unchanged
  - a debug check-in passes on the branch deploy
- [ ] Update `CLAUDE.md`, `architecture.md` and `onboarding.md`
- [ ] Merge to `main` (one production deploy)

## Phase 2: login, roles and data views (ADR 0008)

- [ ] Migration:
  - `auth` schema from Better Auth's generated SQL
  - `user_roles`
  - `audit_log`
  - the `admin_app` role and its permissions
  - update `NEON_PERMISSIONS.md` and its verification checklist
- [ ] Login:
  - password and passkey
  - no public sign-up
  - `create-admin` for your account
  - an admin page to create users and reset passwords
- [ ] Every `/admin/*` route and admin API checks the session and role on the server. A user
      with no role sees nothing
- [ ] **Check-ins** view: latest event by default, with a toggle for test rows
- [ ] **Active streaks** view
- [ ] **Email list** view, with CSV export (each export audited) and **opt-out**
      (`ok_to_email → false`, audited, in the same transaction)
- [ ] Attendee corrections (name, business, phone), audited
- [ ] Tests: role checks for each route, the `social` role denied attendee data, and the audit
      log can't be changed by `admin_app`

## Phase 3: Google Form replacement and media (ADRs 0009, 0010)

- [ ] Migration: `events`, `event_reports`, `event_media`
- [ ] Neon bucket (private) and `storage:read`/`storage:write` credentials for staging and
      production
- [ ] `/admin/events/YYYY-MM-DD`:
  - status
  - location
  - cancel flow (reason, announced on socials)
  - report form (Gives and Asks count, notes, Bling given and details)
  - calculated check-in count shown next to the report
- [ ] Photo upload from a phone:
  - the browser makes the 1600px JPEG and 400px thumbnail
  - uploads go straight to the bucket via presigned PUT
  - a gallery shown through short-lived GET URLs
  - each photo tagged `signin_board` / `social_photo`, with `publicly_usable`
- [ ] Dashboard: upcoming events, and **"report missing"** for past dates still marked
      `scheduled`
- [ ] Import the Google Form CSV (fix `7/14/0026`), using a backfill script like the Airtable
      one

## Phase 4: event pages from the database and readiness checklist (ADR 0009)

- [ ] Migration: `event_links`
- [ ] Import `luma_events.yml` and the README URL table, then delete both
- [ ] `/events/[date]` rendered from Neon on request and cached at the CDN, with the cache cleared
      on save:
  - Luma embed as the only call to action
  - `sameAs` in JSON-LD for the other listings
  - a real 404 for unknown dates
- [ ] Remove the Ruby build and the `/events/* → /` 302
- [ ] Readiness checklist on the admin event page: four links, the public page, and the social
      channels (once Phase 5 lands)

## Phase 5: social work order (ADR 0011)

- [ ] Migration: `social_posts`, `social_post_channels`
- [ ] Promo video upload (`promo_video` media), base caption, `publish_at` defaulting to Monday
      7:00 AM ET (shown in both ET and UTC), and a `ready` toggle
- [ ] Caption and first-comment defaults in code, with TikTok's default hashtags plus
      `extra_hashtags`
- [ ] `/admin/social/next` and `/admin/social/verify`:
  - server-rendered pages that are easy for an agent to read
  - forms for each channel's status and post URL
  - the `social` role allowed
  - JSON API underneath
- [ ] A `social` account for Modron, signed in by hand once in its Chrome profile
- [ ] Chrome scheduled tasks: Wednesday (schedule) and Monday about 7:20 AM ET (verify and post
      the first comment), rehearsed against the staging branch deploy
- [ ] Thursday check (Netlify scheduled function) that alerts you about channels not yet
      `scheduled`. Choose how the alert is sent; a transactional email provider is not in the
      MVP
- [ ] Update `docs/social/README.md` and supersede `WEEKLY_SOCIAL_POSTING_PLAN.md`

## Later, not in the MVP

- Email login, magic links and transactional email
- Importing Drive photos, matched to events by capture date
- Linked Bring a Friend referrals, chosen from that day's check-ins
- Editable caption, hashtag and comment settings
- Deleting attendees or erasing their data
- Cancelled events affecting streaks (the `events` table as the official schedule, per ADR 0004)
- An MCP server over the admin JSON API
- Posting through the platforms' APIs, one channel at a time
- Moving to Neon's managed Better Auth once it supports standalone backends
