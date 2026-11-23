# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Monorepo for Buffalo Open Coffee Club (BOCC) — a weekly Tuesday morning networking event in Buffalo, NY. Contains the public website, backend API, and all program documentation.

**Production URLs:**
- Website: https://716coffee.club
- Backend API: https://716coffee.club/.netlify/functions/ (same-origin with the website)

## Repository Structure

```
bocc/
├── src/              Astro website: pages, components, layouts, data (YAML), content (Markdown)
├── public/           Static files served as-is: images, fonts, JS, the check-in page
├── scripts/          Build helpers (scripts/build-css.mjs compiles the Sass)
├── backend/          Netlify Functions API (same Netlify site)
└── docs/             All documentation
    ├── onboarding.md
    ├── architecture.md
    ├── backend/      Backend technical docs, epics, stories, tasks
    ├── website/      Website docs
    └── strategy/     Social media and brand guides
```

---

## Website (Astro, repo root)

The site moved from Jekyll to Astro in November 2026 (ADR 0007). The repo root is
both the Netlify build base and the Astro project root.

### Build & Development Commands

```bash
npm install

npm run dev      # compiles the Sass, then `astro dev` on http://localhost:4321
npm run build    # compiles the Sass, then `astro build` into dist/
```

Node 24 (Astro 7 needs ≥ 22.23.4). Set `ASTRO_TELEMETRY_DISABLED=1`; Netlify sets it.

Reproducible builds: `BOCC_TODAY=YYYY-MM-DD` fixes which Tuesdays get event pages, and
`BOCC_BUILD_TIME=<ISO time>` fixes the timestamps in the sitemap, feed and event metadata.

**This dev VM** (QEMU CPU, no AVX2) can't run Astro's native compiler binding, and the build
dies with `Illegal instruction`. Locally only: `npm install --no-save --force
@astrojs/compiler-binding-wasm32-wasi@<same version as @astrojs/compiler-binding>` and move
`node_modules/@astrojs/compiler-binding-linux-x64-gnu` out of the way. Netlify is unaffected.

### Architecture

- **Framework**: Astro 7, `output: "static"`. Every page is prerendered at build time.
  Phase 2 of `docs/admin/ADMIN_APP_PLAN.md` adds `@astrojs/netlify` for on-demand routes.
- **Styles**: Sass in `src/styles/` compiled by `scripts/build-css.mjs` to
  `public/assets/css/main.css` (generated, gitignored), linked from `src/layouts/Default.astro`.
- **Markdown**: one renderer for everything, `src/lib/markdown.ts` (`marked` plus SmartyPants
  smart quotes, matching what kramdown produced).
- **Hosting**: Netlify, build command `npm run build`, publish `dist`
- **Custom domain**: `716coffee.club` (DNS managed at Hover)

### Where things live

- `src/data/site.yml` — site settings (was Jekyll's `_config.yml`): title, description, GA4 id, event facts
- `src/data/home.yml`, `nav.yml`, `event_page.yml` — page copy and navigation
- `src/data/luma_events.yml` — the Luma event for each Tuesday; add new dates here
- `src/content/pages/*.md` — About, Sponsorship, Code of Conduct, Privacy and the brand page.
  Front matter sets `permalink`, the page hero and optional `blocks`
  (prose | stats | quotes | gallery | feature | cta)
- `src/content/llms.txt` — text of `/llms.txt`; `{{ site.… }}` placeholders come from `site.yml`
- `src/pages/` — routes: `index.astro` (home), `[...slug].astro` (Markdown pages),
  `events/[date].astro`, `404.astro`, `sitemap.xml.ts`, `feed.xml.ts`, `llms.txt.ts`
- `src/components/Seo.astro` — title, description, Open Graph and page JSON-LD (same output
  `jekyll-seo-tag` produced); `EventJsonLd.astro` — Event and Organization JSON-LD
- `src/layouts/Default.astro` — the shell: CSP, fonts, scripts, header and footer. GA4 loads
  when `google_analytics_id` is set in `site.yml`
- `/events/YYYY-MM-DD/` — one page per upcoming Tuesday (next 13, skipping the Christmas and
  New Year's weeks), built by `src/lib/events.ts`. Each embeds its Luma event from
  `luma_events.yml`. Expired dates 302 to `/` (`netlify.toml`). Phase 4 moves these to Neon

### Check-in System

- `src/pages/checkin/bocc.astro` — the check-in form, served at `/checkin/bocc` (the URL in
  the printed QR codes, with `?token=<GUID>`). It uses the Default layout with
  `analytics={false}`. Keep its element IDs, the `#eventId` value and the `data-sponsor-*`
  attributes: `checkin.js` reads them. Styles: `src/styles/bocc/_checkin.scss`
- `public/js/checkin.js` — Client-side form handler
  - Stores return visitor data in `localStorage` (30-day TTL)
  - POSTs to `/.netlify/functions/checkin` (same-origin)
  - URL parameters: `debug`, `token`, `eventId`, `local` (set `local=1` to skip API calls)
  - Input sanitization, honeypot (`website` field) spam detection, sponsor redirect countdown.
    The server checks the honeypot too (#66, `isHoneypotFilled` in `utils/validation.js`): a POST
    with `website` filled writes nothing but gets the normal success response, and is logged
    with event id and request id only
- **Sponsor redirect**: `src/data/sponsor.yml` (`enabled`, `name`, `url`, `delay`); a change
  needs a deploy
- No analytics on the check-in page
- **Rate limit** (#67, ADR 0013): at most 200 check-in POSTs per client IP per clock hour
  (`x-nf-client-connection-ip`, never `X-Forwarded-For`), counted in Postgres
  (`checkin_rate_limit_hits`, SHA-256 of the IP only) by `utils/rate-limit.js` before the body
  is parsed. Over it: 429 with `Retry-After` and a `message` naming the minutes left in the
  window, and nothing written; `checkin.js` shows the server's message and keeps the form. A counter failure allows the check-in. Sized so a 150-person crowd on one
  venue Wi-Fi IP fits; env `CHECKIN_RATE_LIMIT` / `CHECKIN_RATE_WINDOW_SECONDS` override it
- `checkin/bocc-afternoon.html` was retired with the port (the afternoon series ended)

### Images

All stored in `public/assets/images/`. Brand files and palette: `public/assets/images/brand/`,
documented on the page `/assets/images/brand/` (`src/content/pages/brand-assets.md`).

---

## Backend (`backend/`)

### Build & Development Commands

```bash
cd backend
npm install

# Run all tests (175 tests across 10 suites)
npm test

# Automated local smoke test
npm run test:smoke-local

# Production smoke test
npm run test:smoke-prod

# Local dev (requires Netlify CLI + env vars)
netlify dev
```

### Architecture

**Deployment:** Netlify Functions (serverless), auto-deploys from `main` (base directory: `backend/`)

**One function:**
- `checkin.js` — Main check-in POST endpoint

**Module System:** CommonJS (`require`/`module.exports`)

### Core Check-in Workflow

1. Form sends attendee data (email, name, phone, businessName, okToEmail) + eventId + debug flag + token
2. API rate-limits the POST per client IP before parsing it (`utils/rate-limit.js`, ADR 0013). Over the limit: 429 and nothing written. Fails open
3. A filled `website` honeypot (`isHoneypotFilled`, `utils/validation.js`) writes nothing and gets the normal success response
4. API validates all inputs via `utils/validation.js`
5. Finds or creates the attendee in Postgres `attendees` (by lowercased email)
6. Inserts the check-in into Postgres `checkins`. Same-day duplicates are rejected by a unique index and return "already checked in"
7. Reads the attendee's streak from the `streaks` view (non-fatal)

### Data Storage (Neon Postgres)

**All data is written to Neon Postgres only** (project `young-queen-80162551`, branch `production`). See ADR 0005 and ADR 0006.
- `attendees`: id (uuid), email (unique), name, phone, business_name, ok_to_email, debug, legacy_airtable_id
- `checkins`: id, attendee_id → attendees, event_id, token, checkin_at, checkin_date (Eastern), debug, legacy_airtable_id
- Views: `held_occurrences`, `streaks` (recompute-on-read, ADR 0004)
- Schema lives in `backend/db/migrations/`. Apply with `npm run migrate` (owner URL from gitignored `.env.local`)
- The app connects as least-privilege `checkin_writer` (SELECT/INSERT only). The owner credential is never in Netlify. See `docs/backend/NEON_PERMISSIONS.md`

**Airtable** is a read-only archive of older records. The app no longer connects to it. `scripts/backfill-from-airtable.js` is the only code that reads it.

**Circle.so is retired** (subscription ended). The Circle integration and profile photo enforcement were removed. See ADR 0006. Do not add new Circle calls.

### Environment Variables

Required (set in Netlify dashboard, never committed):
- `CHECKIN_DB_URL`: pooled Neon URL for the `checkin_writer` role (never the owner URL)

Optional:
- `ALLOWED_ORIGIN`: CORS origin (defaults to `*`, set to `https://716coffee.club` in production)
- `CHECKIN_RATE_LIMIT` / `CHECKIN_RATE_WINDOW_SECONDS`: per-IP check-in limit (defaults 200 per
  3600 s, ADR 0013). Staging can set small values to demo the 429

Local operator-only files (gitignored, never deployed): `.env.local` (Neon owner URL from `neon link`), `.env.backfill` (checkin_writer URL + Airtable creds). The Neon CLI authenticates with a project-scoped API key in `~/.config/neon/api-key` (`NEON_API_KEY="$(cat ~/.config/neon/api-key)" neon …`), because browser login doesn't work on this remote machine.

See `docs/backend/NEON_PERMISSIONS.md` for permissions documentation.

### Code Patterns

**Postgres check-in store** (`utils/pg-store.js`, parameterized SQL only):
- `findOrCreateAttendee({ email, name, phone, businessName, okToEmail, debug })`
- `insertCheckin({ attendeeId, eventId, token, debug, checkinDate })` → `{ created }`. `created: false` means a same-day duplicate
- `getStreak(attendeeId, eventId)` reads the `streaks` view
- `recordAttemptUnderLimit({ clientKey, windowStart, limit })` → boolean: records one rate-limit attempt only if the window isn't full (insert-only, `checkin_rate_limit_hits`)
- `utils/db-ssl.js` `toPgConfig(url, extra)`: verify-full TLS, strips `sslmode` from URLs

**Rate limit** (`utils/rate-limit.js`, ADR 0013):
- `createRateLimiter({ store, limit, windowSeconds })` → `{ check(clientIp) }` → `{ allowed }` or `{ allowed: false, retryAfterSeconds }`. Never throws; fails open. Stores only the IP's SHA-256
- `rateLimitedMessage(retryAfterSeconds)`: the 429 message ("…try again in about N minutes.")

**Input validation** (`utils/validation.js`):
- `validateCheckinInput(input)` → `{ isValid, errors, sanitized }`
- `isHoneypotFilled(input)`: true when the hidden `website` field is filled (a bot)
- Email (RFC 5322), phone, eventId, token validators

### Testing Strategy

- 175 Jest tests across 10 suites (checkin, checkin-rate-limit, check-in use-case, rate-limit, pg-store, db-ssl, config, validation, eastern-week, streak-celebration)
- `npm run test:db` at the repo root runs the SQL (including the rate-limit store and grants) against a throwaway Postgres
- Unit tests mock `pg` and the Postgres store, so no database or API keys are needed
- Smoke tests: `test:smoke-local` (automated), `test:smoke-prod` (deployed)
- Use `debug: "1"` for all test submissions

### Common Tasks

**Adding fields to check-in:**
1. Add a new migration file in `backend/db/migrations/` (never edit an applied one). Grant `checkin_writer` access if it's a new table
2. Run `npm run migrate` (owner URL in `../.env.local`) **before** deploying code that uses it
3. Add validation in `utils/validation.js`
4. Update `findOrCreateAttendee()` or `insertCheckin()` in `utils/pg-store.js`
5. Add tests

---

## Deployment

A **single** Netlify site deploys from `main` and serves both the website and the
backend functions (config in the root `netlify.toml`). The API is same-origin with
the website, so no CORS is required.

| Part | Source | Served at |
|------|--------|-----------|
| Website (Astro) | repo root (`src/`, `public/`) → `dist/` | `https://716coffee.club` |
| Functions (API) | `backend/netlify/functions/` | `https://716coffee.club/.netlify/functions/` |

Each push to `main` triggers one build = **15 credits**. Free tier = 300 credits/month. Limit pushes to `main` to batching work on `dev` (docs-only changes still rebuild the single site, so batch them too). Deploy Previews and branch deploys cost **0 credits** per build (functions on them still use a little compute and bandwidth credit). Staging is the branch deploy of `dev` (https://dev--bocc-backend.netlify.app) against the Neon `dev` branch, with its own `checkin_writer` password (see `docs/backend/NEON_PERMISSIONS.md`, "Staging").

---

## Git Workflow

- **`main`** — Production. The single Netlify site auto-deploys.
- **`dev`** — Active development. Test locally, then merge to `main`.

Commit frequently on `dev`. Merge to `main` only when ready to deploy. Each merge = 15 credits.

Run `npm test` in `backend/` and `npm run build` at the repo root before merging to `main`.

---

## Documentation

All docs live in `docs/`:
- `docs/onboarding.md` — Start here (new volunteers and AI agents)
- `docs/architecture.md` — End-to-end system overview
- `docs/backend/` — Backend epics, stories, tasks, API docs, safety specs
- `docs/website/` — Website future work, event runbooks
- `docs/strategy/` — Social media strategies, brand guide
