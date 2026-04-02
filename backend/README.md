# BOCC Backend

Backend API for Buffalo Open Coffee Club (BOCC) that handles event check-ins with Airtable data storage and Circle.so community integration.

## Features

### Check-in Management
- Attendee registration with email, name, phone, business name
- Event-based check-ins with token-based anti-spoofing
- Duplicate check-in prevention (same attendee, event, token, and day)
- Debug flag for filtering test submissions from production data

### Circle.so Community Integration
- Automatic member invitations to Circle.so community after check-in
- Idempotent member creation (safe retry on duplicates)
- Non-blocking invitation (check-in succeeds even if Circle fails)
- Only production check-ins trigger invitations (debug check-ins skip Circle)

### Security
- Input validation and sanitization for all fields
- Formula injection protection for Airtable queries
- XSS prevention through text sanitization
- Email format validation with dangerous character rejection
- Token format validation (alphanumeric + hyphens only)
- CORS configuration with environment-based origin control

## Architecture

**Deployment**: Netlify Functions (serverless)
**Data Storage**: Airtable (attendees and checkins tables)
**Community Platform**: Circle.so (member engagement)
**Module System**: CommonJS (require/module.exports)

### Core Workflow
1. Check-in form sends attendee data + eventID + debug flag + token
2. API checks for duplicate check-in (same attendee, event, token, and date)
3. If duplicate found: return friendly message "Already checked in for this event today"
4. API checks if attendee email exists in Airtable `attendees` table
5. If exists: fetch attendee record; If not exists: create new attendee record
6. Create check-in record in `checkins` table with attendee link, eventId, token, and timestamp
7. For non-debug check-ins: Invite attendee to Circle.so community (non-blocking)
8. Return success response to client

## Environment Variables

Required environment variables (set in Netlify dashboard):
- `AIRTABLE_API_KEY` - Airtable API key for authentication
- `AIRTABLE_BASE_ID` - Base ID for the BOCC Airtable database
- `CIRCLE_API_TOKEN` - Circle.so Admin API v2 token for member invitations

Optional environment variables:
- `ALLOWED_ORIGIN` - CORS allowed origin (defaults to `*`, set to frontend domain in production)

**Security**: Follow principle of least privilege:
- Airtable key: minimum permissions for read/write on `attendees` and `checkins` tables only
- Circle.so key: minimum permissions for creating/reading community members only
- See `CIRCLE_PERMISSIONS.md` for detailed Circle.so permissions documentation

## Testing

### Prerequisites
- Node.js installed
- npm installed
- Netlify CLI (for local testing): `npm install -g netlify-cli`

### Install Dependencies
```bash
npm install
```

### Run Tests
```bash
# Run all unit tests (143 tests)
npm test

# Run specific test suite
npm test -- tests/validation.test.js
npm test -- tests/checkin.test.js
npm test -- tests/deduplication.test.js
npm test -- tests/circle.test.js

# Run automated local smoke test (starts server, tests, cleans up)
npm run test:smoke-local

# Run production smoke test (tests deployed API with debug flag)
npm run test:smoke-prod
```

### Test Coverage
The test suite includes 143 tests covering:

- **Validation utilities** (`validation.test.js`, 43 tests)
  - Email validation (format, injection attacks)
  - Phone number validation
  - Event ID validation
  - Token validation
  - Airtable formula escaping
  - Text sanitization (XSS prevention)

- **Checkin handler** (`checkin.test.js`, 23 tests)
  - CORS preflight handling
  - Input validation and sanitization
  - Existing attendee check-in flow
  - New attendee creation and check-in flow
  - Error handling
  - Debug flag handling

- **Deduplication** (`deduplication.test.js`, 8 tests)
  - Duplicate check-in detection
  - Same-day duplicate prevention
  - Different event/token handling
  - Formula injection prevention
  - Client-side filtering by attendeeId

- **Circle.so Integration** (`circle.test.js`, 11 tests)
  - Member search (found, not found, case-insensitive)
  - Member creation
  - Error handling
  - Idempotent ensure operation

- **Validation utilities** (`validation.test.js`, 58 tests)
  - Comprehensive input validation coverage

### Manual Testing

**Local Development**:
```bash
# Start local Netlify dev server
netlify dev

# Test check-in endpoint
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
    "token": "test-token-123"
  }'
```

**Production Testing**:
```bash
# Test against deployed API (use debug flag)
curl -X POST https://bocc-backend.netlify.app/.netlify/functions/checkin \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "name": "Test User",
    "eventId": "bocc",
    "debug": "1",
    "token": "test-token-123"
  }'
```

**Debug vs Production Check-ins**:
- `debug: "1"` - Marks as test data, skips Circle invitation
- `debug: "0"` or omitted - Production check-in, triggers Circle invitation

## API Endpoints

### POST /checkin

Creates a check-in record for an attendee.

**Request Body**:
```json
{
  "email": "attendee@example.com",      // Required, validated format
  "name": "John Doe",                    // Optional, sanitized
  "phone": "555-1234",                   // Optional, validated format
  "businessName": "Acme Corp",           // Optional, sanitized
  "okToEmail": true,                     // Optional, boolean
  "eventId": "bocc",                     // Required, non-empty string
  "debug": "1",                          // Optional, "1" or "0"
  "token": "unique-event-token"          // Required, alphanumeric + hyphens
}
```

**Success Response** (200):
```json
{
  "message": "Check-in successful"
}
```

**Duplicate Check-in Response** (200):
```json
{
  "message": "Already checked in for this event today",
  "alreadyCheckedIn": true,
  "checkinDate": "2026-02-02T16:47:54.000Z"
}
```

**Validation Error Response** (400):
```json
{
  "message": "Email is required",
  "errors": ["Email is required", "Event ID is required"]
}
```

**Server Error Response** (500):
```json
{
  "message": "An error occurred while processing your request"
}
```

## Project Structure

```
bocc-backend/
├── netlify/
│   └── functions/
│       ├── checkin.js           # Main API endpoint handler
│       └── utils/
│           ├── airtable.js      # Airtable client and database operations
│           ├── circle.js        # Circle.so API client (Admin API v2)
│           └── validation.js    # Input validation and sanitization
├── tests/
│   ├── checkin.test.js          # Checkin handler unit tests
│   ├── circle.test.js           # Circle.so integration unit tests
│   ├── deduplication.test.js    # Duplicate detection unit tests
│   ├── validation.test.js       # Validation utilities unit tests
│   ├── smoke-test.sh            # End-to-end smoke test
│   ├── manual-dedup-test.sh     # Manual deduplication testing
│   ├── circle-diagnostic.sh     # Circle.so diagnostic test
│   └── start-local-test.sh      # Automated local testing
├── docs/
│   └── EPIC_2_CIRCLE_INTEGRATION.md  # Circle.so integration documentation
├── CIRCLE_PERMISSIONS.md        # Circle.so API permissions guide
├── CLAUDE.md                    # Development guidance for Claude Code
├── netlify.toml                 # Netlify configuration
└── package.json                 # Dependencies (airtable, axios, jest)
```

## Debugging

### Netlify Function Logs

View logs at: Netlify Dashboard → Functions → View logs

**Successful check-in with Circle invitation**:
```
Parsed email: test@example.com
Fetching attendee by email: test@example.com
Found existing attendee: recXXXXX
Checking for existing check-in today: recXXXXX bocc test-token
No matching check-in found for this attendee
Creating check-in for attendee: recXXXXX
Created check-in successfully
Inviting attendee to Circle.so: test@example.com
Searching for Circle member: test@example.com
Creating Circle member: test@example.com Test User
Successfully created Circle member: {...}
Successfully ensured Circle member: 12345
```

**Common Issues**:
- `Circle API response status: 401` - Invalid CIRCLE_API_TOKEN
- `Circle API response status: 403` - Insufficient API permissions
- `Circle API response status: 404` - Incorrect API endpoint
- See `docs/EPIC_2_CIRCLE_INTEGRATION.md` for detailed debugging guide

## Development Workflow

**Current Setup**: Push to `main` branch → Netlify auto-deploys

**Recommended**: Implement dev/staging/main workflow
- `dev` - Daily development, test locally
- `staging` - Pre-production testing
- `main` - Production deployment

## Related Repositories

- **Frontend**: https://github.com/z1g1/bocc-website
- **Backend**: https://github.com/z1g1/bocc-backend (this repo)

## Improvements Completed

- ✅ Token-based anti-spoofing via QR code URL parameter
- ✅ Email format validation
- ✅ Phone number format validation
- ✅ Duplicate check-in prevention (same day, same event, same token)
- ✅ Circle.so community integration with automatic invitations
- ✅ Comprehensive input validation and sanitization
- ✅ Formula injection protection
- ✅ XSS prevention

## Future Improvements

- Display check-in confirmation with edit option
- Privacy policy and data deletion capability
- Engagement rewards based on check-in count
- Dev/staging/main branch workflow

## Documentation

- `CLAUDE.md` - Development guidance and architecture
- `CIRCLE_PERMISSIONS.md` - Circle.so API permissions setup
- `docs/EPIC_2_CIRCLE_INTEGRATION.md` - Circle.so integration details

## License

Private repository for Buffalo Open Coffee Club
