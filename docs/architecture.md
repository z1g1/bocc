# System Architecture

Technical overview of the BOCC platform — how the website, backend API, and external services work together.

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    716coffee.club                        │
│                  (Netlify - Static)                      │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌────────────────────┐    │
│  │ Homepage  │  │  About   │  │  Check-in Forms    │    │
│  │ index.md  │  │ about.md │  │ checkin/bocc.astro │    │
│  │           │  │          │  │ js/checkin.js       │    │
│  │ Luma      │  │  Photos  │  │                    │    │
│  │  Embed    │  │          │  │  localStorage      │    │
│  └──────────┘  └──────────┘  └────────┬───────────┘    │
└───────────────────────────────────────┼─────────────────┘
                                        │ POST /checkin
                                        ▼
┌─────────────────────────────────────────────────────────┐
│         716coffee.club/.netlify/functions/ (same-origin) │
│              (Netlify Functions - Serverless)            │
│                                                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │ checkin.js → utils/check-in.js                    │   │
│  │  1. Validate inputs (validation.js)               │   │
│  │  2. Find/create attendee (pg-store.js)            │   │
│  │  3. Insert check-in, DB-enforced dedup (pg-store) │   │
│  │  4. Read streak (pg-store.js) [non-fatal]         │   │
│  └──────────────────────────────────────────────────┘   │
└────────────────────────────┬────────────────────────────┘
                             │ checkin_writer
                             ▼
                    ┌────────────────┐
                    │ Neon Postgres  │
                    │                │
                    │ • attendees    │
                    │ • checkins     │
                    │ • held_        │
                    │   occurrences  │
                    │ • streaks      │
                    └────────────────┘
```

> **Module layer (June 2026 refactor):** the `checkin.js` function is a thin HTTP
> adapter; the check-in business flow lives in `utils/check-in.js`
> (`checkInAttendee`). Configuration is centralized in `utils/config.js`. See
> [architecture-review-2026-06.md](architecture-review-2026-06.md) and
> [`CONTEXT.md`](../CONTEXT.md) for the module seams.
>
> **Datastore (September 2026):** check-ins moved from Airtable (free base full) to
> Neon Postgres. See [ADR-0003](adr/0003-supabase-transactional-store.md) (data model)
> and [ADR-0005](adr/0005-neon-replaces-supabase.md) (host).
>
> **Circle retired (November 2026):** the Circle integration and profile photo enforcement
> were removed, and Postgres is the only data store. See
> [ADR-0006](adr/0006-retire-circle-postgres-only.md).
>
> **Admin app (November 2026):** `/admin/*`, `/api/admin/*`, `/api/auth/*`, `/login/` and
> `/logout` are rendered on demand by the Astro SSR function (`@astrojs/netlify`); everything
> else stays prerendered. See [Admin App](#admin-app) below.

## Check-in Flow (Detailed)

### 1. User scans QR code at event
The QR code URL contains the event token: `https://716coffee.club/checkin/bocc?token=<GUID>`

### 2. Frontend form (`js/checkin.js`)
- Checks `localStorage` for return visitor (30-day TTL)
- If returning: shows "Welcome back!" quick-confirm flow
- If new: shows full form (name, email, phone, business)
- Validates inputs client-side (email format, honeypot bot detection)
- POSTs JSON to `/.netlify/functions/checkin` (same-origin)

### 3. Backend validation (`utils/validation.js`)
- Email: RFC 5322 format + dangerous character rejection
- Phone: digits, spaces, hyphens, parentheses (optional)
- Token: alphanumeric + hyphens only
- Text fields: HTML/script tag removal, XSS prevention
- All SQL uses parameterized queries (`$1…`). Nothing is string-built.

### 4. Attendee record (`utils/pg-store.js`)
- `INSERT … ON CONFLICT (email) DO NOTHING`, then reads the id back if the attendee already existed
- A returning attendee's stored details are not overwritten

### 5. Check-in + duplicate detection (`utils/pg-store.js`)
- `INSERT … ON CONFLICT DO NOTHING` into `checkins`
- The unique index on (attendee, event, token, Eastern day) makes dedup race-safe
- No row inserted → returns `200 "Already checked in for this event today"`

### 6. Streak (`streaks` view)
- Reads current/longest streak for the celebration
- Failure returns `streak: null` and never fails the check-in; debug check-ins skip it

### 7. Frontend response
- On success: shows confirmation, plus a sponsor redirect countdown if one is enabled
- On API failure: saves data to `localStorage` and shows "saved locally" message

## Data Model

Source of truth: `backend/db/migrations/*.sql`.

### Postgres: `attendees`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| email | text | Unique; lowercased by the app (natural key) |
| name | text | |
| phone | text | Optional |
| business_name | text | Optional |
| ok_to_email | boolean | Consent for future emails |
| debug | boolean | Test submission flag |
| legacy_airtable_id | text | Provenance from the backfill (unique when set) |
| created_at | timestamptz | |

### Postgres: `checkins`
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| attendee_id | uuid | → attendees |
| event_id | text | "bocc", "codeCoffee", etc. |
| token | text | Event GUID from QR code |
| checkin_at | timestamptz | Time of check-in |
| checkin_date | date | Eastern calendar day (dedup key) |
| debug | boolean | Test submission flag |
| legacy_airtable_id | text | Provenance from the backfill |
| created_at | timestamptz | |

Unique index `checkins_dedup_key` on `(attendee_id, event_id, coalesce(token,''), checkin_date)`.

### Postgres views
- `held_occurrences`: the weeks each event actually met (≥1 non-debug check-in)
- `streaks`: `current_streak`, `longest_streak`, `is_personal_best` per (attendee, event), via gaps-and-islands ([ADR-0004](adr/0004-streak-computation-model.md))

### Airtable archive
The Airtable `attendees` and `checkins` tables remain as a read-only historical copy; all rows
were backfilled to Postgres. The app no longer connects to Airtable.

## External Service Integration

### Luma
- Primary RSVP: https://luma.com/716coffeeclub
- Calendar embed on the homepage; event embed on each `/events/YYYY-MM-DD/` page, from the `luma` row in Neon `event_links` (ADR 0009)
- No API integration — purely frontend iframes
- CSP in `_layouts/default.html` allows `luma.com` as a frame source

### Eventbrite
- Discovery listing only, as a plain link from the homepage and `llms.txt`

### Neon Postgres
- `pg` driver over Neon's pooled endpoint, verify-full TLS (`utils/db-ssl.js`)
- Auth: least-privilege `checkin_writer` role in `CHECKIN_DB_URL`
- Free plan: compute scales to zero when idle and wakes on connect (no inactivity pause)
- Permissions documented in `docs/backend/NEON_PERMISSIONS.md`

### Google Forms
- Used for sponsor contact and code of conduct reporting
- Links embedded in website pages, no API integration

## Security Architecture

### Input Validation (Defense in Depth)
- Client-side: `js/checkin.js` validates before sending
- Server-side: `utils/validation.js` validates all inputs again
- Database: parameterized SQL, a DB-enforced dedup index, and a role that can't UPDATE,
  DELETE, or run DDL.

### CORS
- Backend `ALLOWED_ORIGIN` env var controls allowed origins
- Defaults to `*` in development, should be `https://716coffee.club` in production

### Secrets Management
- All secrets in Netlify environment variables (never in code), read and
  validated once in `utils/config.js` (fails fast at import; see
  [ADR-0001](adr/0001-config-fail-fast-at-import.md))
- The static website has zero secrets; the admin app's (`ADMIN_DB_URL`, `BETTER_AUTH_SECRET`)
  are read only by on-demand routes
- Backend env vars: required `CHECKIN_DB_URL`, plus optional `ALLOWED_ORIGIN` (see
  `.env.example`)
- The Neon owner URL and Neon API key are operator-only and never deployed
- Principle of least privilege for all API tokens and database roles

### Admin App
- Login: Better Auth ([ADR-0008](adr/0008-admin-auth-better-auth.md)), one shared instance in
  `src/lib/auth/auth.mjs`. Password + passkey, 30-day sliding sessions, no public sign-up;
  accounts come from `npm run create-admin` or `/admin/users/`
- `src/middleware.ts` checks the session and roles (`public.user_roles`: `admin`, `social`) for
  `/admin/*` and `/api/admin/*`; each route also calls `requireRole()`. No role, no access
- Database: the `admin_app` role (`ADMIN_DB_URL`), which can read attendee data, correct four
  attendee columns and append to `audit_log`, but never insert or delete attendee data. Every
  change is written with its `audit_log` row in one transaction (`src/lib/admin/db.mjs`)
- Mutations are form POSTs whose `Origin` must match `BETTER_AUTH_URL`; admin pages send a strict
  first-party CSP with no analytics (`src/lib/admin/headers.mjs`)
- Env: `ADMIN_DB_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, optional `ADMIN_DB_POOL_MAX`
  (locally in `.env.admin`). Tests: `npm run test:db` (throwaway Postgres in Docker)

### Content Security Policy
- Configured in `src/layouts/Default.astro` (a `<meta http-equiv>` tag). The check-in page
  (`src/pages/checkin/bocc.astro`) passes `analytics={false}`, which drops the analytics script
  and its CSP origins
- Allows: self-hosted fonts and scripts, Luma embeds (`frame-src`), images over https, Google
  Analytics origins (website only), and form posts to Google Forms
- Inline scripts are allowed (`'unsafe-inline'`); there is no nonce or hash yet

## Observability
- OpenTelemetry traces for the SSR function and `social-check`, structured JSON logs with
  trace ids, and request metrics in span attributes and log lines: see
  [backend/OBSERVABILITY.md](backend/OBSERVABILITY.md) (`src/lib/telemetry.mjs`). Netlify
  ingests traces only, when it has tracing turned on for the site
