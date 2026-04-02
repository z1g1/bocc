# Story 20: Refactor Function Implementation

**ID**: STORY-20
**Epic**: EPIC-5 (Circle.so Member Photo Detection Refactoring)
**Status**: READY
**Story Points**: 5
**Complexity**: Medium
**Created**: 2026-02-06
**Dependencies**: STORY-19 (research documentation)

---

## User Story

As a **developer**, I want to **refactor `getSegmentMembers()` into `getMembersWithoutPhotos()` with client-side filtering and safety limits**, so that the profile photo enforcement system can detect members without photos reliably and safely.

## Context

The current `getSegmentMembers(segmentId)` function was designed to query Circle.so audience segments, but research confirmed that segments are not accessible via API. This story implements the replacement function that fetches all community members and filters them client-side based on the `avatar_url` field, with safety limits to prevent accidental mass-processing.

This is a critical path story - Epic 4 cannot be tested or deployed until this is complete.

## Acceptance Criteria

### Functional Requirements
- [ ] Create new function `getMembersWithoutPhotos()` in `circle.js`
- [ ] Function takes no parameters (fetches all members, no segment ID needed)
- [ ] Fetches all community members via `GET /api/admin/v2/community_members`
- [ ] Implements pagination to handle >100 members (use `has_next_page` field)
- [ ] Filters members client-side: `!member.avatar_url || member.avatar_url === ''`
- [ ] Returns array with structure: `[{id, email, name, avatar_url}]`

### Safety Requirements
- [ ] **Hard limit**: Throw error if total members > 1000
- [ ] **Warning threshold**: Log warning if total members > 500 (but continue)
- [ ] Error message for limit violation must be clear and actionable
- [ ] Safety check happens BEFORE filtering (check total fetched, not filtered)

### Performance Requirements
- [ ] Complete in <2 seconds for current community size (~60 members)
- [ ] Complete in <10 seconds for safety limit (1000 members)
- [ ] Log execution metrics: total members, filtered count, duration

### Code Quality Requirements
- [ ] Comprehensive JSDoc comments explaining approach
- [ ] Inline comments explaining client-side filtering rationale
- [ ] Reference `CIRCLE_SEGMENTS_RESEARCH.md` in function documentation
- [ ] Error messages are descriptive and include context
- [ ] Follows existing code patterns from `findMemberByEmail()`, `ensureMember()`

### Deprecation Requirements
- [ ] Add deprecation comment to `getSegmentMembers()` function
- [ ] Keep `getSegmentMembers()` temporarily for reference (will be removed in STORY-21)
- [ ] Export new `getMembersWithoutPhotos()` in `module.exports`

## Technical Implementation Notes

### New Function Signature

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

### Deprecation Comment for Old Function

```javascript
/**
 * @deprecated This function was designed to query Circle.so audience segments,
 * but Circle.so Admin API v2 does not support segment member queries.
 * Use getMembersWithoutPhotos() instead, which fetches all members and filters client-side.
 * See docs/CIRCLE_SEGMENTS_RESEARCH.md for details.
 *
 * This function will be removed in STORY-21 after all tests are updated.
 */
const getSegmentMembers = async (segmentId) => {
    // ... existing implementation (kept temporarily for reference)
};
```

### Module Exports Update

```javascript
module.exports = {
    findMemberByEmail,
    createMember,
    updateMemberCustomField,
    incrementCheckinCount,
    ensureMember,
    deactivateMember,
    getSegmentMembers,        // Deprecated, keep for now
    getMembersWithoutPhotos   // New function
};
```

### Implementation Checklist

**Step 1: Function Structure** (30 min)
- [ ] Add new function to `circle.js`
- [ ] Add comprehensive JSDoc documentation
- [ ] Add performance timing (start/end)

**Step 2: Member Fetching** (45 min)
- [ ] Implement GET /community_members request
- [ ] Add pagination loop using `has_next_page`
- [ ] Validate response structure
- [ ] Handle pagination edge cases

**Step 3: Safety Limits** (30 min)
- [ ] Add check for >1000 members (throw error)
- [ ] Add warning log for >500 members
- [ ] Test error messages for clarity

**Step 4: Client-Side Filtering** (30 min)
- [ ] Filter by `avatar_url` presence
- [ ] Handle null vs empty string
- [ ] Log filtered count

**Step 5: Error Handling** (45 min)
- [ ] Comprehensive try/catch
- [ ] Specific error messages for 401, 429
- [ ] Network error handling
- [ ] Response structure validation

**Step 6: Deprecation** (15 min)
- [ ] Add deprecation comment to old function
- [ ] Update module exports
- [ ] Add reference to research doc

## Integration Points

### Existing Code Reuse
- **circleApi axios instance**: Already configured with baseURL and auth
- **Error handling pattern**: Follow `findMemberByEmail()` pattern
- **Logging pattern**: Follow existing console.log conventions

### Calling Code (Will Update in STORY-21)
- `netlify/functions/profile-photo-enforcement.js` - Main enforcement orchestrator
- Currently calls `getSegmentMembers(238273)` with hardcoded segment ID
- Will change to `getMembersWithoutPhotos()` with no parameters

### Environment Variables
- Uses existing `CIRCLE_API_TOKEN` (no new env vars needed)

## Dependencies

### Blocks
- **STORY-21**: Test updates depend on this implementation
- **Epic 4 Manual Testing**: Cannot test until this is complete

### Blocked By
- **STORY-19**: Safety requirements must be defined first

### Related
- **STORY-22**: Documentation updates will reference this implementation

## Out of Scope

### Not Included
- Caching mechanism (community too small, always fetch fresh)
- Configurable safety limits via env vars (hardcode for now)
- Retry logic for transient failures (weekly cron, manual retry acceptable)
- Performance optimization beyond pagination (not needed for current scale)

### Future Enhancements
- If community grows >1000: Implement caching or incremental updates
- If Circle.so adds segment support: Migrate back to segment-based approach
- Configurable limits: `MAX_MEMBERS_LIMIT` and `WARNING_THRESHOLD` env vars

## Testing Approach

### Manual Testing During Development

**Test 1: Normal Operation (60 members)**
```bash
# Run enforcement function locally with dry-run mode
netlify dev

# In another terminal:
curl "http://localhost:8888/.netlify/functions/profile-photo-enforcement?dryRun=true"

# Expected output:
# - Fetched 60 total members
# - Found X members without photos
# - Execution time <1 second
# - No warnings logged
```

**Test 2: Warning Threshold (Mock 600 members)**
```javascript
// Temporarily modify function to mock 600 members response
// Verify warning logged but execution continues
```

**Test 3: Safety Limit (Mock 1500 members)**
```javascript
// Temporarily modify function to mock 1500 members response
// Verify error thrown with helpful message
```

### Unit Tests (Updated in STORY-21)
- All 15 existing tests will be updated to use new function
- 5 new tests will be added for safety limits
- Tests will mock Circle API responses

## Performance Benchmarks

### Expected Performance
| Community Size | API Calls | Estimated Time | Status |
|----------------|-----------|----------------|--------|
| 60 members | 1 page | <1 second | Current |
| 100 members | 1 page | <1 second | OK |
| 500 members | 5 pages | <2 seconds | OK (warning logged) |
| 1000 members | 10 pages | <10 seconds | Limit (error thrown) |

### Performance Monitoring
- Log execution time on every run
- Alert if execution time >5 seconds (indicates growth)
- Monthly review of performance trends

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Pagination logic error | High | Comprehensive tests, use reliable `has_next_page` field |
| Safety limit too low | Low | 1000 is 16x current size, can adjust if needed |
| `avatar_url` field changes | Medium | Validate response structure, fail fast if malformed |
| Performance degradation | Low | Monitor execution time, optimize if exceeds 5 seconds |

## Success Criteria

**Technical**:
- Function fetches all members correctly
- Pagination handles multiple pages
- Safety limits enforce correctly
- Client-side filtering accurate
- Performance <2 seconds for 60 members

**Quality**:
- Code is readable and well-documented
- Error messages are clear and actionable
- Follows existing code patterns
- No linting errors or warnings

**Integration**:
- Can be called from enforcement function
- Returns same structure as old function
- Doesn't break existing tests (tests updated in STORY-21)

---

**Next Steps**: Implement function, test manually with `netlify dev`, then proceed to STORY-21 for test updates.

**Time Estimate**: 3-4 hours (implementation + manual testing)
