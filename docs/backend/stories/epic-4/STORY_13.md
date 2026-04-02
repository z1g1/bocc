# Story 13: Progressive Warning Logic and Status Transitions

**ID**: STORY-13
**Epic**: EPIC-4 (Profile Photo Enforcement)
**Status**: READY
**Story Points**: 4
**Complexity**: Medium-High
**Created**: 2026-02-05
**Dependencies**: STORY-11 (segment members), STORY-12 (warning operations)

---

## User Story

As a **developer**, I want **progressive warning logic that determines enforcement actions based on warning count**, so that members receive appropriate escalation (standard warning → final warning → deactivation) and members who add photos are thanked and removed from tracking.

## Context

This story implements the core enforcement decision logic that sits at the heart of the photo enforcement system. For each member in the "No Profile Photo" segment, it determines: (1) Have they been warned before? (2) What warning level are they at? (3) Have they added a photo since last check? (4) What action should be taken (send warning, deactivate, thank)? This logic orchestrates the state machine that drives the entire enforcement workflow.

The warning progression is: 1-3 (standard warnings) → 4 (final warning + admin alert) → 5 (deactivation + admin alert).

## Acceptance Criteria

### Functional Requirements
- [ ] Function `determineEnforcementAction(member, existingWarning)` returns action object with fields: `action`, `warningLevel`, `shouldNotifyAdmin`
- [ ] **New Member** (no existing warning): Return `{action: 'CREATE_WARNING', warningLevel: 1, shouldNotifyAdmin: false}`
- [ ] **Existing Warning (Active, count 1-3)**: Return `{action: 'INCREMENT_WARNING', warningLevel: count+1, shouldNotifyAdmin: false}`
- [ ] **Existing Warning (Active, count 3→4)**: Return `{action: 'INCREMENT_WARNING', warningLevel: 4, shouldNotifyAdmin: true}` (final warning triggers admin alert)
- [ ] **Existing Warning (Active, count 4→5)**: Return `{action: 'DEACTIVATE', warningLevel: 5, shouldNotifyAdmin: true}`
- [ ] **Photo Added** (member not in segment but has warning record): Return `{action: 'PHOTO_ADDED', warningLevel: 0, shouldNotifyAdmin: false}`
- [ ] **Already Deactivated** (status='Deactivated'): Return `{action: 'SKIP', warningLevel: 5, shouldNotifyAdmin: false}` (no further action)
- [ ] Function `processEnforcementAction(member, warningRecord, action)` executes the determined action (create, increment, deactivate, thank, skip)

### Non-Functional Requirements
- [ ] Decision logic is pure function (no side effects, testable with simple inputs)
- [ ] Action execution logs each step (create warning, send DM, update status, etc.)
- [ ] Errors during action execution log details but don't crash entire enforcement run
- [ ] Warning count never exceeds 5 (safeguard in logic)

### Testing Requirements
- [ ] Unit test: New member → CREATE_WARNING action with level 1
- [ ] Unit test: Warning count 1 → INCREMENT_WARNING to level 2 (no admin notify)
- [ ] Unit test: Warning count 2 → INCREMENT_WARNING to level 3 (no admin notify)
- [ ] Unit test: Warning count 3 → INCREMENT_WARNING to level 4 (admin notified)
- [ ] Unit test: Warning count 4 → DEACTIVATE to level 5 (admin notified)
- [ ] Unit test: Member adds photo → PHOTO_ADDED action (delete record, send thank you)
- [ ] Unit test: Already deactivated → SKIP action (no further processing)
- [ ] Unit test: Edge case - warning count > 5 → Cap at 5, log anomaly
- [ ] Integration test: Full progression with Test Glick (1→2→3→4→5)

## Technical Implementation Notes

### Approach

**Module**: Create new utility module `netlify/functions/utils/enforcement-logic.js` containing pure decision logic and action execution.

**Two-Phase Design**:
1. **Decision Phase** (`determineEnforcementAction`): Pure function that determines what action to take based on current state
2. **Execution Phase** (`processEnforcementAction`): Impure function that executes the determined action (Airtable updates, DM sending, etc.)

This separation enables:
- Easy unit testing of decision logic (no mocks needed)
- Dry-run mode (determine actions without executing)
- Clear audit logs of what was decided vs. what was executed

### Function Implementations

#### 1. Determine Enforcement Action (Decision Logic)

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
    // This shouldn't happen if Circle segment is accurate, but handle gracefully
    if (member.has_profile_picture === true) {
        if (existingWarning && existingWarning.fields['Status'] !== 'Photo Added') {
            return {
                action: 'PHOTO_ADDED',
                warningLevel: 0,
                shouldNotifyAdmin: false,
                reason: 'Member added profile photo since last enforcement run'
            };
        }
        // Member has photo and no active warning - shouldn't be in segment, skip
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

    // Case 3a: Already deactivated - skip (no further action)
    if (currentStatus === 'Deactivated') {
        return {
            action: 'SKIP',
            warningLevel: currentCount,
            shouldNotifyAdmin: false,
            reason: 'Member already deactivated, no further action'
        };
    }

    // Case 3b: Already marked as Photo Added - skip (shouldn't happen, record should be deleted)
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

    // Warnings 1→2, 2→3: Standard increments (no admin notification)
    return {
        action: 'INCREMENT_WARNING',
        warningLevel: nextCount,
        shouldNotifyAdmin: false,
        reason: `Member received warning ${nextCount} of 4 before deactivation`
    };
};
```

#### 2. Process Enforcement Action (Execution Logic)

```javascript
const {
    createWarningRecord,
    incrementWarningCount,
    updateWarningStatus,
    deleteWarningRecord
} = require('./airtable-warnings');

const { sendWarningDM, sendThankYouDM } = require('./circle-messaging'); // STORY-14
const { deactivateMember } = require('./circle'); // STORY-15
const { notifyAdmin } = require('./admin-notifications'); // STORY-16

/**
 * Execute the determined enforcement action
 * Impure function - makes API calls, has side effects
 *
 * @param {object} member - Circle member object
 * @param {object|null} warningRecord - Airtable warning record or null
 * @param {object} action - Action object from determineEnforcementAction
 * @param {boolean} dryRun - If true, log actions but don't execute (for testing)
 * @returns {Promise<object>} Result object {success, executedActions, errors}
 */
const processEnforcementAction = async (member, warningRecord, action, dryRun = false) => {
    const result = {
        success: false,
        executedActions: [],
        errors: []
    };

    try {
        console.log(`Processing ${action.action} for ${member.email} (warning level: ${action.warningLevel})`);

        if (dryRun) {
            console.log(`[DRY RUN] Would execute: ${action.action} for ${member.email}`);
            result.success = true;
            result.executedActions.push(`DRY_RUN:${action.action}`);
            return result;
        }

        switch (action.action) {
            case 'CREATE_WARNING':
                // Create warning record in Airtable
                const newRecord = await createWarningRecord(member.name, member.email);
                result.executedActions.push('CREATED_WARNING_RECORD');

                // Send first warning DM
                try {
                    await sendWarningDM(member, 1); // Warning level 1
                    result.executedActions.push('SENT_WARNING_DM');
                } catch (dmError) {
                    console.error('Failed to send warning DM (non-blocking):', dmError.message);
                    result.errors.push(`DM send failed: ${dmError.message}`);
                }

                result.success = true;
                break;

            case 'INCREMENT_WARNING':
                // Increment warning count in Airtable
                await incrementWarningCount(warningRecord.id);
                result.executedActions.push('INCREMENTED_WARNING_COUNT');

                // Send appropriate warning DM (standard or final)
                const isFinalWarning = action.warningLevel === 4;
                try {
                    await sendWarningDM(member, action.warningLevel, isFinalWarning);
                    result.executedActions.push(isFinalWarning ? 'SENT_FINAL_WARNING_DM' : 'SENT_WARNING_DM');
                } catch (dmError) {
                    console.error('Failed to send warning DM (non-blocking):', dmError.message);
                    result.errors.push(`DM send failed: ${dmError.message}`);
                }

                // Notify admin if final warning or anomaly
                if (action.shouldNotifyAdmin) {
                    try {
                        await notifyAdmin({
                            action: 'FINAL_WARNING',
                            member,
                            warningCount: action.warningLevel
                        });
                        result.executedActions.push('NOTIFIED_ADMIN');
                    } catch (notifyError) {
                        console.error('Failed to notify admin (non-blocking):', notifyError.message);
                        result.errors.push(`Admin notify failed: ${notifyError.message}`);
                    }
                }

                result.success = true;
                break;

            case 'DEACTIVATE':
                // Send deactivation notice DM BEFORE deactivating (DM may not work after)
                try {
                    await sendWarningDM(member, 5, true); // Deactivation notice
                    result.executedActions.push('SENT_DEACTIVATION_NOTICE');
                } catch (dmError) {
                    console.error('Failed to send deactivation notice (non-blocking):', dmError.message);
                    result.errors.push(`Deactivation notice failed: ${dmError.message}`);
                }

                // Deactivate Circle account
                try {
                    await deactivateMember(member.id);
                    result.executedActions.push('DEACTIVATED_ACCOUNT');
                } catch (deactivateError) {
                    console.error('Failed to deactivate account:', deactivateError.message);
                    result.errors.push(`Deactivation failed: ${deactivateError.message}`);
                    result.success = false;
                    break; // Don't update status if deactivation failed
                }

                // Update warning status to Deactivated
                await updateWarningStatus(warningRecord.id, 'Deactivated');
                result.executedActions.push('UPDATED_STATUS_DEACTIVATED');

                // Notify admin of deactivation
                try {
                    await notifyAdmin({
                        action: 'DEACTIVATION',
                        member,
                        warningCount: 5
                    });
                    result.executedActions.push('NOTIFIED_ADMIN');
                } catch (notifyError) {
                    console.error('Failed to notify admin (non-blocking):', notifyError.message);
                    result.errors.push(`Admin notify failed: ${notifyError.message}`);
                }

                result.success = true;
                break;

            case 'PHOTO_ADDED':
                // Send thank-you DM
                try {
                    await sendThankYouDM(member);
                    result.executedActions.push('SENT_THANK_YOU_DM');
                } catch (dmError) {
                    console.error('Failed to send thank you DM (non-blocking):', dmError.message);
                    result.errors.push(`Thank you DM failed: ${dmError.message}`);
                }

                // Delete warning record (no longer needed)
                await deleteWarningRecord(warningRecord.id);
                result.executedActions.push('DELETED_WARNING_RECORD');

                result.success = true;
                break;

            case 'SKIP':
                console.log(`Skipping member ${member.email}: ${action.reason}`);
                result.executedActions.push('SKIPPED');

                // Notify admin if this is an anomaly
                if (action.shouldNotifyAdmin) {
                    try {
                        await notifyAdmin({
                            action: 'ERROR',
                            member,
                            warningCount: action.warningLevel,
                            error: action.reason
                        });
                        result.executedActions.push('NOTIFIED_ADMIN_ANOMALY');
                    } catch (notifyError) {
                        console.error('Failed to notify admin (non-blocking):', notifyError.message);
                        result.errors.push(`Admin notify failed: ${notifyError.message}`);
                    }
                }

                result.success = true;
                break;

            default:
                throw new Error(`Unknown action: ${action.action}`);
        }

    } catch (error) {
        console.error(`Error processing enforcement action for ${member.email}:`, error.message);
        result.success = false;
        result.errors.push(error.message);

        // Notify admin of processing error
        try {
            await notifyAdmin({
                action: 'ERROR',
                member,
                error: error.message
            });
        } catch (notifyError) {
            console.error('Failed to notify admin of error:', notifyError.message);
        }
    }

    return result;
};

module.exports = {
    determineEnforcementAction,
    processEnforcementAction
};
```

### Integration Points

- **STORY-12**: Uses all Airtable warning operations (create, increment, update, delete)
- **STORY-14**: Calls `sendWarningDM()` and `sendThankYouDM()` for member notifications
- **STORY-15**: Calls `deactivateMember()` when warning count reaches 5
- **STORY-16**: Calls `notifyAdmin()` for final warnings, deactivations, and errors

### Technical Considerations

**Pure vs. Impure Functions**:
- `determineEnforcementAction`: Pure function (no side effects, same input = same output)
- `processEnforcementAction`: Impure function (API calls, side effects)
- Separation enables comprehensive unit testing without mocking

**Non-Blocking DM Failures**:
- If DM sending fails, log error but continue enforcement
- Admin notification still sent for final warnings/deactivations
- Airtable state remains consistent (warning count tracks enforcement attempts, not successful DMs)

**Deactivation Ordering**:
- Send deactivation notice DM **before** calling DELETE endpoint
- Rationale: DM may not be deliverable after account deactivation
- If DM fails, proceed with deactivation anyway (logged for admin review)

**Dry-Run Mode**:
- When `dryRun: true`, log actions but don't execute
- Enables testing enforcement logic without affecting production data
- Useful for verifying fix after enforcement bugs

**Warning Count Cap**:
- Safeguard prevents infinite escalation if enforcement logic has bug
- Warns if count > 5 (shouldn't happen, indicates anomaly)
- Notifies admin if anomaly detected

### Existing Patterns to Follow

- **Non-blocking errors**: Like Epic 2/3 Circle integration, DM failures don't crash enforcement
- **Comprehensive logging**: Log decision rationale, execution steps, and errors
- **Error context**: Include member email, warning count, and action in all error logs

### Security Considerations

- **PII Logging**: Never log full member lists, only individual processing steps
- **Status Validation**: Ensure status transitions are valid (prevent invalid states)
- **Warning Count Bounds**: Enforce max warning count to prevent abuse/bugs

## Dependencies

### Blocks
- **STORY-17**: Scheduled function depends on this to process each segment member

### Blocked By
- **STORY-11**: Needs segment members to process
- **STORY-12**: Needs warning operations to track state

### Related
- **STORY-14**: Execution logic calls DM functions from this story
- **STORY-15**: Execution logic calls deactivation from this story
- **STORY-16**: Execution logic calls admin notifications from this story

## Out of Scope

- Custom escalation schedules (e.g., 7 warnings instead of 5) - hardcoded to 5 for MVP
- Warning decay (reducing count if member remains active without violations) - not needed
- Manual override mechanism (admin manually adjusts warning count) - can be done in Airtable UI
- Batch processing optimizations - sequential processing is fine for weekly enforcement

## Testing Approach

### Unit Tests (`tests/enforcement-logic.test.js`)

```javascript
describe('determineEnforcementAction', () => {
    it('should return CREATE_WARNING for new member without photo', () => {
        const member = {id: '123', email: 'test@example.com', name: 'Test', has_profile_picture: false};
        const result = determineEnforcementAction(member, null);

        expect(result.action).toBe('CREATE_WARNING');
        expect(result.warningLevel).toBe(1);
        expect(result.shouldNotifyAdmin).toBe(false);
    });

    it('should return INCREMENT_WARNING for warning count 1→2', () => {
        const member = {id: '123', email: 'test@example.com', name: 'Test', has_profile_picture: false};
        const warning = {fields: {'Status': 'Active', 'Number of Warnings': 1}};
        const result = determineEnforcementAction(member, warning);

        expect(result.action).toBe('INCREMENT_WARNING');
        expect(result.warningLevel).toBe(2);
        expect(result.shouldNotifyAdmin).toBe(false);
    });

    it('should return INCREMENT_WARNING with admin notify for warning count 3→4', () => {
        const member = {id: '123', email: 'test@example.com', name: 'Test', has_profile_picture: false};
        const warning = {fields: {'Status': 'Active', 'Number of Warnings': 3}};
        const result = determineEnforcementAction(member, warning);

        expect(result.action).toBe('INCREMENT_WARNING');
        expect(result.warningLevel).toBe(4);
        expect(result.shouldNotifyAdmin).toBe(true);
    });

    it('should return DEACTIVATE for warning count 4→5', () => {
        const member = {id: '123', email: 'test@example.com', name: 'Test', has_profile_picture: false};
        const warning = {fields: {'Status': 'Active', 'Number of Warnings': 4}};
        const result = determineEnforcementAction(member, warning);

        expect(result.action).toBe('DEACTIVATE');
        expect(result.warningLevel).toBe(5);
        expect(result.shouldNotifyAdmin).toBe(true);
    });

    it('should return PHOTO_ADDED when member has photo and active warning', () => {
        const member = {id: '123', email: 'test@example.com', name: 'Test', has_profile_picture: true};
        const warning = {fields: {'Status': 'Active', 'Number of Warnings': 2}};
        const result = determineEnforcementAction(member, warning);

        expect(result.action).toBe('PHOTO_ADDED');
        expect(result.warningLevel).toBe(0);
    });

    it('should return SKIP for already deactivated member', () => {
        const member = {id: '123', email: 'test@example.com', name: 'Test', has_profile_picture: false};
        const warning = {fields: {'Status': 'Deactivated', 'Number of Warnings': 5}};
        const result = determineEnforcementAction(member, warning);

        expect(result.action).toBe('SKIP');
        expect(result.warningLevel).toBe(5);
    });
});

describe('processEnforcementAction', () => {
    // Mock all dependencies
    it('should create warning record and send DM for CREATE_WARNING', async () => {
        // Test execution of CREATE_WARNING action
    });

    it('should support dry-run mode without executing actions', async () => {
        // Test dryRun: true logs actions but doesn't execute
    });
});
```

### Integration Test

**Test Full Progression**:
1. Remove Test Glick's profile photo
2. Run enforcement (should create warning, count=1)
3. Run enforcement again (should increment to count=2)
4. Run enforcement again (should increment to count=3)
5. Run enforcement again (should increment to count=4, admin notified)
6. Verify admin received final warning notification
7. Test Glick adds photo
8. Run enforcement (should send thank you, delete record)
9. Verify warning record deleted

## Notes

**State Machine Visualization**:
```
[No Warning] → [Warning 1] → [Warning 2] → [Warning 3] → [Warning 4 (Final)] → [Deactivated]
                    ↓              ↓              ↓                ↓                    ↓
              [Photo Added] → [Thank You] → [Delete Record]
```

**Admin Notification Triggers**:
- Warning 4 (final warning): "Member X received final warning, will be deactivated next week"
- Warning 5 (deactivation): "Member X's account has been deactivated"
- Anomaly (count > 5): "Warning count anomaly detected for member X"

**Why Not Combined Function**:
- Separating decision from execution enables dry-run mode (test logic without side effects)
- Pure decision function is trivial to unit test (no mocks needed)
- Clear audit trail: "Decided X, executed Y, errors: Z"

---

**Next Steps**: Implement decision and execution logic in `enforcement-logic.js`, write comprehensive unit tests for all state transitions, integrate with stories 14/15/16 for action execution.
