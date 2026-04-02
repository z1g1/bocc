# STORY-15 Tasks: Account Deactivation Implementation

**Story**: [[STORY-15]] - Account Deactivation Implementation
**Epic**: [[EPIC-4]] - Profile Photo Enforcement System
**Total Tasks**: 4
**Estimated Time**: 6-7 hours

---

## TASK-89: Write Tests for Member Deactivation

**Type**: Test | **Estimated Time**: 1 hour | **Status**: Ready

### Test File
`/Users/zack/projects/bocc-backend/tests/unit/circle-deactivation.test.js`

### Test Specifications
```javascript
describe('deactivateMember', () => {
  it('should successfully deactivate member via DELETE endpoint');
  it('should handle 404 gracefully (member already deleted) - idempotent');
  it('should propagate auth errors (401) with response details');
  it('should propagate permission errors (403)');
  it('should handle timeout after 30 seconds');
  it('should return success indicator and metadata');
});
```

**DoD**: 6 tests written, DELETE endpoint mocked

---

## TASK-90: Implement deactivateMember Function

**Type**: Implementation | **Estimated Time**: 1.5 hours | **Status**: Ready
**Dependencies**: TASK-89 | **Sequential After**: TASK-89

### Implementation File
`/Users/zack/projects/bocc-backend/netlify/functions/utils/circle.js` (extend existing)

### Function
```javascript
const deactivateMember = async (memberId) => {
  try {
    console.log('Deactivating Circle member:', memberId);

    const response = await circleApi.delete(`/community_members/${memberId}`, {
      timeout: 30000
    });

    console.log('DELETE response status:', response.status);
    const isHardDelete = response.status === 204 || !response.data;

    return {
      success: true,
      deletedMemberId: memberId,
      isHardDelete: isHardDelete,
      responseData: response.data || null
    };
  } catch (error) {
    // Handle 404 gracefully (idempotent)
    if (error.response && error.response.status === 404) {
      console.log('Member already deleted or not found:', memberId);
      return {
        success: true,
        deletedMemberId: memberId,
        alreadyDeleted: true
      };
    }
    // Propagate other errors
    throw error;
  }
};
```

**DoD**: Tests pass (Green phase), 404 handled idempotently, comprehensive logging

---

## TASK-91: Integration Test - Verify DELETE Behavior (Soft vs Hard Delete)

**Type**: Integration Test | **Estimated Time**: 2 hours | **Status**: Ready
**Dependencies**: TASK-90 | **Sequential After**: TASK-90

### Test Prerequisites
- Test Glick user available for destructive testing
- Backup Test Glick data before test
- CIRCLE_API_TOKEN with delete permissions

### Test Script (Manual + Automated)

**Manual Steps**:
1. Deactivate Test Glick via API
2. Check Circle.so admin UI: User status?
3. Attempt GET /community_members/{id}
4. Document findings: soft delete or hard delete?

**Automated Test**:
```javascript
describe('Member Deactivation Integration', () => {
  it('should deactivate Test Glick and determine delete behavior', async () => {
    const result = await deactivateMember('a594d38f');
    expect(result.success).toBe(true);

    // Try to query deactivated member
    try {
      const member = await findMemberByEmail('zglicka@gmail.com');
      if (member) {
        console.log('Soft delete detected: Member still queryable');
      } else {
        console.log('Hard delete detected: Member not found');
      }
    } catch (error) {
      console.log('Hard delete detected: 404 error');
    }
  });
});
```

**DoD**: DELETE behavior documented in story notes, re-invitation workflow understood

---

## TASK-92: Document Re-Invitation Workflow and Update Epic

**Type**: Documentation | **Estimated Time**: 1.5 hours | **Status**: Ready
**Dependencies**: TASK-91 | **Sequential After**: TASK-91

### Objective
Document confirmed DELETE behavior and re-invitation process.

### Documentation Updates

1. **Update STORY-15 Notes Section**:
   - Confirm soft delete or hard delete
   - Document exact re-invitation steps
   - Note any Circle.so UI steps required

2. **Update EPIC-4.md**:
   - Section 5: Account Deactivation
   - Update with confirmed behavior
   - Add re-invitation workflow

3. **Create Re-Invitation Runbook**:
   - `docs/runbooks/member-reinvitation.md`
   - Step-by-step admin instructions
   - Include warning count reset steps

### Definition of Done
- [ ] DELETE behavior confirmed and documented
- [ ] Re-invitation workflow documented
- [ ] EPIC-4 updated with findings
- [ ] Runbook created for admin reference
- [ ] Warning count reset process defined

---

## Summary

**Total Tasks**: 4
**Red-Green-Refactor**: 1 cycle (test → impl → document)
**Critical Path**: TASK-89 → TASK-90 → TASK-91 → TASK-92

**Testing**: 6 unit tests, 1 integration test

**Critical Documentation**: Re-invitation workflow impacts Epic 4 acceptance criteria
