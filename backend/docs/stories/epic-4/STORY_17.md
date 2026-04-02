# Story 17: Netlify Scheduled Function Setup and Orchestration

**ID**: STORY-17
**Epic**: EPIC-4 (Profile Photo Enforcement)
**Status**: READY
**Story Points**: 4
**Complexity**: Medium
**Created**: 2026-02-05
**Dependencies**: STORY-11, STORY-12, STORY-13, STORY-14, STORY-15, STORY-16 (orchestrates all enforcement components)

---

## User Story

As a **community admin**, I want the **profile photo enforcement system to run automatically every Monday at 9 AM** via a Netlify scheduled function, so that members without profile photos receive progressive warnings without manual admin intervention.

## Context

This story implements the main orchestration function that ties together all enforcement components: segment querying, warning logic, DM sending, deactivation, and admin notifications. The function runs on a weekly schedule (Monday 9 AM) configured via Netlify's scheduled functions plugin. It processes all members in the "No Profile Photo" segment, applies progressive enforcement logic, handles errors gracefully, and generates comprehensive logs for admin review.

## Acceptance Criteria

### Functional Requirements
- [ ] Function `netlify/functions/photo-enforcement.js` created as main scheduled handler
- [ ] Netlify scheduled function configured in `netlify.toml` with cron: `0 9 * * 1` (Monday 9 AM UTC)
- [ ] Function queries Circle.so "No Profile Photo" segment (ID: 238273) via STORY-11
- [ ] For each member in segment:
  - [ ] Query existing warning record via STORY-12
  - [ ] Determine enforcement action via STORY-13
  - [ ] Process action (create/increment warning, send DM, deactivate, thank) via STORY-13
  - [ ] Handle errors non-blocking (log and continue to next member)
- [ ] Function generates summary log: members processed, warnings sent (by level), deactivations, errors
- [ ] Function supports manual trigger for testing (POST request with optional filters)
- [ ] Dry-run mode supported via query param `dryRun=true` (determines actions without executing)

### Non-Functional Requirements
- [ ] Total function execution time: <5 minutes (sufficient for 200 members at ~1.5s per member)
- [ ] Comprehensive logging at each step (segment query, member processing, summary)
- [ ] Errors logged with full context (member email, action attempted, error details)
- [ ] Function returns 200 OK with summary even if some member processing fails
- [ ] Rate limiting respected (sequential processing to avoid Circle API rate limits)

### Testing Requirements
- [ ] Unit test: Orchestrates all enforcement steps in correct order
- [ ] Unit test: Handles errors during segment query (logs and exits gracefully)
- [ ] Unit test: Handles errors during individual member processing (logs and continues)
- [ ] Unit test: Generates accurate summary (counts by action type)
- [ ] Integration test: Full enforcement run with Test Glick user
- [ ] Integration test: Dry-run mode executes without side effects

## Technical Implementation Notes

### Approach

**Main Function**: `netlify/functions/photo-enforcement.js` (new serverless function)

**Execution Flow**:
1. Query Circle.so "No Profile Photo" segment
2. For each member:
   - Fetch warning record from Airtable
   - Determine action (create warning, increment, deactivate, thank, skip)
   - Process action (execute or dry-run)
   - Log results
3. Generate execution summary
4. Return summary to caller (logged in Netlify function logs)

**Scheduling**:
- Netlify Scheduled Functions plugin via `netlify.toml`
- Cron syntax: `0 9 * * 1` = Every Monday at 9:00 AM UTC (4 AM EST / 5 AM EDT)

### Function Implementation

```javascript
// netlify/functions/photo-enforcement.js

const { getSegmentMembers } = require('./utils/circle');
const {
    findWarningByEmail,
    createWarningRecord,
    incrementWarningCount,
    updateWarningStatus,
    deleteWarningRecord
} = require('./utils/airtable-warnings');
const {
    determineEnforcementAction,
    processEnforcementAction
} = require('./utils/enforcement-logic');

// Segment ID for "No Profile Photo" in Circle.so
const NO_PROFILE_PHOTO_SEGMENT_ID = 238273;

/**
 * Netlify scheduled function: Profile photo enforcement
 * Runs every Monday at 9 AM UTC
 */
exports.handler = async (event, context) => {
    console.log('=== Photo Enforcement Run Started ===');
    console.log('Timestamp:', new Date().toISOString());
    console.log('Event:', JSON.stringify(event));

    // Parse dry-run mode from query params or request body
    const dryRun = event.queryStringParameters?.dryRun === 'true' ||
                   (event.body && JSON.parse(event.body).dryRun === true);

    if (dryRun) {
        console.log('*** DRY RUN MODE ENABLED - No actions will be executed ***');
    }

    // Initialize summary counters
    const summary = {
        startTime: new Date().toISOString(),
        dryRun: dryRun,
        segmentMembersCount: 0,
        processed: 0,
        actions: {
            CREATE_WARNING: 0,
            INCREMENT_WARNING: 0,
            DEACTIVATE: 0,
            PHOTO_ADDED: 0,
            SKIP: 0
        },
        warningLevels: {
            1: 0, 2: 0, 3: 0, 4: 0, 5: 0
        },
        errors: [],
        endTime: null,
        durationMs: 0
    };

    try {
        // Step 1: Query Circle.so "No Profile Photo" segment
        console.log('\n--- Step 1: Query No Profile Photo Segment ---');
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

            // Cannot proceed without segment data
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

        // Step 2: Process each member in segment
        console.log('\n--- Step 2: Process Members ---');

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

                // Log any errors from action processing (non-blocking)
                if (result.errors && result.errors.length > 0) {
                    console.warn(`Action processing had non-blocking errors:`, result.errors);
                    summary.errors.push({
                        type: 'ACTION_ERROR',
                        member: member.email,
                        action: action.action,
                        errors: result.errors
                    });
                }

                console.log(`✓ Completed processing for ${member.email}`);
            } catch (memberError) {
                // Log error and continue to next member (non-blocking)
                console.error(`Error processing member ${member.email}:`, memberError.message);
                summary.errors.push({
                    type: 'MEMBER_PROCESSING_FAILED',
                    member: member.email,
                    error: memberError.message
                });
            }
        }

        // Step 3: Generate summary
        console.log('\n--- Step 3: Enforcement Run Summary ---');
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
        console.log(`Duration: ${summary.durationMs}ms (${(summary.durationMs / 1000).toFixed(2)}s)`);

        if (summary.errors.length > 0) {
            console.log('\nError details:');
            summary.errors.forEach((err, idx) => {
                console.log(`  ${idx + 1}. ${err.type}: ${err.member || 'N/A'} - ${err.error}`);
            });
        }

        console.log('\n=== Photo Enforcement Run Completed ===');

        // Return success with summary
        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                success: true,
                message: 'Enforcement run completed',
                summary
            })
        };

    } catch (unexpectedError) {
        // Catch-all for unexpected errors
        console.error('Unexpected error during enforcement run:', unexpectedError);
        summary.endTime = new Date().toISOString();
        summary.durationMs = Date.now() - new Date(summary.startTime).getTime();
        summary.errors.push({
            type: 'UNEXPECTED_ERROR',
            error: unexpectedError.message,
            stack: unexpectedError.stack
        });

        return {
            statusCode: 500,
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                success: false,
                message: 'Enforcement run failed',
                summary
            })
        };
    }
};
```

### Netlify Configuration (`netlify.toml`)

```toml
# Add to existing netlify.toml

[[plugins]]
package = "@netlify/plugin-functions-schedule"

[[functions]]
schedule = "0 9 * * 1"  # Every Monday at 9:00 AM UTC
function = "photo-enforcement"
```

### Integration Points

- **STORY-11**: `getSegmentMembers()` - Query "No Profile Photo" segment
- **STORY-12**: All Airtable warning operations
- **STORY-13**: `determineEnforcementAction()`, `processEnforcementAction()`
- **STORY-14**: DM sending (called within STORY-13 action processing)
- **STORY-15**: Deactivation (called within STORY-13 action processing)
- **STORY-16**: Admin notifications (called within STORY-13 action processing)

### Technical Considerations

**Execution Time**:
- Expected: ~1.5 seconds per member (segment query, Airtable lookup, action processing, DM send)
- For 200 members: ~300 seconds = 5 minutes
- Netlify function timeout: 10 minutes (default) - sufficient headroom

**Rate Limiting**:
- Circle.so: 100 requests/minute
- Sequential processing keeps us under limit (40 members/minute max)
- If enforcement scales >1000 members, implement batch processing with delays

**Error Handling Philosophy**:
- **Segment query failure**: Critical, exit immediately (can't proceed without members)
- **Individual member processing failure**: Non-critical, log and continue to next member
- **DM send failure**: Non-blocking, logged in action results
- **Admin notification failure**: Non-blocking, logged separately

**Dry-Run Mode**:
- Triggered via query param `?dryRun=true` or request body `{"dryRun": true}`
- Executes all decision logic but skips side effects (no Airtable updates, no DMs, no deactivations)
- Useful for testing logic changes or verifying enforcement state before production run

**Manual Trigger**:
- Scheduled function can also be triggered manually via POST request
- Useful for testing, emergency enforcement runs, or debugging
- POST to: `https://bocc-backend.netlify.app/.netlify/functions/photo-enforcement`

**Logging Strategy**:
- Log segment query results (member count)
- Log each member processing (email, action determined, result)
- Log comprehensive summary (counts, errors, duration)
- All logs visible in Netlify function logs dashboard

**Performance Optimization**:
- JWT token cached across all DM sends (STORY-14)
- Chat room UUIDs cached across multiple messages to same recipient
- Warning records fetched once per member (not redundantly)

### Existing Patterns to Follow

- **Non-blocking errors**: Like Epic 2/3, continue processing even if individual operations fail
- **Comprehensive logging**: Log every significant step for debugging
- **Error context**: Include member email, action, and error details in all error logs

### Security Considerations

- **Environment Variables**: All API tokens (Circle, Airtable, Headless) secured in Netlify env vars
- **Manual Trigger Security**: Function can be triggered manually, but requires Netlify deployment access (no public API)
- **PII Logging**: Log individual member processing but avoid logging full member lists
- **Dry-Run Safety**: Dry-run mode prevents accidental enforcement during testing

## Dependencies

### Blocks
- None (this is the final integration story that completes Epic 4)

### Blocked By
- **STORY-11**: Segment query (foundation)
- **STORY-12**: Warning operations (state management)
- **STORY-13**: Enforcement logic (orchestrates actions)
- **STORY-14**: DM sending (member notifications)
- **STORY-15**: Deactivation (enforcement action)
- **STORY-16**: Admin notifications (oversight)

### Related
- **STORY-18**: Testing framework depends on this function for end-to-end tests

## Out of Scope

- Multi-segment enforcement (only "No Profile Photo" segment for MVP)
- Configurable schedule (hardcoded to Monday 9 AM, can be changed in netlify.toml)
- Batch processing optimizations (sequential is sufficient for <1000 members)
- Concurrent execution (not needed for weekly enforcement)
- Progress reporting UI (Netlify logs provide sufficient visibility)
- Pause/resume enforcement (can be disabled by removing schedule in netlify.toml)

## Testing Approach

### Unit Tests (`tests/photo-enforcement.test.js`)

```javascript
describe('photo-enforcement function', () => {
    it('should query segment and process all members', async () => {
        // Mock segment query (2 members)
        // Mock warning lookups
        // Mock action processing
        // Verify all members processed
        // Verify summary accurate
    });

    it('should handle segment query failure gracefully', async () => {
        // Mock segment query error
        // Verify returns 500 with error in summary
    });

    it('should continue processing after individual member errors', async () => {
        // Mock segment query (3 members)
        // Mock member 2 processing throws error
        // Verify members 1 and 3 still processed
        // Verify error logged in summary
    });

    it('should execute dry-run without side effects', async () => {
        // Mock segment query
        // Call with dryRun: true
        // Verify no Airtable updates
        // Verify no DMs sent
        // Verify summary includes dryRun flag
    });

    it('should generate accurate summary', async () => {
        // Mock various actions (create, increment, deactivate, skip)
        // Verify summary counts match actions taken
    });
});
```

### Integration Test

**Prerequisites**:
- Test Glick user configured (zglicka@gmail.com, ID: a594d38f)
- Test Glick profile photo removed (appears in segment 238273)
- All environment variables configured (CIRCLE_API_TOKEN, CIRCLE_HEADLESS_API, AIRTABLE_API_KEY, AIRTABLE_BASE_ID)

**Test Script** (manual):
```bash
# Step 1: Dry-run to verify logic without side effects
curl -X POST http://localhost:8888/.netlify/functions/photo-enforcement \
  -H "Content-Type: application/json" \
  -d '{"dryRun": true}'

# Expected: Summary shows actions that would be taken, but no changes in Airtable/Circle

# Step 2: Real enforcement run
curl -X POST http://localhost:8888/.netlify/functions/photo-enforcement \
  -H "Content-Type: application/json"

# Expected:
# - Test Glick receives warning DM
# - Warning record created/updated in Airtable
# - Summary shows 1 member processed
# - No errors

# Step 3: Verify results
# - Check Test Glick's Circle DMs (should have warning message)
# - Check Airtable "No Photo Warnings" table (should have Test Glick record)
# - Check Netlify function logs (should have detailed execution logs)

# Step 4: Test full progression
# - Run enforcement 4 more times (weekly simulation)
# - Verify warning count increments (1→2→3→4)
# - Verify admin receives final warning alert (warning 4)
# - Verify Test Glick account deactivated (warning 5)
# - Verify admin receives deactivation alert
```

### Automated Integration Test (STORY-18)

Detailed automated testing covered in STORY-18 (Testing Framework)

## Notes

**Cron Schedule**:
- `0 9 * * 1` = Every Monday at 9:00 AM UTC
- Converts to:
  - 4:00 AM EST (winter)
  - 5:00 AM EDT (summer)
- Early morning timing avoids disrupting active community hours

**Why Monday**:
- Gives weekend for members to add photos before next check
- Admin has full week to respond to final warnings/deactivations
- Consistent weekly cadence (52 enforcement runs per year)

**Manual Trigger Use Cases**:
1. Testing after code changes (dry-run mode)
2. Emergency enforcement run (e.g., spam wave of users without photos)
3. Debugging specific member issue (filter by email in query params - future enhancement)

**Netlify Scheduled Functions Plugin**:
- Install: `npm install @netlify/plugin-functions-schedule`
- Configuration in `netlify.toml` (not code)
- Netlify handles scheduling (no external cron service needed)

**Function Logs Access**:
- Netlify dashboard: Functions → photo-enforcement → Logs
- Real-time logs during development: `netlify dev` shows logs in terminal
- Production logs: Search by timestamp, filter by error level

**Future Enhancements**:
- Filter members by email/ID for targeted enforcement (admin override)
- Configurable schedule via environment variable (e.g., `ENFORCEMENT_CRON_SCHEDULE`)
- Batch processing with delays if enforcement scales >1000 members
- Webhook to external systems after enforcement run (e.g., notify Slack channel)
- Progress reporting (e.g., update status field in Airtable during run)

---

**Next Steps**: Implement `photo-enforcement.js` function, configure `netlify.toml` with scheduled function plugin, test dry-run mode locally, perform manual trigger test, verify scheduled execution on Netlify, integrate with STORY-18 for comprehensive end-to-end testing.
