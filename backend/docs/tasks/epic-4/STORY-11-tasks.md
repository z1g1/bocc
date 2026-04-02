# STORY-11 Tasks: Circle.so Audience Segment API Integration

**Story**: [[STORY-11]] - Circle.so Audience Segment API Integration
**Epic**: [[EPIC-4]] - Profile Photo Enforcement System
**Total Tasks**: 6
**Estimated Time**: 8-10 hours

---

## Task Overview

Implement Circle.so audience segment querying to identify members without profile photos using the "No Profile Photo" segment (ID: 238273).

---

## TASK-61: Write Tests for getSegmentMembers Function

**Type**: Test
**Estimated Time**: 1.5 hours
**Status**: Ready
**Dependencies**: None

### Objective
Create comprehensive Jest unit tests for segment member querying functionality before implementation.

### Test File
`/Users/zack/projects/bocc-backend/tests/unit/circle-segment.test.js`

### Test Specifications

```javascript
describe('getSegmentMembers', () => {
  it('should fetch segment members successfully with valid segment ID', async () => {
    // Mock circleApi.get to return segment members
    // Verify returns array of member objects
    // Verify each member has required fields: id, email, name, has_profile_picture
  });

  it('should handle empty segment (0 members) gracefully', async () => {
    // Mock response with empty records array
    // Verify returns empty array without errors
  });

  it('should handle pagination for segments with >100 members', async () => {
    // Mock paginated responses (2 pages)
    // Verify all members from both pages accumulated
  });

  it('should fall back to all-members query if segment endpoint returns 404', async () => {
    // Mock 404 from /community_segments/{id}/members
    // Mock successful /community_members response
    // Verify fallback executed and members filtered by has_profile_picture: false
  });

  it('should propagate Circle API errors with full response context', async () => {
    // Mock 401 auth error
    // Verify error thrown
    // Verify error includes response.status and response.data
  });

  it('should timeout after 30 seconds', async () => {
    // Mock timeout error
    // Verify error thrown
  });
});
```

### Definition of Done
- [ ] Test file created with all 6 test cases
- [ ] Tests fail with "function not defined" error (Red phase)
- [ ] Mock axios properly using jest.mock()
- [ ] Test assertions are specific and descriptive
- [ ] Tests follow existing patterns from Epic 2/3

---

## TASK-62: Implement getSegmentMembers Primary Endpoint

**Type**: Implementation
**Estimated Time**: 2 hours
**Status**: Ready
**Dependencies**: TASK-61
**Sequential After**: TASK-61

### Objective
Implement the primary segment members endpoint with pagination support in `circle.js`.

### Implementation File
`/Users/zack/projects/bocc-backend/netlify/functions/utils/circle.js`

### Function Signature

```javascript
/**
 * Get members in a Circle.so audience segment
 * @param {string|number} segmentId - Circle segment ID (e.g., 238273)
 * @returns {Promise<Array>} Array of member objects {id, email, name, has_profile_picture}
 * @throws {Error} If Circle API request fails
 */
const getSegmentMembers = async (segmentId) => {
  try {
    console.log('Fetching Circle segment members:', segmentId);

    const response = await circleApi.get(`/community_segments/${segmentId}/members`, {
      params: { per_page: 100 },
      timeout: 30000
    });

    // TODO: Implement pagination if needed (next task)
    console.log(`Found ${response.data.records.length} members in segment ${segmentId}`);
    return response.data.records;
  } catch (error) {
    console.error('Error fetching segment members:', error.message);
    if (error.response) {
      console.error('Circle API response status:', error.response.status);
      console.error('Circle API response data:', JSON.stringify(error.response.data));
    }
    throw error;
  }
};
```

### Integration Points
- Reuse existing `circleApi` axios instance from `circle.js`
- Follow error logging pattern from `findMemberByEmail()`
- Export function in module.exports

### Definition of Done
- [ ] Function added to `circle.js`
- [ ] Uses existing circleApi axios instance
- [ ] Logs segment query with segmentId
- [ ] Returns array of member objects
- [ ] Comprehensive error logging with response details
- [ ] Tests from TASK-61 pass (Green phase)
- [ ] No linting errors

---

## TASK-63: Add Pagination Support for Large Segments

**Type**: Implementation
**Estimated Time**: 1.5 hours
**Status**: Ready
**Dependencies**: TASK-62
**Sequential After**: TASK-62

### Objective
Enhance `getSegmentMembers` to handle pagination when segment has >100 members.

### Implementation Details

```javascript
const getSegmentMembers = async (segmentId) => {
  try {
    console.log('Fetching Circle segment members:', segmentId);

    let allMembers = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const response = await circleApi.get(`/community_segments/${segmentId}/members`, {
        params: {
          per_page: 100,
          page: page
        },
        timeout: 30000
      });

      allMembers = allMembers.concat(response.data.records);

      // Check if more pages exist
      const pagination = response.data.pagination;
      hasMore = pagination && (page * pagination.per_page < pagination.total);
      page++;
    }

    console.log(`Found ${allMembers.length} total members in segment ${segmentId}`);
    return allMembers;
  } catch (error) {
    // ... existing error handling
  }
};
```

### Definition of Done
- [ ] Pagination loop implemented
- [ ] All members across pages accumulated
- [ ] Pagination test from TASK-61 passes
- [ ] Logs total member count after pagination
- [ ] Handles edge case: pagination.total undefined

---

## TASK-64: Implement Fallback to All-Members Query

**Type**: Implementation
**Estimated Time**: 2 hours
**Status**: Ready
**Dependencies**: TASK-63
**Sequential After**: TASK-63

### Objective
Add fallback logic to query all members and filter client-side if segment endpoint unavailable.

### Implementation Details

```javascript
const getSegmentMembers = async (segmentId) => {
  try {
    console.log('Fetching Circle segment members:', segmentId);

    // Try primary endpoint first
    try {
      // ... existing pagination logic
    } catch (primaryError) {
      // If segment endpoint not available (404), fall back
      if (primaryError.response && primaryError.response.status === 404) {
        console.log('Segment members endpoint not available, falling back to all-members query');
        return await getAllMembersWithoutPhotos();
      }
      throw primaryError; // Re-throw other errors
    }
  } catch (error) {
    // ... existing error handling
  }
};

/**
 * Fallback: Query all members and filter client-side
 * @returns {Promise<Array>} Members without profile photos
 */
const getAllMembersWithoutPhotos = async () => {
  console.log('Fetching all members and filtering for no profile photo');

  const response = await circleApi.get('/community_members', {
    params: { per_page: 100 },
    timeout: 30000
  });

  const membersWithoutPhotos = response.data.records.filter(
    m => !m.has_profile_picture || m.profile_picture === null
  );

  console.log(`Found ${membersWithoutPhotos.length} members without photos out of ${response.data.records.length} total`);
  return membersWithoutPhotos;
};
```

### Definition of Done
- [ ] Fallback function created
- [ ] 404 error triggers fallback
- [ ] Members filtered by has_profile_picture field
- [ ] Other errors (401, 500) still propagated
- [ ] Fallback test from TASK-61 passes
- [ ] Logs indicate fallback was used

---

## TASK-65: Integration Test with Production Segment

**Type**: Integration Test
**Estimated Time**: 1 hour
**Status**: Ready
**Dependencies**: TASK-64
**Sequential After**: TASK-64

### Objective
Validate segment querying works with real Circle.so API and segment ID 238273.

### Test Prerequisites
- Test Glick user profile photo removed (appears in segment)
- CIRCLE_API_TOKEN configured in environment
- Circle.so segment 238273 exists

### Test Script

Create `/Users/zack/projects/bocc-backend/tests/integration/segment-query-integration.test.js`:

```javascript
const { getSegmentMembers } = require('../../netlify/functions/utils/circle');

describe('getSegmentMembers Integration Test', () => {
  it('should query production "No Profile Photo" segment', async () => {
    const segmentId = 238273;
    const members = await getSegmentMembers(segmentId);

    // Verify response structure
    expect(Array.isArray(members)).toBe(true);

    // Verify Test Glick is in results (if photo removed)
    const testGlick = members.find(m => m.email === 'zglicka@gmail.com');
    if (testGlick) {
      expect(testGlick).toHaveProperty('id');
      expect(testGlick).toHaveProperty('name');
      expect(testGlick.has_profile_picture).toBe(false);
    }

    // Verify all members lack photos
    members.forEach(member => {
      expect(member.has_profile_picture).toBeFalsy();
    });

    console.log(`Integration test: Found ${members.length} members in segment`);
  }, 30000); // 30s timeout
});
```

### Definition of Done
- [ ] Integration test file created
- [ ] Test queries real Circle.so API
- [ ] Test passes with valid member data
- [ ] Test Glick validation (if in segment)
- [ ] All members confirmed to lack profile photos
- [ ] Test documented in test suite

---

## TASK-66: Refactor and Edge Case Handling

**Type**: Refactor
**Estimated Time**: 1 hour
**Status**: Ready
**Dependencies**: TASK-65
**Sequential After**: TASK-65

### Objective
Clean up code, add edge case handling, and ensure production readiness.

### Refactoring Checklist

1. **Input Validation**:
   ```javascript
   if (!segmentId) {
     throw new Error('segmentId is required');
   }
   ```

2. **Rate Limit Handling**:
   - Add delay between paginated requests if needed
   - Respect Circle.so 100 req/min limit

3. **Error Message Clarity**:
   - Improve error messages for debugging
   - Include segmentId in all error logs

4. **Code Comments**:
   - Add JSDoc comments
   - Document pagination logic
   - Explain fallback trigger conditions

5. **Performance Logging**:
   ```javascript
   const startTime = Date.now();
   // ... query logic
   console.log(`Segment query completed in ${Date.now() - startTime}ms`);
   ```

### Definition of Done
- [ ] Input validation added
- [ ] Code comments comprehensive
- [ ] Error messages clear and actionable
- [ ] Performance logging added
- [ ] All tests still pass
- [ ] Code review ready
- [ ] Linting passes with no warnings

---

## Summary

**Total Tasks**: 6
**Red-Green-Refactor Cycles**: 2
- Cycle 1: TASK-61 (test) → TASK-62 (impl) → TASK-66 (refactor)
- Cycle 2: Enhanced in TASK-63, TASK-64 (pagination + fallback)

**Critical Path**: TASK-61 → TASK-62 → TASK-63 → TASK-64 → TASK-65 → TASK-66

**Dependencies for Other Stories**:
- STORY-13 (Enforcement Logic) needs this completed
- STORY-17 (Scheduled Function) uses getSegmentMembers as first step

**Testing Coverage**:
- 6 unit tests (TASK-61)
- 1 integration test (TASK-65)
- Smoke test (part of STORY-18)
