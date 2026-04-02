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
│              bocc-backend.netlify.app                    │
│              (Netlify Functions - Serverless)            │
│                                                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │ checkin.js                                        │   │
│  │  1. Validate inputs (validation.js)               │   │
│  │  2. Check for duplicate (airtable.js)             │   │
│  │  3. Fetch/create attendee (airtable.js)           │   │
│  │  4. Create check-in record (airtable.js)          │   │
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
└──────────────┬──────────────────────┬───────────────────┘
               │                      │
               ▼                      ▼
┌──────────────────────┐  ┌──────────────────────────┐
│      Airtable        │  │      Circle.so           │
│                      │  │      (716.social)        │
│  Tables:             │  │                          │
│  • attendees         │  │  • Member profiles       │
│  • checkins          │  │  • checkinCount field    │
│  • No Photo Warnings │  │  • Bot DMs (716.social   │
│                      │  │    Bot)                  │
└──────────────────────┘  └──────────────────────────┘
```

## Check-in Flow (Detailed)

### 1. User scans QR code at event
The QR code URL contains the event token: `https://716coffee.club/checkin/bocc?token=<GUID>`

### 2. Frontend form (`js/checkin.js`)
- Checks `localStorage` for return visitor (30-day TTL)
- If returning: shows "Welcome back!" quick-confirm flow
- If new: shows full form (name, email, phone, business)
- Validates inputs client-side (email format, honeypot bot detection)
- POSTs JSON to `https://bocc-backend.netlify.app/.netlify/functions/checkin`

### 3. Backend validation (`utils/validation.js`)
- Email: RFC 5322 format + dangerous character rejection
- Phone: digits, spaces, hyphens, parentheses (optional)
- Token: alphanumeric + hyphens only
- Text fields: HTML/script tag removal, XSS prevention
- Airtable formula injection protection

### 4. Duplicate detection (`utils/airtable.js`)
- Queries `checkins` table for same attendee + eventId + token + today's date
- If found: returns `200 "Already checked in for this event today"`
- If not: continues to create records

### 5. Airtable records (`utils/airtable.js`)
- Looks up attendee by email in `attendees` table
- If not found: creates new attendee record
- Creates check-in record in `checkins` table linking to attendee

### 6. Circle.so integration (`utils/circle.js`) — non-blocking
- Only for production check-ins (debug flag = "0")
- Calls `ensureMember(email, name)` to find or create Circle member
- Increments `checkinCount` custom field
- If Circle API fails, check-in still succeeds (graceful degradation)

### 7. Frontend response
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

### Airtable: `attendees`
| Field | Type | Notes |
|-------|------|-------|
| email | Email | Primary key (unique) |
| attendeeID | Auto | Airtable record ID |
| name | Text | |
| phone | Phone | Optional |
| businessName | Text | Optional |
| okToEmail | Checkbox | Consent for future emails |
| debug | Checkbox | Test submission flag |
| Checkins | Rollup | Count of linked check-in records |

### Airtable: `checkins`
| Field | Type | Notes |
|-------|------|-------|
| id | Auto | Airtable record ID |
| checkinDate | DateTime | Timestamp of check-in |
| eventId | Text | "bocc", "codeCoffee", etc. |
| Attendee | Link | → attendees table |
| email | Text | Denormalized for convenience |
| name | Text | |
| phone | Text | |
| businessName | Text | |
| token | Text | Event GUID from QR code |
| debug | Checkbox | Test submission flag |

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

Full schema: `docs/backend/AIRTABLE_SCHEMA_PHOTO_WARNINGS.md`

## External Service Integration

### Eventbrite
- Embedded checkout widget on homepage (`index.md`)
- Event ID: `1983098086761`
- No API integration — purely a frontend embed
- CSP headers in `_includes/head/custom.html` allow Eventbrite domains

### Airtable
- REST API via `airtable` npm package
- Auth: API key in `AIRTABLE_API_KEY` env var
- Formula injection protection in all queries
- Principle of least privilege: read/write on 3 tables only

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
- Database: Airtable formula injection protection via `escapeAirtableFormula()`

### CORS
- Backend `ALLOWED_ORIGIN` env var controls allowed origins
- Defaults to `*` in development, should be `https://716coffee.club` in production

### Secrets Management
- All API keys in Netlify environment variables (never in code)
- Website has zero secrets (static site)
- Backend has 5 env vars (4 required, 1 optional)
- Principle of least privilege for all API tokens

### Content Security Policy
- Configured in `website/_includes/head/custom.html`
- Allows: Eventbrite, Google Fonts, Font Awesome, jsDelivr, Netlify backend
- Blocks inline scripts except for specific hashes
