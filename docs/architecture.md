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
│  │ index.md  │  │ about.md │  │ checkin/bocc.html  │    │
│  │           │  │          │  │ js/checkin.js       │    │
│  │ Eventbrite│  │  Photos  │  │                    │    │
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
│  │  5. Invite to Circle.so (circle.js) [non-blocking]│   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │ profile-photo-enforcement.js (weekly cron)        │   │
│  │  1. Fetch all Circle members (circle.js)          │   │
│  │  2. Filter for missing photos                     │   │
│  │  3. Check warning history (airtable-warnings.js)  │   │
│  │  4. Send progressive DMs (circle-member-api.js)   │   │
│  │  5. Deactivate after 4 warnings                   │   │
│  └──────────────────────────────────────────────────┘   │
└───────┬──────────────────┬───────────────────┬──────────┘
        │ checkin_writer   │                   │
        ▼                  ▼                   ▼
┌────────────────┐ ┌──────────────────┐ ┌──────────────────────┐
│ Neon Postgres  │ │    Airtable      │ │     Circle.so        │
│                │ │                  │ │     (716.social)     │
│ • attendees    │ │ • No Photo       │ │                      │
│ • checkins     │ │   Warnings       │ │ • Member profiles    │
│ • held_        │ │ • attendees /    │ │ • checkinCount field │
│   occurrences  │ │   checkins       │ │ • Bot DMs (716.social│
│ • streaks      │ │   (historical,   │ │   Bot)               │
│                │ │   read-only)     │ │                      │
└────────────────┘ └──────────────────┘ └──────────────────────┘
```

> **Module layer (June 2026 refactor):** the `checkin.js` function is a thin HTTP
> adapter; the check-in business flow lives in `utils/check-in.js`
> (`checkInAttendee`). Configuration is centralized in `utils/config.js`, and
> Circle HTTP transport in `utils/circle-http.js`. See
> [architecture-review-2026-06.md](architecture-review-2026-06.md) and
> [`CONTEXT.md`](../CONTEXT.md) for the module seams.
>
> **Datastore (September 2026):** check-ins moved from Airtable (free base full) to
> Neon Postgres. See [ADR-0003](adr/0003-supabase-transactional-store.md) (data model)
> and [ADR-0005](adr/0005-neon-replaces-supabase.md) (host).

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

### 7. Circle.so integration (`utils/circle.js`) — non-blocking
- Only for production check-ins (debug flag = "0")
- Calls `ensureMember(email, name)` to find or create Circle member
- Increments `checkinCount` custom field
- If Circle API fails, check-in still succeeds (graceful degradation)

### 8. Frontend response
- On success: shows confirmation + optional sponsor redirect countdown
- On API failure: saves data to `localStorage` and shows "saved locally" message

## Profile Photo Enforcement Flow

Runs weekly on Mondays at 9:00 AM EST via Netlify scheduled function.

### Warning Progression
| Warning # | Action | DM Sent? |
|-----------|--------|----------|
| 1 | Create warning record, send friendly DM | Yes |
| 2 | Increment count, send reminder DM | Yes |
| 3 | Increment count, send serious DM | Yes |
| 4 | Increment count, deactivate account | No |
| Photo added | Delete warning, send thank-you DM | Yes |

### Safety Limits
- 500 members: warning logged (community approaching limit)
- 1000 members: error thrown, processing stops (prevents mass-processing bugs)

See `docs/backend/SAFETY_LIMITS_SPECIFICATION.md` for rationale.

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

### Airtable: `No Photo Warnings`
| Field | Type | Notes |
|-------|------|-------|
| Email | Email | Circle member email |
| Name | Text | Circle member name |
| WarningCount | Number | 1-4 |
| Status | Select | Active, Deactivated, PhotoAdded |
| LastWarningDate | Date | |
| CreatedDate | Date | |
| MemberID | Text | Circle.so member ID |
| Notes | Text | Action log |

Full schema: `docs/backend/AIRTABLE_SCHEMA_PHOTO_WARNINGS.md`. The Airtable `attendees` and
`checkins` tables remain as a read-only historical copy; all rows were backfilled to Postgres.

## External Service Integration

### Eventbrite
- Embedded checkout widget on homepage (`index.md`)
- Event ID: `1983098086761`
- No API integration — purely a frontend embed
- CSP headers in `_includes/head/custom.html` allow Eventbrite domains

### Neon Postgres
- `pg` driver over Neon's pooled endpoint, verify-full TLS (`utils/db-ssl.js`)
- Auth: least-privilege `checkin_writer` role in `CHECKIN_DB_URL`
- Free plan: compute scales to zero when idle and wakes on connect (no inactivity pause)
- Permissions documented in `docs/backend/NEON_PERMISSIONS.md`

### Airtable
- REST API via `airtable` npm package (enforcement warnings only)
- Auth: API key in `AIRTABLE_API_KEY` env var
- Formula injection protection in all queries

### Circle.so (716.social)
- Three APIs (all under `app.circle.so`):
  - Admin API v2 — member CRUD, custom fields
  - Headless Auth API — JWT generation for bot user
  - Headless Member API — send DMs as bot
- Auth: two separate tokens (`CIRCLE_API_TOKEN`, `CIRCLE_HEADLESS_API`)
- Limitation: no segment API access; all members fetched and filtered client-side
- Permissions documented in `docs/backend/CIRCLE_PERMISSIONS.md`

### Google Forms
- Used for sponsor contact and code of conduct reporting
- Links embedded in website pages, no API integration

## Security Architecture

### Input Validation (Defense in Depth)
- Client-side: `js/checkin.js` validates before sending
- Server-side: `utils/validation.js` validates all inputs again
- Database: parameterized SQL, a DB-enforced dedup index, and a role that can't UPDATE,
  DELETE, or run DDL. Airtable queries keep `escapeAirtableFormula()`.

### CORS
- Backend `ALLOWED_ORIGIN` env var controls allowed origins
- Defaults to `*` in development, should be `https://716coffee.club` in production

### Enforcement endpoint authorization
- Both enforcement functions share an authorization gate (`makeEnforcementHandler`):
  a run is allowed only for a genuine Netlify scheduled invocation
  (unspoofable `X-NF-Event: schedule`) **or** a valid `x-enforcement-token`.
  Anonymous requests get `401` (fail-closed). See
  [ADR-0002](adr/0002-enforcement-endpoint-authorization.md).
- The manual endpoint additionally restricts processing to the test user.

### Secrets Management
- All API keys in Netlify environment variables (never in code), read and
  validated once in `utils/config.js` (fails fast at import; see
  [ADR-0001](adr/0001-config-fail-fast-at-import.md))
- Website has zero secrets (static site)
- Backend env vars: 4 required secrets + `CHECKIN_DB_URL` (required in the default
  `postgres` mode) + optional `ALLOWED_ORIGIN`, `ENFORCEMENT_TRIGGER_TOKEN`, and
  identity overrides (see `.env.example`)
- The Neon owner URL and Neon API key are operator-only and never deployed
- Principle of least privilege for all API tokens and database roles

### Content Security Policy
- Configured in `website/_includes/head/custom.html`
- Allows: Eventbrite, Google Fonts, Font Awesome, jsDelivr, Netlify backend
- Blocks inline scripts except for specific hashes
