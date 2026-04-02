# STORY-17 Tasks: Netlify Scheduled Function Setup and Orchestration

**Story**: [[STORY-17]] - Netlify Scheduled Function Setup and Orchestration
**Epic**: [[EPIC-4]] - Profile Photo Enforcement System
**Total Tasks**: 7
**Estimated Time**: 12-14 hours

---

## TASK-98: Write Tests for Orchestration Function Structure

**Type**: Test | **Estimated Time**: 2 hours | **Status**: Ready

### Test File
`/Users/zack/projects/bocc-backend/tests/unit/photo-enforcement.test.js`

### Test Specifications
```javascript
describe('photo-enforcement handler', () => {
  it('should query segment and process all members');
  it('should handle segment query failure gracefully (return 500)');
  it('should continue processing after individual member errors');
  it('should execute dry-run without side effects');
  it('should generate accurate summary with action counts');
  it('should respect rate limits with sequential processing');
  it('should log comprehensive execution details');
  it('should handle unexpected errors without crashing');
});
```

**DoD**: 8+ tests for orchestration logic

---

## TASK-99: Create photo-enforcement.js Function Skeleton

**Type**: Implementation | **Estimated Time**: 1.5 hours | **Status**: Ready
**Dependencies**: TASK-98 | **Sequential After**: TASK-98

### Implementation File
`/Users/zack/projects/bocc-backend/netlify/functions/photo-enforcement.js`

### Function Structure
```javascript
const { getSegmentMembers } = require('./utils/circle');
const { findWarningByEmail } = require('./utils/airtable-warnings');
const { determineEnforcementAction, processEnforcementAction } = require('./utils/enforcement-logic');

const NO_PROFILE_PHOTO_SEGMENT_ID = 238273;

exports.handler = async (event, context) => {
  console.log('=== Photo Enforcement Run Started ===');

  const dryRun = event.queryStringParameters?.dryRun === 'true' ||
                 (event.body && JSON.parse(event.body).dryRun === true);

  const summary = {
    startTime: new Date().toISOString(),
    dryRun: dryRun,
    segmentMembersCount: 0,
    processed: 0,
    actions: { CREATE_WARNING: 0, INCREMENT_WARNING: 0, DEACTIVATE: 0, PHOTO_ADDED: 0, SKIP: 0 },
    warningLevels: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    errors: [],
    endTime: null,
    durationMs: 0
  };

  try {
    // Step 1: Query segment (next task)
    // Step 2: Process members (next task)
    // Step 3: Generate summary (next task)
  } catch (unexpectedError) {
    // Error handling
  }
};
```

**DoD**: Function skeleton created, imports correct, summary structure defined

---

## TASK-100: Implement Segment Query and Error Handling

**Type**: Implementation | **Estimated Time**: 1.5 hours | **Status**: Ready
**Dependencies**: TASK-99 | **Sequential After**: TASK-99

### Implementation
```javascript
// Step 1: Query Circle.so "No Profile Photo" segment
let segmentMembers;
try {
  segmentMembers = await getSegmentMembers(NO_PROFILE_PHOTO_SEGMENT_ID);
  summary.segmentMembersCount = segmentMembers.length;
  console.log(`Found ${segmentMembers.length} members without profile photos`);
} catch (segmentError) {
  console.error('Failed to query segment:', segmentError.message);
  summary.errors.push({
    type: 'SEGMENT_QUERY_FAILED',
    error: segmentError.message
  });

  summary.endTime = new Date().toISOString();
  summary.durationMs = Date.now() - new Date(summary.startTime).getTime();

  return {
    statusCode: 500,
    body: JSON.stringify({
      success: false,
      message: 'Failed to query segment',
      summary
    })
  };
}
```

**DoD**: Segment query error handling implemented, tests pass

---

## TASK-101: Implement Member Processing Loop

**Type**: Implementation | **Estimated Time**: 2.5 hours | **Status**: Ready
**Dependencies**: TASK-100 | **Sequential After**: TASK-100

### Implementation
```javascript
// Step 2: Process each member in segment
for (const member of segmentMembers) {
  console.log(`\nProcessing member: ${member.email} (${member.name})`);

  try {
    // Find existing warning record
    const existingWarning = await findWarningByEmail(member.email);

    // Determine enforcement action
    const action = determineEnforcementAction(member, existingWarning);
    console.log(`Determined action: ${action.action} (level ${action.warningLevel})`);

    // Process action (execute or dry-run)
    const result = await processEnforcementAction(
      member,
      existingWarning,
      action,
      dryRun
    );

    // Update summary
    summary.actions[action.action]++;
    if (action.warningLevel > 0 && action.warningLevel <= 5) {
      summary.warningLevels[action.warningLevel]++;
    }
    summary.processed++;

    // Log non-blocking errors
    if (result.errors && result.errors.length > 0) {
      summary.errors.push({
        type: 'ACTION_ERROR',
        member: member.email,
        action: action.action,
        errors: result.errors
      });
    }

    console.log(`✓ Completed processing for ${member.email}`);
  } catch (memberError) {
    // Log error and continue (non-blocking)
    console.error(`Error processing member ${member.email}:`, memberError.message);
    summary.errors.push({
      type: 'MEMBER_PROCESSING_FAILED',
      member: member.email,
      error: memberError.message
    });
  }
}
```

**DoD**: Member loop implemented, non-blocking errors handled, summary updated

---

## TASK-102: Implement Summary Generation and Response

**Type**: Implementation | **Estimated Time**: 1.5 hours | **Status**: Ready
**Dependencies**: TASK-101 | **Sequential After**: TASK-101

### Implementation
```javascript
// Step 3: Generate summary
console.log('\n--- Enforcement Run Summary ---');
summary.endTime = new Date().toISOString();
summary.durationMs = Date.now() - new Date(summary.startTime).getTime();

console.log(`Total members in segment: ${summary.segmentMembersCount}`);
console.log(`Members processed: ${summary.processed}`);
console.log('Actions taken:');
console.log(`  - New warnings created: ${summary.actions.CREATE_WARNING}`);
console.log(`  - Warnings incremented: ${summary.actions.INCREMENT_WARNING}`);
console.log(`  - Accounts deactivated: ${summary.actions.DEACTIVATE}`);
console.log(`  - Photos added (thanked): ${summary.actions.PHOTO_ADDED}`);
console.log(`  - Skipped: ${summary.actions.SKIP}`);
console.log('Warning levels:');
console.log(`  - Level 1: ${summary.warningLevels[1]}`);
console.log(`  - Level 2: ${summary.warningLevels[2]}`);
console.log(`  - Level 3: ${summary.warningLevels[3]}`);
console.log(`  - Level 4 (final): ${summary.warningLevels[4]}`);
console.log(`  - Level 5 (deactivated): ${summary.warningLevels[5]}`);
console.log(`Errors encountered: ${summary.errors.length}`);
console.log(`Duration: ${(summary.durationMs / 1000).toFixed(2)}s`);

return {
  statusCode: 200,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    success: true,
    message: 'Enforcement run completed',
    summary
  })
};
```

**DoD**: Summary logged comprehensively, HTTP response returned, tests pass (Green phase)

---

## TASK-103: Configure Netlify Scheduled Function

**Type**: Configuration | **Estimated Time**: 1 hour | **Status**: Ready
**Dependencies**: TASK-102 | **Sequential After**: TASK-102

### Objective
Configure weekly scheduled execution in Netlify.

### Configuration File
Update `/Users/zack/projects/bocc-backend/netlify.toml`

```toml
# Add to existing netlify.toml

[[plugins]]
package = "@netlify/plugin-functions-schedule"

[[functions]]
schedule = "0 9 * * 1"  # Every Monday at 9:00 AM UTC (4 AM EST / 5 AM EDT)
function = "photo-enforcement"
```

### Package Installation
```bash
npm install --save-dev @netlify/plugin-functions-schedule
```

**DoD**: Plugin installed, netlify.toml updated, schedule configured

---

## TASK-104: Manual Trigger Testing and Integration Test

**Type**: Integration Test | **Estimated Time**: 2 hours | **Status**: Ready
**Dependencies**: TASK-103 | **Sequential After**: TASK-103

### Test Prerequisites
- All previous stories (11-16) implemented
- Test Glick user configured
- All environment variables set

### Manual Trigger Test
```bash
# Dry-run mode
curl -X POST http://localhost:8888/.netlify/functions/photo-enforcement \
  -H "Content-Type: application/json" \
  -d '{"dryRun": true}'

# Verify summary returned, no side effects

# Real enforcement run (local)
curl -X POST http://localhost:8888/.netlify/functions/photo-enforcement

# Verify:
# - Test Glick receives DM
# - Warning record created/updated in Airtable
# - Summary accurate
```

### Automated Integration Test
```javascript
describe('Photo Enforcement Integration Test', () => {
  it('should run full enforcement with Test Glick in dry-run mode', async () => {
    const event = {
      queryStringParameters: { dryRun: 'true' }
    };
    const response = await handler(event, {});

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.summary.dryRun).toBe(true);
  });
});
```

**DoD**: Manual testing successful, integration test passes, documented

---

## Summary

**Total Tasks**: 7
**Red-Green-Refactor**: 2 cycles (structure → impl → test)
**Critical Path**: TASK-98 → TASK-99 → TASK-100 → TASK-101 → TASK-102 → TASK-103 → TASK-104

**Testing**: 8+ unit tests, 1+ integration test

**Completes Epic 4**: This story ties all previous stories together into scheduled enforcement
