# STORY-16 Tasks: Admin Notification System

**Story**: [[STORY-16]] - Admin Notification System
**Epic**: [[EPIC-4]] - Profile Photo Enforcement System
**Total Tasks**: 5
**Estimated Time**: 8-9 hours

---

## TASK-93: Write Tests for Admin Alert Formatting

**Type**: Test | **Estimated Time**: 1.5 hours | **Status**: Ready

### Test File
`/Users/zack/projects/bocc-backend/tests/unit/admin-notifications.test.js`

### Test Specifications
```javascript
describe('formatAdminAlert', () => {
  it('should format FINAL_WARNING alert with all required fields');
  it('should format DEACTIVATION alert with account details');
  it('should format ERROR alert with error details');
  it('should include member name, email, warning count');
  it('should include Circle profile link');
  it('should format timestamp in Eastern Time');
  it('should include contextual additional info per action type');
});
```

**DoD**: 7 tests for alert formatting, template validation

---

## TASK-94: Implement Admin Alert Formatting Logic

**Type**: Implementation | **Estimated Time**: 1.5 hours | **Status**: Ready
**Dependencies**: TASK-93 | **Sequential After**: TASK-93

### Implementation File
`/Users/zack/projects/bocc-backend/netlify/functions/utils/admin-notifications.js`

### Function
```javascript
const formatAdminAlert = (alertData) => {
  const timestamp = alertData.timestamp || new Date().toISOString();
  const profileLink = `https://www.716.social/u/${alertData.member.id}`;

  let actionDescription, additionalContext;
  switch (alertData.action) {
    case 'FINAL_WARNING':
      actionDescription = 'FINAL WARNING';
      additionalContext = 'Member has until next Monday...';
      break;
    case 'DEACTIVATION':
      actionDescription = 'DEACTIVATION';
      additionalContext = `Account deactivated via DELETE...`;
      break;
    case 'ERROR':
      actionDescription = 'ERROR';
      additionalContext = `Error details: ${alertData.error}`;
      break;
  }

  return `[716.social Bot] Profile Photo Enforcement Alert

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
};
```

**DoD**: Tests pass, all alert types formatted correctly

---

## TASK-95: Write Tests for Admin Notification Delivery

**Type**: Test | **Estimated Time**: 1.5 hours | **Status**: Ready
**Dependencies**: TASK-94 | **Sequential After**: TASK-94

### Test Specifications
```javascript
describe('notifyAdmin', () => {
  it('should send admin notification via DM (reuse STORY-14 infrastructure)');
  it('should handle DM send failures gracefully (non-blocking)');
  it('should return success/failure indicator');
  it('should log notification attempts and results');
});
```

**DoD**: 4 tests for notification delivery, STORY-14 integration mocked

---

## TASK-96: Implement notifyAdmin Function

**Type**: Implementation | **Estimated Time**: 2 hours | **Status**: Ready
**Dependencies**: TASK-95 | **Sequential After**: TASK-95

### Implementation
```javascript
const { getHeadlessJWT, findOrCreateDMChat, sendDMMessage } = require('./circle-messaging');

const ADMIN_USER_ID = process.env.ADMIN_USER_ID || '2d8e9215';
const BOT_USER_ID = process.env.CIRCLE_BOT_USER_ID || '73e5a590';

const notifyAdmin = async (alertData) => {
  try {
    console.log(`Sending admin notification: ${alertData.action}`);

    const alertMessage = formatAdminAlert(alertData);

    try {
      await sendAdminDM(alertMessage);
      return { success: true, notificationSent: true, method: 'DM' };
    } catch (dmError) {
      console.error('Failed to send admin notification via DM:', dmError.message);
      return { success: false, notificationSent: false, error: dmError.message };
    }
  } catch (error) {
    console.error('Error sending admin notification:', error.message);
    return { success: false, notificationSent: false, error: error.message };
  }
};

const sendAdminDM = async (message) => {
  const jwt = await getHeadlessJWT(BOT_USER_ID);
  const chatRoomUuid = await findOrCreateDMChat(BOT_USER_ID, ADMIN_USER_ID, jwt);
  await sendDMMessage(chatRoomUuid, message, jwt);
};
```

**DoD**: Tests pass (Green phase), DM reuse from STORY-14, non-blocking errors

---

## TASK-97: Integration Test with Admin User

**Type**: Integration Test | **Estimated Time**: 1.5 hours | **Status**: Ready
**Dependencies**: TASK-96 | **Sequential After**: TASK-96

### Test Prerequisites
- Admin user (circle@zackglick.com, ID: 2d8e9215) exists
- CIRCLE_HEADLESS_API configured
- Bot user configured

### Test Script
```javascript
describe('Admin Notification Integration', () => {
  it('should send FINAL_WARNING alert to admin', async () => {
    const alertData = {
      action: 'FINAL_WARNING',
      member: { id: 'a594d38f', email: 'test@example.com', name: 'Test User' },
      warningCount: 4
    };
    const result = await notifyAdmin(alertData);
    expect(result.success).toBe(true);
    // Manual verification: Check DMs as circle@zackglick.com
  });

  it('should send DEACTIVATION alert to admin', async () => { /* Similar */ });
  it('should send ERROR alert to admin', async () => { /* Similar */ });
});
```

**DoD**: Integration tests pass, manual DM verification successful

---

## Summary

**Total Tasks**: 5
**Red-Green-Refactor**: 2 cycles (format → impl, notify → impl)
**Critical Path**: TASK-93 → TASK-94 → TASK-95 → TASK-96 → TASK-97

**Testing**: 11+ unit tests, 3 integration tests

**Dependencies**: Reuses STORY-14 DM infrastructure
