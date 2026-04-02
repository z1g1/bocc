# Integration Tests

Integration tests validate the system works with real Circle.so API.

## Prerequisites

- `CIRCLE_API_TOKEN` environment variable set
- Access to Circle.so API

## Running Integration Tests

### Option 1: Via netlify dev (Recommended)

```bash
# Start netlify dev (loads .env automatically)
netlify dev

# In another terminal
npm run test:integration
```

### Option 2: Load .env manually

```bash
# Load environment from .env
source .env

# Run integration tests
npm run test:integration
```

### Option 3: Skip integration tests

```bash
# Run only unit tests (skips integration automatically)
npm run test:unit
```

## What Gets Tested

- `getMembersWithoutPhotos()` with real Circle.so API
- Member filtering logic with production data
- Performance (<3 seconds)
- Response structure validation
- Enforcement function integration

## Expected Output

```
PASS tests/integration/member-photo-detection-integration.test.js
  getMembersWithoutPhotos Integration Test
    ✓ should fetch all members and filter for those without photos from real API (850ms)
    ✓ should work end-to-end with enforcement function dry run (120ms)

Integration test completed in 850ms
Found 10 members without photos
✓ Integration test passed
```

## Troubleshooting

**Error: "CIRCLE_API_TOKEN not set"**
- Solution: Load .env file or start netlify dev

**Error: "Circle API authentication failed"**
- Solution: Check token is valid in Circle.so dashboard
- Regenerate token if needed

**Tests skipped**
- This is normal if CIRCLE_API_TOKEN is not available
- Integration tests only run when explicitly enabled
