# New Test Scenarios for Epic 5
## getMembersWithoutPhotos() Function Testing

**Epic**: Epic 5 - Circle.so Member Photo Detection Refactoring
**Story**: STORY-19 - Research Documentation & Safety Analysis
**Task**: TASK-93
**Implementation**: STORY-21 (TASK-103)
**Date**: 2026-02-06

---

## Overview

This document defines **5 new test scenarios** to be added to the test suite for the `getMembersWithoutPhotos()` function. These tests supplement the existing 10 tests (updated from segment-based approach) to ensure comprehensive coverage of client-side filtering logic and safety limits.

**Test File**: `tests/circle-members-without-photos.test.js`
**Total Test Count After Addition**: 20 tests (10 updated + 5 removed + 5 new)

---

## Test Scenario 1: Client-Side Filtering by avatar_url (Null)

### Purpose
Verify that members with `avatar_url === null` are correctly identified as having no profile photo.

### Business Context
Circle.so API returns `avatar_url: null` for members who have never uploaded a profile photo. This is the primary indicator we use for enforcement.

### Test Specification

**Test Name**: `should filter members with null avatar_url as having no photo`

**Setup**:
```javascript
const membersWithMixedPhotos = [
  {
    id: 'member-1',
    email: 'hasphoto@example.com',
    name: 'Has Photo User',
    avatar_url: 'https://app.circle.so/rails/active_storage/.../photo.jpg'
  },
  {
    id: 'member-2',
    email: 'nophoto@example.com',
    name: 'No Photo User',
    avatar_url: null  // <-- NULL means no photo
  },
  {
    id: 'member-3',
    email: 'alsohphoto@example.com',
    name: 'Also Has Photo',
    avatar_url: 'https://example.com/another-photo.png'
  }
];

mockAxiosGet.mockResolvedValue({
  data: {
    records: membersWithMixedPhotos,
    has_next_page: false
  }
});
```

**Execution**:
```javascript
const result = await getMembersWithoutPhotos();
```

**Assertions**:
```javascript
// Should return only the member with null avatar_url
expect(result).toHaveLength(1);
expect(result[0].email).toBe('nophoto@example.com');
expect(result[0].avatar_url).toBeNull();

// Should NOT include members with avatar URLs
expect(result.find(m => m.email === 'hasphoto@example.com')).toBeUndefined();
expect(result.find(m => m.email === 'alsohphoto@example.com')).toBeUndefined();
```

**Edge Cases Covered**:
- Null avatar_url (primary case)
- Valid avatar_url (should be excluded)
- Mixed member list (realistic scenario)

**Expected Outcome**: ✅ Pass - Only members with `null` avatar_url returned

---

## Test Scenario 2: Client-Side Filtering by avatar_url (Empty String)

### Purpose
Verify that members with `avatar_url === ""` (empty string) are correctly identified as having no profile photo.

### Business Context
In some API responses, Circle.so may return an empty string instead of null for members without photos. Our filtering logic must handle both cases.

### Test Specification

**Test Name**: `should filter members with empty string avatar_url as having no photo`

**Setup**:
```javascript
const membersWithEmptyStrings = [
  {
    id: 'member-1',
    email: 'emptystring@example.com',
    name: 'Empty String User',
    avatar_url: ''  // <-- EMPTY STRING means no photo
  },
  {
    id: 'member-2',
    email: 'hasphoto@example.com',
    name: 'Has Photo User',
    avatar_url: 'https://example.com/photo.jpg'
  },
  {
    id: 'member-3',
    email: 'nullphoto@example.com',
    name: 'Null Photo User',
    avatar_url: null
  }
];

mockAxiosGet.mockResolvedValue({
  data: {
    records: membersWithEmptyStrings,
    has_next_page: false
  }
});
```

**Execution**:
```javascript
const result = await getMembersWithoutPhotos();
```

**Assertions**:
```javascript
// Should return members with null OR empty string
expect(result).toHaveLength(2);

// Both null and empty string should be included
expect(result.find(m => m.email === 'emptystring@example.com')).toBeDefined();
expect(result.find(m => m.email === 'nullphoto@example.com')).toBeDefined();

// Members with actual URLs should be excluded
expect(result.find(m => m.email === 'hasphoto@example.com')).toBeUndefined();
```

**Edge Cases Covered**:
- Empty string avatar_url
- Null and empty string mixed in same response
- Ensures comprehensive filtering logic

**Expected Outcome**: ✅ Pass - Members with `null` OR `""` avatar_url returned

---

## Test Scenario 3: Safety Limit - Warning Threshold (500 Members)

### Purpose
Verify that the warning threshold is triggered when fetching exactly 500 members, and that processing continues normally.

### Business Context
When member count reaches 500, we log a warning to alert administrators about approaching the safety limit. This is an early signal of growth or potential issues, but not critical enough to stop processing.

### Test Specification

**Test Name**: `should log warning when fetching exactly 500 members but continue processing`

**Setup**:
```javascript
// Generate 500 members: 250 with photos, 250 without
const members500 = [
  ...Array(250).fill(null).map((_, i) => ({
    id: `with-photo-${i}`,
    email: `hasphoto${i}@example.com`,
    name: `User With Photo ${i}`,
    avatar_url: `https://example.com/photo-${i}.jpg`
  })),
  ...Array(250).fill(null).map((_, i) => ({
    id: `no-photo-${i}`,
    email: `nophoto${i}@example.com`,
    name: `User Without Photo ${i}`,
    avatar_url: null
  }))
];

mockAxiosGet.mockResolvedValue({
  data: {
    records: members500,
    has_next_page: false
  }
});
```

**Execution**:
```javascript
const consoleWarnSpy = jest.spyOn(console, 'warn');
const result = await getMembersWithoutPhotos();
```

**Assertions**:
```javascript
// Warning should be logged
expect(consoleWarnSpy).toHaveBeenCalledWith(
  expect.stringContaining('WARNING: Processing 500 members')
);
expect(consoleWarnSpy).toHaveBeenCalledWith(
  expect.stringContaining('Approaching safety limit')
);

// Processing should continue normally
expect(result).toBeDefined();
expect(result).toHaveLength(250);  // 250 members without photos

// All 250 members without photos should be returned
expect(result.every(m => m.avatar_url === null)).toBe(true);
```

**Edge Cases Covered**:
- Exact threshold boundary (500)
- Warning logged but processing continues
- Filtering still works correctly at scale

**Expected Outcome**: ✅ Pass - Warning logged, 250 members without photos returned

---

## Test Scenario 4: Safety Limit - Hard Cap (1000 Members)

### Purpose
Verify that the hard limit is enforced when fetching exactly 1000 members, and that an error is thrown to prevent processing.

### Business Context
When member count reaches 1000, this likely indicates a bug, misconfiguration, or unexpected growth. We stop processing immediately and require manual intervention to prevent accidental mass-processing.

### Test Specification

**Test Name**: `should throw error when fetching exactly 1000 members (hard limit)`

**Setup**:
```javascript
// Generate 1000 members
const members1000 = Array(1000).fill(null).map((_, i) => ({
  id: `member-${i}`,
  email: `user${i}@example.com`,
  name: `User ${i}`,
  avatar_url: i % 2 === 0 ? null : `https://example.com/photo-${i}.jpg`
}));

mockAxiosGet.mockResolvedValue({
  data: {
    records: members1000,
    has_next_page: false
  }
});
```

**Execution**:
```javascript
// Should throw error before filtering
await expect(getMembersWithoutPhotos()).rejects.toThrow();
```

**Assertions**:
```javascript
// Error message should be clear and actionable
await expect(getMembersWithoutPhotos()).rejects.toThrow('Safety limit exceeded');
await expect(getMembersWithoutPhotos()).rejects.toThrow('Found 1000 members');
await expect(getMembersWithoutPhotos()).rejects.toThrow('maximum allowed is 1000');

// Error should include instructions for fixing
await expect(getMembersWithoutPhotos()).rejects.toThrow('Update HARD_LIMIT_MAX_MEMBERS');
```

**Edge Cases Covered**:
- Exact hard limit boundary (1000)
- Error thrown before filtering (fail-fast)
- Clear error message with remediation steps

**Expected Outcome**: ✅ Pass - Error thrown with clear message

---

## Test Scenario 5: Safety Limit - Above Hard Cap (1001+ Members)

### Purpose
Verify that the hard limit is enforced even when member count exceeds 1000 by a large margin.

### Business Context
If a bug causes us to fetch 5000+ members, the safety limit should still trigger and prevent processing. This tests that the limit works for extreme cases.

### Test Specification

**Test Name**: `should throw error when fetching more than 1000 members (5000 member test)`

**Setup**:
```javascript
// Generate 5000 members (extreme case)
const members5000 = Array(5000).fill(null).map((_, i) => ({
  id: `member-${i}`,
  email: `user${i}@example.com`,
  name: `User ${i}`,
  avatar_url: null  // All without photos for worst case
}));

mockAxiosGet.mockResolvedValue({
  data: {
    records: members5000,
    has_next_page: false
  }
});
```

**Execution**:
```javascript
const consoleErrorSpy = jest.spyOn(console, 'error');
await expect(getMembersWithoutPhotos()).rejects.toThrow();
```

**Assertions**:
```javascript
// Error message should show actual count
await expect(getMembersWithoutPhotos()).rejects.toThrow('Found 5000 members');

// Console error should be logged
expect(consoleErrorSpy).toHaveBeenCalledWith(
  expect.stringContaining('SAFETY LIMIT EXCEEDED')
);

// Error should still reference the 1000 limit
await expect(getMembersWithoutPhotos()).rejects.toThrow('maximum allowed is 1000');
```

**Edge Cases Covered**:
- Far above hard limit (5x over)
- Worst case: All members without photos
- Console error logging works

**Expected Outcome**: ✅ Pass - Error thrown, actual count shown in message

---

## Test Coverage Summary

### New Tests Added: 5

| # | Test Name | Category | Lines of Code | Priority |
|---|-----------|----------|---------------|----------|
| 1 | Filter null avatar_url | Filtering Logic | ~25 | P0 (Critical) |
| 2 | Filter empty string avatar_url | Filtering Logic | ~25 | P0 (Critical) |
| 3 | Warning at 500 members | Safety Limits | ~30 | P1 (High) |
| 4 | Error at 1000 members | Safety Limits | ~20 | P0 (Critical) |
| 5 | Error above 1000 members | Safety Limits | ~20 | P1 (High) |

**Total New Test Lines**: ~120 lines

### Updated Tests: 10

Tests from `circle-segment.test.js` will be updated to test `getMembersWithoutPhotos()` instead of `getSegmentMembers()`.

### Removed Tests: 5

Tests specific to segment ID validation will be removed (no longer applicable).

### Final Test Count: 20 Tests

- 10 updated (from original segment tests)
- 5 new (defined in this document)
- 5 removed (segment-specific tests)

**Coverage Metrics**:
- Function coverage: 100% (all functions tested)
- Branch coverage: 95%+ (all safety limit branches)
- Line coverage: 90%+ (all critical paths)

---

## Test Implementation Order

**Phase 1: STORY-20 (Implementation)**
- Tests 1-2 implemented during TDD for filtering logic (TASK-95)
- Tests 3-5 implemented during TDD for safety limits (TASK-97)

**Phase 2: STORY-21 (Test Suite Update)**
- All 5 tests integrated into updated test file (TASK-102)
- Run with full test suite to verify no conflicts
- Code coverage validation

---

## Acceptance Criteria

### For Each Test

✅ **Test is runnable**: Uses Jest syntax, can be executed with `npm test`

✅ **Test is isolated**: Uses mocks, doesn't depend on external state

✅ **Test is deterministic**: Always produces same result for same input

✅ **Test is clear**: Descriptive name, clear assertions, good comments

✅ **Test is fast**: Completes in <100ms (no real API calls)

### For Test Suite

✅ **All 20 tests pass**: No failures or skipped tests

✅ **Coverage maintained**: 90%+ line coverage, 95%+ branch coverage

✅ **No regressions**: Existing functionality still works

✅ **Documentation updated**: Test file has clear describe blocks

---

## Integration with Existing Tests

### Describe Block Structure

```javascript
describe('getMembersWithoutPhotos', () => {

  // Existing tests (updated)
  describe('Successful member retrieval and filtering', () => {
    it('should fetch all members and filter by avatar_url');
    it('should handle empty member list gracefully');
    it('should return members with null or empty avatar_url');
  });

  // NEW: Client-side filtering tests
  describe('Client-side filtering logic', () => {
    it('should filter members with null avatar_url as having no photo');  // TEST 1
    it('should filter members with empty string avatar_url as having no photo');  // TEST 2
    it('should exclude members with valid avatar URLs');
  });

  // Updated: Pagination tests
  describe('Pagination handling', () => {
    it('should handle pagination with has_next_page');
    it('should accumulate members across multiple pages');
  });

  // NEW: Safety limits tests
  describe('Safety limits enforcement', () => {
    it('should not log warning when member count is below 500');
    it('should log warning when fetching exactly 500 members');  // TEST 3
    it('should throw error when fetching exactly 1000 members');  // TEST 4
    it('should throw error when fetching more than 1000 members');  // TEST 5
  });

  // Updated: Error handling tests
  describe('Error handling', () => {
    it('should throw helpful error for 401 authentication errors');
    it('should handle network errors');
    it('should handle rate limit errors (429)');
  });

  // Updated: Input validation tests
  describe('Input validation', () => {
    it('should work without requiring segmentId parameter');
  });
});
```

---

## Manual Testing Checklist

After automated tests pass, verify with manual testing:

- [ ] **Test 1**: Run with real API, verify members with null avatar_url are returned
- [ ] **Test 2**: Check API response for empty string avatar_url (if any exist)
- [ ] **Test 3**: Mock 500 members locally, verify warning logged to console
- [ ] **Test 4**: Mock 1000 members locally, verify error thrown
- [ ] **Test 5**: Mock 5000 members locally, verify error message shows 5000

---

## Regression Testing

### Ensure These Still Work

- ✅ Pagination with multiple pages
- ✅ Error handling for 401/404/429
- ✅ Empty member list (0 members)
- ✅ Single member without photo
- ✅ All members have photos (return empty array)

### Ensure These Are Removed

- ❌ Segment ID validation tests (no longer applicable)
- ❌ Segment endpoint 404 fallback tests (dangerous, removed)
- ❌ Tests expecting segmentId parameter validation

---

## Success Metrics

### Quantitative

- **Test Count**: 20 tests (5 new + 10 updated + 5 removed)
- **Test Duration**: <2 seconds for full suite
- **Code Coverage**: 90%+ line, 95%+ branch
- **Test Pass Rate**: 100% (all green)

### Qualitative

- **Clarity**: New tests are well-documented and self-explanatory
- **Maintainability**: Easy to understand and modify
- **Safety**: Safety limits thoroughly tested
- **Confidence**: Full confidence in filtering logic

---

## Next Steps

1. **TASK-94**: Document code comment strategy
2. **TASK-95**: Implement these tests during TDD (Red phase)
3. **TASK-96**: Implement function to make tests pass (Green phase)
4. **TASK-97**: Add safety limit tests (Red phase for limits)
5. **TASK-102**: Integrate all tests into renamed test file

---

## References

- **Safety Limits Spec**: `docs/SAFETY_LIMITS_SPECIFICATION.md`
- **Research Doc**: `docs/CIRCLE_SEGMENTS_RESEARCH.md`
- **Task Breakdown**: `docs/tasks/epic-5/STORY-20-tasks.md`
- **Epic 5**: `docs/epics/EPIC_5.md`

---

**Document Status**: ✅ Complete
**Approved for Implementation**: Yes
**Next Task**: TASK-94 (Code comment strategy)
