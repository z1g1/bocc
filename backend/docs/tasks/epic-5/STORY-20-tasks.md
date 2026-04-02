# STORY-20 Tasks: Refactor Function Implementation

**Story**: [[STORY-20]] - Refactor Function Implementation
**Epic**: [[EPIC-5]] - Circle.so Member Photo Detection Refactoring
**Total Tasks**: 6
**Estimated Time**: 3-4 hours

---

## Task Overview

Refactor `getSegmentMembers()` into `getMembersWithoutPhotos()` with client-side filtering and safety limits. This is the critical path for unblocking Epic 4 deployment.

---

## TASK-95: Write Test for Basic Member Fetching (Red Phase)

**Type**: Test
**Estimated Time**: 30 minutes
**Status**: Ready
**Dependencies**: STORY-19 complete

### Objective

Write a failing test for the new `getMembersWithoutPhotos()` function that verifies basic member fetching and filtering.

### Test Specification

**Test File**: `/Users/zack/projects/bocc-backend/tests/circle-member-photo-detection.test.js` (create new file)

**Test Description**:
```javascript
describe('getMembersWithoutPhotos', () => {
    it('should fetch all members and filter for those without photos', async () => {
        // Arrange
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

        // Act
        const result = await getMembersWithoutPhotos();

        // Assert
        expect(mockAxiosGet).toHaveBeenCalledWith(
            '/community_members',
            expect.objectContaining({
                params: expect.objectContaining({ per_page: 100, page: 1 }),
                timeout: 30000
            })
        );
        expect(result).toHaveLength(2);
        expect(result[0].id).toBe('member-1');
        expect(result[1].id).toBe('member-3');
    });
});
```

### Expected Test Failure

Before implementation:
```
Error: getMembersWithoutPhotos is not a function
```

### Definition of Done

- [ ] New test file created: `circle-member-photo-detection.test.js`
- [ ] Test imports axios mock and circle.js utilities
- [ ] Test describes basic filtering scenario
- [ ] Test runs and fails (function doesn't exist yet)
- [ ] Mock structure matches real Circle.so API response

---

## TASK-96: Implement getMembersWithoutPhotos Function (Green Phase)

**Type**: Implementation
**Estimated Time**: 60 minutes
**Status**: Ready
**Dependencies**: TASK-95 (test written)

### Objective

Implement the new `getMembersWithoutPhotos()` function with pagination, client-side filtering, and safety limits.

### Implementation Steps

**File**: `/Users/zack/projects/bocc-backend/netlify/functions/utils/circle.js`

**Step 1: Add Function Implementation**
```javascript
/**
 * Get all community members without profile photos
 *
 * Uses client-side filtering as Circle.so Admin API v2 does not support
 * querying audience segments directly. Fetches all community members and
 * filters by avatar_url field presence.
 *
 * See docs/CIRCLE_SEGMENTS_RESEARCH.md for API limitations explanation.
 *
 * SAFETY LIMITS:
 * - Hard limit: 1000 members (throws error if exceeded)
 * - Warning threshold: 500 members (logs warning, continues)
 *
 * PERFORMANCE:
 * - Current community size: ~60 members (<1 second)
 * - Expected growth (1 year): 200-500 members (<2 seconds)
 * - Safety limit (1000 members): <10 seconds
 *
 * @returns {Promise<Array>} Array of members without profile photos
 *   Each member object: {id, email, name, avatar_url}
 * @throws {Error} If total members > 1000 (safety limit exceeded)
 * @throws {Error} If Circle API request fails (auth, network, etc.)
 */
const getMembersWithoutPhotos = async () => {
    const startTime = Date.now();

    try {
        console.log('Fetching all community members for client-side photo filtering');

        // Step 1: Fetch all members with pagination
        let allMembers = [];
        let page = 1;
        let hasMore = true;

        while (hasMore) {
            const response = await circleApi.get('/community_members', {
                params: {
                    per_page: 100,
                    page: page
                },
                timeout: 30000
            });

            // Validate response structure
            if (!response.data || !response.data.records) {
                throw new Error('Invalid response structure from Circle API: missing "records" field');
            }

            allMembers = allMembers.concat(response.data.records);

            // Check pagination using has_next_page field (more reliable than math)
            const pagination = response.data.pagination;
            hasMore = pagination && pagination.has_next_page === true;

            if (hasMore) {
                console.log(`Fetched page ${page}, continuing to next page...`);
            }

            page++;
        }

        console.log(`Fetched ${allMembers.length} total members from Circle.so`);

        // Step 2: Safety check - enforce maximum member limit
        if (allMembers.length > 1000) {
            throw new Error(
                `Safety limit exceeded: ${allMembers.length} members found, maximum is 1000. ` +
                `This likely indicates an error or unexpected community growth. ` +
                `Review community size and consider increasing limit if legitimate.`
            );
        }

        // Step 3: Warning threshold - log if approaching limit
        if (allMembers.length > 500) {
            console.warn(
                `⚠️  WARNING: Community has ${allMembers.length} members, approaching safety limit of 1000. ` +
                `Consider reviewing member detection architecture if growth continues.`
            );
        }

        // Step 4: Filter client-side for members without profile photos
        // avatar_url is null or empty string when no photo uploaded
        const membersWithoutPhotos = allMembers.filter(member => {
            return !member.avatar_url || member.avatar_url === '';
        });

        const duration = Date.now() - startTime;
        console.log(
            `Found ${membersWithoutPhotos.length} members without photos ` +
            `out of ${allMembers.length} total (${duration}ms)`
        );

        // Step 5: Return filtered members
        return membersWithoutPhotos;

    } catch (error) {
        console.error('CRITICAL ERROR: Failed to fetch members for photo detection:', error.message);

        if (error.response) {
            console.error('Circle API response status:', error.response.status);
            console.error('Circle API response data:', JSON.stringify(error.response.data));

            // Provide helpful error messages for common failures
            if (error.response.status === 401) {
                throw new Error(
                    'Circle API authentication failed. Check that CIRCLE_API_TOKEN is set correctly.'
                );
            } else if (error.response.status === 429) {
                throw new Error(
                    'Circle API rate limit exceeded. Profile photo enforcement runs weekly, ' +
                    'so this should not happen. Check for multiple simultaneous runs.'
                );
            }
        }

        throw error;
    }
};
```

**Step 2: Export New Function**
```javascript
module.exports = {
    findMemberByEmail,
    createMember,
    updateMemberCustomField,
    incrementCheckinCount,
    ensureMember,
    deactivateMember,
    getSegmentMembers,        // Keep temporarily for reference
    getMembersWithoutPhotos   // NEW
};
```

### Definition of Done

- [ ] Function implemented in `circle.js`
- [ ] Comprehensive JSDoc documentation included
- [ ] Pagination logic uses `has_next_page` field
- [ ] Safety limits enforce correctly (1000 hard, 500 warning)
- [ ] Client-side filtering by `avatar_url` field
- [ ] Error handling for auth, rate limit, network errors
- [ ] Performance metrics logged
- [ ] Function exported in `module.exports`
- [ ] Test from TASK-95 now passes

---

## TASK-97: Write Tests for Safety Limits (Red Phase)

**Type**: Test
**Estimated Time**: 30 minutes
**Status**: Ready
**Dependencies**: TASK-96 (basic implementation complete)

### Objective

Write tests for safety limits: 1000 member hard limit and 500 member warning threshold.

### Test Specifications

**Test 1: Hard Limit (>1000 members)**
```javascript
describe('Safety limits', () => {
    it('should throw error if total members exceeds 1000 (safety limit)', async () => {
        // Mock response with 1500 members across 15 pages
        const mockMembersBatch = (start, count) => Array.from({ length: count }, (_, i) => ({
            id: `member-${start + i + 1}`,
            email: `user${start + i + 1}@example.com`,
            name: `User ${start + i + 1}`,
            avatar_url: (start + i) % 2 === 0 ? null : 'https://example.com/avatar.jpg'
        }));

        // Mock 15 pages of 100 members each
        for (let page = 1; page <= 15; page++) {
            const start = (page - 1) * 100;
            const count = page < 15 ? 100 : 50;  // Last page has 50

            mockAxiosGet.mockResolvedValueOnce({
                data: {
                    records: mockMembersBatch(start, count),
                    pagination: {
                        total: 1500,
                        per_page: 100,
                        page: page,
                        has_next_page: page < 15
                    }
                }
            });
        }

        await expect(getMembersWithoutPhotos()).rejects.toThrow(
            /Safety limit exceeded: 1500 members found, maximum is 1000/
        );
    });
});
```

**Test 2: Warning Threshold (>500 members)**
```javascript
it('should log warning if total members exceeds 500 but continues processing', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    // Mock 600 members across 6 pages
    for (let page = 1; page <= 6; page++) {
        const start = (page - 1) * 100;
        const members = Array.from({ length: 100 }, (_, i) => ({
            id: `member-${start + i + 1}`,
            email: `user${start + i + 1}@example.com`,
            name: `User ${start + i + 1}`,
            avatar_url: (start + i) % 2 === 0 ? null : 'https://example.com/avatar.jpg'
        }));

        mockAxiosGet.mockResolvedValueOnce({
            data: {
                records: members,
                pagination: {
                    total: 600,
                    per_page: 100,
                    page: page,
                    has_next_page: page < 6
                }
            }
        });
    }

    const result = await getMembersWithoutPhotos();

    expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('⚠️  WARNING: Community has 600 members')
    );
    expect(result).toHaveLength(300);  // 50% of 600

    warnSpy.mockRestore();
});
```

### Expected Test Failure

Tests should initially fail if safety limits aren't implemented correctly.

### Definition of Done

- [ ] Test 1 written: Hard limit throws error at >1000 members
- [ ] Test 2 written: Warning logged at >500 members
- [ ] Mock data structure realistic (paginated responses)
- [ ] Tests verify both error message content and execution behavior
- [ ] Tests run and pass (safety limits already implemented in TASK-96)

---

## TASK-98: Write Tests for Edge Cases (Red Phase)

**Type**: Test
**Estimated Time**: 20 minutes
**Status**: Ready
**Dependencies**: TASK-96 (basic implementation complete)

### Objective

Write tests for edge cases: null avatar_url, empty string avatar_url, and performance benchmark.

### Test Specifications

**Test 1: Null avatar_url**
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

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('member-1');
    expect(result[0].avatar_url).toBeNull();
});
```

**Test 2: Empty string avatar_url**
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

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('member-1');
    expect(result[0].avatar_url).toBe('');
});
```

**Test 3: Performance benchmark**
```javascript
it('should complete in less than 2 seconds for 60 members', async () => {
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

    expect(duration).toBeLessThan(2000);
    expect(result).toHaveLength(20);  // Every 3rd member
}, 3000);  // Test timeout: 3 seconds
```

### Definition of Done

- [ ] Test for null avatar_url written and passes
- [ ] Test for empty string avatar_url written and passes
- [ ] Performance benchmark test written and passes
- [ ] All edge cases covered
- [ ] Tests validate correct filtering logic

---

## TASK-99: Add Deprecation Comment to Old Function

**Type**: Code Cleanup
**Estimated Time**: 10 minutes
**Status**: Ready
**Dependencies**: TASK-96 (new function implemented)

### Objective

Add deprecation comment to `getSegmentMembers()` explaining why it's being replaced.

### Implementation

**File**: `/Users/zack/projects/bocc-backend/netlify/functions/utils/circle.js`

**Add comment above `getSegmentMembers` function**:
```javascript
/**
 * @deprecated This function was designed to query Circle.so audience segments,
 * but Circle.so Admin API v2 does not support segment member queries.
 * Use getMembersWithoutPhotos() instead, which fetches all members and filters client-side.
 * See docs/CIRCLE_SEGMENTS_RESEARCH.md for details.
 *
 * This function will be removed in STORY-21 after all tests are updated.
 *
 * Get members in a Circle.so audience segment
 * Includes pagination support for segments with >100 members
 *
 * SAFETY: If segment doesn't exist (404), this function FAILS immediately.
 * We NEVER fall back to processing all members - that would be dangerous.
 *
 * @param {string|number} segmentId - Circle segment ID (e.g., 238273 for "No Profile Photo")
 * @returns {Promise<Array>} Array of member objects with {id, email, name, has_profile_picture, ...}
 * @throws {Error} If Circle API request fails (including 404 if segment doesn't exist)
 */
const getSegmentMembers = async (segmentId) => {
    // ... existing implementation remains unchanged
};
```

### Definition of Done

- [ ] Deprecation comment added to `getSegmentMembers()` function
- [ ] Comment references `CIRCLE_SEGMENTS_RESEARCH.md`
- [ ] Comment explains replacement function
- [ ] Comment notes removal plan (STORY-21)
- [ ] Original function documentation preserved

---

## TASK-100: Manual Testing with netlify dev

**Type**: Manual Testing
**Estimated Time**: 30 minutes
**Status**: Ready
**Dependencies**: All previous tasks complete

### Objective

Manually test the new function with `netlify dev` to verify real API integration works correctly.

### Manual Testing Procedure

**Step 1: Start Local Server**
```bash
cd /Users/zack/projects/bocc-backend
netlify dev
```

**Step 2: Create Test Endpoint (Temporary)**
Add temporary test handler to verify function:

**File**: `/Users/zack/projects/bocc-backend/netlify/functions/test-member-detection.js`
```javascript
const { getMembersWithoutPhotos } = require('./utils/circle');

exports.handler = async (event, context) => {
    try {
        console.log('Testing getMembersWithoutPhotos function...');

        const startTime = Date.now();
        const members = await getMembersWithoutPhotos();
        const duration = Date.now() - startTime;

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify({
                success: true,
                totalMembers: members.length,
                duration: `${duration}ms`,
                members: members.map(m => ({
                    id: m.id,
                    email: m.email,
                    name: m.name,
                    avatar_url: m.avatar_url
                }))
            })
        };
    } catch (error) {
        console.error('Error testing member detection:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                success: false,
                error: error.message
            })
        };
    }
};
```

**Step 3: Test Function**
```bash
curl "http://localhost:8888/.netlify/functions/test-member-detection"
```

**Step 4: Verify Results**
Expected output:
```json
{
  "success": true,
  "totalMembers": 5,
  "duration": "800ms",
  "members": [
    {
      "id": "member-id-1",
      "email": "user1@example.com",
      "name": "User One",
      "avatar_url": null
    },
    ...
  ]
}
```

**Step 5: Check Console Logs**
Verify console output shows:
- "Fetching all community members for client-side photo filtering"
- "Fetched X total members from Circle.so"
- "Found Y members without photos out of X total (Zms)"
- No errors or warnings (unless >500 members)

**Step 6: Cleanup**
Remove temporary test endpoint after verification.

### Definition of Done

- [ ] Local server starts successfully
- [ ] Temporary test endpoint created
- [ ] Function executes without errors
- [ ] Results show correct filtering
- [ ] Performance <2 seconds for current community size
- [ ] Console logs show expected messages
- [ ] No warnings or errors logged
- [ ] Temporary test endpoint removed

---

## Summary

**Total Tasks**: 6
**Critical Path**: Tasks must be completed sequentially (TDD: Red → Green → Refactor)

**Task Breakdown**:
- TASK-95: Write basic test (Red) - 30 min
- TASK-96: Implement function (Green) - 60 min
- TASK-97: Write safety limit tests (Red) - 30 min
- TASK-98: Write edge case tests (Red) - 20 min
- TASK-99: Add deprecation comment - 10 min
- TASK-100: Manual testing - 30 min

**Total Time**: ~3 hours

**Deliverables**:
- New `getMembersWithoutPhotos()` function in `circle.js`
- Comprehensive JSDoc documentation
- Safety limits enforced (1000 hard, 500 warning)
- Client-side filtering by `avatar_url`
- Pagination support with `has_next_page`
- Deprecation comment on old function
- 5 new passing tests
- Manual verification complete

**Next Story**: STORY-21 (Update Test Suite) - Rename test file, update 15 existing tests, remove old function

**Success Criteria**:
- All new tests pass
- Function works with real Circle.so API
- Performance <2 seconds for 60 members
- No linting errors
- Ready for STORY-21 test suite updates
