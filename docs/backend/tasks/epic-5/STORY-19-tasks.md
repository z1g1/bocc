# STORY-19 Tasks: Research Documentation & Safety Analysis

**Story**: [[STORY-19]] - Research Documentation & Safety Analysis
**Epic**: [[EPIC-5]] - Circle.so Member Photo Detection Refactoring
**Total Tasks**: 4
**Estimated Time**: 1-2 hours

---

## Task Overview

Document API research findings and define safety requirements for the client-side filtering approach that replaces segment-based member detection.

---

## TASK-91: Create CIRCLE_SEGMENTS_RESEARCH.md Documentation

**Type**: Documentation
**Estimated Time**: 45 minutes
**Status**: Ready
**Dependencies**: None

### Objective
Create comprehensive documentation explaining why Circle.so audience segments cannot be queried via API and the alternative approach chosen.

### Documentation File
`/Users/zack/projects/bocc-backend/docs/CIRCLE_SEGMENTS_RESEARCH.md`

### Content Sections

1. **Executive Summary**
   - Circle.so segments are UI-only (not API-accessible)
   - Admin API v2 has no segment member query endpoints
   - Client-side filtering is the correct approach

2. **API Endpoints Tested**
   - Primary: `GET /api/admin/v2/community_segments/238273/members` → 404 Not Found
   - Segment details: `GET /api/admin/v2/community_segments/238273` → Limited metadata only
   - Fallback: `GET /api/admin/v2/community_members` → Works, returns all members

3. **Why Segments Are UI-Only**
   - Explain Circle.so architecture (UI filtering vs API capabilities)
   - Segments designed for Circle.so dashboard use, not programmatic access
   - No public API documentation for segment member queries

4. **Alternative Approaches Considered**
   - Option 1: Segment-based (ideal but impossible) → Rejected: endpoint doesn't exist
   - Option 2: Member API workaround (complex) → Rejected: N API calls, auth complexity
   - Option 3: Client-side filtering (chosen) → Selected: simple, reliable, performant

5. **Implementation Decision**
   - Fetch all members via `/community_members`
   - Filter client-side by `avatar_url` field (null or empty = no photo)
   - Add safety limits to prevent runaway processing

6. **Future Considerations**
   - If Circle.so adds segment endpoints: migrate back to segment-based
   - Keep safety limits regardless of approach
   - Update documentation if API capabilities change

7. **References**
   - Circle.so Admin API v2 Documentation links
   - API research dates: 2026-02-05 to 2026-02-06
   - Community plan tier and capabilities

### Definition of Done
- [ ] Documentation file created in `/docs/`
- [ ] All 7 sections completed with specific details
- [ ] API endpoints documented with results
- [ ] Rationale for decision is clear
- [ ] Future developers can understand why this approach was chosen
- [ ] Links and references are accurate

---

## TASK-92: Define Safety Limits and Rationale

**Type**: Requirements Definition
**Estimated Time**: 20 minutes
**Status**: Ready
**Dependencies**: None

### Objective
Document safety requirements with clear rationale based on community size projections.

### Safety Limits to Define

#### Hard Limit: 1000 Members
**Action**: Throw error, stop processing
**Rationale**:
- Current community size: 60 members
- Expected 1-year growth: 200-500 members
- Hard limit is 16x current size, 2x expected max
- Prevents accidental mass-processing if API returns unexpected data
- Unlikely to reach legitimately (would require 10+ years of growth at current rate)

**Error Message**:
```
Safety limit exceeded: {count} members found, maximum is 1000.
This likely indicates an error or unexpected community growth.
Review community size and consider increasing limit if legitimate.
```

#### Warning Threshold: 500 Members
**Action**: Log warning, continue processing
**Rationale**:
- 8x current size, 1x expected maximum growth
- Gives admin advance notice of approaching limit
- Processing continues (not blocking)
- Time to review architecture before hitting hard limit

**Warning Message**:
```
⚠️  WARNING: Community has {count} members, approaching safety limit of 1000.
Consider reviewing member detection architecture if growth continues.
```

### Performance Targets

| Community Size | Expected Time | Status |
|----------------|---------------|--------|
| 60 members (current) | <1 second | Normal operation |
| 500 members (warning) | <2 seconds | Approaching limit, still acceptable |
| 1000 members (limit) | <10 seconds | Maximum acceptable, stop here |

### Documentation Updates
Add safety limits table to `CIRCLE_SEGMENTS_RESEARCH.md`:

```markdown
## Safety Architecture

### Limits and Thresholds

| Threshold | Action | Rationale |
|-----------|--------|-----------|
| 0-500 members | Normal operation | Current and near-term expected size |
| 501-1000 members | Log warning, continue | Approaching limit, admin notification |
| 1000+ members | Throw error, stop | Likely error condition, prevent mass processing |

### Community Growth Projection

| Metric | Value | Date |
|--------|-------|------|
| Current members | 60 | 2026-02-06 |
| Expected 1-year | 200-500 | 2027-02-06 (est) |
| Warning threshold | 500 | 8x current |
| Hard limit | 1000 | 16x current |
```

### Definition of Done
- [ ] Hard limit defined: 1000 members
- [ ] Warning threshold defined: 500 members
- [ ] Rationale documented for each limit
- [ ] Error and warning messages drafted
- [ ] Performance targets established
- [ ] Documentation includes safety architecture table

---

## TASK-93: Define Test Scenarios for New Tests

**Type**: Test Planning
**Estimated Time**: 30 minutes
**Status**: Ready
**Dependencies**: TASK-92 (safety limits must be defined)

### Objective
Define 5 new test scenarios for safety limits and edge cases that will be implemented in STORY-21.

### New Test Scenarios

#### Test 1: Safety Limit Enforcement (>1000 members)
**Scenario**: Mock response with 1500 members
**Expected**: Error thrown with message "Safety limit exceeded: 1500 members found"
**Validation**:
- Error includes member count
- Error includes guidance for resolution
- Error stops execution (doesn't continue processing)
- Pagination fetches all pages before checking limit

**Mock Data**:
```javascript
// Mock 15 pages of 100 members each (1500 total)
// Mock paginated responses with has_next_page: true for pages 1-14
// Mock has_next_page: false for page 15
// Verify error thrown after fetching all 1500
```

#### Test 2: Warning Threshold (>500 members)
**Scenario**: Mock response with 600 members
**Expected**: Warning logged, execution continues
**Validation**:
- console.warn called with warning message
- Warning includes member count (600)
- Execution completes (not blocked)
- Correct filtered results returned

**Mock Data**:
```javascript
// Mock 6 pages of 100 members each (600 total)
// 50% with photos, 50% without photos
// Verify warning logged but function returns 300 members
```

#### Test 3: Null avatar_url Filtering
**Scenario**: Members with null avatar_url
**Expected**: Correctly identified as having no photo
**Validation**:
- Member with `avatar_url: null` included in results
- Member with `avatar_url: "https://..."` excluded from results
- Filtering logic correct

**Mock Data**:
```javascript
// Member 1: avatar_url: null (included)
// Member 2: avatar_url: "https://example.com/avatar.jpg" (excluded)
// Expected result: 1 member
```

#### Test 4: Empty String avatar_url Filtering
**Scenario**: Members with empty string avatar_url
**Expected**: Correctly identified as having no photo
**Validation**:
- Member with `avatar_url: ""` included in results
- Member with `avatar_url: "https://..."` excluded from results
- Handles both null and empty string

**Mock Data**:
```javascript
// Member 1: avatar_url: "" (included)
// Member 2: avatar_url: "https://example.com/avatar.jpg" (excluded)
// Expected result: 1 member
```

#### Test 5: Performance Benchmark (<2 seconds)
**Scenario**: Mock 60 members (current community size)
**Expected**: Completes in <2 seconds
**Validation**:
- Execution time measured
- Time <2000ms
- Correct filtering (every 3rd member has no photo)
- Returns expected count

**Mock Data**:
```javascript
// Mock 60 members (single page)
// Pattern: i % 3 === 0 → no photo (null avatar_url)
// Expected: 20 members without photos
// Duration: <2000ms
```

### Test Coverage Matrix

| Test | Category | Mock Pages | Mock Members | Expected Result |
|------|----------|------------|--------------|-----------------|
| 1 | Safety limit | 15 | 1500 | Error thrown |
| 2 | Warning | 6 | 600 | Warning logged, 300 returned |
| 3 | Null filtering | 1 | 2 | 1 member returned |
| 4 | Empty filtering | 1 | 2 | 1 member returned |
| 5 | Performance | 1 | 60 | <2s, 20 returned |

### Definition of Done
- [ ] 5 test scenarios fully defined
- [ ] Mock data structure specified
- [ ] Expected results documented
- [ ] Validation criteria clear
- [ ] Test coverage matrix created
- [ ] Ready for implementation in STORY-21

---

## TASK-94: Document Code Comment Strategy

**Type**: Documentation Strategy
**Estimated Time**: 15 minutes
**Status**: Ready
**Dependencies**: TASK-91, TASK-92

### Objective
Define strategy for code comments explaining client-side filtering approach and referencing research documentation.

### Function-Level Documentation Template

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
const getMembersWithoutPhotos = async () => { ... };
```

### Inline Comment Strategy

**Step 1: Member Fetching**
```javascript
// Step 1: Fetch all members with pagination
// Circle.so Admin API v2 does not support querying segments, so we fetch
// all members and filter client-side. See CIRCLE_SEGMENTS_RESEARCH.md.
let allMembers = [];
```

**Step 2: Safety Checks**
```javascript
// Step 2: Safety check - enforce maximum member limit
// Prevents accidental mass-processing if API returns unexpected data
// or community grows beyond architectural assumptions
if (allMembers.length > 1000) {
    throw new Error(...);
}
```

**Step 3: Warning Threshold**
```javascript
// Step 3: Warning threshold - log if approaching limit
// Gives admin advance notice to review architecture before hitting hard limit
if (allMembers.length > 500) {
    console.warn(...);
}
```

**Step 4: Client-Side Filtering**
```javascript
// Step 4: Filter client-side for members without profile photos
// avatar_url is null or empty string when no photo uploaded
// This is the most reliable field for photo detection in Admin API v2
const membersWithoutPhotos = allMembers.filter(member => {
    return !member.avatar_url || member.avatar_url === '';
});
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
const getSegmentMembers = async (segmentId) => { ... };
```

### Comment Principles
1. **Explain WHY, not WHAT**: Code shows what, comments explain why this approach
2. **Reference documentation**: Link to `CIRCLE_SEGMENTS_RESEARCH.md` for full context
3. **Performance context**: Mention current community size and expectations
4. **Safety rationale**: Explain why limits exist and what they prevent
5. **Future guidance**: Help future developers understand when to revisit approach

### Definition of Done
- [ ] Function-level JSDoc template defined
- [ ] Inline comment strategy for each step
- [ ] Deprecation comment drafted
- [ ] Comment principles documented
- [ ] References to research doc included
- [ ] Ready for implementation in STORY-20

---

## Summary

**Total Tasks**: 4
**Critical Path**: All tasks can be done in parallel (no dependencies between them)

**Task Breakdown**:
- TASK-91: Research documentation (45 min)
- TASK-92: Safety limits definition (20 min)
- TASK-93: Test scenarios (30 min)
- TASK-94: Code comment strategy (15 min)

**Deliverables**:
- `CIRCLE_SEGMENTS_RESEARCH.md` documentation file
- Safety limits table and rationale
- 5 test scenarios fully defined
- Code comment templates and strategy

**Dependencies for Other Stories**:
- STORY-20 (Implementation) needs TASK-92, TASK-94
- STORY-21 (Tests) needs TASK-93

**Success Criteria**:
- Documentation is comprehensive and clear
- Safety limits have documented rationale
- Test scenarios are implementable
- Code comment strategy is consistent
- Future developers can understand decisions
