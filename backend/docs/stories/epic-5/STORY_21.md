# Story 21: Update Test Suite

**ID**: STORY-21
**Epic**: EPIC-5 (Circle.so Member Photo Detection Refactoring)
**Status**: READY
**Story Points**: 3
**Complexity**: Medium
**Created**: 2026-02-06
**Dependencies**: STORY-20 (implementation complete)

---

## User Story

As a **developer**, I want to **update all 15 existing tests and add 5 new tests for the refactored member photo detection function**, so that comprehensive test coverage is maintained and safety limits are validated.

## Context

The test suite `tests/circle-segment.test.js` was written for the `getSegmentMembers(segmentId)` function, which assumed segment API queries were possible. Now that we've refactored to `getMembersWithoutPhotos()` with client-side filtering, all tests need to be updated to match the new implementation.

Additionally, the new safety limits (1000 member hard limit, 500 member warning) require new tests to ensure they function correctly and prevent dangerous scenarios.

## Acceptance Criteria

### Test Updates (15 Existing Tests)
- [ ] Update test file name: `circle-segment.test.js` → `circle-member-photo-detection.test.js`
- [ ] Update all test descriptions to reference `getMembersWithoutPhotos()` instead of `getSegmentMembers()`
- [ ] Remove `segmentId` parameter from all test function calls
- [ ] Update mock API endpoint from `/community_segments/{id}/members` to `/community_members`
- [ ] All 15 existing tests pass with new function

### New Tests (5 Additional Tests)
- [ ] **Test 1**: Throw error if total members > 1000 (safety limit)
- [ ] **Test 2**: Log warning if total members > 500 (warning threshold)
- [ ] **Test 3**: Handle members with null `avatar_url` correctly
- [ ] **Test 4**: Handle members with empty string `avatar_url` correctly
- [ ] **Test 5**: Performance benchmark: complete in <2 seconds for 60 members

### Test Suite Quality
- [ ] Total tests: 20 passing (15 updated + 5 new)
- [ ] No skipped or failing tests
- [ ] Test coverage includes all code paths
- [ ] Test names are descriptive and clear
- [ ] Mock responses match real Circle API structure

### Cleanup Requirements
- [ ] Remove old `getSegmentMembers()` function from `circle.js`
- [ ] Remove deprecation comment (no longer needed)
- [ ] Update `module.exports` to remove old function
- [ ] Verify no other code references `getSegmentMembers()`

## Technical Implementation Notes

### Test File Renaming

**Old File**: `/Users/zack/projects/bocc-backend/tests/circle-segment.test.js`
**New File**: `/Users/zack/projects/bocc-backend/tests/circle-member-photo-detection.test.js`

**Rationale**: New name reflects actual functionality (photo detection), not the abandoned approach (segments).

### Test Structure Updates

**Before (Segment-Based)**:
```javascript
describe('getSegmentMembers', () => {
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
});
```

**After (Client-Side Filtering)**:
```javascript
describe('getMembersWithoutPhotos', () => {
    it('should fetch all members and filter for those without photos', async () => {
        const mockMembers = [
            {
                id: 'member-1',
                email: 'user1@example.com',
                name: 'User One',
                avatar_url: null  // No photo
            },
            {
                id: 'member-2',
                email: 'user2@example.com',
                name: 'User Two',
                avatar_url: 'https://circle.so/avatars/member-2.jpg'  // Has photo
            },
            {
                id: 'member-3',
                email: 'user3@example.com',
                name: 'User Three',
                avatar_url: ''  // No photo (empty string)
            }
        ];

        mockAxiosGet.mockResolvedValue({
            data: {
                records: mockMembers,
                pagination: {
                    total: 3,
                    per_page: 100,
                    page: 1,
                    has_next_page: false
                }
            }
        });

        const result = await getMembersWithoutPhotos();

        // Verify correct endpoint called
        expect(mockAxiosGet).toHaveBeenCalledWith(
            '/community_members',
            expect.objectContaining({
                params: expect.objectContaining({ per_page: 100, page: 1 }),
                timeout: 30000
            })
        );

        // Verify filtered correctly (only members 1 and 3 without photos)
        expect(result).toHaveLength(2);
        expect(result[0].id).toBe('member-1');
        expect(result[1].id).toBe('member-3');
        expect(result.find(m => m.id === 'member-2')).toBeUndefined();
    });
});
```

### New Test Implementations

#### Test 1: Safety Limit (>1000 members)

```javascript
describe('Safety limits', () => {
    it('should throw error if total members exceeds 1000 (safety limit)', async () => {
        // Mock response with 1500 members
        const mockMembers = Array.from({ length: 1500 }, (_, i) => ({
            id: `member-${i + 1}`,
            email: `user${i + 1}@example.com`,
            name: `User ${i + 1}`,
            avatar_url: i % 2 === 0 ? null : 'https://example.com/avatar.jpg'
        }));

        // Mock paginated responses (15 pages of 100 each, last page 50)
        for (let page = 1; page <= 15; page++) {
            const start = (page - 1) * 100;
            const end = Math.min(start + 100, 1500);
            const pageMembers = mockMembers.slice(start, end);

            mockAxiosGet.mockResolvedValueOnce({
                data: {
                    records: pageMembers,
                    pagination: {
                        total: 1500,
                        per_page: 100,
                        page: page,
                        has_next_page: end < 1500
                    }
                }
            });
        }

        // Verify error thrown with helpful message
        await expect(getMembersWithoutPhotos()).rejects.toThrow(
            /Safety limit exceeded: 1500 members found, maximum is 1000/
        );

        // Verify error message includes guidance
        await expect(getMembersWithoutPhotos()).rejects.toThrow(
            /Review community size and consider increasing limit/
        );
    });
});
```

#### Test 2: Warning Threshold (>500 members)

```javascript
it('should log warning if total members exceeds 500 but continues processing', async () => {
    // Spy on console.warn
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    // Mock response with 600 members (50% without photos)
    const mockMembers = Array.from({ length: 600 }, (_, i) => ({
        id: `member-${i + 1}`,
        email: `user${i + 1}@example.com`,
        name: `User ${i + 1}`,
        avatar_url: i % 2 === 0 ? null : 'https://example.com/avatar.jpg'
    }));

    // Mock paginated responses (6 pages)
    for (let page = 1; page <= 6; page++) {
        const start = (page - 1) * 100;
        const end = Math.min(start + 100, 600);
        const pageMembers = mockMembers.slice(start, end);

        mockAxiosGet.mockResolvedValueOnce({
            data: {
                records: pageMembers,
                pagination: {
                    total: 600,
                    per_page: 100,
                    page: page,
                    has_next_page: end < 600
                }
            }
        });
    }

    // Execute function
    const result = await getMembersWithoutPhotos();

    // Verify warning logged
    expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('⚠️  WARNING: Community has 600 members')
    );

    // Verify execution continued (not thrown)
    expect(result).toHaveLength(300);  // 50% of 600

    warnSpy.mockRestore();
});
```

#### Test 3: Null `avatar_url`

```javascript
it('should filter members with null avatar_url correctly', async () => {
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

    // Verify only member with null avatar_url returned
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('member-1');
    expect(result[0].avatar_url).toBeNull();
});
```

#### Test 4: Empty String `avatar_url`

```javascript
it('should filter members with empty string avatar_url correctly', async () => {
    const mockMembers = [
        { id: 'member-1', email: 'user1@example.com', name: 'User One', avatar_url: '' },
        { id: 'member-2', email: 'user2@example.com', name: 'User Two', avatar_url: 'https://example.com/avatar.jpg' }
    ];

    mockAxiosGet.mockResolvedValue({
        data: {
            records: mockMembers,
            pagination: { total: 2, per_page: 100, page: 1, has_next_page: false }
        }
    });

    const result = await getMembersWithoutPhotos();

    // Verify only member with empty string avatar_url returned
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('member-1');
    expect(result[0].avatar_url).toBe('');
});
```

#### Test 5: Performance Benchmark

```javascript
it('should complete in less than 2 seconds for 60 members', async () => {
    // Mock realistic response for current community size
    const mockMembers = Array.from({ length: 60 }, (_, i) => ({
        id: `member-${i + 1}`,
        email: `user${i + 1}@example.com`,
        name: `User ${i + 1}`,
        avatar_url: i % 3 === 0 ? null : 'https://example.com/avatar.jpg'
    }));

    mockAxiosGet.mockResolvedValue({
        data: {
            records: mockMembers,
            pagination: { total: 60, per_page: 100, page: 1, has_next_page: false }
        }
    });

    const startTime = Date.now();
    const result = await getMembersWithoutPhotos();
    const duration = Date.now() - startTime;

    // Verify performance target
    expect(duration).toBeLessThan(2000);

    // Verify correct filtering (every 3rd member has no photo)
    expect(result).toHaveLength(20);
}, 3000);  // Test timeout: 3 seconds
```

### Test Updates Checklist

**Update 15 Existing Tests**:
1. ✅ Test: Fetch members successfully
   - Update: Remove segmentId parameter, change endpoint to /community_members
2. ✅ Test: Handle empty results
   - Update: Mock all members with photos (filtered result empty)
3. ✅ Test: Handle pagination
   - Update: Change endpoint, use has_next_page field
4. ✅ Test: Stop pagination correctly
   - Update: Mock has_next_page: false
5. ✅ Test: 404 error (segment not found)
   - **Remove**: No longer relevant (no segment endpoint)
6. ✅ Test: 401 auth error
   - Update: Endpoint change only
7. ✅ Test: Helpful 401 error message
   - Update: Error message verification
8. ✅ Test: Network error handling
   - Update: No changes needed (generic)
9. ✅ Test: Timeout after 30 seconds
   - Update: No changes needed
10. ✅ Test: Rate limit (429) error
    - Update: Error message verification
11. ✅ Test: Null segmentId
    - **Remove**: No parameters anymore
12. ✅ Test: Undefined segmentId
    - **Remove**: No parameters anymore
13. ✅ Test: Empty string segmentId
    - **Remove**: No parameters anymore
14. ✅ Test: Numeric segmentId
    - **Remove**: No parameters anymore
15. ✅ Test: String segmentId
    - **Remove**: No parameters anymore

**Add 5 New Tests**:
1. ✅ Safety limit >1000 members
2. ✅ Warning threshold >500 members
3. ✅ Null avatar_url filtering
4. ✅ Empty string avatar_url filtering
5. ✅ Performance <2 seconds

**Net Result**: 20 total tests (10 updated from original 15, 5 removed as no longer relevant, 5 new)

## Dependencies

### Blocks
- **STORY-22**: Documentation updates can proceed after tests pass
- **Epic 4 Manual Testing**: Can begin after all tests pass

### Blocked By
- **STORY-20**: Implementation must be complete before tests can be updated

### Related
- **STORY-19**: Test scenarios defined in research documentation

## Out of Scope

### Not Included
- Integration tests (manual testing in STORY-22)
- Performance profiling beyond benchmark test
- Stress testing with >1000 members (not realistic scenario)
- Testing Circle API failure recovery (handled at enforcement function level)

## Testing Approach

### Test Development Process
1. **Red Phase**: Update existing tests to fail (function signature changed)
2. **Green Phase**: Fix tests to pass with new implementation
3. **Add New Tests**: Implement 5 new safety/edge case tests
4. **Refactor**: Clean up test code, improve readability

### Running Tests
```bash
# Run all tests
npm test

# Run only photo detection tests
npm test -- circle-member-photo-detection

# Run with coverage
npm test -- --coverage circle-member-photo-detection

# Watch mode for development
npm test -- --watch circle-member-photo-detection
```

### Expected Output
```
Test Suites: 1 passed, 1 total
Tests:       20 passed, 20 total
Snapshots:   0 total
Time:        <1 second

Test Coverage:
  circle.js
    getMembersWithoutPhotos: 100%
    Branches: 100%
    Functions: 100%
    Lines: 100%
```

## Success Criteria

**Test Quality**:
- All 20 tests pass
- No skipped or disabled tests
- Test names are clear and descriptive
- Mocks match real API responses

**Code Quality**:
- Old `getSegmentMembers()` removed
- No references to segments in test names
- Test file renamed appropriately
- No linting warnings

**Coverage**:
- All code paths tested
- All error scenarios covered
- All safety limits validated
- Performance benchmark included

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Tests brittle to API changes | Medium | Use flexible matchers, validate structure |
| Mock responses unrealistic | Medium | Compare with real API responses in STORY-22 |
| Performance test flaky | Low | Use generous 2-second threshold, run multiple times |
| Missing edge cases | Medium | Code review with user, reference STORY-19 scenarios |

## Notes

### Why 20 Tests (Not 15+5=20)
- Original 15 tests included 5 input validation tests for `segmentId` parameter
- New function has no parameters, so those 5 tests are removed
- Net: 15 - 5 (removed) + 10 (updated) + 5 (new) = 20 total

### Test Philosophy
This project uses TDD (Test-Driven Development):
- Tests define expected behavior
- Implementation matches test expectations
- Refactoring maintains test coverage

### Maintaining Test Quality
- Every test should have a clear purpose
- Test names should explain what they validate
- Mocks should be realistic (match actual API responses)
- Edge cases should be explicit (not assumed)

---

**Next Steps**: Update test file, run test suite, verify 20/20 passing, then proceed to STORY-22 for manual testing.

**Time Estimate**: 2-3 hours (test updates + new tests + verification)
