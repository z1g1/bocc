# STORY-13 Tasks: Progressive Warning Logic and Status Transitions

**Story**: [[STORY-13]] - Progressive Warning Logic and Status Transitions
**Epic**: [[EPIC-4]] - Profile Photo Enforcement System
**Total Tasks**: 6
**Estimated Time**: 12-14 hours

---

## Task Overview

Implement the core enforcement decision logic that determines actions based on warning count and orchestrates execution of enforcement actions.

---

## TASK-74: Write Tests for Enforcement Decision Logic (Pure Function)

**Type**: Test
**Estimated Time**: 2 hours
**Status**: Ready
**Dependencies**: None

### Objective
Create comprehensive Jest unit tests for pure decision function (no side effects, easy to test).

### Test File
`/Users/zack/projects/bocc-backend/tests/unit/enforcement-logic.test.js`

### Test Specifications - determineEnforcementAction

```javascript
describe('determineEnforcementAction', () => {
  it('should return CREATE_WARNING for new member without photo', () => {
    const member = {
      id: '123',
      email: 'test@example.com',
      name: 'Test User',
      has_profile_picture: false
    };
    const result = determineEnforcementAction(member, null);

    expect(result.action).toBe('CREATE_WARNING');
    expect(result.warningLevel).toBe(1);
    expect(result.shouldNotifyAdmin).toBe(false);
    expect(result.reason).toContain('First time');
  });

  it('should return INCREMENT_WARNING for warning count 1→2', () => {
    const member = { has_profile_picture: false };
    const warning = { fields: { 'Status': 'Active', 'Number of Warnings': 1 } };
    const result = determineEnforcementAction(member, warning);

    expect(result.action).toBe('INCREMENT_WARNING');
    expect(result.warningLevel).toBe(2);
    expect(result.shouldNotifyAdmin).toBe(false);
  });

  it('should return INCREMENT_WARNING for warning count 2→3', () => {
    const member = { has_profile_picture: false };
    const warning = { fields: { 'Status': 'Active', 'Number of Warnings': 2 } };
    const result = determineEnforcementAction(member, warning);

    expect(result.action).toBe('INCREMENT_WARNING');
    expect(result.warningLevel).toBe(3);
    expect(result.shouldNotifyAdmin).toBe(false);
  });

  it('should return INCREMENT_WARNING with admin notify for 3→4', () => {
    const member = { has_profile_picture: false };
    const warning = { fields: { 'Status': 'Active', 'Number of Warnings': 3 } };
    const result = determineEnforcementAction(member, warning);

    expect(result.action).toBe('INCREMENT_WARNING');
    expect(result.warningLevel).toBe(4);
    expect(result.shouldNotifyAdmin).toBe(true);
    expect(result.reason).toContain('final warning');
  });

  it('should return DEACTIVATE for warning count 4→5', () => {
    const member = { has_profile_picture: false };
    const warning = { fields: { 'Status': 'Active', 'Number of Warnings': 4 } };
    const result = determineEnforcementAction(member, warning);

    expect(result.action).toBe('DEACTIVATE');
    expect(result.warningLevel).toBe(5);
    expect(result.shouldNotifyAdmin).toBe(true);
  });

  it('should return PHOTO_ADDED when member has photo and active warning', () => {
    const member = { has_profile_picture: true };
    const warning = { fields: { 'Status': 'Active', 'Number of Warnings': 2 } };
    const result = determineEnforcementAction(member, warning);

    expect(result.action).toBe('PHOTO_ADDED');
    expect(result.warningLevel).toBe(0);
    expect(result.reason).toContain('added profile photo');
  });

  it('should return SKIP for already deactivated member', () => {
    const member = { has_profile_picture: false };
    const warning = { fields: { 'Status': 'Deactivated', 'Number of Warnings': 5 } };
    const result = determineEnforcementAction(member, warning);

    expect(result.action).toBe('SKIP');
    expect(result.warningLevel).toBe(5);
    expect(result.shouldNotifyAdmin).toBe(false);
  });

  it('should handle warning count > 5 anomaly with admin notification', () => {
    const member = { has_profile_picture: false };
    const warning = { fields: { 'Status': 'Active', 'Number of Warnings': 6 } };
    const result = determineEnforcementAction(member, warning);

    expect(result.action).toBe('SKIP');
    expect(result.warningLevel).toBe(5);
    expect(result.shouldNotifyAdmin).toBe(true);
    expect(result.reason).toContain('Anomaly');
  });

  it('should skip if member has photo and no warning', () => {
    const member = { has_profile_picture: true };
    const result = determineEnforcementAction(member, null);

    expect(result.action).toBe('SKIP');
    expect(result.reason).toContain('has profile photo');
  });
});
```

### Definition of Done
- [ ] Test file created with 9+ test cases for decision logic
- [ ] Tests fail with "function not defined" error (Red phase)
- [ ] All state transitions covered
- [ ] Edge cases tested (anomaly, photo added)
- [ ] Pure function tests (no mocks needed)

---

## TASK-75: Implement determineEnforcementAction Pure Function

**Type**: Implementation
**Estimated Time**: 2.5 hours
**Status**: Ready
**Dependencies**: TASK-74
**Sequential After**: TASK-74

### Objective
Implement pure decision logic function that determines enforcement action based on member and warning state.

### Implementation File
`/Users/zack/projects/bocc-backend/netlify/functions/utils/enforcement-logic.js`

### Function Implementation

```javascript
/**
 * Determine what enforcement action to take for a member
 * Pure function - no side effects, easy to test
 *
 * @param {object} member - Circle member object {id, email, name, has_profile_picture}
 * @param {object|null} existingWarning - Airtable warning record or null if not found
 * @returns {object} Action object {action, warningLevel, shouldNotifyAdmin, reason}
 */
const determineEnforcementAction = (member, existingWarning) => {
  // Case 1: Member has profile photo now (added since last check)
  if (member.has_profile_picture === true) {
    if (existingWarning && existingWarning.fields['Status'] !== 'Photo Added') {
      return {
        action: 'PHOTO_ADDED',
        warningLevel: 0,
        shouldNotifyAdmin: false,
        reason: 'Member added profile photo since last enforcement run'
      };
    }
    return {
      action: 'SKIP',
      warningLevel: 0,
      shouldNotifyAdmin: false,
      reason: 'Member has profile photo, no action needed'
    };
  }

  // Case 2: No existing warning record - create first warning
  if (!existingWarning) {
    return {
      action: 'CREATE_WARNING',
      warningLevel: 1,
      shouldNotifyAdmin: false,
      reason: 'First time member identified without profile photo'
    };
  }

  // Case 3: Existing warning record - check status and count
  const currentStatus = existingWarning.fields['Status'];
  const currentCount = existingWarning.fields['Number of Warnings'];

  // Case 3a: Already deactivated - skip
  if (currentStatus === 'Deactivated') {
    return {
      action: 'SKIP',
      warningLevel: currentCount,
      shouldNotifyAdmin: false,
      reason: 'Member already deactivated, no further action'
    };
  }

  // Case 3b: Already marked as Photo Added - skip
  if (currentStatus === 'Photo Added') {
    return {
      action: 'SKIP',
      warningLevel: currentCount,
      shouldNotifyAdmin: false,
      reason: 'Member marked as Photo Added, record should be deleted'
    };
  }

  // Case 3c: Active status - determine escalation
  const nextCount = currentCount + 1;

  // Safeguard: Cap at 5 warnings
  if (currentCount >= 5) {
    console.warn(`WARNING: Member ${member.email} has warning count >= 5 (${currentCount}). Capping at 5.`);
    return {
      action: 'SKIP',
      warningLevel: 5,
      shouldNotifyAdmin: true,
      reason: `Anomaly detected: warning count is ${currentCount}, expected max 5`
    };
  }

  // Warning 4→5: Deactivation time
  if (nextCount === 5) {
    return {
      action: 'DEACTIVATE',
      warningLevel: 5,
      shouldNotifyAdmin: true,
      reason: 'Member reached 5 warnings, account will be deactivated'
    };
  }

  // Warning 3→4: Final warning (triggers admin notification)
  if (nextCount === 4) {
    return {
      action: 'INCREMENT_WARNING',
      warningLevel: 4,
      shouldNotifyAdmin: true,
      reason: 'Member received final warning (4th warning)'
    };
  }

  // Warnings 1→2, 2→3: Standard increments
  return {
    action: 'INCREMENT_WARNING',
    warningLevel: nextCount,
    shouldNotifyAdmin: false,
    reason: `Member received warning ${nextCount} of 4 before deactivation`
  };
};

module.exports = {
  determineEnforcementAction
};
```

### Definition of Done
- [ ] Function implemented as pure function
- [ ] All state transitions handled correctly
- [ ] Warning count safeguard (cap at 5)
- [ ] Comprehensive reason messages
- [ ] Tests from TASK-74 pass (Green phase)
- [ ] No side effects (logs only in anomaly case)

---

## TASK-76: Write Tests for Action Execution Logic (Impure Function)

**Type**: Test
**Estimated Time**: 2.5 hours
**Status**: Ready
**Dependencies**: TASK-75
**Sequential After**: TASK-75

### Objective
Create Jest unit tests for action execution function (requires mocking dependencies).

### Test Specifications - processEnforcementAction

```javascript
jest.mock('../../netlify/functions/utils/airtable-warnings');
jest.mock('../../netlify/functions/utils/circle-messaging');
jest.mock('../../netlify/functions/utils/circle');
jest.mock('../../netlify/functions/utils/admin-notifications');

describe('processEnforcementAction', () => {
  it('should execute CREATE_WARNING action', async () => {
    // Mock createWarningRecord, sendWarningDM
    // Call with action: CREATE_WARNING
    // Verify warning created and DM sent
    // Verify result.success = true
    // Verify executedActions includes CREATED_WARNING_RECORD, SENT_WARNING_DM
  });

  it('should execute INCREMENT_WARNING action', async () => {
    // Mock incrementWarningCount, sendWarningDM
    // Call with action: INCREMENT_WARNING, level 2
    // Verify warning incremented and standard DM sent
  });

  it('should execute INCREMENT_WARNING with admin notify (final warning)', async () => {
    // Mock incrementWarningCount, sendWarningDM, notifyAdmin
    // Call with action: INCREMENT_WARNING, level 4, shouldNotifyAdmin: true
    // Verify admin notified
    // Verify executedActions includes NOTIFIED_ADMIN
  });

  it('should execute DEACTIVATE action', async () => {
    // Mock sendWarningDM (deactivation notice), deactivateMember, updateWarningStatus, notifyAdmin
    // Call with action: DEACTIVATE
    // Verify order: DM sent first, then deactivate, then status update, then admin notify
    // Verify executedActions includes all steps
  });

  it('should execute PHOTO_ADDED action', async () => {
    // Mock sendThankYouDM, deleteWarningRecord
    // Call with action: PHOTO_ADDED
    // Verify thank you sent and record deleted
  });

  it('should execute SKIP action', async () => {
    // Call with action: SKIP
    // Verify no operations performed
    // Verify result.success = true
  });

  it('should support dry-run mode without side effects', async () => {
    // Call with dryRun: true
    // Verify no functions called
    // Verify result.executedActions includes DRY_RUN:ACTION
  });

  it('should handle DM send failures gracefully (non-blocking)', async () => {
    // Mock sendWarningDM to throw error
    // Call with action: CREATE_WARNING
    // Verify warning still created
    // Verify error logged in result.errors
    // Verify result.success = true (non-blocking)
  });

  it('should handle admin notification failures gracefully', async () => {
    // Mock notifyAdmin to throw error
    // Verify action still completes
    // Verify error logged
  });

  it('should fail DEACTIVATE if deactivation fails', async () => {
    // Mock deactivateMember to throw error
    // Verify status NOT updated
    // Verify result.success = false
  });
});
```

### Definition of Done
- [ ] 10+ test cases for execution logic
- [ ] All action types tested
- [ ] Non-blocking error handling tested
- [ ] Dry-run mode tested
- [ ] Tests fail until implementation (Red phase)

---

## TASK-77: Implement processEnforcementAction Execution Function

**Type**: Implementation
**Estimated Time**: 3.5 hours
**Status**: Ready
**Dependencies**: TASK-76
**Sequential After**: TASK-76

### Objective
Implement action execution function that orchestrates warning operations, DMs, deactivation, and notifications.

### Implementation

**Note**: This is a large implementation. See STORY-13 documentation for full code. Key structure:

```javascript
const {
  createWarningRecord,
  incrementWarningCount,
  updateWarningStatus,
  deleteWarningRecord
} = require('./airtable-warnings');

// Note: These modules created in later stories, stub for now
const { sendWarningDM, sendThankYouDM } = require('./circle-messaging');
const { deactivateMember } = require('./circle');
const { notifyAdmin } = require('./admin-notifications');

const processEnforcementAction = async (member, warningRecord, action, dryRun = false) => {
  const result = {
    success: false,
    executedActions: [],
    errors: []
  };

  try {
    if (dryRun) {
      console.log(`[DRY RUN] Would execute: ${action.action} for ${member.email}`);
      result.success = true;
      result.executedActions.push(`DRY_RUN:${action.action}`);
      return result;
    }

    switch (action.action) {
      case 'CREATE_WARNING':
        // Create warning + send DM (non-blocking)
        break;
      case 'INCREMENT_WARNING':
        // Increment + send DM + maybe notify admin
        break;
      case 'DEACTIVATE':
        // Send notice + deactivate + update status + notify admin
        break;
      case 'PHOTO_ADDED':
        // Send thank you + delete record
        break;
      case 'SKIP':
        // Log only, maybe notify admin if anomaly
        break;
      default:
        throw new Error(`Unknown action: ${action.action}`);
    }
  } catch (error) {
    console.error(`Error processing enforcement action for ${member.email}:`, error.message);
    result.success = false;
    result.errors.push(error.message);
  }

  return result;
};

module.exports = {
  determineEnforcementAction,
  processEnforcementAction
};
```

### Definition of Done
- [ ] Function implemented with all action cases
- [ ] Non-blocking DM failures (logged, don't fail action)
- [ ] Blocking deactivation failures (don't update status)
- [ ] Dry-run mode implemented
- [ ] Comprehensive error handling
- [ ] Tests from TASK-76 pass (Green phase)
- [ ] Detailed logging for each action

---

## TASK-78: Integration Test with Stubbed Dependencies

**Type**: Integration Test
**Estimated Time**: 1.5 hours
**Status**: Ready
**Dependencies**: TASK-77
**Sequential After**: TASK-77

### Objective
Test full enforcement logic flow with mocked external dependencies.

### Test File
`/Users/zack/projects/bocc-backend/tests/integration/enforcement-logic-integration.test.js`

### Test Script

```javascript
const {
  determineEnforcementAction,
  processEnforcementAction
} = require('../../netlify/functions/utils/enforcement-logic');

// Mock all external dependencies
jest.mock('../../netlify/functions/utils/airtable-warnings');
jest.mock('../../netlify/functions/utils/circle-messaging');
jest.mock('../../netlify/functions/utils/circle');
jest.mock('../../netlify/functions/utils/admin-notifications');

describe('Enforcement Logic Integration', () => {
  it('should process full progression from new member to deactivation', async () => {
    const member = {
      id: 'test-123',
      email: 'test@example.com',
      name: 'Test User',
      has_profile_picture: false
    };

    // Scenario 1: New member (no warning)
    let action = determineEnforcementAction(member, null);
    expect(action.action).toBe('CREATE_WARNING');
    let result = await processEnforcementAction(member, null, action, true);
    expect(result.success).toBe(true);

    // Scenario 2: Warning 1→2
    let warning = { fields: { Status: 'Active', 'Number of Warnings': 1 } };
    action = determineEnforcementAction(member, warning);
    expect(action.action).toBe('INCREMENT_WARNING');
    expect(action.warningLevel).toBe(2);

    // Scenario 3: Warning 3→4 (final warning)
    warning.fields['Number of Warnings'] = 3;
    action = determineEnforcementAction(member, warning);
    expect(action.shouldNotifyAdmin).toBe(true);

    // Scenario 4: Warning 4→5 (deactivation)
    warning.fields['Number of Warnings'] = 4;
    action = determineEnforcementAction(member, warning);
    expect(action.action).toBe('DEACTIVATE');

    // Scenario 5: Photo added
    member.has_profile_picture = true;
    action = determineEnforcementAction(member, warning);
    expect(action.action).toBe('PHOTO_ADDED');
  });

  it('should handle dry-run mode end-to-end', async () => {
    const member = { has_profile_picture: false };
    const action = determineEnforcementAction(member, null);
    const result = await processEnforcementAction(member, null, action, true);

    expect(result.success).toBe(true);
    expect(result.executedActions[0]).toContain('DRY_RUN');
  });
});
```

### Definition of Done
- [ ] Integration test covers full progression
- [ ] All state transitions validated
- [ ] Dry-run mode tested
- [ ] Tests pass with mocked dependencies
- [ ] Test documented in test suite

---

## TASK-79: Refactor and Documentation

**Type**: Refactor
**Estimated Time**: 1 hour
**Status**: Ready
**Dependencies**: TASK-78
**Sequential After**: TASK-78

### Objective
Clean up code, add comprehensive documentation, and ensure production readiness.

### Refactoring Checklist

1. **JSDoc Comments**:
   - Add comprehensive JSDoc for both functions
   - Document all parameters and return types
   - Include usage examples

2. **Error Messages**:
   - Ensure all error messages are clear and actionable
   - Include member email in all logs

3. **Code Organization**:
   - Group related case blocks together
   - Add section comments for clarity

4. **Constants**:
   - Extract magic numbers (5 for max warnings)
   - Extract action types to constants if helpful

5. **Performance**:
   - Review async/await usage
   - Ensure no unnecessary await calls

### Definition of Done
- [ ] JSDoc comments comprehensive
- [ ] Code is well-organized and readable
- [ ] All tests still pass
- [ ] Linting passes with no warnings
- [ ] Ready for code review
- [ ] Integration with STORY-14/15/16 planned

---

## Summary

**Total Tasks**: 6
**Red-Green-Refactor Cycles**: 2
- Cycle 1: TASK-74 (test decision logic) → TASK-75 (impl decision)
- Cycle 2: TASK-76 (test execution logic) → TASK-77 (impl execution) → TASK-79 (refactor)

**Critical Path**: TASK-74 → TASK-75 → TASK-76 → TASK-77 → TASK-78 → TASK-79

**Dependencies for Other Stories**:
- STORY-14, 15, 16 functions will be stubbed initially, integrated later
- STORY-17 (Scheduled Function) depends on this as core orchestration

**Testing Coverage**:
- 9+ decision logic tests (pure function)
- 10+ execution logic tests (with mocks)
- Integration test with full progression
- End-to-end testing in STORY-18

**Key Integration Points**:
- Will need to integrate with STORY-14 (DM sending) when available
- Will need to integrate with STORY-15 (deactivation) when available
- Will need to integrate with STORY-16 (admin notifications) when available
- For now, stub these dependencies and test with mocks
