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
The **ADR changes** these findings led to are listed at the end of this phase. Zack accepted
all seven on 2026-11-16, and they are written into the ADRs.

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
  - [x] **Changed ADR 0011:** Business Suite does not post to Threads, and Instagram's "Share
        to Threads" only works for posts published immediately, so Threads is now its own
        Wednesday step. Third-party source; the first rehearsal confirms it.
        [Sprout](https://sproutsocial.com/insights/schedule-threads-posts/)
  - Notes: TikTok Studio schedules 15 min to 10 days ahead and needs a Business Account. LinkedIn
    Pages schedule 1 hour to 3 months ahead. Neither allows editing a scheduled post's content.
- [x] **LinkedIn CLI:** `tools/linkedin-events/bocc_events/config.py` pins `202609`, which is
      active until 2027-09-15. 202511 sunset on 2026-11-16, as expected.
      [LinkedIn versioning](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/migrations)

### ADR changes (accepted 2026-11-16, written into the ADRs)

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

Built on `dev` on 2026-11-16. Baseline: the live site, mirrored the same day (production's
`website/` matched `dev`; its last build was 2026-11-08T18:37:43Z). The port was built "as of"
that moment (`BOCC_TODAY=2026-11-08 BOCC_BUILD_TIME=2026-11-08T18:37:43Z`) and every file
compared.

- [x] Astro 7.4.12 at the repo root replaces `website/`, with every page ported. Node 24,
      telemetry off. Content stays in YAML (`src/data/`) and Markdown (`src/content/pages/`)
- [x] `checkin/bocc.html` is production's rendered file, byte for byte (`cmp` identical), and
      `js/checkin.js` is unchanged. The sponsor redirect now lives in the page's `data-sponsor-*`
      attributes, since the page is frozen. One later edit (2026-11-16, `3f71563`): the Wilson
      Foundation funding paragraph was removed from its footer, as from the site's, because the
      grant ended
- [x] `bocc-afternoon` retired, along with the unpublished demo post and two unused Jekyll
      leftovers (`head/custom.html`, `navigation.yml`)
- [x] Event pages are still built at build time from `luma_events.yml` (`src/lib/events.ts`)
- [x] Release checks, local build against the live baseline:
  - **File list:** matches, except the retired `checkin/bocc-afternoon.html`
  - **HTML:** 20 of 21 pages identical after normalizing whitespace and entities. The brand
    page differs only in kramdown's syntax-highlighting wrappers around one code block (same
    text, no CSS targets them)
  - **JSON-LD and CSP:** unchanged on every page (compared as parsed JSON and per directive)
  - **`llms.txt`, `sitemap.xml`, `robots.txt`:** byte-identical. `feed.xml` drops only its
    Jekyll `generator` tag, as do the pages' `<meta name="generator">`
  - **CSS:** the same 336 rules. Three differ only in notation (Dart Sass writes `transparent`
    as `#0000` and drops spaces in `calc()`)
  - Two fixes were needed to match: SmartyPants mode 2 (kramdown's en dashes), and `/about/`
    getting `WebSite` JSON-LD like the home page, which is what `jekyll-seo-tag` did
- [x] Release checks on the `dev` branch deploy (https://dev--bocc-backend.netlify.app),
      2026-11-16:
  - Every route behaves like production (pages, `/checkin/bocc` pretty URL, the 302 for expired
    event dates, the custom 404). A mirror of the deploy matches the local build except for
    build timestamps, and the deployed `checkin/bocc.html` and `js/checkin.js` are
    byte-identical to production's. `/checkin/bocc-afternoon` now returns 404, as intended
  - A `debug: "1"` check-in returned 200 and its row landed in the **Neon `dev` branch**; a
    read-only lookup on production found nothing
- [x] Update `CLAUDE.md`, `README.md`, `architecture.md`, `onboarding.md` and the docs that
      pointed into `website/`
- [x] Check-in page brought into Astro (2026-11-16, Zack's call; amends ADR 0007 decision 3).
      `src/pages/checkin/bocc.astro` uses the site layout with `analytics={false}`, and the
      sponsor redirect is back in `src/data/sponsor.yml`. The build moves the output to
      `checkin/bocc.html` (`astro.config.mjs`), so `/checkin/bocc` is served without a redirect,
      as before. Against the frozen file: same markup, CSP, metadata and JSON-LD, differing only
      in whitespace, the dropped Jekyll comment and generator tags, and one `'` written as
      `&#39;`. `js/checkin.js` is unchanged. A headless-Chromium run with `?local=1` showed the
      thank-you message and sponsor countdown with no console or CSP errors
- [x] Release check on the `dev` branch deploy for the Astro check-in page (2026-11-16, `7e63e50`):
  - `/checkin/bocc` and `/checkin/bocc?token=…&debug=1` return 200 with no redirect;
    `/checkin/bocc/` 301s to `/checkin/bocc`. The deployed page is byte-identical to the local
    build, has no analytics, and `js/checkin.js` is byte-identical to `public/js/checkin.js`
  - A form submission in headless Chromium returned 200 and showed the thank-you message and
    sponsor countdown, with no console errors. Note: `js/checkin.js` never sends `debug` to the
    API (by design), so a form test always writes a non-debug row. This one is on the Neon `dev`
    branch (`astro-staging-20261116t211245@example.com`). Use a direct API POST for debug rows
  - A direct `debug: "1"` POST returned 200 and its row landed in the Neon `dev` branch with
    `debug = true`. A read-only lookup on `production` found neither test row
- [x] Merge to `main` (one production deploy), with Zack's go-ahead: 2026-11-16, fast-forward
      to `867dffa`. Checked on https://716coffee.club: every page, event page, `sitemap.xml`,
      `feed.xml`, `llms.txt` and `robots.txt` returns 200; an expired event date 302s to `/`; an
      unknown path gets the custom 404; `/checkin/bocc` (with and without `?token=`) returns 200
      without a redirect, matches the local build byte for byte and has no analytics;
      `js/checkin.js` is unchanged; no funding text; the page loads in headless Chromium with
      no errors. A direct `debug: "1"` POST returned 200 and its row is in Neon `production` with
      `debug = true` (`astro-release-debug-20261116t212035@example.com`)

## Phase 2: login, roles and data views (ADR 0008)

- [x] Migration:
  - `auth` schema from Better Auth's generated SQL
  - `user_roles`
  - `audit_log`
  - the `admin_app` role and its permissions
  - update `NEON_PERMISSIONS.md` and its verification checklist
- [x] Login:
  - password and passkey
  - no public sign-up
  - `create-admin` for your account
  - an admin page to create users and reset passwords
- [x] Every `/admin/*` route and admin API checks the session and role on the server. A user
      with no role sees nothing
- [x] **Check-ins** view: latest event by default, with a toggle for test rows
- [x] **Active streaks** view
- [x] **Email list** view, with CSV export (each export audited) and **opt-out**
      (`ok_to_email → false`, audited, in the same transaction)
- [x] Attendee corrections (name, business, phone), audited
- [x] Tests: role checks for each route, the `social` role denied attendee data, and the audit
      log can't be changed by `admin_app`
- [x] Built on `dev` 2026-11-16/17 (`55f7455`…`e7d8179`). Backend jest 152/152, `npm run test:db`
      87/87 (throwaway Postgres). The public site's build output is byte-identical. Notes:
  - The admin plugin's `createUser` skips `minPasswordLength` and its `setUserPassword` reads the
    plugin's `role` column, so `src/lib/admin/users.mjs` enforces the minimum (12) and resets
    through Better Auth's internal adapter. Creating a user can't share a transaction with its
    role grant (Better Auth writes on its own connection); a failed grant deletes the user again.
    A password reset writes its audit row first in an open transaction and commits after the
    reset, so `ADMIN_DB_POOL_MAX` must be at least 2
  - `BETTER_AUTH_URL` is required (no fallback to Netlify's `URL`/`DEPLOY_PRIME_URL`, which
    would bind passkeys to the wrong host) and must **not** be marked secret in Netlify: the
    secrets scanner then fails the build, since the URL appears throughout the repo
  - The adapter sends unmatched paths to its SSR function, so unknown URLs cost a function call
- [x] Staging, 2026-11-17 (https://dev--bocc-backend.netlify.app, deploy of `e7d8179`, Neon `dev`
      migrated, `admin_app` login enabled with its own password, Zack's admin account created):
  - No session: `/admin/*` 302s to `/login/?next=…`, `/api/admin/me` 401. Sign-up refused
    (`EMAIL_PASSWORD_SIGN_UP_DISABLED`), cross-origin sign-in 403 `INVALID_ORIGIN`, the admin
    plugin's `/api/auth/admin/*` 404. `/login/` sends `noindex`, `no-store` and the strict CSP
  - Throwaway users, deleted afterwards: no role → 403 on every admin page and API; `social`
    → 200 on `/admin/`, `/admin/account/` and `/api/admin/me` only, 403 on check-ins, streaks,
    email list, attendees, users, CSV export and opt-out
  - `/checkin/bocc` (with and without `?token=`) 200, byte-identical to production, no analytics;
    `js/checkin.js` identical. A `debug: "1"` POST returned 200 and landed in Neon `dev` with
    `debug = true`; nothing in production. An expired event date still 302s to `/`, an unknown
    path gets the custom 404, sitemap/feed/llms/robots 200
- [ ] Zack: sign in on staging and add a passkey
- [x] Production, 2026-11-17, with Zack's go-ahead: Neon `production` migrated, `admin_app` given
      its own password, `main` fast-forwarded to `9a0ca47`. Every admin route returned an empty
      500 and the function log was empty: the Production `ADMIN_DB_URL`/`BETTER_AUTH_SECRET`
      values were wrong (Netlify's API returns placeholders for secrets, so this couldn't be
      checked beforehand). Zack re-entered them; `fb0041e` (which logs such failures, with
      variable names only and connection strings redacted) went out as the redeploy. Then on
      https://716coffee.club:
  - `/admin/` 302s to `/login/`, `/api/admin/me` 401. A failed sign-in left its rate-limit
    row in Neon **production** and nothing in `dev`, which shows production's `ADMIN_DB_URL`
    is correct. Sign-up refused, cross-origin sign-in 403, `/api/auth/admin/*` 404, `/login/`
    `noindex` and `no-store`
  - Every public page, event page, sitemap, feed, `llms.txt`, `robots.txt` 200; an expired
    event date 302s to `/`; unknown path → custom 404. `/checkin/bocc` (with and without
    `?token=`) 200, same bytes as before, no analytics; `js/checkin.js` unchanged. A `debug:
    "1"` POST returned 200 and is in Neon `production` with `debug = true`
    (`phase2-release-debug-20261117t202057@example.com`), not in `dev`
- [x] Zack's production account (2026-11-17): `create-admin` → one user, `admin` role, a
      `user.create` audit row; signed in on 716coffee.club and added a passkey (the `rpID`
      check passed). **Phase 2 is complete.**

## Phase 3: Google Form replacement and media (ADRs 0009, 0010)

Release runbook: [PHASE3_RELEASE.md](PHASE3_RELEASE.md). Staging (Neon `dev` + the `dev`
branch deploy) has the migrations, storage env and both imports since 2026-11-17; the
on-device checks and production are open.

- [x] Migration: `events`, `event_reports`, `event_media` (`20261118120000`), plus
      `20261119120000` (HEIC originals for imported `signin_board` photos). Applied on `dev`
- [x] Neon bucket (private) and `storage:read`/`storage:write` credentials for staging and
      production (2026-11-17: a `bocc-media` bucket and credential on each branch; CORS
      locked to each branch's site origins)
- [x] `/admin/events/YYYY-MM-DD`:
  - status
  - location
  - cancel flow (reason, announced on socials). Since 2026-11-19 it is part of the status
    form: Cancelled is a third status whose reason fields show only while it is selected
    (CSS `:has()`), saved with the location in one UPDATE; choosing Scheduled or Held
    (past dates) leaves cancelled and clears the reason. The separate cancel and un-cancel
    forms are gone; the audit actions are unchanged.
  - report form (Gives and Asks count, notes, Bling given and details)
  - calculated check-in count shown next to the report
  - Built on `dev` 2026-11-17 (`src/lib/admin/events.mjs`). Audit actions `event.update`,
    `event.cancel`, `event.uncancel`, `event_report.submit`, `event_report.update`. A date
    without a row renders as a new scheduled event; the first save creates it. Reports are
    refused on cancelled events and on dates after today (Eastern); cancelling is refused
    once a report exists. Editing an imported report makes it `source = 'admin'`
- [x] Photo upload from a phone (`EventMedia.astro`, `/api/admin/media/*`, `public/js/admin-media.js`;
      admin only). The on-device check stays open in Phase 0 (presigned PUT from mobile Safari
      and Chrome):
  - the browser makes the 1600px JPEG and 400px thumbnail
  - uploads go straight to the bucket via presigned PUT
  - a gallery shown through short-lived GET URLs
  - each photo tagged `signin_board` / `social_photo`, with `publicly_usable`. Since
    2026-11-18 that is not a choice: social photos are always publicly usable (the posted
    photo waiver), sign-in board photos never (ADR 0010 decision 2, migration `20261120120000`)
  - pending uploads over a day old are listed on the event page for deletion; no storage
    configured shows a message and the APIs answer 503
- [x] Dashboard: upcoming events, and **"report missing"** for past dates still marked
      `scheduled` ("today" is the Eastern date). Also `/admin/events/`: upcoming, past (paged,
      `?missing=1`) and an open-a-date form
- [x] Import script for the Google Form CSV (fix `7/14/0026`), like the Airtable backfill:
      `backend/scripts/import-google-form.js` (dry run by default, `--apply` writes as the owner,
      idempotent, never overwrites `source = 'admin'`, one `event_report.import` audit row).
      Dry run of the real export: 135 rows (22 `google_form`, 113 `pre_form`), 3 year fixes,
      1 Bling inferred from the "who" column (Zack: names there mean Bling was given), 0
      errors. Two non-Tuesday dates are listed for information and imported as is
- [ ] Run the import on Neon: done on `dev` 2026-11-17 (135 created; a re-run changes nothing).
      Production pending (runbook step 8)
- [ ] Import the old sign-in board photos (45, from the Drive export) with a local script:
      HEIC converted on the operator's machine, matched to events by file-name date or capture
      date, dry-run match table confirmed by Zack first (ADR 0010, amended 2026-11-17).
      Script ready: `scripts/signin-photos/import.mjs` (dry run by default; `--apply --confirm`).
      Originals are stored as the untouched HEIC (migration `20261119120000`, `signin_board`
      only). Dry run done 2026-11-17 against the Form's dates (no Neon read): 10 of 45
      uncertain, all confirmed by Zack (3 date changes); with the confirm file it would import
      45 and create 2024-11-12 and 2026-08-18 as `held`. Applied on `dev` 2026-11-17 against the
      real events: 45 imported, 2024-11-12 created as `held`. Production pending (runbook step 8)

## Phase 4: event pages from the database and readiness checklist (ADR 0009)

- [x] Migration: `event_links` (and the `site_reader` role): `20261121120000_event_links_site_reader.sql`
- [x] Import `luma_events.yml` and the README URL table, then delete both:
      `backend/scripts/import-event-links.js` (dry run by default, `--apply`, `--prefer-db`).
      Both sources deleted 2026-11-18; the import reads them from git history (`829155c`).
      Run on `dev` and production: [PHASE4_RELEASE.md](PHASE4_RELEASE.md) steps 4 and 12
- [x] `/events/[date]` rendered from Neon on request and cached at the CDN, with the cache cleared
      on save:
  - Luma embed as the only call to action
  - `sameAs` in JSON-LD for the other listings
  - a real 404 for unknown dates
  - Built on `dev` 2026-11-18 (`src/pages/events/[date].astro`, `src/lib/site/`), read as
    `site_reader` (`SITE_DB_URL`). Cancelled and past dates get their own notice (past:
    `noindex`); `/events/` 302s to `/`; the sitemap is on demand too (tag `event-list`).
    Headers and purge scoping: `src/lib/site/http.mjs`, `src/lib/site/purge.mjs`. Release:
    [PHASE4_RELEASE.md](PHASE4_RELEASE.md). The Phase 0 open item (a staging purge leaves
    production's copy alone) is its step 14
- [x] Remove the Ruby build and the `/events/* → /` 302 (the Ruby build went with the Astro
      port; the 302 and the YAML readers are gone, and no event page is prerendered)
- [x] Readiness checklist on the admin event page: four links, the public page, and the social
      channels (once Phase 5 lands). Built 2026-11-18: the Listings forms and the checklist on
      `/admin/events/YYYY-MM-DD/` (`src/lib/admin/event-links.mjs`), "n/4 listings" on the
      events list and home. The social lines (post ready, then each channel's status) came with
      Phase 5 part A

## Phase 5: social work order (ADR 0011)

- [x] Migration: `social_posts`, `social_post_channels`: `20261122120000_social_posts.sql`
      (admin_app SELECT/INSERT/UPDATE, no DELETE; the video FK is on (event_date, id), so it is
      always the same event's media)
- [x] Promo video upload (`promo_video` media), base caption, `publish_at` defaulting to Monday
      7:00 AM ET (shown in both ET and UTC), and a `ready` toggle. Built on `dev` 2026-11-18: the
      "Social post" section on `/admin/events/YYYY-MM-DD/` (`src/components/admin/SocialPost.astro`,
      `src/lib/admin/social.mjs`, `/js/admin-video.js`). One MP4/MOV file up to 100 MB through the
      same presigned-PUT flow as photos; deleting the attached video un-readies the post. Ready is
      refused without a ready video, a base caption, the Luma listing, every caption within its
      platform's limit, and a future publish time. Per-channel caption and first-comment
      overrides, with the default and the final text shown
- [x] Caption and first-comment defaults in code, with TikTok's default hashtags plus
      `extra_hashtags`: `src/lib/admin/social-rules.mjs` (Facebook, Threads, LinkedIn: caption +
      "RSVP: <Luma>"; Instagram, TikTok: "Link in bio", Luma as the first comment;
      `TIKTOK_HASHTAGS`). The `getWorkOrder()` read is what `/admin/social/*` builds on
- [x] `/admin/social/next` and `/admin/social/verify`:
  - server-rendered pages that are easy for an agent to read
  - forms for each channel's status and post URL
  - the `social` role allowed
  - JSON API underneath

  Built on `dev` 2026-11-18 (part B): `src/pages/admin/social/{next,verify}.astro`,
  `src/lib/admin/social-pages.mjs`, `setChannelResult()` / `findNext()` / `findVerify()` in
  `social.mjs`, and `GET /api/admin/social/next`, `GET /api/admin/social/verify`,
  `POST /api/admin/social/channel`. No script; one `<section id="channel-<key>">` per channel,
  the exact texts in `<pre>`, "Save <Channel>" / "Mark <Channel> live|failed" / "First comment
  posted on <Channel>" buttons, PRG. Statuses: any change except live -> pending; scheduling
  needs an actionable post, live a post URL on the channel's domain, failed a note. The
  `social` role is fenced by the guard to `/admin/`, `/admin/account/`, `/admin/social/*`,
  `/api/admin/social/*` and `/api/admin/me` (`roles.mjs` `SOCIAL_PATHS`); everything else is
  403, unknown paths included
- [ ] A `social` account for Modron, signed in by hand once in its Chrome profile
- [ ] Chrome scheduled tasks: Wednesday (schedule) and Monday about 7:20 AM ET (verify and post
      the first comment), rehearsed against the staging branch deploy
- [x] Thursday check (Netlify scheduled function) that alerts you about channels not yet
      `scheduled`. The alert is an **ntfy.sh push** (decided 2026-11-18; ADR 0011 decision 5,
      amended), not email. Built on `dev` 2026-11-18:
      - `backend/netlify/functions/social-check.mjs`, Thursdays 14:00 UTC (9 AM EST, 10 AM EDT)
      - the pure rules and the ntfy call are in `src/lib/social-alert/alert.mjs`; the read is in
        `run.mjs`
      - it checks the next Tuesday: no post, post not ready (with its problems), or any channel
        not `scheduled`/`live`. If all is fine it only logs
      - it reads as the new read-only `social_checker` role (migration
        `20261123120000_social_checker.sql`, `SOCIAL_CHECK_DB_URL`)
      - env: `SOCIAL_ALERT_NTFY_TOPIC` (the only secret; unset = log and skip),
        `SOCIAL_ALERT_NTFY_SERVER` (optional)
      - on staging, trigger it with Netlify's **Run now** button
      ([PHASE5_RELEASE.md](PHASE5_RELEASE.md)). The first staging push is still to do
- [x] Update `docs/social/README.md` and supersede `WEEKLY_SOCIAL_POSTING_PLAN.md`. The two
      Chrome task prompts are in [`docs/social/CHROME_TASKS.md`](../social/CHROME_TASKS.md)

## Phase 6: LinkedIn events and the event-page prefactor (ADR 0012)

Spec: GitHub issue #18. One combined production release with the prefactor and the LinkedIn
work (to save deploy credits); everything is verified on staging first.

- [ ] Event page tabs (#19): Readiness above three server-rendered tabs, `?tab=info|social|post`,
      default Event Info for a future date and Post Event for today or earlier (Eastern time),
      every form returning to its tab. Renames: "Listings" → **Online Event Listings**,
      "Social photos" → **Photos from Event** (labels only; `social_photo` and the
      `event_links` slots are unchanged)
- [ ] Event Image (`event_image` media: upload or reference a recent publicly usable photo,
      the logo as the default, a 16:9 cover copy), previews and downloads for the hand-entered
      listings, and the Social Post cover image defaulting to it
- [ ] Migrations: `linkedin_connections` (token encrypted under `LINKEDIN_TOKEN_KEY`),
      `linkedin_events` (the ledger, unique on `event_date`), the `event_media` changes and the
      social post's cover. Grants: `admin_app` SELECT/INSERT/UPDATE on both (DELETE on
      connections only), `social_checker` the connection expiry only, nothing for
      `site_reader`/`checkin_writer`
- [x] LinkedIn OAuth connect, status ("Connected as …, expires …"), reconnect and disconnect,
      for Admins (#23: `/api/admin/linkedin/{connect,callback,disconnect}`, the LinkedIn client
      adapter and use-case in `src/lib/linkedin/`). Still to do on the LinkedIn app: add the
      production and staging callback URLs
- [ ] The LinkedIn event section on Event Info (#38: moved from Social Posts, after the Event
      Image; it is made Tuesday afternoon for the next week's event, alongside the other
      online listings, and its actions and the OAuth return land on `?tab=info`): preview, "Create live event" with a confirm
      dialog (Publish event too, with its own dialog), dry run everywhere but production (`LINKEDIN_LIVE=1`), the ledger state machine
      (`pending` → `created` → `posted`) with Publish-retry and allow-retry, duplicate guards,
      the `linkedin_event` listing filled on post, drift and cancellation notices
      (#25 done: `linkedin_events` ledger migration, the preview, the dialog with
      `confirm=live`, the allowed-actions matrix, the organizer duplicate check and the dry
      run. #26 done: the live sequence, `pending` committed before anything is sent, each
      transition audited `linkedin_event.{pending,created,posted,retire}`, the listing filled
      with `posted` in one transaction, "Publish event" retrying only the post, "I checked:
      nothing was created, allow retry" retiring a `pending` row, and LinkedIn errors in plain
      language. A failed step leaves the last committed state, even when LinkedIn clearly
      refused before creating anything: the page then says it is safe to allow retry.
      #27 done: drift is flagged, not synced: once posted, a change of location (by its
      wording: not set reads as the lobby) or of the Event Image's cover shows "LinkedIn is
      out of date…" in Readiness and the LinkedIn section, linking the event (a CLI-imported
      row with no image recorded compares the location only). A cancelled event with a
      posted row shows a red "Cancel the LinkedIn event on LinkedIn" item in Cancel and
      Readiness until "Done on LinkedIn" (audited `linkedin_event.cancel_ack`))
- [x] Readiness lines: Event Image, LinkedIn posted, LinkedIn out of date, cancel on LinkedIn
      (#21/#27, and "LinkedIn event posted" from the review fixes: done once the ledger row is
      posted, linking the event; no line for a cancelled event, where the cancel line takes over)
- [x] Thursday check: ntfy alert when the LinkedIn connection has under 10 days left
      or has expired, naming whose it is and pointing at `/admin/account/` (#24: a second,
      independent check in `src/lib/social-alert/run.mjs`; migration
      `20261126120000_social_checker_linkedin.sql` gives `social_checker` only
      `linkedin_connections (user_id, expires_at, display_name)`, and nothing in `auth`: the
      alert names the connection by its LinkedIn display name. If the connections can't be
      read, it pushes its own "the Thursday check couldn't read the connection" alert rather than
      staying silent)
- [ ] Env: `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_TOKEN_KEY` (both
      environments), `LINKEDIN_LIVE=1` (production only)
- [ ] Import the CLI's local ledger into `linkedin_events` before the first webapp create.
      Script ready (#28): `backend/scripts/import-linkedin-ledger.js` (dry run by default,
      `--apply`, `--prefer-db`; rules in its header). It reads the CLI's
      `~/.local/state/bocc-linkedin/ledger.json` (or `--ledger <file>`), so run it on the
      machine that ran the CLI, **with the production owner URL, after the Phase 6
      migrations and before the first web create** (dev first, as a rehearsal):
      ```sh
      cd backend
      node --env-file=../.env.local scripts/import-linkedin-ledger.js           # dry run vs production
      node --env-file=../.env.local scripts/import-linkedin-ledger.js --apply
      node --env-file=../.env.local scripts/import-linkedin-ledger.js           # again: unchanged N, conflicts 0
      ```
      `posted` and `created` entries become ledger rows (created_by and the image null);
      `pending` entries are SKIPPED and listed: check LinkedIn for that week, then finish it
      with the CLI (`bocc-event post`) or `bocc-event forget` it, and re-run. A posted week
      with no `linkedin_event` listing gets one. A stored web row that disagrees is a
      CONFLICT and refuses `--apply` unless `--prefer-db` (keeps the stored row). One
      `linkedin_event.import` audit row per run that changed something. Afterwards each
      imported week's Event Info tab shows **Posted on LinkedIn** with the event and post
      links, and Create live event is refused for it
- [ ] Release runbook (`PHASE6_RELEASE.md`): prefactor checked on staging, then production,
      **before** the first live create. Reminder: `LinkedIn-Version: 202609` sunsets
      2027-09-15
- [ ] After the first successful live create from production: delete `tools/linkedin-events/`,
      rewrite the LinkedIn permissions doc for the web OAuth flow and repoint the
      `bocc-linkedin-event` skill (docs-only, batched into a later deploy)

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
