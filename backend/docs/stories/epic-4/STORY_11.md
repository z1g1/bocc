# Story 11: Circle.so Audience Segment API Integration

**ID**: STORY-11
**Epic**: EPIC-4 (Profile Photo Enforcement)
**Status**: READY
**Story Points**: 3
**Complexity**: Medium
**Created**: 2026-02-05
**Dependencies**: None (foundation story)

---

## User Story

As a **developer**, I want to **query Circle.so's "No Profile Photo" audience segment via the Admin API**, so that the enforcement system can identify which members currently lack profile photos without implementing custom photo detection logic.

## Context

Circle.so maintains a built-in audience segment (ID: 238273) that automatically tracks members without profile photos. This story implements the API integration to query this segment's membership list, which serves as the foundation for the entire enforcement system. By leveraging Circle's native segmentation, we avoid the complexity of custom photo detection and ensure our enforcement stays synchronized with Circle's internal state.

## Acceptance Criteria

### Functional Requirements
- [ ] Function `getSegmentMembers(segmentId)` queries Circle.so Admin API v2 endpoint for segment members
- [ ] Endpoint used: `GET /api/admin/v2/community_segments/{segmentId}/members` (primary)
- [ ] Fallback implemented: If segment members endpoint unavailable, query all members and filter client-side by `has_profile_picture: false`
- [ ] Returns array of member objects with fields: `id`, `email`, `name`, `has_profile_picture`
- [ ] Handles pagination if segment has >100 members (use `per_page` and `page` params)
- [ ] Uses existing `circleApi` axios instance from `netlify/functions/utils/circle.js`

### Non-Functional Requirements
- [ ] Function logs segment query operation with segmentId
- [ ] Errors include full Circle API response details (status, data) for debugging
- [ ] Timeout set to 30 seconds for segment queries (large segment consideration)
- [ ] Rate limiting respected (max 100 requests per minute per Circle.so API limits)

### Testing Requirements
- [ ] Unit test: Successfully queries segment and returns member array
- [ ] Unit test: Handles empty segment (0 members) gracefully
- [ ] Unit test: Handles pagination for segments with >100 members
- [ ] Unit test: Falls back to all-members query if segment endpoint returns 404
- [ ] Unit test: Propagates Circle API errors with full response context
- [ ] Integration test: Queries production "No Profile Photo" segment (ID: 238273) with Test Glick user

## Technical Implementation Notes

### Approach

**Module**: Extend existing `netlify/functions/utils/circle.js` (reuse axios instance, consistent with Epic 2/3 patterns)

**Primary Endpoint** (preferred, needs verification):
```javascript
GET https://app.circle.so/api/admin/v2/community_segments/238273/members
Authorization: Bearer {CIRCLE_API_TOKEN}
```

**Fallback Endpoint** (if segment members endpoint not available):
```javascript
GET https://app.circle.so/api/admin/v2/community_members?per_page=100
Authorization: Bearer {CIRCLE_API_TOKEN}

// Then filter client-side:
members.filter(m => !m.has_profile_picture || m.profile_picture === null)
```

**Response Structure** (expected):
```json
{
  "records": [
    {
      "id": "a594d38f",
      "email": "zglicka@gmail.com",
      "name": "Test Glick",
      "has_profile_picture": false,
      "profile_picture": null
    }
  ],
  "pagination": {
    "page": 1,
    "per_page": 100,
    "total": 1
  }
}
```

### Function Signature

```javascript
/**
 * Get members in a Circle.so audience segment
 * @param {string|number} segmentId - Circle segment ID (e.g., 238273 for "No Profile Photo")
 * @returns {Promise<Array>} Array of member objects {id, email, name, has_profile_picture}
 * @throws {Error} If Circle API request fails
 */
const getSegmentMembers = async (segmentId) => {
    try {
        console.log('Fetching Circle segment members:', segmentId);

        // Try primary endpoint first
        try {
            const response = await circleApi.get(`/community_segments/${segmentId}/members`, {
                params: { per_page: 100 },
                timeout: 30000
            });

            console.log(`Found ${response.data.records.length} members in segment ${segmentId}`);
            return response.data.records;
        } catch (primaryError) {
            // If segment endpoint not available (404), fall back to filtering all members
            if (primaryError.response && primaryError.response.status === 404) {
                console.log('Segment members endpoint not available, falling back to all-members query');
                return await getAllMembersWithoutPhotos();
            }
            throw primaryError;
        }
    } catch (error) {
        console.error('Error fetching segment members:', error.message);
        if (error.response) {
            console.error('Circle API response status:', error.response.status);
            console.error('Circle API response data:', JSON.stringify(error.response.data));
        }
        throw error;
    }
};

/**
 * Fallback: Query all members and filter client-side for missing profile photos
 * @returns {Promise<Array>} Array of members without profile photos
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

### Integration Points

- **Existing Module**: `netlify/functions/utils/circle.js`
  - Reuses `circleApi` axios instance (already configured with baseURL and auth)
  - Follows same error handling pattern as `findMemberByEmail()`, `createMember()`

- **Environment Variables**:
  - `CIRCLE_API_TOKEN` (already exists from Epic 2)

- **Used By**:
  - STORY-17 (Scheduled enforcement function) will call this to get members needing warnings

### Technical Considerations

**Segment Endpoint Verification**:
- Circle.so Admin API v2 documentation doesn't explicitly show segment members endpoint
- Test with production segment ID 238273 during implementation
- If endpoint returns 404, fallback is seamless and transparent to calling code

**Pagination Handling**:
- If segment has >100 members, implement pagination loop
- Continue fetching pages until `pagination.page * pagination.per_page >= pagination.total`
- Accumulate all members in array before returning

**Performance**:
- Expected ~500-700ms per API call (based on Epic 2/3 experience)
- For 200 members, with pagination: 2 API calls = ~1.4 seconds (acceptable for weekly cron)

**Rate Limiting**:
- Circle.so rate limit: 100 requests/minute
- With 200 members (2 API calls for segment query), well under limit
- Enforcement function will make additional calls for DMs/deactivation, but sequential processing keeps us safe

**Error Scenarios**:
1. **Segment not found (404)**: Fall back to all-members query (handled)
2. **Auth failure (401)**: Propagate error, indicates `CIRCLE_API_TOKEN` issue
3. **Rate limit (429)**: Propagate error, indicates too many enforcement runs (should only happen once/week)
4. **Timeout**: Set 30s timeout, propagate if exceeded (indicates Circle API slowness)

### Existing Patterns to Follow

From `netlify/functions/utils/circle.js` (Epic 2):
- Use `circleApi.get()` with consistent error handling
- Log operation start with key parameters
- Log success with result count
- Log errors with full response details (`error.response.status`, `error.response.data`)
- Propagate errors to caller (non-blocking will be handled at enforcement function level)

### Security Considerations

- **API Token Security**: Uses existing `CIRCLE_API_TOKEN` (already secured in Netlify env vars)
- **Input Validation**: `segmentId` should be validated (alphanumeric, reasonable length) before API call
- **Response Sanitization**: Email addresses in response are PII - handle carefully, never log full member lists

## Dependencies

### Blocks
- **STORY-13**: Progressive warning logic depends on this to get members needing enforcement
- **STORY-17**: Scheduled function depends on this as first step in enforcement workflow

### Blocked By
- None (foundation story, uses existing Circle.so Admin API integration from Epic 2)

### Related
- **STORY-14**: Member API DM integration will use the member IDs returned by this function
- **STORY-15**: Deactivation will use member IDs from this function

## Out of Scope

- Custom photo detection logic (leverage Circle's built-in segment)
- Admin UI for segment configuration (use Circle.so's native segment builder)
- Historical tracking of segment membership changes (only current state matters)
- Caching segment results (segment can change between enforcement runs, always query fresh)

## Testing Approach

### Unit Tests (`tests/circle-segment.test.js`)

```javascript
describe('getSegmentMembers', () => {
    it('should fetch segment members successfully', async () => {
        // Mock successful segment members response
        // Verify returns array of members with expected fields
    });

    it('should handle empty segment gracefully', async () => {
        // Mock response with records: []
        // Verify returns empty array, no errors
    });

    it('should handle pagination for large segments', async () => {
        // Mock paginated response (page 1, page 2)
        // Verify all members accumulated across pages
    });

    it('should fall back to all-members query if segment endpoint 404', async () => {
        // Mock 404 from segment endpoint
        // Mock successful all-members response
        // Verify fallback executed and members filtered
    });

    it('should propagate Circle API errors', async () => {
        // Mock 401 auth error
        // Verify error thrown with response details
    });
});
```

### Integration Test

**Prerequisites**:
- Test Glick user (zglicka@gmail.com) should have profile photo **removed** before test
- Verify Test Glick appears in segment 238273 via Circle.so UI

**Test Script** (manual):
```bash
# Test segment query with real Circle.so API
curl -X POST http://localhost:8888/.netlify/functions/test-segment-query \
  -H "Content-Type: application/json" \
  -d '{"segmentId": 238273}'

# Expected response:
# {
#   "members": [
#     {
#       "id": "a594d38f",
#       "email": "zglicka@gmail.com",
#       "name": "Test Glick",
#       "has_profile_picture": false
#     }
#   ],
#   "count": 1
# }
```

**Automated Integration Test** (add to smoke tests):
- Create temporary test function that calls `getSegmentMembers(238273)`
- Verify Test Glick is in results
- Verify all members have `has_profile_picture: false`
- Clean up test function after verification

## Notes

**Circle.so Plan Requirements**:
- Audience segments available on all Circle.so plan tiers
- No additional permissions needed beyond existing Admin API access

**Segment ID Source**:
- Segment ID 238273 identified by user from Circle.so UI
- Segment filter: "Has Profile Photo: No"
- Segment is maintained automatically by Circle.so

**Why Not Custom Photo Detection**:
- Circle.so's segment logic is authoritative (they control profile photo uploads)
- Avoids complexity of parsing `profile_picture` URL field (may be null, empty string, or placeholder)
- Segment updates in real-time as members add/remove photos
- Reduces potential for false positives/negatives

**Future Enhancements**:
- If Circle.so adds webhook support for segment membership changes, could trigger enforcement immediately instead of weekly
- Could query multiple segments for different enforcement policies (e.g., "No Bio Text", "No Location")

---

**Next Steps**: Implement `getSegmentMembers()` function in `circle.js`, write unit tests, verify with production segment 238273 using Test Glick user as validation.

---

## Architectural Change Update (2026-02-06)

**Issue**: After implementation research (Epic 5), we discovered that Circle.so Admin API v2 **does not expose audience segments** for querying member lists. The `GET /api/admin/v2/community_segments/{segmentId}/members` endpoint does not exist.

**Resolution**: This story's approach was **replaced** by `getMembersWithoutPhotos()` implemented in Epic 5:
- Fetches all members via `GET /api/admin/v2/community_members` (with pagination)
- Filters client-side by `avatar_url === null || avatar_url === ""`
- Added safety limits (500 warning, 1000 hard cap) to prevent accidental mass-processing
- Performance remains acceptable: <3 seconds for expected community sizes (<1000 members)

**Function Changes**:
- ~~`getSegmentMembers(segmentId)`~~ → **Deprecated, never implemented**
- `getMembersWithoutPhotos()` → **New approach** (Epic 5)

**Documentation**:
- See `docs/CIRCLE_SEGMENTS_RESEARCH.md` for API investigation details
- See `docs/SAFETY_LIMITS_SPECIFICATION.md` for safety limit rationale
- See `netlify/functions/utils/circle.js` for implementation

**Impact on Epic 4**:
- All enforcement logic remains the same (STORY-13 through STORY-18)
- Only the member detection mechanism changed
- Integration tests validate new approach with real Circle.so API
