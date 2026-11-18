# Phase 5 release: the social work order

Operator runbook for Zack. Staging comes first: Neon `dev` plus the `dev` branch deploy, 0
credits. Production then ships in **the same release as Phases 3 and 4**: one merge, one
15-credit deploy. Background:
- [ADR 0011](../adr/0011-social-posting-via-chrome-work-order.md), including decision 5 as
  amended 2026-11-18 (the ntfy push)
- [the plan](ADMIN_APP_PLAN.md), Phase 5
- roles and env vars: [NEON_PERMISSIONS.md](../backend/NEON_PERMISSIONS.md)
- the weekly flow: [docs/social/README.md](../social/README.md)
- the Chrome task prompts: [docs/social/CHROME_TASKS.md](../social/CHROME_TASKS.md)

Rules for every step:
- Never print a connection string, credential, secret or the ntfy topic.
- Never give a non-production context a production value.
- Never let a rehearsal touch the real BOCC social accounts unless the step says so.

## What changes

- **Event page.** `/admin/events/YYYY-MM-DD/` gets a "Social post" section (part A):
  - the promo video upload (MP4/MOV up to 100 MB, presigned PUT like the photos)
  - the base caption, extra TikTok hashtags, a cover note and the publish time (default Monday
    7:00 AM ET, shown in both ET and UTC)
  - per-channel caption and first-comment overrides
  - a **Ready** toggle, refused until the post is complete
  - the readiness checklist gains the social lines
- **Social pages.** `/admin/social/next/` and `/admin/social/verify/`, with their JSON under
  `/api/admin/social/*` (part B), are for the `social` role and admins. The guard keeps the
  `social` role on these pages, the admin home and its own account page. Everything else
  answers 403.
- **Thursday check** (part C). The new scheduled function `social-check`
  (`backend/netlify/functions/social-check.mjs`) runs **Thursdays at 14:00 UTC**, which is 9:00 AM
  EST or 10:00 AM EDT.
  - It checks the next Tuesday and sends an ntfy push when there is no post, the post isn't
    ready (the push lists the problems), or any channel isn't `scheduled`/`live`.
  - If all is well, it only logs. A cancelled event never alerts. If it can't read Neon, it
    pushes "the Thursday check failed".
  - The push's link opens `/admin/social/next` on that context's site: production uses
    Netlify's site URL (`https://716coffee.club`), staging uses `BETTER_AUTH_URL`.
  - Deploy previews never send.
  - Function log lines start with `[social-check]` (Netlify → Logs → Functions →
    `social-check`). They never contain the topic.
- **Migrations:**
  - `20261122120000_social_posts.sql`: the two tables; `admin_app` SELECT/INSERT/UPDATE
  - `20261123120000_social_checker.sql`: the new read-only `social_checker` role, created
    `NOLOGIN`
  Both are additive, and production's current code never touches them.
- **Admin CSP.** `media-src` now names the bucket origin as well as `'self'`, so the promo video
  plays from its presigned GET (`src/lib/admin/headers.mjs`).

**Scheduled functions and branch deploys.** Netlify runs a scheduled function on its schedule
only on the **published production deploy**. Branch deploys and deploy previews never trigger
it, and it can't be invoked by URL. On staging, trigger it by hand: Netlify → the site → **Logs
→ Functions**, choose the `dev` branch deploy, open `social-check`, and click **Run now**. The
same button works in production. Locally, `netlify dev` followed by
`netlify functions:invoke social-check` calls it once; it needs the env vars in your shell.

## New environment variables

| Var | Contexts | Value |
|---|---|---|
| `SOCIAL_CHECK_DB_URL` | Production; Branch deploys + Deploy Previews | that branch's **pooled** `social_checker` URL. Secret |
| `SOCIAL_ALERT_NTFY_TOPIC` | Production; Branch deploys + Deploy Previews | a long random topic, **different per context**, e.g. `bocc-alert-` + `openssl rand -hex 16`. Secret. Unset = no alerts (the check logs "not set" and stops) |
| `SOCIAL_ALERT_NTFY_SERVER` | optional | leave unset (`https://ntfy.sh`) |

The Click link uses existing variables: Netlify's own `URL` / site URL, and `BETTER_AUTH_URL`.

## Before you start

- [ ] `cd backend && npm test`, `npm run test:db` (needs Docker) and `npm run build` pass on
  `dev`.
- [ ] Phase 4's staging steps are done ([PHASE4_RELEASE.md](PHASE4_RELEASE.md)). The Ready
  toggle needs the Luma listing from the links import.
- [ ] Install the **ntfy** app on your iPhone (free, no account). Allow notifications. Don't
  subscribe yet: the topics are made in steps 3 and 13.

## Staging

1. [x] **Migrate Neon `dev`.** *(done 2026-11-18)* Put the owner URL of `dev` in `DATABASE_URL_UNPOOLED`, as in
   Phase 2, then run `cd backend && npm run migrate:status && npm run migrate`. Expect
   `20261122120000_social_posts.sql` and `20261123120000_social_checker.sql`, and nothing
   else.
2. [x] **`social_checker` on `dev`.** *(done 2026-11-18)* As `neondb_owner` on `dev`, with a fresh
   `openssl rand -hex 32` (never production's):
   ```sql
   alter role social_checker login password '<new hex>';
   ```
   Then check it as `social_checker` on `dev`. These should succeed:
   - `select count(*) from social_posts`
   - `select id, kind, status from event_media limit 1`

   These should fail with `permission denied`:
   - `select original_key from event_media limit 1`
   - `select 1 from attendees limit 1`
   - `update social_post_channels set status = status`
3. [x] **Netlify env, Branch deploys and Deploy Previews contexts:** *(done 2026-11-18)*
   - `SOCIAL_CHECK_DB_URL`: the **pooled** `dev` URL for `social_checker` (host with
     `-pooler`). Mark it secret.
   - `SOCIAL_ALERT_NTFY_TOPIC`: a new staging topic (`bocc-alert-` +
     `openssl rand -hex 16`). Mark it secret.

   In the ntfy app, subscribe to the staging topic on `https://ntfy.sh`.
4. [x] **Push `dev`.** *(done 2026-11-18)* Netlify → the `dev` deploy → Functions should list `social-check` as
   scheduled (`0 14 * * 4`).
5. [ ] **Your checks on https://dev--bocc-backend.netlify.app**, signed in as admin:
   - [ ] **On your iPhone**, open `/admin/events/<next Tuesday>/` and use "Social post" to
         upload a real promo video. The progress bar finishes, the video plays inline, and
         Safari shows no CSP error. Write a base caption. Check that each channel's final text
         is right:
         - Facebook, Threads and LinkedIn: caption plus "RSVP: <Luma>"
         - Instagram and TikTok: caption plus "Link in bio", with the Luma link as the first
           comment
         - TikTok: the hashtags too
   - [ ] Tick **Ready** and save. Then test the refusals: un-tick, delete the Luma listing,
         try Ready again (refused, naming the Luma listing), and put the listing back.
   - [ ] **Run the Thursday check by hand** with the post ready and every channel `pending`:
         Functions → `social-check` → Run now. Within a few seconds the phone gets a
         high-priority push:
         - title "BOCC social: 5 of 5 channels not scheduled for Tue …"
         - the five channels listed as pending
         - tapping it opens `/admin/social/next` on **dev**--bocc-backend, not 716coffee.club

         The function log has `[social-check] <date>: alert sent (…)` and no topic.
   - [ ] Un-ready the post and Run now again. The push says "post not ready". Mark it ready
         again.
6. [ ] **Modron's `social` account on staging.** In `/admin/users/`, create a user for Modron
   with the **social** role only. Modron sets the password and passkey there.
   **In Modron's Chrome profile**, Modron signs in once by hand at
   `https://dev--bocc-backend.netlify.app/login/`. Then, as that user:
   - [ ] `/admin/social/next/` shows the work order: the video download link, each channel's
         caption and form. `/admin/social/verify/` shows "Nothing to verify" until the publish
         time has passed.
   - [ ] `/admin/events/`, `/admin/attendees/` and `/admin/users/` answer 403, and so does
         any `/api/admin/*` path outside `/api/admin/social/` (except `/api/admin/me`). The nav
         shows only the social links.
   - [ ] Save Facebook as `scheduled` with a made-up `https://www.facebook.com/...` URL. The
         page confirms the save. Run now again: the push now lists 4 channels, without
         Facebook. Set Facebook back to `pending`.
7. [ ] **Chrome task rehearsal against staging.** Use the two prompts in
   [CHROME_TASKS.md](../social/CHROME_TASKS.md) with `{SITE}` =
   `https://dev--bocc-backend.netlify.app`.
   - Use a **test post** whose publish time is a day or more ahead, so nothing real goes out by
     surprise. Delete each scheduled test post on the platforms afterwards, by hand.
   - Or point the Wednesday prompt at the real accounts for a real week, but only once
     you're happy with the dry run.
   - [ ] **Signed out:** in a fresh profile with no session, the task stops at `/login/` and
         reports "Signed out", without typing anything.
   - [ ] **Nothing ready:** un-ready the post. The Wednesday task stops and quotes the reason.
   - [ ] **Wednesday run:** schedules each pending channel and saves `scheduled` plus the URL
         where one exists. Watch the first run live. Settle the open questions:
         - Threads web scheduling (ADR 0011 decision 3)
         - whether Modron's account can post as the LinkedIn page
           ([CHROME_TASKS.md](../social/CHROME_TASKS.md), setup step 4)
         - whether a scheduled task runs unattended on Modron's machine (ADR 0011
           consequences)
   - [ ] **Monday run** (after the test publish time): opens each post, marks it live, posts
         the first comment on Instagram and TikTok, and the page ends with "All done".
   - [ ] Run the Thursday check once more after the Wednesday run. **No push**, and the log
         says "every channel is scheduled or live; no alert".
   - [ ] Record the results in ADMIN_APP_PLAN.md Phase 5 and tick the Chrome-tasks line.
         Amend ADR 0011 if Threads or LinkedIn had to leave the task.

## Production (together with Phases 3 and 4)

These steps fold into the combined release in [PHASE4_RELEASE.md](PHASE4_RELEASE.md) ("Production
(together with Phase 3)"). Everything up to the merge happens before the one merge-and-push
(PHASE4_RELEASE.md step 13). The checks come after it.

8. [ ] **Migrations on `production`.** These come with PHASE4_RELEASE.md step 7, in the same
   `npm run migrate`. `migrate:status` now lists:
   - Phase 3's three migrations
   - `20261121120000_event_links_site_reader.sql`
   - `20261122120000_social_posts.sql` and `20261123120000_social_checker.sql`

   Check the grants:
   - `admin_app` has SELECT/INSERT/UPDATE on `social_posts` and `social_post_channels`, and no
     DELETE
   - `social_checker` has SELECT on `events`, `event_links`, `social_posts` and
     `social_post_channels`, plus the four `event_media` columns
   - `site_reader` has nothing on the social tables
9. [ ] **`social_checker` on `production`**: the same `alter role social_checker login
   password …` as step 2, with a **different** `openssl rand -hex 32`. Run step 2's checks as
   `social_checker` on production.
10. [ ] **Netlify, Production context:** set these two variables. Don't reuse the staging topic.
    - `SOCIAL_CHECK_DB_URL`: production's pooled `social_checker` URL. Secret.
    - `SOCIAL_ALERT_NTFY_TOPIC`: a **new** production topic. Secret.

    Subscribe to the production topic in the ntfy app. Keep the staging subscription too,
    named so the two can be told apart. In the ntfy app, a subscription's display name can be
    set to "BOCC staging" or "BOCC production".
11. [ ] **Merge and push:** PHASE4_RELEASE.md step 13. It is the single 15-credit deploy for
    Phases 3, 4 and 5.
12. [ ] **Check https://716coffee.club.** Do this after PHASE4_RELEASE.md step 14, as admin:
    - [ ] **Admin CSP:** on an event page, `curl -sI` or devtools shows
          `media-src 'self' https://br-noisy-poetry-a5q2e3cd.storage.c-1.us-east-2.aws.neon.tech`,
          with production's bucket host and not `dev`'s. The same host appears in `img-src` and
          `connect-src` (Phase 3's check). The promo video plays there with no CSP error in the
          console.
    - [ ] Netlify → the production deploy → Functions lists `social-check` as scheduled, with
          its next run on Thursday at 14:00 UTC.
    - [ ] Upload this week's real promo video on your iPhone, write the caption, check the
          per-channel texts, and mark it **Ready**.
    - [ ] **Run now** on production's `social-check`. The push arrives on the **production**
          subscription, and tapping it opens `https://716coffee.club/admin/social/next`. If
          every channel is already scheduled, there is no push; check the log line instead.
13. [ ] **Modron's `social` account on production.** Create it in `/admin/users/` with the
    social role only. It is a separate account from staging's. Modron signs in once by hand in
    the Chrome profile the tasks use. As that user:
    - `/admin/social/next/` works
    - `/admin/events/` answers 403
14. [ ] **Point the Chrome tasks at production.** Set `{SITE}` to `https://716coffee.club` in
    both scheduled tasks. Watch the first real Wednesday run, then confirm on Thursday that no
    push came: the log says "every channel is scheduled or live".

**Rollback:** Netlify → Deploys → the previous production deploy → "Publish deploy". This takes
Phases 3 and 4 back with it. The scheduled function goes with that deploy too. To stop only
the alerts, delete production's `SOCIAL_ALERT_NTFY_TOPIC` and redeploy. Leave the migrations
and the `social_checker` role in place: they are additive, and the old code ignores them.
