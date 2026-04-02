# STORY-21 Tasks: Update Test Suite

**Story**: [[STORY-21]] - Update Test Suite
**Epic**: [[EPIC-5]] - Circle.so Member Photo Detection Refactoring
**Total Tasks**: 5
**Estimated Time**: 2-3 hours

---

## Task Overview

Update the existing test suite from segment-based testing to client-side filtering approach. Rename test file, update 15 existing tests, and remove deprecated `getSegmentMembers()` function.

---

## TASK-101: Rename Test File and Update Imports

**Type**: Refactor
**Estimated Time**: 15 minutes
**Status**: Ready
**Dependencies**: STORY-20 complete (new function implemented)

### Objective

Rename test file from `circle-segment.test.js` to `circle-member-photo-detection.test.js` and update all imports.

### Implementation Steps

**Step 1: Rename Test File**
```bash
cd /Users/zack/projects/bocc-backend
mv tests/circle-segment.test.js tests/circle-member-photo-detection.test.js
```

**Step 2: Update Imports in Test File**
```javascript
const { getMembersWithoutPhotos } = require('../netlify/functions/utils/circle');

// Remove old import (if exists):
// const { getSegmentMembers } = require('../netlify/functions/utils/circle');
```

**Step 3: Update Test Suite Description**
```javascript
// Old:
describe('getSegmentMembers', () => {

// New:
describe('getMembersWithoutPhotos', () => {
```

**Step 4: Verify File Renamed**
```bash
# Should find new file
ls -la tests/circle-member-photo-detection.test.js

# Should NOT find old file
ls -la tests/circle-segment.test.js
```

### Definition of Done

- [ ] Test file renamed to `circle-member-photo-detection.test.js`
- [ ] Import statement updated to use `getMembersWithoutPhotos`
- [ ] Test suite description updated
- [ ] Old test file no longer exists
- [ ] Git recognizes this as a file rename (not delete + create)

---

## TASK-102: Update Existing Tests for New Function Signature

**Type**: Refactor
**Estimated Time**: 60 minutes
**Status**: Ready
**Dependencies**: TASK-101 (file renamed)

### Objective

Update all existing tests to use the new function signature (no parameters) and new API endpoint (`/community_members`).

### Tests to Update

**Current Test Count**: 15 tests
**Tests to Update**: 10 tests (5 will be removed - see TASK-103)
**Updated Tests**: Change function call, endpoint, and expectations

### Update Pattern

**Before (Segment-Based)**:
```javascript
it('should fetch segment members successfully with valid segment ID', async () => {
    mockAxiosGet.mockResolvedValue({
        data: {
            records: mockMembers,
            pagination: { total: 2, per_page: 100, page: 1 }
        }
    });

    const result = await getSegmentMembers(238273);

    expect(mockAxiosGet).toHaveBeenCalledWith(
        '/community_segments/238273/members',
        expect.objectContaining({ params: expect.objectContaining({ per_page: 100 }) })
    );
});
```

**After (Client-Side Filtering)**:
```javascript
it('should fetch all members and filter for those without photos', async () => {
    const mockMembers = [
        { id: 'member-1', email: 'user1@example.com', name: 'User One', avatar_url: null },
        { id: 'member-2', email: 'user2@example.com', name: 'User Two', avatar_url: 'https://example.com/avatar.jpg' }
    ];

    mockAxiosGet.mockResolvedValue({
        data: {
            records: mockMembers,
            pagination: { total: 2, per_page: 100, page: 1, has_next_page: false }
        }
    });

    const result = await getMembersWithoutPhotos();

    expect(mockAxiosGet).toHaveBeenCalledWith(
        '/community_members',
        expect.objectContaining({
            params: expect.objectContaining({ per_page: 100, page: 1 }),
            timeout: 30000
        })
    );
    expect(result).toHaveLength(1);  // Only member-1 has no photo
});
```

### Tests to Update (10 tests)

1. **Test: Fetch members successfully**
   - Remove `segmentId` parameter
   - Change endpoint to `/community_members`
   - Add filtering expectation
   - Add `has_next_page: false` to pagination

2. **Test: Handle empty results**
   - Mock all members WITH photos (filtered result empty)
   - Verify empty array returned

3. **Test: Handle pagination**
   - Update endpoint to `/community_members`
   - Change pagination check to use `has_next_page` field
   - Mock multiple pages with `has_next_page: true/false`

4. **Test: Stop pagination correctly**
   - Mock `has_next_page: false` in pagination
   - Verify only one page fetched

5. **Test: 401 auth error**
   - Update endpoint to `/community_members`
   - Verify error message mentions `CIRCLE_API_TOKEN`

6. **Test: Helpful 401 error message**
   - Verify error message: "Circle API authentication failed"
   - Verify mentions checking token

7. **Test: Network error handling**
   - No changes needed (generic error handling)
   - Just update function call (no parameters)

8. **Test: Timeout after 30 seconds**
   - Verify timeout parameter still 30000ms
   - Update function call (no parameters)

9. **Test: Rate limit (429) error**
   - Update error message expectation
   - Should mention weekly cron, not daily

10. **Test: Invalid response structure**
    - Verify error when `records` field missing
    - Update function call (no parameters)

### Implementation Checklist

- [ ] Update test 1: Fetch members successfully
- [ ] Update test 2: Handle empty results
- [ ] Update test 3: Handle pagination
- [ ] Update test 4: Stop pagination correctly
- [ ] Update test 5: 401 auth error
- [ ] Update test 6: Helpful 401 error message
- [ ] Update test 7: Network error handling
- [ ] Update test 8: Timeout after 30 seconds
- [ ] Update test 9: Rate limit (429) error
- [ ] Update test 10: Invalid response structure

### Definition of Done

- [ ] All 10 tests updated to new function signature
- [ ] All endpoint references changed to `/community_members`
- [ ] All tests use `has_next_page` for pagination
- [ ] All mock responses include realistic pagination structure
- [ ] All tests pass after updates
- [ ] No references to `segmentId` remain in these tests

---

## TASK-103: Remove Tests for Segment ID Validation

**Type**: Test Cleanup
**Estimated Time**: 10 minutes
**Status**: Ready
**Dependencies**: TASK-102 (other tests updated)

### Objective

Remove 5 tests that validated `segmentId` parameter, which is no longer needed since the new function takes no parameters.

### Tests to Remove

1. **Test: 404 error (segment not found)**
   - No longer relevant - no segment endpoint
   - Remove entirely

2. **Test: Null segmentId**
   - No longer relevant - no parameters
   - Remove entirely

3. **Test: Undefined segmentId**
   - No longer relevant - no parameters
   - Remove entirely

4. **Test: Empty string segmentId**
   - No longer relevant - no parameters
   - Remove entirely

5. **Test: Numeric vs string segmentId**
   - No longer relevant - no parameters
   - Remove entirely

### Implementation

**Step 1: Identify Tests to Remove**
```bash
# Search for tests mentioning segmentId
grep -n "segmentId" tests/circle-member-photo-detection.test.js
```

**Step 2: Remove Test Blocks**
Delete entire test blocks (including `it()` or `describe()` wrappers):
```javascript
// DELETE THIS:
it('should throw error if segmentId is null', async () => {
    await expect(getSegmentMembers(null)).rejects.toThrow('segmentId is required');
});
```

**Step 3: Verify Removal**
```bash
# Should return no results
grep -n "segmentId" tests/circle-member-photo-detection.test.js
```

### Definition of Done

- [ ] 5 tests removed from test file
- [ ] No references to `segmentId` remain in tests
- [ ] No references to segment endpoint remain
- [ ] Test file still has valid syntax
- [ ] Remaining tests still pass

---

## TASK-104: Remove Deprecated getSegmentMembers Function

**Type**: Code Cleanup
**Estimated Time**: 15 minutes
**Status**: Ready
**Dependencies**: TASK-102, TASK-103 (all tests updated)

### Objective

Remove the deprecated `getSegmentMembers()` function from `circle.js` now that all tests use the new function.

### Implementation Steps

**File**: `/Users/zack/projects/bocc-backend/netlify/functions/utils/circle.js`

**Step 1: Remove Function**
Delete entire `getSegmentMembers` function (lines ~194-268):
```javascript
// DELETE FROM HERE:
/**
 * @deprecated This function was designed to query Circle.so audience segments,
 * ...
 */
const getSegmentMembers = async (segmentId) => {
    // ... entire implementation ...
};
// TO HERE
```

**Step 2: Update Module Exports**
```javascript
// Before:
module.exports = {
    findMemberByEmail,
    createMember,
    updateMemberCustomField,
    incrementCheckinCount,
    ensureMember,
    deactivateMember,
    getSegmentMembers,        // REMOVE THIS LINE
    getMembersWithoutPhotos
};

// After:
module.exports = {
    findMemberByEmail,
    createMember,
    updateMemberCustomField,
    incrementCheckinCount,
    ensureMember,
    deactivateMember,
    getMembersWithoutPhotos   // Only new function exported
};
```

**Step 3: Verify No References Remain**
```bash
# Search entire codebase for references
grep -r "getSegmentMembers" netlify/
grep -r "getSegmentMembers" tests/

# Should only find references in:
# - tests/circle-member-photo-detection.test.js (if any old comments remain)
# - This should be empty after TASK-102/103
```

**Step 4: Run All Tests**
```bash
npm test
```

### Definition of Done

- [ ] `getSegmentMembers` function removed from `circle.js`
- [ ] Function removed from `module.exports`
- [ ] No references to function remain in codebase
- [ ] All tests still pass
- [ ] No linting errors

---

## TASK-105: Run Full Test Suite and Verify Coverage

**Type**: Testing
**Estimated Time**: 20 minutes
**Status**: Ready
**Dependencies**: All previous tasks complete

### Objective

Run the complete test suite, verify all tests pass, and check that test coverage is maintained.

### Testing Steps

**Step 1: Run All Unit Tests**
```bash
npm test
```

**Expected Output**:
```
Test Suites: X passed, X total
Tests:       20 passed, 20 total
Snapshots:   0 total
Time:        <2 seconds
```

**Step 2: Run Specific Test File**
```bash
npm test -- circle-member-photo-detection
```

**Expected Output**:
```
PASS tests/circle-member-photo-detection.test.js
  getMembersWithoutPhotos
    ✓ should fetch all members and filter for those without photos
    ✓ should handle empty results
    ✓ should handle pagination
    ✓ should stop pagination correctly
    ✓ should handle 401 auth error
    ✓ should provide helpful 401 error message
    ✓ should handle network errors
    ✓ should timeout after 30 seconds
    ✓ should handle rate limit (429) error
    ✓ should validate response structure
  Safety limits
    ✓ should throw error if total members exceeds 1000
    ✓ should log warning if total members exceeds 500
  Edge cases
    ✓ should filter members with null avatar_url
    ✓ should filter members with empty string avatar_url
    ✓ should complete in less than 2 seconds for 60 members

Test Suites: 1 passed, 1 total
Tests:       15 passed, 15 total (note: 5 removed, 5 added from STORY-20)
```

**Step 3: Run with Coverage**
```bash
npm test -- --coverage circle-member-photo-detection
```

**Expected Coverage**:
```
File                | % Stmts | % Branch | % Funcs | % Lines
--------------------|---------|----------|---------|--------
circle.js           |     100 |      100 |     100 |     100
  getMembersWithoutPhotos |  100 |      100 |     100 |     100
```

**Step 4: Test Other Circle Functions**
Verify other circle.js functions still work:
```bash
npm test -- tests/circle.test.js
npm test -- tests/deactivation.test.js
```

**Step 5: Verify No Broken Tests**
```bash
# Run ALL tests
npm test

# Should see:
# - All test suites pass
# - No skipped tests
# - No failing tests
# - Total test count matches expected
```

### Test Count Summary

| Category | Before Epic 5 | After STORY-20 | After STORY-21 | Change |
|----------|---------------|----------------|----------------|--------|
| Segment tests | 15 | 15 (deprecated) | 0 | -15 |
| Photo detection tests | 0 | 5 (new) | 15 (updated + new) | +15 |
| Total | 15 | 20 | 15 | 0 |

**Explanation**:
- Started with 15 segment tests
- STORY-20 added 5 new tests (20 total temporarily)
- STORY-21 removes 5 parameter validation tests, updates 10 existing = 15 final

### Definition of Done

- [ ] All unit tests pass (100% passing)
- [ ] No skipped or failing tests
- [ ] Test coverage maintained at 100% for `getMembersWithoutPhotos`
- [ ] Other circle.js tests still pass
- [ ] Total test count: 15 tests in photo detection file
- [ ] No linting errors in test file
- [ ] Test execution time <2 seconds

---

## Summary

**Total Tasks**: 5
**Critical Path**: Tasks must be completed sequentially

**Task Breakdown**:
- TASK-101: Rename test file and update imports - 15 min
- TASK-102: Update 10 existing tests - 60 min
- TASK-103: Remove 5 parameter validation tests - 10 min
- TASK-104: Remove deprecated function - 15 min
- TASK-105: Run full test suite - 20 min

**Total Time**: ~2 hours

**Deliverables**:
- Test file renamed: `circle-member-photo-detection.test.js`
- 10 tests updated for new function signature
- 5 parameter validation tests removed
- Deprecated `getSegmentMembers()` function removed
- All 15 tests passing
- Test coverage maintained at 100%

**Test Count Summary**:
- Initial: 15 tests (segment-based)
- Added in STORY-20: +5 new tests (safety limits, edge cases)
- Removed in STORY-21: -5 tests (parameter validation)
- Final: 15 tests (client-side filtering)

**Next Story**: STORY-22 (Integration Testing & Documentation) - Manual testing with real API, update Epic 4 docs

**Success Criteria**:
- All tests pass
- Old function completely removed
- No references to segments remain
- Test coverage maintained
- Ready for STORY-22 integration testing
