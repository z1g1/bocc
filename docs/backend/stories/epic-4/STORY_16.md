# Story 16: Admin Notification System

**ID**: STORY-16
**Epic**: EPIC-4 (Profile Photo Enforcement)
**Status**: READY
**Story Points**: 3
**Complexity**: Medium
**Created**: 2026-02-05
**Dependencies**: STORY-13 (enforcement logic triggers notifications), STORY-14 (may reuse DM infrastructure)

---

## User Story

As a **community admin**, I want to **receive automated notifications when members receive final warnings, are deactivated, or when enforcement errors occur**, so that I can monitor the enforcement system and manually intervene when necessary.

## Context

The admin (circle@zackglick.com, Circle ID: 2d8e9215) needs visibility into high-stakes enforcement actions (final warnings, deactivations) and system errors. This story implements the notification system that sends structured alerts to the admin via in-app DM (preferred) or email (fallback). Notifications enable admin oversight without requiring constant manual monitoring of the enforcement system.

## Acceptance Criteria

### Functional Requirements
- [ ] Function `notifyAdmin(alertData)` sends notification to admin user
- [ ] Alert types supported: `FINAL_WARNING`, `DEACTIVATION`, `ERROR`
- [ ] Notification includes: action type, member name, member email, warning count, Circle profile link, timestamp, error details (if applicable)
- [ ] Admin user: circle@zackglick.com (Circle ID: 2d8e9215)
- [ ] Delivery method: In-app DM via Member API (reuse STORY-14 infrastructure) or email (fallback TBD)
- [ ] Message formatting uses template from MESSAGE_TEMPLATES_EPIC_4.md (section 5: Admin Alert)

### Non-Functional Requirements
- [ ] Admin notifications are non-blocking (failure to notify doesn't crash enforcement)
- [ ] Notification failures are logged with full error details
- [ ] Timeout set to 15 seconds per notification
- [ ] Alerts are batched per enforcement run (optional enhancement: single summary vs. individual alerts)

### Testing Requirements
- [ ] Unit test: Format alert message for each alert type (FINAL_WARNING, DEACTIVATION, ERROR)
- [ ] Unit test: Include all required fields in alert (member name, email, warning count, profile link, timestamp)
- [ ] Integration test: Send final warning alert to admin (circle@zackglick.com), verify received
- [ ] Integration test: Send deactivation alert to admin, verify received
- [ ] Integration test: Send error alert to admin with error details, verify received

## Technical Implementation Notes

### Approach

**Module**: Create new utility module `netlify/functions/utils/admin-notifications.js` or extend STORY-14's `circle-messaging.js`

**Delivery Method** (preferred):
- In-app DM to admin user (Circle ID: 2d8e9215)
- Reuse Member API infrastructure from STORY-14 (`sendDMMessage`, `findOrCreateDMChat`, `getHeadlessJWT`)
- Fallback: Email notifications if DM infrastructure unavailable or fails

**Alert Structure**:
```javascript
{
    action: 'FINAL_WARNING' | 'DEACTIVATION' | 'ERROR',
    member: {
        id: 'a594d38f',
        email: 'zglicka@gmail.com',
        name: 'Test Glick'
    },
    warningCount: 4,
    error: 'Optional error message if action=ERROR',
    timestamp: '2026-02-05T14:30:00.000Z'
}
```

### Function Implementation

```javascript
const { getHeadlessJWT, findOrCreateDMChat, sendDMMessage } = require('./circle-messaging');

const ADMIN_USER_ID = process.env.ADMIN_USER_ID || '2d8e9215'; // circle@zackglick.com
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'circle@zackglick.com';
const BOT_USER_ID = process.env.CIRCLE_BOT_USER_ID || '73e5a590';

/**
 * Send notification to admin about enforcement actions or errors
 * @param {object} alertData - Alert data {action, member, warningCount, error, timestamp}
 * @returns {Promise<object>} Result object {success, notificationSent, error}
 */
const notifyAdmin = async (alertData) => {
    try {
        console.log(`Sending admin notification: ${alertData.action} for ${alertData.member.email}`);

        // Format alert message
        const alertMessage = formatAdminAlert(alertData);

        // Send via in-app DM (preferred)
        try {
            await sendAdminDM(alertMessage);
            console.log('Successfully sent admin notification via DM');
            return { success: true, notificationSent: true, method: 'DM' };
        } catch (dmError) {
            console.error('Failed to send admin notification via DM:', dmError.message);

            // Fallback: Email notification (if configured)
            // For MVP, log error and consider notification failed
            // Future enhancement: Implement email fallback
            console.warn('Admin notification not delivered (DM failed, email fallback not implemented)');
            return { success: false, notificationSent: false, error: dmError.message };
        }
    } catch (error) {
        console.error('Error sending admin notification:', error.message);
        return { success: false, notificationSent: false, error: error.message };
    }
};

/**
 * Send admin notification via DM (reuses Member API infrastructure)
 * @param {string} message - Formatted alert message
 * @returns {Promise<void>}
 */
const sendAdminDM = async (message) => {
    // Generate JWT for bot user
    const jwt = await getHeadlessJWT(BOT_USER_ID);

    // Find or create DM chat room with admin
    const chatRoomUuid = await findOrCreateDMChat(BOT_USER_ID, ADMIN_USER_ID, jwt);

    // Send message
    await sendDMMessage(chatRoomUuid, message, jwt);
};

/**
 * Format admin alert message based on action type
 * @param {object} alertData - Alert data object
 * @returns {string} Formatted alert message
 */
const formatAdminAlert = (alertData) => {
    const timestamp = alertData.timestamp || new Date().toISOString();
    const profileLink = `https://www.716.social/u/${alertData.member.id}`;

    let actionDescription;
    let additionalContext = '';

    switch (alertData.action) {
        case 'FINAL_WARNING':
            actionDescription = 'FINAL WARNING';
            additionalContext = 'Member has until next Monday\'s enforcement run to add a photo.';
            break;

        case 'DEACTIVATION':
            actionDescription = 'DEACTIVATION';
            additionalContext = `Account deactivated via DELETE /community_members/${alertData.member.id}. Member can be re-invited manually.`;
            break;

        case 'ERROR':
            actionDescription = 'ERROR';
            additionalContext = `Error details: ${alertData.error || 'Unknown error'}`;
            break;

        default:
            actionDescription = alertData.action;
            additionalContext = 'Unknown action type';
    }

    // Format message using template from MESSAGE_TEMPLATES_EPIC_4.md
    const message = `[716.social Bot] Profile Photo Enforcement Alert

Action: ${actionDescription}
Member: ${alertData.member.name} (${alertData.member.email})
Warning Count: ${alertData.warningCount}
Circle Profile: ${profileLink}

${additionalContext}

---
Automated enforcement run: ${new Date(timestamp).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    dateStyle: 'medium',
    timeStyle: 'short'
})}`;

    return message;
};

module.exports = {
    notifyAdmin
};
```

### Integration Points

- **STORY-14**: Reuses Member API functions (`getHeadlessJWT`, `findOrCreateDMChat`, `sendDMMessage`)
- **STORY-13**: Enforcement logic calls `notifyAdmin()` for final warnings, deactivations, errors
- **Environment Variables**:
  - `ADMIN_USER_ID` - Admin Circle ID: `2d8e9215` (can hardcode or use env var)
  - `ADMIN_EMAIL` - Admin email: `circle@zackglick.com` (for fallback email, future)
  - `CIRCLE_BOT_USER_ID` - Bot user ID: `73e5a590` (existing from STORY-14)

### Technical Considerations

**Non-Blocking Pattern**:
- Admin notification failures are logged but don't crash enforcement
- Enforcement actions (warning increment, deactivation) proceed even if admin notification fails
- Rationale: Critical path is enforcement, admin notification is monitoring/oversight

**Notification Triggers**:
1. **FINAL_WARNING**: When warning count 3→4 (member's final warning before deactivation)
2. **DEACTIVATION**: When warning count 4→5 (member's account deactivated)
3. **ERROR**: When enforcement logic encounters unexpected errors (API failures, anomalies)

**Alert Batching** (optional enhancement for Phase 2):
- For large enforcement runs (>100 members), consider batching alerts into summary
- Summary format: "Enforcement Run Summary: 5 final warnings, 2 deactivations, 0 errors"
- Individual alerts still sent for errors (require immediate attention)

**Admin DM Chat Persistence**:
- Once bot-to-admin DM chat created, cached for remainder of enforcement run
- Subsequent alerts reuse same chat room (all alerts in one conversation thread)

**Message Formatting**:
- Use plain text (no TipTap formatting for MVP)
- Include all context needed for admin to take action (member link, warning count, timestamp)
- Eastern Time timezone for timestamp (716.social community is Buffalo, NY based)

**Error Scenarios**:
1. **Admin user not found (404)**: Log critical error, check `ADMIN_USER_ID` configuration
2. **DM send fails**: Log error, consider notification failed (no fallback for MVP)
3. **Rate limit (429)**: Unlikely with <20 alerts per enforcement run, log and retry

**Performance**:
- Expected per-alert: ~1.0 seconds (reuses cached JWT and chat room)
- For 10 alerts per enforcement run: ~10 seconds total (acceptable overhead)

**Timezone Handling**:
- Enforcement runs at 9 AM Monday UTC (4 AM EST / 5 AM EDT)
- Format timestamps in Eastern Time for admin readability

### Existing Patterns to Follow

- **Non-blocking errors**: Like STORY-13 enforcement logic, notification failures don't crash system
- **Comprehensive logging**: Log notification attempts, successes, and failures with full context
- **Reuse infrastructure**: Leverage STORY-14's Member API functions (avoid duplication)

### Security Considerations

- **Admin PII**: Admin email and Circle ID are not sensitive (admin is known/public)
- **Member PII in Logs**: Alert messages include member email - logs should be access-controlled
- **Alert Content**: Include enough context for admin action, but avoid excessive member data exposure

## Dependencies

### Blocks
- None (admin notifications are optional oversight, not blocking enforcement)

### Blocked By
- **STORY-14**: Depends on Member API DM infrastructure (or implement email fallback)

### Related
- **STORY-13**: Enforcement logic triggers admin notifications
- **STORY-17**: Scheduled function orchestrates enforcement and notifications

## Out of Scope

- Email fallback notifications (MVP uses DM only, log failures)
- SMS notifications (not needed)
- Slack/Discord webhook integrations (not needed)
- Admin dashboard UI for viewing alerts (Airtable views provide sufficient visibility)
- Alert acknowledgment/read tracking (Circle.so may not support)
- Alert escalation (e.g., re-notify if admin doesn't respond in 24 hours)
- Batch summary alerts (send individual alerts for MVP)

## Testing Approach

### Unit Tests (`tests/admin-notifications.test.js`)

```javascript
describe('formatAdminAlert', () => {
    it('should format FINAL_WARNING alert with all required fields', () => {
        const alertData = {
            action: 'FINAL_WARNING',
            member: { id: 'a594d38f', email: 'test@example.com', name: 'Test User' },
            warningCount: 4,
            timestamp: '2026-02-05T14:00:00.000Z'
        };

        const message = formatAdminAlert(alertData);

        expect(message).toContain('FINAL WARNING');
        expect(message).toContain('Test User');
        expect(message).toContain('test@example.com');
        expect(message).toContain('Warning Count: 4');
        expect(message).toContain('https://www.716.social/u/a594d38f');
    });

    it('should format DEACTIVATION alert', () => {
        // Test deactivation alert formatting
    });

    it('should format ERROR alert with error details', () => {
        const alertData = {
            action: 'ERROR',
            member: { id: 'a594d38f', email: 'test@example.com', name: 'Test User' },
            warningCount: 3,
            error: 'Circle API returned 500 Internal Server Error'
        };

        const message = formatAdminAlert(alertData);

        expect(message).toContain('ERROR');
        expect(message).toContain('Circle API returned 500');
    });
});

describe('notifyAdmin', () => {
    it('should send admin notification via DM', async () => {
        // Mock Member API functions
        // Verify DM sent to admin user
    });

    it('should handle DM send failures gracefully', async () => {
        // Mock DM send failure
        // Verify returns success:false but doesn't throw error
    });
});
```

### Integration Test

**Prerequisites**:
- Admin user (circle@zackglick.com, ID: 2d8e9215) exists in Circle.so
- Bot user (716.social Bot, ID: 73e5a590) configured with Member API access
- `CIRCLE_HEADLESS_API` configured in Netlify env vars

**Test Script** (manual):
```bash
# Test final warning alert
curl -X POST http://localhost:8888/.netlify/functions/test-admin-notification \
  -H "Content-Type: application/json" \
  -d '{
    "action": "FINAL_WARNING",
    "member": {
      "id": "a594d38f",
      "email": "zglicka@gmail.com",
      "name": "Test Glick"
    },
    "warningCount": 4
  }'

# Test deactivation alert
curl -X POST http://localhost:8888/.netlify/functions/test-admin-notification \
  -H "Content-Type: application/json" \
  -d '{
    "action": "DEACTIVATION",
    "member": {
      "id": "a594d38f",
      "email": "zglicka@gmail.com",
      "name": "Test Glick"
    },
    "warningCount": 5
  }'

# Test error alert
curl -X POST http://localhost:8888/.netlify/functions/test-admin-notification \
  -H "Content-Type: application/json" \
  -d '{
    "action": "ERROR",
    "member": {
      "id": "a594d38f",
      "email": "zglicka@gmail.com",
      "name": "Test Glick"
    },
    "warningCount": 3,
    "error": "Failed to send DM: Circle API returned 403 Forbidden"
  }'

# Verify in Circle.so UI:
# 1. Log in as circle@zackglick.com
# 2. Check Messages/DMs from 716.social Bot
# 3. Verify alert received with correct formatting
# 4. Verify all fields present (action, member, warning count, profile link, timestamp)
```

**Expected Result**:
- Admin receives DM from 716.social Bot
- Alert includes all required fields
- Formatting is readable and actionable
- Profile link is clickable

## Notes

**Admin User Configuration**:
- Admin Circle ID: 2d8e9215
- Admin email: circle@zackglick.com
- Hardcoded in code (or env var if flexible admin assignment needed)

**Alert Volume**:
- Expected alerts per enforcement run: 5-10 (assuming ~200 active members, ~5% at final warning/deactivation)
- Low volume allows individual alerts (no batching needed for MVP)

**Email Fallback** (future enhancement):
- If DM infrastructure fails, implement SendGrid/similar integration
- Alert format can remain same (plain text)
- Subject line: "[716.social] Photo Enforcement Alert: {action} for {member}"

**Alert History**:
- All alerts delivered via DM chat (persistent in Circle.so)
- Admin can review alert history in chat thread
- Airtable warning records provide audit trail

**Future Enhancements**:
- Batch summary alerts for large enforcement runs (>50 members processed)
- Configurable admin notification preferences (e.g., only errors, not final warnings)
- Multiple admin recipients (e.g., notify all admins, not just one)
- Alert severity levels (critical, warning, info) with different delivery methods

---

**Next Steps**: Implement `notifyAdmin()` and `formatAdminAlert()` in `admin-notifications.js`, integrate with STORY-14's Member API functions, test with all three alert types to admin user, verify admin receives and can act on alerts.
