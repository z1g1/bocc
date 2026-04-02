# STORY-14 Tasks: Bot User DM Integration via Member API

**Story**: [[STORY-14]] - Bot User DM Integration via Member API
**Epic**: [[EPIC-4]] - Profile Photo Enforcement System
**Total Tasks**: 8
**Estimated Time**: 14-16 hours

---

## Task Overview

Implement Circle.so Member API (Headless) integration for sending in-app direct messages from 716.social Bot to members.

---

## TASK-80: Write Tests for JWT Authentication

**Type**: Test | **Estimated Time**: 1 hour | **Status**: Ready

### Test File
`/Users/zack/projects/bocc-backend/tests/unit/circle-messaging.test.js`

### Test Specifications
```javascript
describe('getHeadlessJWT', () => {
  it('should generate JWT token via Headless Auth API');
  it('should cache JWT token for subsequent calls within 23 hours');
  it('should regenerate JWT after cache expiration');
  it('should propagate auth errors (401) with response details');
});
```

**DoD**: 4 tests written and failing

---

## TASK-81: Implement JWT Token Generation and Caching

**Type**: Implementation | **Estimated Time**: 2 hours | **Status**: Ready
**Dependencies**: TASK-80 | **Sequential After**: TASK-80

### Implementation File
`/Users/zack/projects/bocc-backend/netlify/functions/utils/circle-messaging.js`

### Function
```javascript
const getHeadlessJWT = async (userId = BOT_USER_ID) => {
  // Check cache (23-hour TTL)
  // POST to /api/auth/headless with user_id
  // Return JWT and cache with expiration
};
```

**DoD**: Tests pass, JWT cached properly, comprehensive logging

---

## TASK-82: Write Tests for Chat Room Management

**Type**: Test | **Estimated Time**: 1.5 hours | **Status**: Ready
**Dependencies**: TASK-81 | **Sequential After**: TASK-81

### Test Specifications
```javascript
describe('findOrCreateDMChat', () => {
  it('should find existing DM chat room by participants');
  it('should create new DM chat if not found');
  it('should cache chat room UUID for reuse');
  it('should filter for is_direct_message: true');
  it('should handle Member API errors');
});
```

**DoD**: 5 tests written, mocking axios for Member API

---

## TASK-83: Implement Chat Room Find/Create Logic

**Type**: Implementation | **Estimated Time**: 2.5 hours | **Status**: Ready
**Dependencies**: TASK-82 | **Sequential After**: TASK-82

### Implementation
```javascript
const findOrCreateDMChat = async (botUserId, recipientUserId, jwt) => {
  // Check cache
  // GET /api/headless/v1/me/chat_rooms
  // Find DM with recipient in participants
  // If not found, POST /api/headless/v1/chat_rooms
  // Cache chat room UUID
};
```

**DoD**: Tests pass, caching works, handles existing/new chats

---

## TASK-84: Write Tests for Message Sending

**Type**: Test | **Estimated Time**: 1 hour | **Status**: Ready
**Dependencies**: TASK-83 | **Sequential After**: TASK-83

### Test Specifications
```javascript
describe('sendDMMessage', () => {
  it('should send message in TipTap JSON format');
  it('should convert plain text to TipTap structure');
  it('should propagate Member API errors (404, 403)');
  it('should include proper authorization header with JWT');
});
```

**DoD**: 4 tests for message sending with TipTap validation

---

## TASK-85: Implement Message Sending with TipTap Formatting

**Type**: Implementation | **Estimated Time**: 2 hours | **Status**: Ready
**Dependencies**: TASK-84 | **Sequential After**: TASK-84

### Implementation
```javascript
const sendDMMessage = async (chatRoomUuid, message, jwt) => {
  const tiptapMessage = {
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: [{ type: 'text', text: message }]
    }]
  };

  // POST /api/headless/v1/messages/{chatRoomUuid}/chat_room_messages
};
```

**DoD**: Tests pass, TipTap format correct, errors propagated

---

## TASK-86: Write Tests for High-Level DM Functions

**Type**: Test | **Estimated Time**: 1.5 hours | **Status**: Ready
**Dependencies**: TASK-85 | **Sequential After**: TASK-85

### Test Specifications
```javascript
describe('sendWarningDM', () => {
  it('should send standard warning for level 1-3');
  it('should send final warning for level 4');
  it('should send deactivation notice for level 5');
  it('should use correct message template based on level');
});

describe('sendThankYouDM', () => {
  it('should send thank you message with member name');
});
```

**DoD**: 5 tests for high-level functions, template selection logic tested

---

## TASK-87: Implement High-Level DM Functions and Message Templates

**Type**: Implementation | **Estimated Time**: 2.5 hours | **Status**: Ready
**Dependencies**: TASK-86 | **Sequential After**: TASK-86

### Implementation
```javascript
const sendWarningDM = async (member, warningLevel, isFinalWarning = false) => {
  const jwt = await getHeadlessJWT(BOT_USER_ID);
  const chatRoomUuid = await findOrCreateDMChat(BOT_USER_ID, member.id, jwt);

  let messageText;
  if (warningLevel === 5) {
    messageText = getDeactivationNoticeMessage(member.name);
  } else if (isFinalWarning || warningLevel === 4) {
    messageText = getFinalWarningMessage(member.name);
  } else {
    messageText = getStandardWarningMessage(member.name, warningLevel);
  }

  return await sendDMMessage(chatRoomUuid, messageText, jwt);
};

const sendThankYouDM = async (member) => { /* Similar pattern */ };

// Message template functions (placeholders for MVP)
const getStandardWarningMessage = (name, warningNum) => { /* Template */ };
const getFinalWarningMessage = (name) => { /* Template */ };
const getDeactivationNoticeMessage = (name) => { /* Template */ };
const getThankYouMessage = (name) => { /* Template */ };
```

**DoD**: All tests pass (Green phase), templates return placeholder messages

---

## TASK-88: Integration Test with Test Glick User

**Type**: Integration Test | **Estimated Time**: 1.5 hours | **Status**: Ready
**Dependencies**: TASK-87 | **Sequential After**: TASK-87

### Test Prerequisites
- CIRCLE_HEADLESS_API configured
- Test Glick user exists (ID: a594d38f)
- Bot user configured (ID: 73e5a590)

### Test Script
```javascript
describe('DM Delivery Integration Test', () => {
  it('should send standard warning DM to Test Glick', async () => {
    const member = {
      id: 'a594d38f',
      email: 'zglicka@gmail.com',
      name: 'Test Glick'
    };

    await sendWarningDM(member, 1, false);

    // Manual verification: Check Circle.so DMs as Test Glick
    // Automated: Verify no errors thrown
  });

  it('should send thank you DM to Test Glick', async () => { /* Similar */ });
});
```

**DoD**: Integration tests pass, manual DM verification successful

---

## Summary

**Total Tasks**: 8
**Red-Green-Refactor**: 4 cycles (JWT, Chat, Message, High-level)
**Critical Path**: TASK-80 → TASK-81 → TASK-82 → TASK-83 → TASK-84 → TASK-85 → TASK-86 → TASK-87 → TASK-88

**Testing**: 18+ unit tests, 2+ integration tests

**Manual Verification Required**:
- Check Circle.so UI as Test Glick to verify DM received
- Verify message formatting looks correct
