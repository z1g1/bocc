# Testing Documentation

## Test Types

### Unit Tests
Run with Jest to test individual functions and validation logic.

```bash
npm test
```

**Location:** `/tests/*.test.js`
**Coverage:** 124 tests covering validation utilities and checkin handler

### Smoke Tests
End-to-end tests that verify the API is working by making real HTTP requests.

## Smoke Test Usage

### Local Testing

**Prerequisites:**
1. Copy `.env.example` to `.env` and fill in your Airtable credentials:
   ```bash
   cp .env.example .env
   # Edit .env with your AIRTABLE_API_KEY and AIRTABLE_BASE_ID
   ```

**Run automated local test:**
```bash
npm run test:smoke-local
```

This will:
1. Start Netlify dev server automatically
2. Wait for server to be ready
3. Send test check-in request with `debug: "1"`
4. Verify API responds with success
5. Clean up and stop server

**Manual local test** (if server already running):
```bash
# Terminal 1: Start server
netlify dev

# Terminal 2: Run smoke test
API_URL=http://localhost:8888/.netlify/functions/checkin bash tests/smoke-test.sh
```

### Production Testing

Test the deployed API (creates test record in Airtable with debug flag):

```bash
npm run test:smoke-prod
```

This sends a test check-in to `https://bocc-backend.netlify.app` with `debug: "1"` flag.

## Test Data

All smoke tests use:
- **Email:** `smoke-test-{timestamp}@test.local` (unique per test)
- **Debug flag:** `"1"` (marks as test data in Airtable)
- **Event ID:** `smoke-test`
- **Token:** `test-smoke-token` (or from TEST_TOKEN env var)

Filter test data in Airtable using the `debug` field.

## Environment Variables

Required for local testing:
- `AIRTABLE_API_KEY` - Your Airtable API key
- `AIRTABLE_BASE_ID` - Your Airtable base ID

Optional:
- `API_URL` - Override API endpoint (default: localhost:8888)
- `TEST_TOKEN` - Token to use in smoke tests (default: test-smoke-token)
- `ALLOWED_ORIGIN` - CORS origin (default: *)

## Exit Codes

- `0` - All tests passed
- `1` - Tests failed
