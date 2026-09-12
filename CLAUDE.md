# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Monorepo for Buffalo Open Coffee Club (BOCC) — a weekly Tuesday morning networking event in Buffalo, NY. Contains the public website, backend API, and all program documentation.

**Production URLs:**
- Website: https://716coffee.club
- Backend API: https://716coffee.club/.netlify/functions/ (same-origin with the website)
- Community: https://www.716.social

## Repository Structure

```
bocc/
├── website/          Jekyll static site (Netlify Site #1)
├── backend/          Netlify Functions API (Netlify Site #2)
└── docs/             All documentation
    ├── onboarding.md
    ├── architecture.md
    ├── backend/      Backend technical docs, epics, stories, tasks
    ├── website/      Website docs
    └── strategy/     Social media and brand guides
```

---

## Website (`website/`)

### Build & Development Commands

```bash
cd website
bundle install

# Local development
bundle exec jekyll serve

# With SSL (required for Eventbrite embed checkout)
bundle exec jekyll serve --host localhost --ssl-key ssl/localhost.key --ssl-cert ssl/localhost.crt
```

SSL certs are generated locally (see README.md). Ruby version managed via `website/.ruby-version`.

**Important:** `_config.yml` changes require a server restart (Jekyll does not auto-reload config).

### Architecture

- **Static site generator**: Jekyll with `github-pages` gem, using `minimal-mistakes` remote theme (v4.26.2, `sunrise` skin)
- **Hosting**: Netlify (base directory: `website/`, build command: `bundle exec jekyll build`)
- **Custom domain**: `716coffee.club` (DNS managed in Netlify)

### Key Pages

All Markdown with YAML front matter:
- `index.md` — Landing page with embedded Eventbrite checkout widget (event `1983098086761`)
- `about.md` — `/about/` — Event history, photo gallery
- `sponsorship.md` — `/sponsorship/` — Sponsor pitch with LinkedIn testimonial gallery
- `code-of-conduct.md` — `/code-of-conduct/`

### Check-in System

- `checkin/bocc.html` and `checkin/bocc-afternoon.html` — HTML forms for event check-in
- `js/checkin.js` — Client-side form handler (12KB)
  - Stores return visitor data in `localStorage` (30-day TTL)
  - POSTs to `/.netlify/functions/checkin` (same-origin)
  - URL parameters: `debug`, `token`, `eventId`, `local` (set `local=1` to skip API calls)
  - Input sanitization, honeypot spam detection, sponsor redirect countdown
- `_data/sponsor.yml` — Sponsor redirect configuration
- `_includes/head/custom.html` — CSP headers, structured data, Google Analytics

### Images

All stored in `assets/images/`. Header overlay image reused across multiple pages.

---

## Backend (`backend/`)

### Build & Development Commands

```bash
cd backend
npm install

# Run all tests (~299 tests across 10 suites)
npm test

# Unit tests only (exclude integration)
npm run test:unit

# Integration tests (requires real API tokens)
npm run test:integration

# Automated local smoke test
npm run test:smoke-local

# Production smoke test
npm run test:smoke-prod

# Local dev (requires Netlify CLI + env vars)
netlify dev
```

### Architecture

**Deployment:** Netlify Functions (serverless), auto-deploys from `main` (base directory: `backend/`)

**Three functions:**
- `checkin.js` — Main check-in POST endpoint
- `profile-photo-enforcement.js` — Scheduled weekly (Mondays 9:00 AM EST, cron in `netlify.toml`)
- `profile-photo-enforcement-manual.js` — HTTP manual trigger (supports `?dryRun=true`)

**Module System:** CommonJS (`require`/`module.exports`)

### Core Check-in Workflow

1. Form sends attendee data (email, name, phone, businessName, okToEmail) + eventId + debug flag + token
2. API validates all inputs via `utils/validation.js`
3. Finds or creates the attendee in Postgres `attendees` (by lowercased email)
4. Inserts the check-in into Postgres `checkins`. Same-day duplicates are rejected by a unique index and return "already checked in"
5. Reads the attendee's streak from the `streaks` view (non-fatal)
6. For non-debug check-ins: invites to Circle.so + increments `checkinCount` (non-blocking)

### Data Storage (Neon Postgres + legacy Airtable)

**Check-ins live in Neon Postgres** (project `young-queen-80162551`, branch `production`). See ADR 0005.
- `attendees`: id (uuid), email (unique), name, phone, business_name, ok_to_email, debug, legacy_airtable_id
- `checkins`: id, attendee_id → attendees, event_id, token, checkin_at, checkin_date (Eastern), debug, legacy_airtable_id
- Views: `held_occurrences`, `streaks` (recompute-on-read, ADR 0004)
- Schema lives in `backend/db/migrations/`. Apply with `npm run migrate` (owner URL from gitignored `.env.local`)
- The app connects as least-privilege `checkin_writer` (SELECT/INSERT only). The owner credential is never in Netlify. See `docs/backend/NEON_PERMISSIONS.md`

**Airtable** now holds only `No Photo Warnings` (enforcement) plus the read-only historical `attendees`/`checkins` (the free base is full). See `docs/backend/AIRTABLE_SCHEMA_PHOTO_WARNINGS.md`.

### Community Platform (Circle.so)

- Attendees auto-invited after check-in; check-in counter tracked via custom field
- Admin API v2 at `https://app.circle.so/api/admin/v2` (auth: `CIRCLE_API_TOKEN`)
- Headless Auth API at `https://app.circle.so/api/v1/headless` (auth: `CIRCLE_HEADLESS_API`)
- Headless Member API at `https://app.circle.so/api/headless/v1` (auth: member JWT)
- Bot user "716.social Bot" (`bocc-bot@zackglick.com`) sends enforcement DMs

**Important:** `app.circle.so` is the live API server. `api.circle.so` and `api-headless.circle.so` are documentation sites, NOT API endpoints.

**Limitation:** Circle.so Admin API v2 does NOT expose audience segments. The codebase fetches all members and filters client-side (see `docs/backend/CIRCLE_SEGMENTS_RESEARCH.md`).

### Profile Photo Enforcement

Progressive warning system (4 warnings → deactivation):
- `utils/enforcement-logic.js` — Warning decision engine
- `utils/message-templates.js` — Bot story arc DMs in TipTap JSON format
- `utils/airtable-warnings.js` — Warning tracking in Airtable
- Safety limits: 500-member warning, 1000-member hard cap
- See `docs/backend/716-bot-final-messaging.md` for message spec

### Environment Variables

Required (set in Netlify dashboard, never committed):
- `CHECKIN_DB_URL`: pooled Neon URL for the `checkin_writer` role (never the owner URL)
- `AIRTABLE_API_KEY`: Airtable API key (enforcement warnings)
- `AIRTABLE_BASE_ID`: BOCC Airtable base ID
- `CIRCLE_API_TOKEN`: Circle.so Admin API v2 token
- `CIRCLE_HEADLESS_API`: Circle.so Headless Auth API token

Optional:
- `CHECKIN_STORE`: `postgres` (default) or `airtable` (legacy rollback only)
- `ALLOWED_ORIGIN`: CORS origin (defaults to `*`, set to `https://716coffee.club` in production)

Local operator-only files (gitignored, never deployed): `.env.local` (Neon owner URL from `neon link`), `.env.backfill` (checkin_writer URL + Airtable creds). The Neon CLI authenticates with a project-scoped API key in `~/.config/neon/api-key` (`NEON_API_KEY="$(cat ~/.config/neon/api-key)" neon …`), because browser login doesn't work on this remote machine.

See `docs/backend/NEON_PERMISSIONS.md` and `docs/backend/CIRCLE_PERMISSIONS.md` for permissions documentation.

### Code Patterns

**Postgres check-in store** (`utils/pg-store.js`, parameterized SQL only):
- `findOrCreateAttendee({ email, name, phone, businessName, okToEmail, debug })`
- `insertCheckin({ attendeeId, eventId, token, debug, checkinDate })` → `{ created }`. `created: false` means a same-day duplicate
- `getStreak(attendeeId, eventId)` reads the `streaks` view
- `utils/db-ssl.js` `toPgConfig(url, extra)`: verify-full TLS, strips `sslmode` from URLs

**Airtable operations** (`utils/airtable.js`, legacy rollback path; `utils/airtable-warnings.js` for enforcement):
- `fetchAttendeeByEmail(email)` — Query with formula injection protection
- `createAttendee(email, name, phone, businessName, okToEmail, debug)`
- `createCheckinEntry(attendeeId, eventId, debug, token)`
- `findExistingCheckin(attendeeId, eventId, token)` — Same-day duplicate check

**Circle.so operations** (`utils/circle.js`):
- `ensureMember(email, name)` — Find or create (idempotent)
- `incrementCheckinCount(memberId, currentCount)`
- `getMembersWithoutPhotos()` — Fetch all + client-side filter
- `deactivateMember(memberId)`

**Input validation** (`utils/validation.js`):
- `validateCheckinInput(input)` → `{ isValid, errors, sanitized }`
- `escapeAirtableFormula(value)` — Formula injection protection
- Email (RFC 5322), phone, eventId, token validators

### Testing Strategy

- ~355 Jest tests across 19 suites (checkin, check-in stores, pg-store, db-ssl, config, validation, deduplication, circle, enforcement, messages, warnings, member API)
- Unit tests mock `pg`, Airtable, and Circle, so no database or API keys are needed
- Integration tests require `RUN_INTEGRATION_TESTS=true` + real API tokens
- Smoke tests: `test:smoke-local` (automated), `test:smoke-prod` (deployed)
- Use `debug: "1"` for all test submissions

### Common Tasks

**Adding fields to check-in:**
1. Add a new migration file in `backend/db/migrations/` (never edit an applied one). Grant `checkin_writer` access if it's a new table
2. Run `npm run migrate` (owner URL in `../.env.local`) **before** deploying code that uses it
3. Add validation in `utils/validation.js`
4. Update `findOrCreateAttendee()` or `insertCheckin()` in `utils/pg-store.js`
5. Add tests

**Modifying enforcement:**
1. Message copy: `utils/message-templates.js` (see `docs/backend/716-bot-final-messaging.md`)
2. Warning logic: `utils/enforcement-logic.js`
3. Schedule: `netlify.toml` cron expression
4. Test with manual endpoint + `?dryRun=true`

---

## Deployment

A **single** Netlify site deploys from `main` and serves both the website and the
backend functions (config in the root `netlify.toml`). The API is same-origin with
the website, so no CORS is required.

| Part | Source | Served at |
|------|--------|-----------|
| Website (Jekyll) | `website/` → `website/_site` | `https://716coffee.club` |
| Functions (API) | `backend/netlify/functions/` | `https://716coffee.club/.netlify/functions/` |

Each push to `main` triggers one build = **15 credits**. Free tier = 300 credits/month. Limit pushes to `main` to batching work on `dev` (docs-only changes still rebuild the single site, so batch them too).

---

## Git Workflow

- **`main`** — Production. The single Netlify site auto-deploys.
- **`dev`** — Active development. Test locally, then merge to `main`.

Commit frequently on `dev`. Merge to `main` only when ready to deploy. Each merge = 15 credits.

Run `npm test` in `backend/` and verify Jekyll builds in `website/` before merging to `main`.

---

## Documentation

All docs live in `docs/`:
- `docs/onboarding.md` — Start here (new volunteers and AI agents)
- `docs/architecture.md` — End-to-end system overview
- `docs/backend/` — Backend epics, stories, tasks, API docs, safety specs
- `docs/website/` — Website future work, event runbooks
- `docs/strategy/` — Social media strategies, brand guide
