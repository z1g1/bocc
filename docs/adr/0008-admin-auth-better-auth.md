# ADR 0008 — Admin login with self-hosted Better Auth on Neon, with app-level roles

- **Status:** Accepted (2026-11-16). Phase 0 of the [admin app plan](../admin/ADMIN_APP_PLAN.md)
  must confirm the items marked *unverified*.
- **Date:** 2026-11-16
- **Deciders:** Zack Glick

## Context

The admin app needs a login for 1–3 people with two roles. One account is used by a Claude in
Chrome scheduled task (ADR 0011), so it needs a session that lasts across weekly runs. Login has
to work with Astro on Netlify Functions, and the data should stay in Neon. Email delivery is not
part of the MVP.

Options checked against current docs on 2026-11-16:

| Option | Result |
|---|---|
| Neon managed Better Auth ("Neon Auth") | GA and free, data in a `neon_auth` schema. But only Next.js and React are supported, and "Standalone frontend + backend", restricted sign-up and MFA are all "coming soon". Session length is not documented |
| Supabase Auth | Would bring back the free-plan inactivity pause that ADR 0005 moved away from |
| Cloudflare Access | Sessions up to a month and JWT checks at the origin, but it needs the domain proxied through Cloudflare. Netlify says that routing must be turned off so it can issue certificates |
| Netlify Identity | Its docs pages return 404 and it is gone from the docs index |
| **Better Auth library, self-hosted** | Uses a `pg` Pool, can use its own schema (`schemaName`), sessions slide forward (`expiresIn`/`updateAge`), the admin plugin supports custom access control, has passkey support, and `auth.api.getSession({ headers })` works in any function |

## Decision

1. **Run Better Auth in our own Netlify Functions** (through Astro), with its tables in an
   **`auth` schema in the existing Neon database**. Its SQL is generated and applied with
   `npm run migrate`, like every other migration.
2. **Login methods:** password plus passkey for admins, and a password for the `social`
   account. No magic links, email codes or email resets in the MVP.
3. **No public sign-up.** Accounts are created by an admin (`create-admin` CLI or the admin UI).
   Password resets are done by an admin.
4. **Roles live in our own table and are checked in the app.**
   - `admin`: everything.
   - `social`: reads the social work order and its media, and updates channel status and post
     URLs. **It has no access to attendees, check-ins, streaks, the email list or the audit
     log.**
   - A user with no role sees nothing. This is what blocks access even if a sign-up path were
     left open.
5. **Sessions:** a 30-day sliding expiry, long enough for the weekly Chrome tasks.
6. **New database role `admin_app`.** The admin functions and Better Auth share one role, because
   the admin function reads sessions on every request anyway.
   - `auth` schema: full read/write on Better Auth's tables
   - `attendees`, `checkins`, `held_occurrences`, `streaks`: SELECT
   - `attendees`: **column-level UPDATE** on `ok_to_email`, `name`, `business_name`, `phone`.
     No DELETE anywhere on attendee or check-in data
   - `events`, `event_reports`, `event_links`, `event_media`, `social_posts`,
     `social_post_channels`: SELECT, INSERT, UPDATE. DELETE only on `event_media`
   - `audit_log`: **SELECT and INSERT only**, for every app role. Each change and its audit row
     are written in one transaction
   - `checkin_writer` is unchanged.

## Alternatives considered

See the table above. Neon's managed Better Auth is the natural upgrade once it supports
standalone backends and restricted sign-up. Both are built on Better Auth, so moving to it
should not require changing how the app calls login.

## Consequences

- We own Better Auth upgrades and its security configuration (trusted origins, cookie
  attributes, rate limiting).
- Roles are enforced by the app, and Postgres permissions are the backstop.
- No MFA beyond passkeys until the 2FA plugin is verified. Erasing an attendee stays a manual
  SQL task as the owner.
- *Unverified, Phase 0:*
  - `disableSignUp` for email/password (if it is missing, roles still block access)
  - The 2FA plugin docs (the page returned 404)
  - Where rate-limit counters are stored on serverless
  - Better Auth's Astro integration
  - The current version and license
- `docs/backend/NEON_PERMISSIONS.md` gains the `admin_app` identity and its verification
  checklist.
