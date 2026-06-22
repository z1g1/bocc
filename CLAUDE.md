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
3. Checks for duplicate check-in (same attendee, event, token, same day)
4. Fetches or creates attendee record in Airtable `attendees` table
5. Creates check-in record in Airtable `checkins` table
6. For non-debug check-ins: invites to Circle.so + increments `checkinCount` (non-blocking)

### Data Storage (Airtable)

Three tables: `attendees`, `checkins`, `No Photo Warnings`

- `attendees`: email, attendeeID, name, phone, businessName, okToEmail, debug
- `checkins`: id, checkinDate, eventId, Attendee (linked), email, name, phone, businessName, token, debug
- `No Photo Warnings`: Email, Name, WarningCount, Status, LastWarningDate, CreatedDate, MemberID, Notes

See `docs/backend/AIRTABLE_SCHEMA_PHOTO_WARNINGS.md` for full warning table schema.

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
- `AIRTABLE_API_KEY` — Airtable API key
- `AIRTABLE_BASE_ID` — BOCC database base ID
- `CIRCLE_API_TOKEN` — Circle.so Admin API v2 token
- `CIRCLE_HEADLESS_API` — Circle.so Headless Auth API token

Optional:
- `ALLOWED_ORIGIN` — CORS origin (defaults to `*`, set to `https://716coffee.club` in production)

See `docs/backend/CIRCLE_PERMISSIONS.md` for detailed API permissions documentation.

### Code Patterns

**Airtable operations** (`utils/airtable.js`):
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

- ~299 Jest tests across 10 suites (checkin, validation, deduplication, circle, enforcement, messages, warnings, member API)
- Integration tests require `RUN_INTEGRATION_TESTS=true` + real API tokens
- Smoke tests: `test:smoke-local` (automated), `test:smoke-prod` (deployed)
- Use `debug: "1"` for all test submissions

### Common Tasks

**Adding fields to check-in:**
1. Add field to Airtable table schema
2. Add validation in `utils/validation.js`
3. Update `createAttendee()` or `createCheckinEntry()` in `utils/airtable.js`
4. Add tests

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
