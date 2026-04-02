# Story 19: Research Documentation & Safety Analysis

**ID**: STORY-19
**Epic**: EPIC-5 (Circle.so Member Photo Detection Refactoring)
**Status**: READY
**Story Points**: 2
**Complexity**: Small
**Created**: 2026-02-06
**Dependencies**: None (foundation story)

---

## User Story

As a **developer**, I want to **document why Circle.so segments cannot be queried via API and define safety requirements for client-side filtering**, so that future developers understand the architectural decision and current developers implement the solution correctly.

## Context

During Epic 4 implementation, we discovered that Circle.so's Admin API v2 does not support querying segment members, despite segments being visible and functional in the Circle.so UI. The original implementation assumed a `/community_segments/{id}/members` endpoint existed based on reasonable assumptions from the UI, but extensive API research confirmed this endpoint does not exist.

This story captures that research, documents the findings, and establishes safety requirements for the client-side filtering approach that must replace the segment-based approach.

## Acceptance Criteria

### Documentation Requirements
- [ ] Create `/Users/zack/projects/bocc-backend/docs/CIRCLE_SEGMENTS_RESEARCH.md`
- [ ] Document API endpoints tested and their results
- [ ] Explain why segments are UI-only (not API-accessible)
- [ ] Include Circle.so API version information (Admin API v2)
- [ ] Add timestamps and sources for research findings
- [ ] Document alternative approaches considered

### Safety Requirements Definition
- [ ] Define maximum member limit: 1000 members (hard limit)
- [ ] Define warning threshold: 500 members (log warning, continue)
- [ ] Document rationale for each limit based on community size projections
- [ ] Specify error messages for limit violations
- [ ] Define metrics to log: total members, filtered members, execution time

### Code Comments Strategy
- [ ] Define template for function-level documentation
- [ ] Specify inline comments explaining client-side filtering rationale
- [ ] Document why `avatar_url` field is used instead of `has_profile_picture`
- [ ] Create TODO comments for future Circle.so API enhancements

### Testing Strategy Documentation
- [ ] List all 15 existing tests that need updates
- [ ] Define 5 new test scenarios for safety limits
- [ ] Document integration test requirements
- [ ] Specify performance benchmarks (<2 seconds for 60 members)

## Technical Implementation Notes

### Research Documentation Structure

**File**: `/Users/zack/projects/bocc-backend/docs/CIRCLE_SEGMENTS_RESEARCH.md`

**Sections**:
1. **Executive Summary**: Why segments don't work via API
2. **API Endpoints Tested**: List of endpoints attempted
3. **Circle.so API Structure**: Admin API v2 vs Member API capabilities
4. **Segment Functionality**: UI-only filtering explanation
5. **Alternative Approaches**: Client-side filtering chosen approach
6. **Future Considerations**: If Circle.so adds segment support
7. **References**: Links to Circle.so documentation

**Content Template**:
```markdown
# Circle.so Audience Segments API Research

**Date**: 2026-02-06
**Researcher**: Zack Glick + Claude Code
**Circle.so Plan**: [Plan tier]
**API Version**: Admin API v2

## Executive Summary

Circle.so audience segments (e.g., "No Profile Photo" segment ID 238273) are
UI-only filtering tools and are NOT accessible via the Admin API v2. Despite
segments appearing in the Circle.so dashboard with visible member counts,
there is no API endpoint to query segment membership.

## API Endpoints Tested

### 1. Segment Members Endpoint (Primary - Failed)
**URL**: `GET /api/admin/v2/community_segments/238273/members`
**Result**: 404 Not Found
**Date Tested**: 2026-02-05
**Conclusion**: Endpoint does not exist

### 2. Segment Details Endpoint (Secondary - Limited)
**URL**: `GET /api/admin/v2/community_segments/238273`
**Result**: [Document actual result if tested]
**Conclusion**: May return segment metadata, but not member list

### 3. All Members Endpoint (Fallback - Works)
**URL**: `GET /api/admin/v2/community_members`
**Result**: 200 OK, returns all members
**Conclusion**: Client-side filtering required

## Why Segments Are UI-Only

[Explain Circle.so architecture, UI vs API capabilities]

## Alternative Approaches Considered

### Option 1: Segment-Based (Ideal but Not Possible)
- Query segment endpoint for members
- ❌ **Rejected**: Endpoint doesn't exist

### Option 2: Member API Workaround
- Authenticate as each member, query their segment membership
- ❌ **Rejected**: Requires N API calls, complex auth

### Option 3: Client-Side Filtering (Chosen)
- Fetch all members via `/community_members`
- Filter by `avatar_url` field presence
- ✅ **Selected**: Simple, reliable, performant at current scale

## Future Considerations

If Circle.so adds segment member query support in future API versions:
1. Check for endpoint: `GET /api/admin/v2/community_segments/{id}/members`
2. If available, migrate back to segment-based approach
3. Keep safety limits - still valuable
4. Update this documentation with findings

## References

- Circle.so Admin API v2 Documentation: [URL]
- Community Segments Feature: [Circle.so help article]
- API Research Date: 2026-02-05 to 2026-02-06
```

### Safety Limits Rationale Table

| Metric | Value | Rationale |
|--------|-------|-----------|
| **Current Members** | 60 | Starting point |
| **Expected Growth (1 year)** | 200-500 | Realistic projection for 716.social |
| **Warning Threshold** | 500 | 8x current, 1x expected max growth |
| **Hard Limit** | 1000 | 16x current, 2x expected max growth |
| **Performance Target** | <2 seconds | Acceptable for weekly cron job |

### Test Coverage Matrix

| Test Category | Existing Tests | New Tests | Total |
|---------------|----------------|-----------|-------|
| Success Cases | 2 | 0 | 2 |
| Pagination | 2 | 0 | 2 |
| Error Handling | 6 | 0 | 6 |
| Input Validation | 5 | 0 | 5 |
| Safety Limits | 0 | 3 | 3 |
| Performance | 0 | 1 | 1 |
| Edge Cases | 0 | 1 | 1 |
| **Total** | **15** | **5** | **20** |

**New Tests Needed**:
1. Safety: Throw error if total members > 1000
2. Safety: Log warning if total members > 500
3. Safety: Handle members with null `avatar_url`
4. Performance: Complete in <2 seconds for 60 members
5. Edge case: Empty `avatar_url` string vs null

## Dependencies

### Blocks
- **STORY-20**: Implementation depends on safety requirements defined here
- **STORY-21**: Tests depend on test scenarios defined here

### Blocked By
- None (foundation story, can start immediately)

### Related
- **STORY-11**: Original segment implementation (will reference this research)
- **Epic 4 Documentation**: Will link to research findings

## Out of Scope

- Contacting Circle.so support (user already researched API)
- Testing Member API approaches (too complex for current needs)
- Implementing caching mechanisms (defer to future if needed)
- Creating admin dashboard for metrics (not required for MVP)

## Testing Approach

### Documentation Review Checklist
- [ ] Research findings are clear and factual
- [ ] Safety limits have documented rationale
- [ ] Future developers can understand decision
- [ ] References are accurate and accessible
- [ ] Examples are concrete and specific

### Validation Steps
1. Review research doc with user (ensure accurate)
2. Verify safety limits align with business projections
3. Confirm test scenarios cover all edge cases
4. Check that documentation answers "why" not just "how"

## Notes

### Documentation Philosophy
This project values thorough documentation (see CLAUDE.md). The research
document serves multiple purposes:
1. Explains architectural decision to future developers
2. Prevents repeating failed approaches
3. Provides context if Circle.so API changes
4. Demonstrates due diligence in problem-solving

### Why Written First
- Clarifies requirements before implementation
- Ensures all stakeholders understand the "why"
- Creates reference material for code review
- Prevents scope creep during implementation

### Success Criteria
Good documentation for this story should enable someone unfamiliar with the
project to:
1. Understand why segments don't work
2. Implement the solution correctly
3. Make informed decisions about future enhancements
4. Troubleshoot issues independently

---

**Next Steps**: Write research documentation, then proceed to STORY-20 implementation.

**Time Estimate**: 1-2 hours (mostly writing, minimal coding)
