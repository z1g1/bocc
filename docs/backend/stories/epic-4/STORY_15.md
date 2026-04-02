# Story 15: Account Deactivation Implementation

**ID**: STORY-15
**Epic**: EPIC-4 (Profile Photo Enforcement)
**Status**: READY
**Story Points**: 2
**Complexity**: Small-Medium
**Created**: 2026-02-05
**Dependencies**: STORY-13 (enforcement logic calls deactivation)

---

## User Story

As a **developer**, I want to **deactivate Circle.so member accounts via the Admin API DELETE endpoint**, so that members who reach 5 warnings without adding a profile photo are automatically removed from the community with the option for manual re-invitation.

## Context

After a member receives 5 warnings without adding a profile photo, the enforcement system must deactivate their account. Circle.so's Admin API v2 provides a DELETE endpoint for member removal. This story implements the deactivation function and verifies whether DELETE performs a soft delete (deactivation) or hard delete (permanent removal). The behavior impacts the re-invitation workflow - soft delete allows simple re-invitation, while hard delete requires creating a new member account.

## Acceptance Criteria

### Functional Requirements
- [ ] Function `deactivateMember(memberId)` calls Circle.so Admin API v2 DELETE endpoint
- [ ] Endpoint used: `DELETE /api/admin/v2/community_members/{memberId}`
- [ ] Function logs member ID and deactivation attempt
- [ ] Function returns success indicator and any response data from Circle API
- [ ] Function integrated into existing `netlify/functions/utils/circle.js` module (reuses axios instance)
- [ ] Behavior documented: soft delete (deactivation) vs. hard delete (permanent removal)

### Non-Functional Requirements
- [ ] Timeout set to 30 seconds for deactivation operation (may be slower than typical API calls)
- [ ] Comprehensive error logging includes Circle API response status and data
- [ ] Errors propagated to caller (enforcement logic will handle non-blocking)
- [ ] Operation is idempotent (calling DELETE on already-deleted member returns 404, handled gracefully)

### Testing Requirements
- [ ] Unit test: Successfully deactivates member via DELETE endpoint
- [ ] Unit test: Handles 404 error gracefully (member already deleted)
- [ ] Unit test: Propagates other errors (401 auth, 500 server error)
- [ ] Integration test: Deactivate Test Glick user, verify behavior (soft vs. hard delete)
- [ ] Integration test: Attempt re-invitation after deactivation, document process

## Technical Implementation Notes

### Approach

**Module**: Extend existing `netlify/functions/utils/circle.js` (same module as `findMemberByEmail`, `createMember`, etc.)

**Endpoint**: `DELETE https://app.circle.so/api/admin/v2/community_members/{memberId}`

**Authentication**: Uses existing `circleApi` axios instance with `CIRCLE_API_TOKEN`

### Function Implementation

```javascript
/**
 * Deactivate/remove a community member
 * Note: Circle API DELETE behavior TBD - may be soft delete (deactivation) or hard delete
 *
 * @param {string} memberId - Circle member ID (e.g., 'a594d38f')
 * @returns {Promise<object>} Result object {success, deletedMemberId, isHardDelete}
 */
const deactivateMember = async (memberId) => {
    try {
        console.log('Deactivating Circle member:', memberId);

        const response = await circleApi.delete(`/community_members/${memberId}`, {
            timeout: 30000 // 30 second timeout (deactivation may be slower)
        });

        console.log('Successfully deactivated member:', memberId);
        console.log('DELETE response status:', response.status);
        console.log('DELETE response data:', JSON.stringify(response.data));

        // Analyze response to determine if soft or hard delete
        // Circle.so may return:
        // - 204 No Content (typical for hard delete)
        // - 200 OK with member object (may indicate soft delete with status field)
        const isHardDelete = response.status === 204 || !response.data;

        return {
            success: true,
            deletedMemberId: memberId,
            isHardDelete: isHardDelete,
            responseData: response.data || null
        };
    } catch (error) {
        // Handle 404 gracefully (member already deleted)
        if (error.response && error.response.status === 404) {
            console.log('Member already deleted or not found:', memberId);
            return {
                success: true, // Consider this success (idempotent operation)
                deletedMemberId: memberId,
                alreadyDeleted: true
            };
        }

        console.error('Error deactivating Circle member:', error.message);
        if (error.response) {
            console.error('Circle API response status:', error.response.status);
            console.error('Circle API response data:', JSON.stringify(error.response.data));
        }
        throw error;
    }
};

module.exports = {
    findMemberByEmail,
    createMember,
    updateMemberCustomField,
    incrementCheckinCount,
    ensureMember,
    deactivateMember  // Add to exports
};
```

### Integration Points

- **Existing Module**: `netlify/functions/utils/circle.js`
  - Reuses `circleApi` axios instance (already configured)
  - Follows same error handling pattern as other Circle functions

- **Environment Variables**:
  - `CIRCLE_API_TOKEN` (existing from Epic 2)

- **Used By**:
  - STORY-13 (Enforcement logic) calls `deactivateMember()` when warning count reaches 5

### Technical Considerations

**Soft Delete vs. Hard Delete**:
- **Soft Delete** (preferred):
  - Member account deactivated but data preserved
  - Can be re-invited via `POST /community_members` with same email
  - Member history (posts, comments) may remain visible or be hidden
  - Circle admin can manually restore account

- **Hard Delete** (less preferred):
  - Member account permanently removed
  - All member data deleted (posts, comments, profile)
  - Re-invitation creates new member account (loses history)
  - Cannot be undone

**Testing to Determine Behavior**:
1. Deactivate Test Glick user via DELETE endpoint
2. Check response status (204 vs. 200) and response body
3. Attempt to query member via `GET /community_members/{id}` (404 if hard delete)
4. Attempt to re-invite member via `POST /community_members` with same email
5. Check Circle.so admin UI for member status

**Expected Behavior Based on Common Patterns**:
- Most platforms: DELETE = soft delete (status change to inactive/deactivated)
- If soft delete: Re-invitation via `POST /community_members` may return existing member or fail
- If hard delete: Re-invitation via `POST /community_members` creates new member

**Re-Invitation Workflow** (to be documented after testing):
- **If Soft Delete**: Admin manually re-invites via Circle.so UI or API (may require specific endpoint)
- **If Hard Delete**: Admin uses standard member creation (new account, loses history)

**Idempotency**:
- Calling DELETE on already-deleted member returns 404
- Function treats 404 as success (operation already completed)
- Prevents error cascade if enforcement runs multiple times

**Error Scenarios**:
1. **Auth failure (401)**: Propagate error, indicates `CIRCLE_API_TOKEN` issue
2. **Member not found (404)**: Treat as success (idempotent), log "already deleted"
3. **Insufficient permissions (403)**: Propagate error, indicates API token lacks delete permission
4. **Rate limit (429)**: Propagate error, indicates too many deactivations (unlikely with weekly enforcement)
5. **Timeout**: 30s timeout, propagate if exceeded (indicates Circle API slowness)

**Performance**:
- Expected DELETE operation: ~700-1000ms (similar to other Circle API calls)
- Acceptable for weekly enforcement (even with 200 deactivations, ~200 seconds = 3.3 minutes)

**Non-Blocking Pattern**:
- STORY-13 enforcement logic calls this function
- If deactivation fails, error is logged and admin notified, but enforcement continues
- Airtable state updated regardless (status set to "Deactivated" even if API call fails, for manual admin follow-up)

### Existing Patterns to Follow

From `netlify/functions/utils/circle.js` (Epic 2):
- Use `circleApi.delete()` with consistent error handling
- Log operation start with member ID
- Log success with response details
- Log errors with full response status and data
- Propagate errors to caller (non-blocking handled upstream)

### Security Considerations

- **API Token Permissions**: `CIRCLE_API_TOKEN` must have member deletion permission (verify in Circle.so API settings)
- **Audit Trail**: Deactivation is destructive, ensure Airtable warning record preserved for audit (status="Deactivated")
- **Accidental Deactivation**: Warning progression (5 warnings over 5 weeks) provides safeguards against accidental deactivation
- **Manual Review**: Admin notification on warning 4 allows manual intervention before deactivation

## Dependencies

### Blocks
- **STORY-13**: Enforcement logic depends on this to execute deactivation action

### Blocked By
- None (uses existing Circle.so Admin API integration from Epic 2)

### Related
- **STORY-16**: Admin notifications include deactivation alerts
- **STORY-18**: Testing framework must verify deactivation and re-invitation workflow

## Out of Scope

- Manual re-invitation workflow automation (admin manually re-invites via Circle.so UI)
- Batch deactivation API (sequential deactivation is acceptable for weekly enforcement)
- Undo/restore deactivation functionality (Circle.so admin UI may provide this)
- Soft delete preference configuration (accept Circle.so's default DELETE behavior)
- Deactivation grace period (5-week warning progression is sufficient grace period)

## Testing Approach

### Unit Tests (`tests/circle-deactivation.test.js`)

```javascript
jest.mock('axios');

describe('deactivateMember', () => {
    it('should successfully deactivate member via DELETE', async () => {
        // Mock successful DELETE (204 No Content)
        // Verify returns success with isHardDelete flag
    });

    it('should handle 404 gracefully (member already deleted)', async () => {
        // Mock 404 error
        // Verify returns success with alreadyDeleted flag
    });

    it('should propagate auth errors', async () => {
        // Mock 401 error
        // Verify error thrown with response details
    });

    it('should propagate permission errors', async () => {
        // Mock 403 error
        // Verify error thrown with response details
    });

    it('should handle timeout', async () => {
        // Mock timeout error
        // Verify error thrown
    });
});
```

### Integration Test

**Prerequisites**:
- Test Glick user (zglicka@gmail.com, ID: a594d38f) exists in Circle.so
- Test Glick has warning record with count=4 (ready for deactivation test)
- Backup Test Glick's user data before test (profile info, posts)

**Test Script** (manual, destructive - use caution):
```bash
# Step 1: Deactivate Test Glick
curl -X POST http://localhost:8888/.netlify/functions/test-deactivation \
  -H "Content-Type: application/json" \
  -d '{"memberId": "a594d38f", "memberEmail": "zglicka@gmail.com"}'

# Step 2: Verify deactivation in Circle.so
# Log in to Circle.so admin UI
# Search for Test Glick user
# Check if user exists, status, profile visibility

# Step 3: Attempt to query deactivated member via API
curl -X GET https://app.circle.so/api/admin/v2/community_members/a594d38f \
  -H "Authorization: Bearer {CIRCLE_API_TOKEN}"

# Expected: 404 (hard delete) or 200 with status=inactive (soft delete)

# Step 4: Attempt re-invitation
curl -X POST https://app.circle.so/api/admin/v2/community_members \
  -H "Authorization: Bearer {CIRCLE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"email": "zglicka@gmail.com", "name": "Test Glick"}'

# Expected:
# - If soft delete: Error (member already exists) or success (restores member)
# - If hard delete: Success (creates new member)

# Step 5: Document findings
# Update this story and EPIC_4.md with DELETE behavior results
```

**Documentation Requirements**:
After integration test, update:
- EPIC_4.md: Section 5 "Account Deactivation" with confirmed behavior
- This story: "Notes" section with re-invitation workflow
- CLAUDE.md: If re-invitation process needs special steps

## Notes

**DELETE Endpoint Uncertainty**:
- Circle.so Admin API v2 documentation doesn't explicitly state DELETE behavior
- Integration test with Test Glick will confirm soft vs. hard delete
- Results will inform re-invitation workflow documentation

**Re-Invitation After Deactivation**:
- If member is re-invited, enforcement system should reset warning count to 0
- Check: Does re-invited member get new Circle ID or retain original ID?
- If new ID, need to update Airtable warning record or create new one

**Epic Acceptance Criteria**:
- Epic 4 states: "When deactivated members are manually re-invited, reset warning count to 0"
- This implies re-invitation is manual (admin-triggered, not automated)
- Enforcement system should detect re-invited members (no longer in segment) and clean up warning records

**Warning Record Cleanup**:
- After deactivation, warning record status set to "Deactivated" (kept for audit)
- If member re-invited and adds photo, next enforcement run should:
  1. Not find member in "No Profile Photo" segment
  2. Find existing warning record (status="Deactivated")
  3. Delete record or update status to "Reactivated" (TBD based on requirements)

**Future Enhancements**:
- Automated re-invitation workflow if member contacts admin with photo proof
- Bulk deactivation for multiple members (if enforcement scales beyond 1000 members)
- Deactivation appeal process (member can request extension)
- Webhook to notify external systems of deactivation

---

**Next Steps**: Implement `deactivateMember()` function in `circle.js`, write unit tests, perform integration test with Test Glick to determine DELETE behavior, document re-invitation workflow based on findings.
