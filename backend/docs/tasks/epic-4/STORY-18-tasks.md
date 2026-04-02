# STORY-18 Tasks: Comprehensive Testing Framework and Integration Validation

**Story**: [[STORY-18]] - Comprehensive Testing Framework
**Epic**: [[EPIC-4]] - Profile Photo Enforcement System
**Total Tasks**: 8
**Estimated Time**: 14-16 hours

---

## TASK-105: Create Test Data Factory and Utilities

**Type**: Test Infrastructure | **Estimated Time**: 2 hours | **Status**: Ready

### Implementation Files

**`tests/utilities/test-data-factory.js`**:
```javascript
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
  pagination: { page: 1, per_page: 100, total: records.length }
});

module.exports = {
  createMockMember,
  createMockWarningRecord,
  createMockCircleAPIResponse
};
```

**`tests/utilities/test-glick-setup.js`**:
```javascript
const TEST_GLICK = {
  id: 'a594d38f',
  email: 'zglicka@gmail.com',
  name: 'Test Glick'
};

const deleteTestGlickWarningRecord = async () => {
  const { findWarningByEmail, deleteWarningRecord } = require('../../netlify/functions/utils/airtable-warnings');
  const warning = await findWarningByEmail(TEST_GLICK.email);
  if (warning) {
    await deleteWarningRecord(warning.id);
    console.log('✓ Deleted Test Glick warning record');
  }
};

module.exports = { TEST_GLICK, deleteTestGlickWarningRecord };
```

**DoD**: Utility files created, mock factories functional, test cleanup utilities working

---

## TASK-106: Consolidate Unit Test Coverage (Stories 11-17)

**Type**: Test Review | **Estimated Time**: 2 hours | **Status**: Ready
**Dependencies**: TASK-105

### Objective
Verify all unit tests from previous stories exist and achieve >90% coverage for enforcement modules.

### Verification Checklist
- [ ] `tests/unit/circle-segment.test.js` - 5+ tests (STORY-11)
- [ ] `tests/unit/airtable-warnings.test.js` - 10+ tests (STORY-12)
- [ ] `tests/unit/enforcement-logic.test.js` - 19+ tests (STORY-13)
- [ ] `tests/unit/circle-messaging.test.js` - 18+ tests (STORY-14)
- [ ] `tests/unit/circle-deactivation.test.js` - 6+ tests (STORY-15)
- [ ] `tests/unit/admin-notifications.test.js` - 11+ tests (STORY-16)
- [ ] `tests/unit/photo-enforcement.test.js` - 8+ tests (STORY-17)

**Total Unit Tests**: 77+ tests

### Coverage Report
```bash
npm test -- --coverage
```

**Target**: >90% coverage for enforcement modules

**DoD**: All unit tests passing, coverage report generated and reviewed

---

## TASK-107: Create Full Enforcement Progression Integration Test

**Type**: Integration Test | **Estimated Time**: 3 hours | **Status**: Ready
**Dependencies**: TASK-106 | **Sequential After**: TASK-106

### Test File
`/Users/zack/projects/bocc-backend/tests/integration/enforcement-progression.test.js`

### Test Specification
```javascript
const { handler } = require('../../netlify/functions/photo-enforcement');
const { findWarningByEmail, deleteWarningRecord } = require('../../netlify/functions/utils/airtable-warnings');
const { TEST_GLICK, deleteTestGlickWarningRecord } = require('../utilities/test-glick-setup');

describe('Full Enforcement Progression Integration Test', () => {
  beforeAll(async () => {
    // Clean up: Delete any existing Test Glick warning record
    await deleteTestGlickWarningRecord();
    // Manual step: Remove Test Glick profile photo in Circle.so
    console.log('⚠️  Ensure Test Glick profile photo is removed before running');
  });

  afterAll(async () => {
    // Clean up test data
    await deleteTestGlickWarningRecord();
    console.log('⚠️  Manually restore Test Glick profile photo in Circle.so');
  });

  it('should create first warning (level 1)', async () => {
    const response = await handler({ queryStringParameters: {} }, {});
    expect(response.statusCode).toBe(200);

    const warning = await findWarningByEmail(TEST_GLICK.email);
    expect(warning).not.toBeNull();
    expect(warning.fields['Number of Warnings']).toBe(1);
    expect(warning.fields['Status']).toBe('Active');
  });

  it('should increment to warning level 2', async () => {
    const response = await handler({ queryStringParameters: {} }, {});
    const warning = await findWarningByEmail(TEST_GLICK.email);
    expect(warning.fields['Number of Warnings']).toBe(2);
  });

  it('should increment to warning level 3', async () => {
    const response = await handler({ queryStringParameters: {} }, {});
    const warning = await findWarningByEmail(TEST_GLICK.email);
    expect(warning.fields['Number of Warnings']).toBe(3);
  });

  it('should increment to warning level 4 (final warning)', async () => {
    const response = await handler({ queryStringParameters: {} }, {});
    const warning = await findWarningByEmail(TEST_GLICK.email);
    expect(warning.fields['Number of Warnings']).toBe(4);
    // Manual check: Admin should have received notification
  });

  it('should deactivate account at warning level 5', async () => {
    const response = await handler({ queryStringParameters: {} }, {});
    const warning = await findWarningByEmail(TEST_GLICK.email);
    expect(warning.fields['Status']).toBe('Deactivated');
    // Manual check: Test Glick account deactivated in Circle.so
    // Manual check: Admin received deactivation notification
  });
});
```

**DoD**: Full progression test passes, manual verification steps documented

---

## TASK-108: Create DM Delivery Validation Integration Test

**Type**: Integration Test | **Estimated Time**: 1.5 hours | **Status**: Ready
**Dependencies**: TASK-107

### Test File
`/Users/zack/projects/bocc-backend/tests/integration/dm-delivery.test.js`

### Test Specification
```javascript
const { sendWarningDM, sendThankYouDM } = require('../../netlify/functions/utils/circle-messaging');
const { TEST_GLICK } = require('../utilities/test-glick-setup');

describe('DM Delivery Integration Test', () => {
  it('should send standard warning DM (level 1)', async () => {
    const member = { id: TEST_GLICK.id, email: TEST_GLICK.email, name: TEST_GLICK.name };
    await sendWarningDM(member, 1, false);
    console.log('✓ Warning DM sent. Verify in Circle.so as Test Glick');
  });

  it('should send final warning DM (level 4)', async () => {
    const member = { id: TEST_GLICK.id, email: TEST_GLICK.email, name: TEST_GLICK.name };
    await sendWarningDM(member, 4, true);
    console.log('✓ Final warning DM sent. Verify in Circle.so as Test Glick');
  });

  it('should send deactivation notice DM (level 5)', async () => {
    const member = { id: TEST_GLICK.id, email: TEST_GLICK.email, name: TEST_GLICK.name };
    await sendWarningDM(member, 5, true);
    console.log('✓ Deactivation notice DM sent. Verify in Circle.so as Test Glick');
  });

  it('should send thank you DM', async () => {
    const member = { id: TEST_GLICK.id, email: TEST_GLICK.email, name: TEST_GLICK.name };
    await sendThankYouDM(member);
    console.log('✓ Thank you DM sent. Verify in Circle.so as Test Glick');
  });
});
```

**DoD**: DM tests pass, manual verification checklist provided

---

## TASK-109: Create Production Smoke Test Script

**Type**: Smoke Test | **Estimated Time**: 2 hours | **Status**: Ready
**Dependencies**: TASK-108

### Test File
`/Users/zack/projects/bocc-backend/tests/smoke/production-enforcement.sh`

### Script Implementation
```bash
#!/bin/bash
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
echo "✓ Test 1 passed"

# Test 2: Summary structure validation
echo "Test 2: Summary structure..."
SEGMENT_COUNT=$(echo "$RESPONSE" | jq -r '.summary.segmentMembersCount')
PROCESSED=$(echo "$RESPONSE" | jq -r '.summary.processed')

if [ -z "$SEGMENT_COUNT" ] || [ -z "$PROCESSED" ]; then
    echo "❌ Test 2 failed: Summary missing expected fields"
    exit 1
fi
echo "✓ Test 2 passed (Segment: $SEGMENT_COUNT, Processed: $PROCESSED)"

# Test 3: Error count check
echo "Test 3: Error count..."
ERROR_COUNT=$(echo "$RESPONSE" | jq -r '.summary.errors | length')

if [ "$ERROR_COUNT" -gt 0 ]; then
    echo "⚠️  Test 3 warning: $ERROR_COUNT errors in dry-run"
    echo "$RESPONSE" | jq '.summary.errors'
else
    echo "✓ Test 3 passed: No errors"
fi

# Test 4: Execution time
echo "Test 4: Execution time..."
DURATION_MS=$(echo "$RESPONSE" | jq -r '.summary.durationMs')
DURATION_S=$((DURATION_MS / 1000))

if [ "$DURATION_S" -gt 300 ]; then
    echo "⚠️  Test 4 warning: Execution took ${DURATION_S}s (>5 minutes)"
else
    echo "✓ Test 4 passed: Execution time ${DURATION_S}s"
fi

echo ""
echo "=== Smoke Tests Complete ==="
```

**DoD**: Script executable, all smoke tests pass, production validation successful

---

## TASK-110: Create Test Documentation

**Type**: Documentation | **Estimated Time**: 2 hours | **Status**: Ready
**Dependencies**: TASK-109

### Documentation File
`/Users/zack/projects/bocc-backend/docs/TESTING_EPIC_4.md`

### Content Outline
```markdown
# Epic 4 Testing Guide

## Overview
- Test coverage summary
- Testing approach (TDD)

## Unit Tests
- How to run: `npm test`
- Coverage report: `npm test -- --coverage`
- Test files and what they cover

## Integration Tests
- Prerequisites (Test Glick setup)
- How to run integration tests
- Manual verification steps

## Smoke Tests
- Production smoke tests
- How to run after deployment

## Test Data Management
- Test Glick setup/cleanup
- Mock data factories
- Airtable test data

## Manual Testing Checklist
- DM verification in Circle.so
- Admin notification verification
- Profile photo status changes
- Full enforcement progression (1→5)

## Troubleshooting
- Common test failures
- Environment variable issues
- API connection problems
```

**DoD**: Testing documentation complete, covers all test types

---

## TASK-111: Run Full Test Suite and Generate Coverage Report

**Type**: Test Execution | **Estimated Time**: 1.5 hours | **Status**: Ready
**Dependencies**: TASK-110 | **Sequential After**: TASK-110

### Objective
Execute all tests and generate comprehensive coverage report.

### Execution Steps
```bash
# 1. Run all unit tests
npm test

# 2. Run unit tests with coverage
npm test -- --coverage

# 3. Run integration tests (requires env vars)
npm run test:integration

# 4. Run smoke tests (local)
npm run test:smoke-local

# 5. Generate coverage HTML report
npm test -- --coverage --coverageReporters=html

# 6. Review coverage report
open coverage/index.html
```

### Coverage Goals
- **Enforcement modules**: >90% (circle-segment, airtable-warnings, enforcement-logic, circle-messaging, admin-notifications, photo-enforcement)
- **Overall project**: >80%

**DoD**: All tests passing, coverage report shows >90% for enforcement modules

---

## TASK-112: Create CI/CD Integration Plan

**Type**: Documentation | **Estimated Time**: 1 hour | **Status**: Ready
**Dependencies**: TASK-111 | **Sequential After**: TASK-111

### Objective
Document how to integrate tests into CI/CD pipeline.

### CI/CD Configuration File
`.github/workflows/epic-4-tests.yml` (example for GitHub Actions)

```yaml
name: Epic 4 Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest

    steps:
    - uses: actions/checkout@v2

    - name: Setup Node.js
      uses: actions/setup-node@v2
      with:
        node-version: '18'

    - name: Install dependencies
      run: npm install

    - name: Run unit tests with coverage
      run: npm test -- --coverage

    - name: Upload coverage to Codecov
      uses: codecov/codecov-action@v2

    - name: Run integration tests
      env:
        CIRCLE_API_TOKEN: ${{ secrets.CIRCLE_API_TOKEN }}
        CIRCLE_HEADLESS_API: ${{ secrets.CIRCLE_HEADLESS_API }}
        AIRTABLE_API_KEY: ${{ secrets.AIRTABLE_API_KEY }}
        AIRTABLE_BASE_ID: ${{ secrets.AIRTABLE_BASE_ID }}
      run: npm run test:integration

    - name: Run smoke tests (dry-run)
      run: bash tests/smoke/production-enforcement.sh
```

**DoD**: CI/CD configuration documented, ready for implementation

---

## Summary

**Total Tasks**: 8
**Test Coverage Goal**: >90% for enforcement modules
**Total Tests**: 80+ unit tests, 12+ integration tests, 4+ smoke tests

**Critical Path**: TASK-105 → TASK-106 → TASK-107 → TASK-108 → TASK-109 → TASK-110 → TASK-111 → TASK-112

**Completes Epic 4 Testing**: Comprehensive test framework validates all enforcement functionality
