# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Netlify Functions backend API for Buffalo Open Coffee Club (BOCC) that handles event attendee check-ins via Airtable integration. The API serves check-in forms on the frontend website that collect attendee information and log check-ins to events.

**Related Repositories:**
- Frontend: https://github.com/z1g1/bocc-website
- Backend: https://github.com/z1g1/bocc-backend (this repo)

**Production URL:** https://bocc-backend.netlify.app

### Core Workflow
1. Check-in form sends attendee data (email, name, phone, businessName, okToEmail) + eventID + debug flag + token
2. API checks for duplicate check-in (same attendee, event, token, and date)
3. If duplicate found: return friendly message "Already checked in for this event today"
4. API checks if attendee email exists in Airtable `attendees` table
5. If exists: fetch attendee record; If not exists: create new attendee record
6. Create check-in record in `checkins` table with attendee link, eventId, token, and timestamp
7. For non-debug check-ins:
   a. Invite attendee to Circle.so community (create/find member)
   b. Increment `checkinCount` custom field in Circle member profile
8. All records include `debug` flag for filtering test submissions
9. All check-ins include `token` field (static GUID per event, embedded in URL for basic anti-spoofing)

## Architecture

**Deployment Platform:** Netlify Functions (serverless)
- Functions are located in `netlify/functions/`
- Three functions:
  - `checkin.js` - Main check-in POST endpoint
  - `profile-photo-enforcement.js` - Scheduled weekly enforcement (Mondays 9:00 AM EST, configured in `netlify.toml`)
  - `profile-photo-enforcement-manual.js` - HTTP-accessible manual trigger (supports `?dryRun=true`)
- Deployed automatically via Netlify CI/CD

**Data Storage:** Airtable
- Three tables: `attendees`, `checkins`, and `No Photo Warnings`
- `attendees` table: Stores unique attendees by email
  - Fields: email, attendeeID, name, phone, businessName, okToEmail, debug
  - Rollup field: Checkins (count of check-ins for this attendee)
- `checkins` table: Stores individual check-in events
  - Fields: id, checkinDate, eventId, Attendee (linked), email, name, phone, businessName, token, debug
  - `eventId` examples: "bocc" (regular meetings), "codeCoffee", or other event identifiers
- `No Photo Warnings` table: Tracks progressive warnings for profile photo enforcement
  - Fields: Email, Name, WarningCount, Status, LastWarningDate, CreatedDate, MemberID, Notes
  - See `docs/AIRTABLE_SCHEMA_PHOTO_WARNINGS.md` for full schema

**Community Platform:** Circle.so
- Third-party community platform for member engagement
- Attendees are automatically invited after successful check-in
- Check-in counter tracked in Circle member custom field (`checkinCount`)
- Circle workflows can trigger automated rewards based on check-in count
- Invitations are non-blocking (don't fail check-in if Circle API fails)
- Only non-debug check-ins trigger Circle invitations and counter updates
- Admin API v2 integration via `netlify/functions/utils/circle.js`
- Headless Auth API integration via `netlify/functions/utils/circle-member-api.js` (bot user DMs)
- **Important limitation:** Circle.so Admin API v2 does NOT expose audience segments via API; the codebase uses client-side filtering of all members instead (see `docs/CIRCLE_SEGMENTS_RESEARCH.md`)

**Circle.so API URLs — IMPORTANT:**
All Circle.so APIs live under `app.circle.so`. Other Circle subdomains are documentation/Swagger sites, NOT live API servers:
- `app.circle.so` — **Correct.** All API requests go here.
- `api.circle.so` — **WRONG.** This is the Circle developer docs site (Next.js). POSTing here returns 405 "Method Not Allowed".
- `api-headless.circle.so` — **WRONG.** This is the Swagger UI docs for the Headless API. Requests here return nginx 404.

The three APIs and their base URLs:
| API | Base URL | Auth | Used in |
|-----|----------|------|---------|
| Admin API v2 | `https://app.circle.so/api/admin/v2` | `CIRCLE_API_TOKEN` Bearer | `circle.js` |
| Headless Auth API | `https://app.circle.so/api/v1/headless` | `CIRCLE_HEADLESS_API` Bearer | `circle-member-api.js` (JWT generation) |
| Headless Member API | `https://app.circle.so/api/headless/v1` | Member JWT Bearer | `circle-member-api.js` (chat rooms, DMs) |

**Module System:** CommonJS (require/module.exports)
- Project uses CommonJS syntax, not ES modules
- All files use `.js` extension with `require()` and `module.exports`

**Security Architecture:**
- Input validation layer in `netlify/functions/utils/validation.js`
- All inputs are validated and sanitized before processing
- Formula injection protection for Airtable queries
- XSS prevention through text sanitization
- Email format validation with dangerous character rejection
- Phone number format validation (optional field)
- Token format validation (alphanumeric + hyphens only)

## Environment Variables

Required environment variables (set in Netlify dashboard):
- `AIRTABLE_API_KEY` - Airtable API key for authentication
- `AIRTABLE_BASE_ID` - Base ID for the BOCC Airtable database
- `CIRCLE_API_TOKEN` - Circle.so Admin API v2 token for member invitations and photo enforcement
- `CIRCLE_HEADLESS_API` - Circle.so Headless Auth API token for bot user DMs (profile photo warnings)

Optional environment variables:
- `ALLOWED_ORIGIN` - CORS allowed origin (defaults to `*` for development, set to frontend domain in production)

**Security Note:** This project uses API keys for Airtable and Circle.so. Follow principle of least privilege:
- Airtable key: minimum required permissions for read/write on `attendees` and `checkins` tables only
- Circle.so key: minimum required permissions for creating/reading community members only
- See `CIRCLE_PERMISSIONS.md` for detailed Circle.so permissions documentation

## Project Structure

```
bocc-backend/
├── netlify/
│   └── functions/
│       ├── checkin.js                        # Main check-in API endpoint (POST)
│       ├── profile-photo-enforcement.js      # Scheduled weekly enforcement function
│       ├── profile-photo-enforcement-manual.js # Manual/on-demand enforcement trigger
│       └── utils/
│           ├── airtable.js                   # Airtable client for attendees/checkins tables
│           ├── airtable-warnings.js          # Airtable client for No Photo Warnings table
│           ├── circle.js                     # Circle.so Admin API v2 client
│           ├── circle-member-api.js          # Circle.so Headless Auth API (bot DMs, JWT auth)
│           ├── enforcement-logic.js          # Warning decision engine and action processor
│           ├── message-templates.js          # Bot story arc DM templates (TipTap JSON for Circle)
│           └── validation.js                 # Input validation and sanitization
├── tests/                                    # Jest unit tests + shell smoke tests
│   └── integration/                          # Integration tests (require RUN_INTEGRATION_TESTS=true)
├── docs/                                     # Epic/story documentation and architecture decisions
├── netlify.toml                              # Netlify config (CORS headers, scheduled function cron)
└── package.json                              # Dependencies: airtable, axios; devDeps: jest
```

## Development

**Current Workflow:**
- Push directly to `main` branch
- Netlify auto-deploys on every push to main
- **TODO:** Implement dev/staging/main workflow for safer deployments

**Local Development:**
```bash
# Install Netlify CLI globally if not already installed
npm install -g netlify-cli

# Install dependencies
npm install

# Run functions locally with environment variables
netlify dev
```

**Testing:**
```bash
# Run all Jest unit tests (~299 tests across 10 test suites)
npm test

# Run only unit tests (excludes integration tests)
npm run test:unit

# Run integration tests (requires real API tokens)
npm run test:integration

# Run automated local smoke test (starts server, tests API with dedup, cleans up)
npm run test:smoke-local

# Run production smoke test (tests deployed API with debug flag)
npm run test:smoke-prod

# Run a single test file
npx jest tests/checkin.test.js

# Run tests matching a pattern
npx jest --testNamePattern "duplicate"
```

**Testing the API:**
```bash
# Test check-in endpoint locally (requires Netlify CLI running)
curl -X POST http://localhost:8888/.netlify/functions/checkin \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "name": "Test User",
    "phone": "555-1234",
    "businessName": "Test Business",
    "okToEmail": true,
    "eventId": "bocc",
    "debug": "1",
    "token": "c96517e8-5936-4c63-a729-4b616569e5ab"
  }'
```

**Production endpoint:**
```bash
curl -X POST https://bocc-backend.netlify.app/.netlify/functions/checkin \
  -H "Content-Type: application/json" \
  -d '{ ... }'
```

**Debug Flag:**
- Pass `debug: "1"` (string) in request body to mark as test submission
- Pass `debug: "0"` or omit to mark as production submission
- Allows filtering test data in Airtable views

**Event IDs:**
- `"bocc"` - Regular Buffalo Open Coffee Club meetings
- `"codeCoffee"` - Code Coffee events
- Use descriptive event IDs to separate different event types in reporting

**Token System:**
- Each event uses a static GUID embedded in the check-in URL
- Token is manually generated and added to QR codes/links for each event
- Provides basic anti-spoofing protection (ensures check-ins come from valid QR codes)
- Same token used for all attendees at the same event

## Code Patterns

**Airtable Operations:**
All database operations are in `netlify/functions/utils/airtable.js`:
- `fetchAttendeeByEmail(email)` - Query attendee by email (uses formula injection protection)
- `createAttendee(email, name, phone, businessName, okToEmail, debug)` - Create new attendee
- `createCheckinEntry(attendeeId, eventId, debug, token)` - Create check-in record
- `findExistingCheckin(attendeeId, eventId, token)` - Check for duplicate check-in on same day (returns existing check-in or null)

**Circle.so Admin API Operations** (`netlify/functions/utils/circle.js`):
- `findMemberByEmail(email)` - Search for Circle member by email (case-insensitive)
- `createMember(email, name)` - Create/invite new Circle community member
- `ensureMember(email, name)` - Find existing or create new member (idempotent)
- `updateMemberCustomField(memberId, fieldName, value)` - Update custom field on member profile
- `incrementCheckinCount(memberId, currentCount)` - Increment check-in counter
- `getMembersWithoutPhotos()` - Fetch all members, filter client-side for missing photos
- `deactivateMember(memberId)` - Deactivate a member account
- Uses Admin API v2 at `https://app.circle.so/api/admin/v2`, auth via `CIRCLE_API_TOKEN`

**Circle.so Headless Auth API** (`netlify/functions/utils/circle-member-api.js`):
- Sends DMs from a bot user ("716.social Bot", email: `bocc-bot@zackglick.com`)
- Auth API at `https://app.circle.so/api/v1/headless/auth_token` generates member JWTs
- Member API at `https://app.circle.so/api/headless/v1/...` for chat rooms and messages
- Bot authenticated by email (NOT by community_member_id — the URL slug `73e5a590` is not the internal ID)

**Profile Photo Enforcement** (`netlify/functions/utils/enforcement-logic.js`):
- Progressive warning system with character-driven "716.social Bot" story arc (see `docs/716-bot-final-messaging.md`)
- Warnings 1-4 send distinct personality-driven DMs; deactivation (after warning 4) has no DM — account is simply deactivated
- If a member adds their photo at any point, they receive a celebratory "thank you" DM
- `determineEnforcementAction(warningRecord)` - Decides what action to take
- `processEnforcementAction(action, member, dryRun)` - Executes the action
- Safety limits: 500-member warning threshold (logs warning), 1000-member hard cap (aborts)
- Warning tracking via Airtable `No Photo Warnings` table (`airtable-warnings.js`)
- DM messages formatted as TipTap JSON with bold, italic, and link support (`message-templates.js`)

**Input Validation:**
All validation functions are in `netlify/functions/utils/validation.js`:
- `validateCheckinInput(input)` - Main validation function, returns `{ isValid, errors, sanitized }`
- `escapeAirtableFormula(value)` - Escapes dangerous characters for Airtable formula queries
- `isValidEmail(email)` - RFC 5322 compliant email validation with security checks
- `isValidPhone(phone)` - Phone number format validation (optional field)
- `isValidEventId(eventId)` - Ensures eventId is non-empty string
- `isValidToken(token)` - Validates token format (alphanumeric + hyphens)
- `sanitizeText(text)` - Removes HTML tags, scripts, and XSS-prone characters

**CORS Handling:**
- Configured in `netlify.toml` for global headers
- OPTIONS preflight handled in `checkin.js` handler
- Dynamically configured via `ALLOWED_ORIGIN` environment variable (defaults to `*` for development)
- Set `ALLOWED_ORIGIN` to frontend domain in production for security

**Error Handling:**
- 400: Missing required fields (email, eventId) or validation failures (invalid email/phone format)
- 500: Airtable API errors or internal failures
- Errors logged to console (visible in Netlify function logs)
- Generic error messages returned to client (Issue #7: sanitized error responses for security)

## Common Tasks

**Adding new fields to attendee:**
1. Add field to Airtable `attendees` table schema
2. Add validation function to `netlify/functions/utils/validation.js` if needed
3. Update `validateCheckinInput()` to validate/sanitize the new field
4. Update `createAttendee()` in `netlify/functions/utils/airtable.js`
5. Add unit tests to `tests/validation.test.js` and `tests/checkin.test.js`

**Adding new fields to check-in:**
1. Add field to Airtable `checkins` table schema
2. Add validation function to `netlify/functions/utils/validation.js` if needed
3. Update `validateCheckinInput()` to validate/sanitize the new field
4. Update `createCheckinEntry()` in `netlify/functions/utils/airtable.js`
5. Add unit tests to `tests/validation.test.js` and `tests/checkin.test.js`

**Modifying profile photo enforcement:**
1. Warning message copy/personality: `netlify/functions/utils/message-templates.js` — bot story arc with `warning1()`, `warning2()`, `warning3()`, `finalWarning()`, `thankYouMessage()` (see `docs/716-bot-final-messaging.md` for spec)
2. Warning thresholds or actions: `netlify/functions/utils/enforcement-logic.js`
3. Schedule timing: `netlify.toml` `[functions."profile-photo-enforcement"]` cron expression
4. Manual testing: call `profile-photo-enforcement-manual` endpoint with `?dryRun=true`
5. Airtable warning records: `netlify/functions/utils/airtable-warnings.js`
6. TipTap parser (bold/italic/links): `textToTipTap()` in `message-templates.js`

**Debugging production issues:**
1. Check Netlify function logs in Netlify dashboard
2. Verify environment variables are set correctly
3. Check Airtable API key permissions
4. Review CORS headers if frontend cannot reach API

## Known Limitations & Future Improvements

Planned improvements:
- Display check-in confirmation back to user with edit option
- Add privacy policy and data deletion capability
- Implement proper dev/staging/main branch workflow instead of pushing directly to production

## Testing Strategy

**Unit Tests:**
- ~299 Jest tests across 10 test suites covering checkin, validation, deduplication, Circle.so, enforcement logic, message templates, airtable warnings, and member API
- Run with `npm test` (all) or `npm run test:unit` (exclude integration)
- Integration tests in `tests/integration/` require `RUN_INTEGRATION_TESTS=true` and real API tokens

**Smoke Tests:**
- End-to-end tests that verify API functionality with real HTTP requests
- Automated local testing: `npm run test:smoke-local` (starts server, tests, cleans up)
- Production testing: `npm run test:smoke-prod` (tests deployed API with debug flag)
- All smoke tests use `debug: "1"` to mark as test data

**Best Practices:**
- Use `debug: "1"` flag for all test submissions
- Filter Airtable views to exclude debug records for production analytics
- Token field provides basic anti-spoofing for QR code check-ins
- Run unit tests before committing changes
- Run smoke tests after deployment to verify API health
- Currently all changes push directly to production - test thoroughly locally before pushing

## Frontend Integration

The frontend (https://github.com/z1g1/bocc-website) contains manually created check-in forms that POST to this API. When creating new event check-in pages:

1. Generate a new GUID token for the event
2. Embed the token in the check-in URL/QR code
3. Set appropriate `eventId` (e.g., "bocc", "codeCoffee") to categorize the event
4. Forms should include: email (required), name, phone, businessName, okToEmail checkbox
5. Include `debug: "1"` in the request for testing, `debug: "0"` for production

## Shared Agents and Commands Setup

This project uses shared Claude Code agents and commands from the
`z1g1/prompts` submodule located in the `prompts/` directory.

Before starting work, initialize the submodule and copy agents and commands
into the expected directories:

\```bash
# Initialize the prompts submodule if not already present
git submodule update --init --recursive

# Copy shared agents and commands to user-level Claude directories
mkdir -p ~/.claude/agents ~/.claude/commands
cp -r prompts/.claude/agents/* ~/.claude/agents/ 2>/dev/null || true
cp -r prompts/.claude/commands/* ~/.claude/commands/ 2>/dev/null || true
\```

Run this setup at the start of each new Claude Code web session. Local terminal
sessions using symlinks do not need this step.

## Git Usage

Run all git commands from the project working directory. Do not use `git -C` to specify paths — use plain `git add`, `git commit`, etc
