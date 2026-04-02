# Story 18: Comprehensive Testing Framework and Integration Validation

**ID**: STORY-18
**Epic**: EPIC-4 (Profile Photo Enforcement)
**Status**: READY
**Story Points**: 5
**Complexity**: High
**Created**: 2026-02-05
**Dependencies**: STORY-17 (needs complete enforcement function for end-to-end tests)

---

## User Story

As a **developer**, I want **comprehensive unit and integration tests for the profile photo enforcement system**, so that all enforcement logic, API integrations, and edge cases are validated before production deployment and can be regression-tested after changes.

## Context

This story implements the complete testing framework for Epic 4, covering unit tests for all modules (segment query, warning operations, enforcement logic, messaging, deactivation, notifications) and integration tests that validate the full enforcement workflow with the Test Glick user. The testing framework ensures system reliability, catches regressions, and provides confidence for production deployment.

## Acceptance Criteria

### Functional Requirements
- [ ] Unit tests for all modules: `circle.js` (segment), `airtable-warnings.js`, `enforcement-logic.js`, `circle-messaging.js`, `admin-notifications.js`, `photo-enforcement.js`
- [ ] Integration test suite using Test Glick user (zglicka@gmail.com, ID: a594d38f)
- [ ] End-to-end test: Full enforcement progression (warning 1→2→3→4→5→deactivation)
- [ ] Test utilities: Mock factories for members, warnings, Circle API responses
- [ ] Smoke test script for production validation after deployment
- [ ] Test data cleanup utilities (reset Test Glick, delete test warning records)
- [ ] All tests pass with >90% code coverage for enforcement modules
- [ ] Test documentation: How to run tests, prerequisites, test data setup

### Non-Functional Requirements
- [ ] Unit tests run in <30 seconds
- [ ] Integration tests run in <5 minutes
- [ ] Tests are deterministic (no flaky tests, consistent results)
- [ ] Tests can run in CI/CD pipeline (GitHub Actions or similar)
- [ ] Test output is clear and actionable (failures include context)

### Testing Requirements
- [ ] **Unit Tests**: 80+ tests covering all functions and edge cases
- [ ] **Integration Tests**: 10+ tests covering full enforcement workflow
- [ ] **Smoke Tests**: 5+ production validation tests (non-destructive)
- [ ] **Test Coverage**: >90% for enforcement modules, >80% overall

## Technical Implementation Notes

### Approach

**Test Structure**:
```
tests/
├── unit/
│   ├── circle-segment.test.js           # STORY-11 tests
│   ├── airtable-warnings.test.js        # STORY-12 tests
│   ├── enforcement-logic.test.js        # STORY-13 tests
│   ├── circle-messaging.test.js         # STORY-14 tests
│   ├── circle-deactivation.test.js      # STORY-15 tests
│   ├── admin-notifications.test.js      # STORY-16 tests
│   └── photo-enforcement.test.js        # STORY-17 tests
├── integration/
│   ├── enforcement-progression.test.js  # Full 1→5 workflow
│   ├── dm-delivery.test.js              # DM sending validation
│   └── deactivation-reinvite.test.js    # Deactivation + re-invite flow
├── smoke/
│   └── production-enforcement.sh        # Production smoke tests
└── utilities/
    ├── test-data-factory.js             # Mock data generators
    ├── test-glick-setup.js              # Test Glick configuration
    └── cleanup-test-data.js             # Test data cleanup
```

**Testing Tools**:
- **Unit Tests**: Jest (existing from Epic 1/2/3)
- **Integration Tests**: Jest + real API calls (Circle.so, Airtable)
- **Smoke Tests**: Bash scripts (like existing `smoke-test.sh`)

### Unit Test Coverage

#### 1. Circle Segment Tests (`tests/unit/circle-segment.test.js`)

```javascript
// STORY-11: getSegmentMembers
describe('getSegmentMembers', () => {
    it('should fetch segment members successfully', async () => { /* ... */ });
    it('should handle empty segment gracefully', async () => { /* ... */ });
    it('should handle pagination for large segments', async () => { /* ... */ });
    it('should fall back to all-members query if segment endpoint 404', async () => { /* ... */ });
    it('should propagate Circle API errors', async () => { /* ... */ });
});

// 5 tests total
```

#### 2. Airtable Warnings Tests (`tests/unit/airtable-warnings.test.js`)

```javascript
// STORY-12: Warning CRUD operations
describe('findWarningByEmail', () => {
    it('should find existing warning (case-insensitive)', async () => { /* ... */ });
    it('should return null if not found', async () => { /* ... */ });
    it('should escape formula injection', async () => { /* ... */ });
});

describe('createWarningRecord', () => {
    it('should create warning with correct fields', async () => { /* ... */ });
});

describe('incrementWarningCount', () => {
    it('should increment count and update date', async () => { /* ... */ });
});

describe('updateWarningStatus', () => {
    it('should update status to Photo Added', async () => { /* ... */ });
    it('should reject invalid status', async () => { /* ... */ });
});

describe('deleteWarningRecord', () => {
    it('should delete warning by ID', async () => { /* ... */ });
});

// 8 tests total
```

#### 3. Enforcement Logic Tests (`tests/unit/enforcement-logic.test.js`)

```javascript
// STORY-13: Decision and execution logic
describe('determineEnforcementAction', () => {
    it('should return CREATE_WARNING for new member', async () => { /* ... */ });
    it('should return INCREMENT_WARNING for 1→2', async () => { /* ... */ });
    it('should return INCREMENT_WARNING for 2→3', async () => { /* ... */ });
    it('should return INCREMENT_WARNING with admin notify for 3→4', async () => { /* ... */ });
    it('should return DEACTIVATE for 4→5', async () => { /* ... */ });
    it('should return PHOTO_ADDED when member has photo', async () => { /* ... */ });
    it('should return SKIP for already deactivated', async () => { /* ... */ });
    it('should handle warning count > 5 anomaly', async () => { /* ... */ });
});

describe('processEnforcementAction', () => {
    it('should execute CREATE_WARNING action', async () => { /* ... */ });
    it('should execute INCREMENT_WARNING action', async () => { /* ... */ });
    it('should execute DEACTIVATE action', async () => { /* ... */ });
    it('should execute PHOTO_ADDED action', async () => { /* ... */ });
    it('should execute SKIP action', async () => { /* ... */ });
    it('should support dry-run mode', async () => { /* ... */ });
    it('should handle DM send failures gracefully', async () => { /* ... */ });
});

// 15 tests total
```

#### 4. Circle Messaging Tests (`tests/unit/circle-messaging.test.js`)

```javascript
// STORY-14: Member API DM integration
describe('getHeadlessJWT', () => {
    it('should generate JWT via Headless Auth API', async () => { /* ... */ });
    it('should cache JWT token', async () => { /* ... */ });
    it('should propagate auth errors', async () => { /* ... */ });
});

describe('findOrCreateDMChat', () => {
    it('should find existing DM chat', async () => { /* ... */ });
    it('should create new DM chat if not found', async () => { /* ... */ });
    it('should cache chat room UUID', async () => { /* ... */ });
});

describe('sendDMMessage', () => {
    it('should send message in TipTap format', async () => { /* ... */ });
    it('should propagate Member API errors', async () => { /* ... */ });
});

describe('sendWarningDM', () => {
    it('should send standard warning for level 1-3', async () => { /* ... */ });
    it('should send final warning for level 4', async () => { /* ... */ });
    it('should send deactivation notice for level 5', async () => { /* ... */ });
});

describe('sendThankYouDM', () => {
    it('should send thank you message', async () => { /* ... */ });
});

// 12 tests total
```

#### 5. Deactivation Tests (`tests/unit/circle-deactivation.test.js`)

```javascript
// STORY-15: Account deactivation
describe('deactivateMember', () => {
    it('should deactivate member via DELETE', async () => { /* ... */ });
    it('should handle 404 gracefully (already deleted)', async () => { /* ... */ });
    it('should propagate auth errors', async () => { /* ... */ });
    it('should propagate permission errors', async () => { /* ... */ });
    it('should handle timeout', async () => { /* ... */ });
});

// 5 tests total
```

#### 6. Admin Notifications Tests (`tests/unit/admin-notifications.test.js`)

```javascript
// STORY-16: Admin alerting
describe('formatAdminAlert', () => {
    it('should format FINAL_WARNING alert', () => { /* ... */ });
    it('should format DEACTIVATION alert', () => { /* ... */ });
    it('should format ERROR alert', () => { /* ... */ });
});

describe('notifyAdmin', () => {
    it('should send admin notification via DM', async () => { /* ... */ });
    it('should handle DM send failures gracefully', async () => { /* ... */ });
});

// 5 tests total
```

#### 7. Photo Enforcement Orchestration Tests (`tests/unit/photo-enforcement.test.js`)

```javascript
// STORY-17: Main scheduled function
describe('photo-enforcement handler', () => {
    it('should process all segment members', async () => { /* ... */ });
    it('should handle segment query failure', async () => { /* ... */ });
    it('should continue after individual member errors', async () => { /* ... */ });
    it('should execute dry-run without side effects', async () => { /* ... */ });
    it('should generate accurate summary', async () => { /* ... */ });
    it('should respect rate limits', async () => { /* ... */ });
});

// 6 tests total
```

**Total Unit Tests**: 56 tests

### Integration Test Coverage

#### 1. Full Enforcement Progression (`tests/integration/enforcement-progression.test.js`)

```javascript
/**
 * End-to-end test: Complete enforcement progression with Test Glick
 * Prerequisites:
 * - Test Glick user exists with no profile photo
 * - No existing warning record for Test Glick
 * - All env vars configured (CIRCLE_API_TOKEN, CIRCLE_HEADLESS_API, AIRTABLE_API_KEY, AIRTABLE_BASE_ID)
 */
describe('Full Enforcement Progression', () => {
    beforeAll(async () => {
        // Setup: Remove Test Glick photo, delete warning record
        await removeTestGlickPhoto();
        await deleteTestGlickWarningRecord();
    });

    afterAll(async () => {
        // Cleanup: Restore Test Glick photo, delete warning record
        await restoreTestGlickPhoto();
        await deleteTestGlickWarningRecord();
    });

    it('should create first warning (level 1)', async () => {
        // Run enforcement
        const result = await runEnforcement();

        // Verify warning record created
        const warning = await findWarningByEmail('zglicka@gmail.com');
        expect(warning).not.toBeNull();
        expect(warning.fields['Number of Warnings']).toBe(1);
        expect(warning.fields['Status']).toBe('Active');

        // Verify DM sent (check Circle.so manually or via API if available)
    });

    it('should increment to warning level 2', async () => {
        // Run enforcement again
        const result = await runEnforcement();

        // Verify warning count incremented
        const warning = await findWarningByEmail('zglicka@gmail.com');
        expect(warning.fields['Number of Warnings']).toBe(2);
    });

    it('should increment to warning level 3', async () => {
        const result = await runEnforcement();
        const warning = await findWarningByEmail('zglicka@gmail.com');
        expect(warning.fields['Number of Warnings']).toBe(3);
    });

    it('should increment to warning level 4 (final warning) and notify admin', async () => {
        const result = await runEnforcement();

        const warning = await findWarningByEmail('zglicka@gmail.com');
        expect(warning.fields['Number of Warnings']).toBe(4);

        // Verify admin received notification (manual check or API query)
        // TODO: Implement admin notification verification
    });

    it('should deactivate account at warning level 5', async () => {
        const result = await runEnforcement();

        // Verify warning status updated to Deactivated
        const warning = await findWarningByEmail('zglicka@gmail.com');
        expect(warning.fields['Status']).toBe('Deactivated');

        // Verify account deactivated (query Circle API)
        const member = await findMemberByEmail('zglicka@gmail.com');
        expect(member).toBeNull(); // If hard delete, member not found

        // Verify admin received deactivation notification
    });

    it('should handle photo added (thank you message)', async () => {
        // Setup: Re-invite Test Glick, add photo
        await reinviteTestGlick();
        await addTestGlickPhoto();

        // Create warning record manually (simulate previous warnings)
        await createWarningRecord('Test Glick', 'zglicka@gmail.com');

        // Run enforcement
        const result = await runEnforcement();

        // Verify warning record deleted
        const warning = await findWarningByEmail('zglicka@gmail.com');
        expect(warning).toBeNull();

        // Verify thank you DM sent
    });
});
```

#### 2. DM Delivery Validation (`tests/integration/dm-delivery.test.js`)

```javascript
/**
 * Validate DM delivery to Test Glick
 */
describe('DM Delivery Integration', () => {
    it('should send standard warning DM', async () => {
        await sendWarningDM(
            { id: 'a594d38f', email: 'zglicka@gmail.com', name: 'Test Glick' },
            1,
            false
        );

        // Manual verification: Check Circle.so DMs as Test Glick
        // TODO: Implement automated DM verification if Circle API supports
    });

    it('should send final warning DM', async () => {
        await sendWarningDM(
            { id: 'a594d38f', email: 'zglicka@gmail.com', name: 'Test Glick' },
            4,
            true
        );
    });

    it('should send deactivation notice DM', async () => {
        await sendWarningDM(
            { id: 'a594d38f', email: 'zglicka@gmail.com', name: 'Test Glick' },
            5,
            true
        );
    });

    it('should send thank you DM', async () => {
        await sendThankYouDM({
            id: 'a594d38f',
            email: 'zglicka@gmail.com',
            name: 'Test Glick'
        });
    });
});
```

#### 3. Deactivation and Re-Invitation (`tests/integration/deactivation-reinvite.test.js`)

```javascript
/**
 * Test deactivation and re-invitation workflow
 */
describe('Deactivation and Re-Invitation', () => {
    it('should deactivate Test Glick account', async () => {
        const result = await deactivateMember('a594d38f');
        expect(result.success).toBe(true);

        // Verify member not found or status inactive
        const member = await findMemberByEmail('zglicka@gmail.com');
        // Expectation depends on soft vs hard delete (determined in STORY-15)
    });

    it('should re-invite Test Glick after deactivation', async () => {
        // Attempt re-invitation
        // Method depends on DELETE behavior (soft vs hard delete)
        // If soft delete: May require special endpoint or manual admin action
        // If hard delete: Use standard createMember

        // Verify member re-created/restored
        const member = await findMemberByEmail('zglicka@gmail.com');
        expect(member).not.toBeNull();
        expect(member.email).toBe('zglicka@gmail.com');
    });

    it('should reset warning count after re-invitation', async () => {
        // After re-invitation, warning record should be deleted or reset
        // Run enforcement to verify no warning record exists
        const warning = await findWarningByEmail('zglicka@gmail.com');
        expect(warning).toBeNull();
    });
});
```

**Total Integration Tests**: 12 tests

### Smoke Tests for Production

**Script**: `tests/smoke/production-enforcement.sh`

```bash
#!/bin/bash
# Production smoke tests for photo enforcement
# Run after deployment to verify system health

set -e

API_URL="https://bocc-backend.netlify.app/.netlify/functions/photo-enforcement"

echo "=== Photo Enforcement Smoke Tests ==="

# Test 1: Dry-run mode (no side effects)
echo "Test 1: Dry-run enforcement..."
RESPONSE=$(curl -s -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -d '{"dryRun": true}')

SUCCESS=$(echo "$RESPONSE" | jq -r '.success')
if [ "$SUCCESS" != "true" ]; then
    echo "❌ Test 1 failed: Dry-run did not succeed"
    exit 1
fi

echo "✓ Test 1 passed: Dry-run enforcement succeeded"

# Test 2: Summary contains expected fields
echo "Test 2: Summary structure..."
SEGMENT_COUNT=$(echo "$RESPONSE" | jq -r '.summary.segmentMembersCount')
PROCESSED=$(echo "$RESPONSE" | jq -r '.summary.processed')

if [ -z "$SEGMENT_COUNT" ] || [ -z "$PROCESSED" ]; then
    echo "❌ Test 2 failed: Summary missing expected fields"
    exit 1
fi

echo "✓ Test 2 passed: Summary structure valid"
echo "  - Segment members: $SEGMENT_COUNT"
echo "  - Processed: $PROCESSED"

# Test 3: No critical errors in dry-run
echo "Test 3: Error count..."
ERROR_COUNT=$(echo "$RESPONSE" | jq -r '.summary.errors | length')

if [ "$ERROR_COUNT" -gt 0 ]; then
    echo "⚠️  Test 3 warning: $ERROR_COUNT errors in dry-run"
    echo "$RESPONSE" | jq '.summary.errors'
else
    echo "✓ Test 3 passed: No errors in dry-run"
fi

# Test 4: Execution time reasonable
echo "Test 4: Execution time..."
DURATION_MS=$(echo "$RESPONSE" | jq -r '.summary.durationMs')
DURATION_S=$((DURATION_MS / 1000))

if [ "$DURATION_S" -gt 300 ]; then
    echo "⚠️  Test 4 warning: Execution took ${DURATION_S}s (>5 minutes)"
else
    echo "✓ Test 4 passed: Execution time ${DURATION_S}s (acceptable)"
fi

echo ""
echo "=== Smoke Tests Complete ==="
```

### Test Utilities

#### Test Data Factory (`tests/utilities/test-data-factory.js`)

```javascript
/**
 * Mock data generators for unit tests
 */

const createMockMember = (overrides = {}) => ({
    id: 'mock-member-id',
    email: 'test@example.com',
    name: 'Test User',
    has_profile_picture: false,
    ...overrides
});

const createMockWarningRecord = (overrides = {}) => ({
    id: 'mock-warning-id',
    fields: {
        'Name': 'Test User',
        'Email': 'test@example.com',
        'Number of Warnings': 1,
        'Last Warning Date': '2026-02-05',
        'Status': 'Active',
        ...overrides
    }
});

const createMockCircleAPIResponse = (records) => ({
    records: records,
    pagination: {
        page: 1,
        per_page: 100,
        total: records.length
    }
});

module.exports = {
    createMockMember,
    createMockWarningRecord,
    createMockCircleAPIResponse
};
```

#### Test Glick Setup (`tests/utilities/test-glick-setup.js`)

```javascript
/**
 * Utilities for Test Glick user setup/cleanup
 */

const TEST_GLICK = {
    id: 'a594d38f',
    email: 'zglicka@gmail.com',
    name: 'Test Glick'
};

const removeTestGlickPhoto = async () => {
    // TODO: Implement via Circle API (if supported)
    // For now: Manual step before running integration tests
    console.log('⚠️  Manually remove Test Glick profile photo before running tests');
};

const addTestGlickPhoto = async () => {
    // TODO: Implement via Circle API (if supported)
    // For now: Manual step
    console.log('⚠️  Manually add Test Glick profile photo');
};

const deleteTestGlickWarningRecord = async () => {
    const { findWarningByEmail, deleteWarningRecord } = require('../../netlify/functions/utils/airtable-warnings');

    const warning = await findWarningByEmail(TEST_GLICK.email);
    if (warning) {
        await deleteWarningRecord(warning.id);
        console.log('✓ Deleted Test Glick warning record');
    }
};

module.exports = {
    TEST_GLICK,
    removeTestGlickPhoto,
    addTestGlickPhoto,
    deleteTestGlickWarningRecord
};
```

### Integration Points

- **All Stories**: Tests validate functionality from stories 11-17
- **Jest Configuration**: Extend existing `package.json` test config
- **CI/CD**: Tests runnable in GitHub Actions or similar

### Technical Considerations

**Test Data Isolation**:
- Unit tests use mocks (no real API calls)
- Integration tests use Test Glick user only (isolated from production data)
- Smoke tests use dry-run mode (non-destructive)

**Test Execution Time**:
- Unit tests: ~30 seconds (all mocked)
- Integration tests: ~5 minutes (real API calls, sequential enforcement progression)
- Smoke tests: ~10 seconds (single dry-run request)

**Flaky Test Prevention**:
- Use fixed test data (Test Glick user with known state)
- Clean up test data before and after tests (idempotent)
- Mock time-sensitive operations (dates, timestamps)
- Retry transient network errors in integration tests

**Manual Verification Steps**:
- DM delivery (check Circle.so UI as Test Glick)
- Admin notifications (check Circle.so UI as circle@zackglick.com)
- Profile photo status (verify in Circle.so UI)

**CI/CD Integration**:
- Unit tests run on every commit
- Integration tests run on PR to main branch (require secrets)
- Smoke tests run after deployment to production

### Existing Patterns to Follow

- **Jest Mocking**: Like Epic 2/3 tests, mock external APIs (axios, Airtable SDK)
- **Test Organization**: Group tests by module, use descriptive test names
- **Assertions**: Use Jest matchers (`expect`, `toBe`, `toHaveBeenCalledWith`)

### Security Considerations

- **Test Secrets**: Integration tests require real API tokens (store in GitHub Secrets for CI/CD)
- **Test Data PII**: Test Glick email is not sensitive (test account)
- **Production Safety**: Smoke tests use dry-run mode (no data changes)

## Dependencies

### Blocks
- None (completes Epic 4)

### Blocked By
- **STORY-17**: Needs main enforcement function for end-to-end tests

### Related
- All stories (tests validate all functionality)

## Out of Scope

- Performance/load testing (not needed for weekly enforcement)
- Security penetration testing (handled separately)
- Chaos testing (deliberately breaking components)
- UI testing (no UI for enforcement system)
- Cross-browser testing (N/A, backend only)

## Testing Approach

This story IS the testing approach - it tests all other stories.

## Notes

**Test Coverage Goals**:
- Enforcement modules: >90% (critical business logic)
- Utility modules: >80% (important but less critical)
- Overall project: >75% (including check-in functionality)

**Test-Driven Development**:
- Tests written alongside implementation (per story)
- This story consolidates and enhances test coverage

**Manual Testing Required**:
- DM delivery verification (Circle.so UI)
- Admin notification verification (Circle.so UI)
- Profile photo status changes (Circle.so UI)
- Deactivation/re-invitation workflow (Circle.so admin UI)

**Test Documentation**:
- All tests include descriptive names and comments
- Integration test prerequisites documented in test files
- Smoke test script includes usage instructions

**Future Enhancements**:
- Automated DM verification (if Circle API adds DM query support)
- Performance benchmarking (track execution time over time)
- Visual regression testing for message formatting
- Automated test data generation (create/cleanup Test Glick photo via API)

---

**Next Steps**: Implement all unit tests alongside story development, create integration test suite, develop smoke test script, validate full enforcement workflow with Test Glick user, achieve >90% test coverage for enforcement modules, integrate tests into CI/CD pipeline.
