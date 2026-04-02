# Story 22: Integration Testing & Documentation

**ID**: STORY-22
**Epic**: EPIC-5 (Circle.so Member Photo Detection Refactoring)
**Status**: READY
**Story Points**: 2
**Complexity**: Small
**Created**: 2026-02-06
**Dependencies**: STORY-21 (tests passing)

---

## User Story

As a **developer**, I want to **manually test the refactored member photo detection with real Circle.so API and update all documentation**, so that Epic 4 can proceed to manual testing and eventually deployment.

## Context

Unit tests validate the logic, but we need to verify the implementation works with the real Circle.so API before proceeding to Epic 4 manual testing. This story includes integration testing with Test Glick user and updating all Epic 4/5 documentation to reflect the architectural change from segments to client-side filtering.

This is the final story in Epic 5 - upon completion, Epic 4 is unblocked and ready for full manual testing.

## Acceptance Criteria

### Integration Testing Requirements
- [ ] Test Glick user profile photo removed via Circle.so UI
- [ ] Run enforcement function locally with `?dryRun=true`
- [ ] Verify Test Glick appears in members without photos list
- [ ] Verify other members with photos are NOT in list
- [ ] Verify execution completes in <2 seconds
- [ ] Verify no errors in console logs
- [ ] Verify correct count logged (total members vs filtered members)

### Documentation Updates
- [ ] Update `EPIC_4.md`: Reference new approach, link to `CIRCLE_SEGMENTS_RESEARCH.md`
- [ ] Update `STORY_11.md`: Add "Architectural Change" section explaining refactor
- [ ] Update `TESTING_GUIDE_EPIC_4.md`: Update member detection explanation
- [ ] Update `README.md`: Update architecture section if needed
- [ ] Create `CIRCLE_SEGMENTS_RESEARCH.md` (from STORY-19)

### Code Updates in Other Files
- [ ] Update `profile-photo-enforcement.js` to call `getMembersWithoutPhotos()` instead of `getSegmentMembers(238273)`
- [ ] Remove hardcoded segment ID `238273` from enforcement function
- [ ] Update function comments to reference new approach
- [ ] Verify no other code references `getSegmentMembers()`

### Verification Checklist
- [ ] All 20 unit tests passing
- [ ] Integration test with real API successful
- [ ] Epic 4 enforcement function works end-to-end
- [ ] All documentation updated and accurate
- [ ] No broken links in documentation
- [ ] Ready to proceed with Epic 4 manual testing guide

## Technical Implementation Notes

### Integration Test Script

**File**: `/Users/zack/projects/bocc-backend/tests/integration/member-photo-detection-integration.test.js`

```javascript
/**
 * Integration test for getMembersWithoutPhotos
 * Tests real Circle.so API with production data
 *
 * Prerequisites:
 * - CIRCLE_API_TOKEN set in environment
 * - Test Glick user photo removed via Circle.so UI
 *
 * Run with: npm test -- integration/member-photo-detection
 */

const { getMembersWithoutPhotos } = require('../../netlify/functions/utils/circle');

describe('getMembersWithoutPhotos Integration Test', () => {
    it('should fetch all members and filter for those without photos from real API', async () => {
        console.log('Running integration test with real Circle.so API...');

        const startTime = Date.now();
        const membersWithoutPhotos = await getMembersWithoutPhotos();
        const duration = Date.now() - startTime;

        console.log(`Integration test completed in ${duration}ms`);
        console.log(`Found ${membersWithoutPhotos.length} members without photos`);

        // Verify response structure
        expect(Array.isArray(membersWithoutPhotos)).toBe(true);
        expect(membersWithoutPhotos.length).toBeGreaterThan(0);

        // Verify each member has required fields
        membersWithoutPhotos.forEach(member => {
            expect(member).toHaveProperty('id');
            expect(member).toHaveProperty('email');
            expect(member).toHaveProperty('name');
            expect(member).toHaveProperty('avatar_url');

            // Verify avatar_url is null or empty
            expect(member.avatar_url === null || member.avatar_url === '').toBe(true);
        });

        // Check if Test Glick is in results (if photo removed)
        const testGlick = membersWithoutPhotos.find(m => m.email === 'zglicka@gmail.com');
        if (testGlick) {
            console.log('✅ Test Glick found in results (photo removed as expected)');
            expect(testGlick.id).toBe('a594d38f');
            expect(testGlick.avatar_url === null || testGlick.avatar_url === '').toBe(true);
        } else {
            console.log('ℹ️  Test Glick not in results (photo may be present)');
        }

        // Verify performance target
        expect(duration).toBeLessThan(3000);  // 3 seconds max

        console.log('✅ Integration test passed');
    }, 30000);  // 30 second timeout
});
```

### Manual Testing Procedure

**Step 1: Prepare Test Environment**
```bash
# Ensure Test Glick photo removed
# Visit: https://www.716.social/u/a594d38f (Test Glick profile)
# Click "Edit Profile" → Remove profile photo → Save

# Start local Netlify dev server
cd /Users/zack/projects/bocc-backend
netlify dev
```

**Step 2: Run Integration Test**
```bash
# In separate terminal
npm test -- integration/member-photo-detection

# Expected output:
# ✅ Integration test passed
# Found X members without photos
# Duration: <2 seconds
```

**Step 3: Test Enforcement Function End-to-End**
```bash
# Trigger enforcement function with dry-run mode
curl "http://localhost:8888/.netlify/functions/profile-photo-enforcement?dryRun=true"

# Expected output:
# {
#   "success": true,
#   "dryRun": true,
#   "summary": {
#     "totalMembers": 60,
#     "membersWithoutPhotos": X,
#     "actionsPerformed": {
#       "CREATE_WARNING": 0,
#       "INCREMENT_WARNING": 0,
#       "DEACTIVATE": 0,
#       "PHOTO_ADDED": 0,
#       "SKIP": X
#     },
#     "executionTime": "<2000ms"
#   }
# }
```

**Step 4: Verify Logs**
Check console output for:
- ✅ "Fetching all community members for client-side photo filtering"
- ✅ "Fetched 60 total members from Circle.so"
- ✅ "Found X members without photos out of 60 total (XXXms)"
- ❌ No error messages
- ❌ No warnings (unless >500 members)

### Code Updates

**File**: `/Users/zack/projects/bocc-backend/netlify/functions/profile-photo-enforcement.js`

**Before**:
```javascript
const { getSegmentMembers } = require('./utils/circle');

// ...inside handler function...

// Step 1: Fetch members without profile photos from Circle.so segment
const segmentId = 238273;  // "No Profile Photo" segment
const membersWithoutPhotos = await getSegmentMembers(segmentId);
```

**After**:
```javascript
const { getMembersWithoutPhotos } = require('./utils/circle');

// ...inside handler function...

// Step 1: Fetch members without profile photos
// Uses client-side filtering as Circle.so Admin API v2 does not support
// querying audience segments. See docs/CIRCLE_SEGMENTS_RESEARCH.md
const membersWithoutPhotos = await getMembersWithoutPhotos();
```

### Documentation Updates

**1. EPIC_4.md Updates**

Add section after "Key Technical Decisions":

```markdown
### Update: Segment API Limitation (2026-02-06)

**Issue Discovered**: Circle.so Admin API v2 does not support querying audience
segments for member lists, despite segments being visible in the Circle.so UI.

**Resolution**: Implemented client-side filtering approach via Epic 5:
- Fetch all community members via `/community_members` endpoint
- Filter client-side by `avatar_url` field (null or empty = no photo)
- Added safety limits: 1000 member hard cap, 500 member warning threshold

**See**: [[EPIC-5]] and `docs/CIRCLE_SEGMENTS_RESEARCH.md` for full details.

**Impact**: No functional change to enforcement system, only implementation approach.
```

**2. STORY_11.md Updates**

Add section at end:

```markdown
## Architectural Change: Epic 5 Refactoring

**Date**: 2026-02-06
**Issue**: Segment member query endpoint does not exist in Circle.so Admin API v2

**Original Design** (This Story):
- Query segment 238273 via `/community_segments/{id}/members`
- Assumed endpoint existed based on UI segment functionality

**Actual Implementation** (Epic 5, STORY-20):
- Fetch all members via `/community_members`
- Filter client-side by `avatar_url` field
- Function renamed: `getSegmentMembers()` → `getMembersWithoutPhotos()`

**Why Changed**:
- Extensive API research confirmed segment endpoints do not exist
- Client-side filtering is reliable and performant for current community size
- Safety limits prevent dangerous scenarios

**See**: [[EPIC-5]], [[STORY-20]], and `docs/CIRCLE_SEGMENTS_RESEARCH.md`
```

**3. TESTING_GUIDE_EPIC_4.md Updates**

Update "How It Works" section:

```markdown
### Member Detection
The system identifies members without profile photos by:
1. Fetching all community members via Circle.so Admin API v2
2. Filtering client-side for members with null or empty `avatar_url` field
3. Applying safety limits (max 1000 members, warning at 500)

**Note**: Originally designed to use Circle.so audience segments, but segments
are not accessible via API. See `docs/CIRCLE_SEGMENTS_RESEARCH.md` for details.
```

## Dependencies

### Blocks
- **Epic 4 Manual Testing**: This story unblocks full Epic 4 testing
- **Production Deployment**: Epic 4 can be deployed after this is complete

### Blocked By
- **STORY-21**: Tests must pass before integration testing

### Related
- **STORY-19**: Research documentation created in this story
- **STORY-20**: Implementation validated in this story

## Out of Scope

### Not Included
- Automated integration tests in CI/CD (manual for now)
- Performance profiling beyond execution time logging
- Testing with mock large communities (>500 members)
- Updating frontend documentation (backend-only changes)

### Future Work
- Add integration tests to CI/CD pipeline
- Create monitoring dashboard for member detection metrics
- Implement alerting if execution time exceeds thresholds

## Testing Approach

### Integration Test Validation

**Test 1: Test Glick Detection**
- Remove Test Glick photo manually
- Run enforcement function
- Verify Test Glick appears in results
- Expected: Test Glick in `membersWithoutPhotos` array

**Test 2: Members with Photos Excluded**
- Identify member with photo (e.g., admin)
- Run enforcement function
- Verify member NOT in results
- Expected: Member with photo excluded from results

**Test 3: Performance Benchmark**
- Run enforcement function
- Measure total execution time
- Verify <2 seconds for current community size
- Expected: Logs show "<2000ms"

**Test 4: Safety Limits Not Triggered**
- Current community ~60 members
- Run enforcement function
- Verify no warnings logged
- Expected: No "⚠️  WARNING" messages in console

### Documentation Review Checklist
- [ ] All Epic 5 references added to Epic 4 docs
- [ ] STORY-11 has architectural change notes
- [ ] Testing guide updated with new approach
- [ ] Research document is comprehensive
- [ ] All links are valid (no broken `[[references]]`)
- [ ] Documentation answers "why" not just "what"

## Success Criteria

**Integration Testing**:
- Test Glick correctly detected when photo removed
- Members with photos correctly excluded
- Performance <2 seconds
- No errors in console logs
- Enforcement function works end-to-end

**Documentation**:
- All Epic 4 docs reference Epic 5 changes
- Research document is clear and comprehensive
- Future developers can understand decision
- No broken links or references

**Code Quality**:
- Enforcement function updated to use new function
- No references to old `getSegmentMembers()` remain
- Code comments explain architectural decision
- All tests passing (20 unit + 1 integration)

**Epic 4 Readiness**:
- Manual testing guide can be executed
- Test tokens ready to use
- No blockers remaining
- Deployment path is clear

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Real API response differs from mocks | High | Compare integration test results with unit test mocks, update if needed |
| Test Glick detection fails | Medium | Verify photo actually removed, check avatar_url field in response |
| Performance slower than expected | Low | Log execution time, optimize if >2 seconds |
| Documentation incomplete | Medium | Use review checklist, verify with user before closing story |

## Notes

### Why Manual Testing Is Critical
- Unit tests mock API responses - could miss real API quirks
- Integration test validates actual Circle.so behavior
- Manual verification ensures end-to-end flow works
- Catches issues before Epic 4 manual testing guide execution

### Documentation Philosophy
This project values comprehensive documentation:
- Explains WHY decisions were made, not just WHAT was done
- Provides context for future developers
- Prevents repeating failed approaches
- Demonstrates problem-solving process

### Epic 5 Completion Criteria
This story marks Epic 5 completion:
- All 4 stories complete (STORY-19, 20, 21, 22)
- Documentation updated and accurate
- Integration tests passing
- Epic 4 unblocked and ready for testing

---

**Next Steps**: Execute integration tests, update documentation, verify Epic 4 can proceed to manual testing guide.

**Time Estimate**: 1-2 hours (integration testing + documentation updates)

**Final Deliverable**: Epic 5 complete, Epic 4 ready for Test Glick manual testing.
