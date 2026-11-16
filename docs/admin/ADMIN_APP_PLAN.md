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
  feature. After creating the `dev` branch, and again after every reset, set new passwords for
  `checkin_writer` and `admin_app` on `dev`. Store them in Netlify's branch-scoped environment
  variables. Keep this as a script in `NEON_PERMISSIONS.md`.
- Staging holds real attendee data and production's Better Auth users, so it needs the same login
  protection as production.
- Neon Free: 10 branches and 100 CU-hours a month across the project, 1 GB of Postgres, and 5 GB
  of object storage.

## Phase 0: check what we haven't confirmed yet (no production code)

Each item gets a short spike on the `dev` branch deploy. A failure goes back to the ADR it came
from before anything else proceeds.

- [ ] **Astro + Netlify:**
  - per-route prerendering alongside `backend/netlify/functions`
  - CDN caching of rendered pages, and clearing it when an event is saved (cache tags or the
    purge API)
- [ ] **Better Auth:**
  - running in Astro on Netlify
  - `getSession` from a function
  - `disableSignUp` for email/password
  - the 2FA plugin
  - passkeys on 716coffee.club
  - 30-day sliding sessions
  - where rate-limit counters are stored
  - version and license
- [ ] **Neon:**
  - whether changing a role password on `dev` leaves `production` unchanged
  - whether Object Storage is GA or beta
  - presigned PUT from mobile Safari and Chrome
  - whether files inherited by a branch count toward the 5 GB limit
- [ ] **Media:**
  - whether iOS Safari turns HEIC into JPEG when a photo is picked
  - whether the browser can resize HEIC
- [ ] **Chrome tasks:**
  - a scheduled task runs with nobody present, since unofficial reports say runs can wait for a
    click
  - whether Business Suite and TikTok Studio can schedule a first comment
  - whether Threads links are clickable
- [ ] **LinkedIn CLI:** the API version pinned in `tools/linkedin-events` config, since 202511
  was retired on 2026-11-16

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
