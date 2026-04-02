# Story 14: Bot User DM Integration via Member API

**ID**: STORY-14
**Epic**: EPIC-4 (Profile Photo Enforcement)
**Status**: READY
**Story Points**: 5
**Complexity**: High
**Created**: 2026-02-05
**Dependencies**: STORY-13 (needs action execution to call DM functions)

---

## User Story

As a **developer**, I want to **send in-app direct messages from the 716.social Bot user via Circle.so's Member API (Headless)**, so that members receive profile photo warnings and thank-you messages directly within the Circle community platform.

## Context

Circle.so's Admin API v2 does **not** support sending direct messages. DM functionality requires the Member API (Headless), which uses a different authentication mechanism (JWT tokens via Headless Auth) and different API endpoints. This story implements the complete DM integration: JWT authentication, finding/creating DM chat rooms, and sending messages with proper formatting. This is the most technically complex story in Epic 4 due to the API differences and multi-step DM sending process.

**User Decision**: User has chosen **Option A** (Full Member API integration) for in-app DMs. Environment variable `CIRCLE_HEADLESS_API` has been created with the Headless Auth token.

## Acceptance Criteria

### Functional Requirements
- [ ] Module `netlify/functions/utils/circle-messaging.js` exports DM functions
- [ ] Function `getHeadlessJWT(userId)` generates JWT token for bot user from Headless Auth API
- [ ] Function `findOrCreateDMChat(botUserId, recipientUserId, jwt)` finds existing DM chat room or creates new one
- [ ] Function `sendDMMessage(chatRoomUuid, message, jwt)` sends message to chat room
- [ ] High-level function `sendWarningDM(member, warningLevel, isFinalWarning)` sends appropriate warning message
- [ ] High-level function `sendThankYouDM(member)` sends thank-you message when photo added
- [ ] High-level function `sendDeactivationNoticeDM(member)` sends deactivation notice
- [ ] All messages use message templates from `/Users/zack/projects/bocc-backend/docs/MESSAGE_TEMPLATES_EPIC_4.md` (placeholders for now)
- [ ] Bot user ID: `73e5a590` (716.social Bot)

### Non-Functional Requirements
- [ ] JWT tokens cached per enforcement run (don't regenerate for every DM)
- [ ] Chat room UUIDs cached after first lookup (avoid redundant queries)
- [ ] Messages formatted in Circle's TipTap JSON format (support bold, links)
- [ ] Timeout set to 15 seconds per DM operation
- [ ] Comprehensive error logging includes Circle API response details

### Testing Requirements
- [ ] Unit test: JWT generation with Headless Auth API
- [ ] Unit test: Find existing DM chat room by participants
- [ ] Unit test: Create new DM chat room if not found
- [ ] Unit test: Send message to chat room with TipTap formatting
- [ ] Unit test: Warning message selection based on warning level (1-3, 4, 5)
- [ ] Integration test: Send warning DM to Test Glick user, verify received in Circle UI
- [ ] Integration test: Send thank-you DM to Test Glick user, verify received

## Technical Implementation Notes

### Approach

**New Module**: `netlify/functions/utils/circle-messaging.js` (separate from `circle.js` due to different API/auth)

**Three-Layer Architecture**:
1. **Authentication Layer**: Generate JWT tokens via Headless Auth API
2. **Chat Management Layer**: Find or create DM chat rooms
3. **Messaging Layer**: Send formatted messages to chat rooms

**API Differences**:
- **Admin API v2**: `https://app.circle.so/api/admin/v2` with Bearer token (existing)
- **Member API (Headless)**: `https://app.circle.so/api/headless/v1` with JWT token (new)
- **Headless Auth**: `https://app.circle.so/api/auth/headless` for JWT generation (new)

### Environment Variables

**New**:
- `CIRCLE_HEADLESS_API` - Headless Auth API key for generating JWTs
- `CIRCLE_BOT_USER_ID` - Bot user ID: `73e5a590` (can hardcode or use env var)

**Existing** (used for reference):
- `CIRCLE_API_TOKEN` - Admin API token (not used in this story, but available)

### Function Implementations

#### 1. JWT Generation

```javascript
const axios = require('axios');

const HEADLESS_AUTH_URL = 'https://app.circle.so/api/auth/headless';
const HEADLESS_API_KEY = process.env.CIRCLE_HEADLESS_API;
const BOT_USER_ID = process.env.CIRCLE_BOT_USER_ID || '73e5a590';

// Cache JWT tokens per enforcement run (valid for ~24 hours typically)
let jwtCache = {
    token: null,
    expiresAt: null
};

/**
 * Generate JWT token for bot user via Headless Auth API
 * @param {string} userId - Circle user ID (defaults to bot user)
 * @returns {Promise<string>} JWT token
 */
const getHeadlessJWT = async (userId = BOT_USER_ID) => {
    try {
        // Check cache first
        if (jwtCache.token && jwtCache.expiresAt && Date.now() < jwtCache.expiresAt) {
            console.log('Using cached JWT token');
            return jwtCache.token;
        }

        console.log('Generating new JWT token for user:', userId);

        const response = await axios.post(
            HEADLESS_AUTH_URL,
            {
                user_id: userId
            },
            {
                headers: {
                    'Authorization': `Bearer ${HEADLESS_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 15000
            }
        );

        const jwt = response.data.jwt;
        console.log('Successfully generated JWT token');

        // Cache token (assume valid for 23 hours to be safe)
        jwtCache.token = jwt;
        jwtCache.expiresAt = Date.now() + (23 * 60 * 60 * 1000);

        return jwt;
    } catch (error) {
        console.error('Error generating JWT token:', error.message);
        if (error.response) {
            console.error('Headless Auth API response status:', error.response.status);
            console.error('Headless Auth API response data:', JSON.stringify(error.response.data));
        }
        throw error;
    }
};
```

#### 2. Find or Create DM Chat Room

```javascript
const MEMBER_API_BASE_URL = 'https://app.circle.so/api/headless/v1';

// Cache chat room UUIDs per enforcement run
const chatRoomCache = new Map();

/**
 * Find existing DM chat room between bot and recipient, or create new one
 * @param {string} botUserId - Bot user ID
 * @param {string} recipientUserId - Recipient Circle user ID
 * @param {string} jwt - JWT token for authentication
 * @returns {Promise<string>} Chat room UUID
 */
const findOrCreateDMChat = async (botUserId, recipientUserId, jwt) => {
    try {
        // Check cache first
        const cacheKey = `${botUserId}:${recipientUserId}`;
        if (chatRoomCache.has(cacheKey)) {
            console.log('Using cached chat room UUID for:', recipientUserId);
            return chatRoomCache.get(cacheKey);
        }

        console.log('Finding or creating DM chat room with:', recipientUserId);

        // Query for existing DM chat rooms
        // Member API endpoint: GET /me/chat_rooms (returns all chat rooms for authenticated user)
        const listResponse = await axios.get(
            `${MEMBER_API_BASE_URL}/me/chat_rooms`,
            {
                headers: {
                    'Authorization': `Bearer ${jwt}`,
                    'Content-Type': 'application/json'
                },
                timeout: 15000
            }
        );

        // Filter for DM chat room with recipient (chat rooms have participants array)
        const existingChat = listResponse.data.records.find(chat => {
            return chat.is_direct_message &&
                   chat.participants &&
                   chat.participants.some(p => p.id === recipientUserId);
        });

        if (existingChat) {
            console.log('Found existing DM chat room:', existingChat.uuid);
            chatRoomCache.set(cacheKey, existingChat.uuid);
            return existingChat.uuid;
        }

        // No existing chat found, create new DM chat room
        console.log('Creating new DM chat room with:', recipientUserId);

        const createResponse = await axios.post(
            `${MEMBER_API_BASE_URL}/chat_rooms`,
            {
                participant_ids: [recipientUserId],
                is_direct_message: true
            },
            {
                headers: {
                    'Authorization': `Bearer ${jwt}`,
                    'Content-Type': 'application/json'
                },
                timeout: 15000
            }
        );

        const chatRoomUuid = createResponse.data.uuid;
        console.log('Created new DM chat room:', chatRoomUuid);

        chatRoomCache.set(cacheKey, chatRoomUuid);
        return chatRoomUuid;
    } catch (error) {
        console.error('Error finding/creating DM chat room:', error.message);
        if (error.response) {
            console.error('Member API response status:', error.response.status);
            console.error('Member API response data:', JSON.stringify(error.response.data));
        }
        throw error;
    }
};
```

#### 3. Send DM Message

```javascript
/**
 * Send message to chat room via Member API
 * @param {string} chatRoomUuid - Chat room UUID
 * @param {string} message - Message text (plain text, will be converted to TipTap)
 * @param {string} jwt - JWT token for authentication
 * @returns {Promise<object>} Sent message object
 */
const sendDMMessage = async (chatRoomUuid, message, jwt) => {
    try {
        console.log('Sending DM message to chat room:', chatRoomUuid);

        // Convert plain text message to TipTap JSON format
        const tiptapMessage = {
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [
                        {
                            type: 'text',
                            text: message
                        }
                    ]
                }
            ]
        };

        const response = await axios.post(
            `${MEMBER_API_BASE_URL}/messages/${chatRoomUuid}/chat_room_messages`,
            {
                body: tiptapMessage
            },
            {
                headers: {
                    'Authorization': `Bearer ${jwt}`,
                    'Content-Type': 'application/json'
                },
                timeout: 15000
            }
        );

        console.log('Successfully sent DM message:', response.data.id);
        return response.data;
    } catch (error) {
        console.error('Error sending DM message:', error.message);
        if (error.response) {
            console.error('Member API response status:', error.response.status);
            console.error('Member API response data:', JSON.stringify(error.response.data));
        }
        throw error;
    }
};
```

#### 4. High-Level Warning DM Function

```javascript
/**
 * Send warning DM to member based on warning level
 * @param {object} member - Circle member object {id, email, name}
 * @param {number} warningLevel - Warning level (1-5)
 * @param {boolean} isFinalWarning - True if this is warning 4 or deactivation notice
 * @returns {Promise<object>} Sent message object
 */
const sendWarningDM = async (member, warningLevel, isFinalWarning = false) => {
    try {
        console.log(`Sending warning DM to ${member.email} (level ${warningLevel})`);

        // Generate JWT for bot user
        const jwt = await getHeadlessJWT(BOT_USER_ID);

        // Find or create DM chat room
        const chatRoomUuid = await findOrCreateDMChat(BOT_USER_ID, member.id, jwt);

        // Select appropriate message template
        let messageText;
        if (warningLevel === 5) {
            // Deactivation notice
            messageText = getDeactivationNoticeMessage(member.name);
        } else if (isFinalWarning || warningLevel === 4) {
            // Final warning (warning 4)
            messageText = getFinalWarningMessage(member.name);
        } else {
            // Standard warning (1-3)
            const warningsRemaining = 4 - warningLevel;
            messageText = getStandardWarningMessage(member.name, warningLevel, warningsRemaining);
        }

        // Send message
        const sentMessage = await sendDMMessage(chatRoomUuid, messageText, jwt);

        console.log(`Successfully sent warning DM to ${member.email}`);
        return sentMessage;
    } catch (error) {
        console.error(`Failed to send warning DM to ${member.email}:`, error.message);
        throw error;
    }
};

/**
 * Send thank-you DM when member adds profile photo
 * @param {object} member - Circle member object {id, email, name}
 * @returns {Promise<object>} Sent message object
 */
const sendThankYouDM = async (member) => {
    try {
        console.log(`Sending thank-you DM to ${member.email}`);

        const jwt = await getHeadlessJWT(BOT_USER_ID);
        const chatRoomUuid = await findOrCreateDMChat(BOT_USER_ID, member.id, jwt);

        const messageText = getThankYouMessage(member.name);
        const sentMessage = await sendDMMessage(chatRoomUuid, messageText, jwt);

        console.log(`Successfully sent thank-you DM to ${member.email}`);
        return sentMessage;
    } catch (error) {
        console.error(`Failed to send thank-you DM to ${member.email}:`, error.message);
        throw error;
    }
};
```

#### 5. Message Template Functions (Placeholders)

```javascript
/**
 * Message template functions
 * TODO: Replace placeholders with final copy from user
 * See: /docs/MESSAGE_TEMPLATES_EPIC_4.md
 */

const getStandardWarningMessage = (name, warningNum, remaining) => {
    return `[PLACEHOLDER - Standard Warning]

Hi ${name},

We noticed you haven't added a profile photo to your 716.social account yet.

This is reminder #${warningNum} out of 4 before we need to temporarily deactivate accounts without photos. You have ${remaining} more reminders before a final warning.

Please add a profile photo to keep your account active.

— The 716.social Team`;
};

const getFinalWarningMessage = (name) => {
    const nextMonday = getNextMonday();
    return `[PLACEHOLDER - Final Warning]

Hi ${name},

FINAL WARNING: This is your 4th and final reminder to add a profile photo.

If a profile photo is not added by ${nextMonday}, your account will be temporarily deactivated.

Please add a profile photo now to avoid deactivation.

— The 716.social Team`;
};

const getDeactivationNoticeMessage = (name) => {
    return `[PLACEHOLDER - Deactivation Notice]

Hi ${name},

Your 716.social account is being deactivated because a profile photo was not added after multiple reminders.

To rejoin, contact circle@zackglick.com with a profile photo ready.

— The 716.social Team`;
};

const getThankYouMessage = (name) => {
    return `[PLACEHOLDER - Thank You]

Hi ${name},

Thanks for adding your profile photo!

Your photo helps make 716.social a more welcoming community.

— The 716.social Team`;
};

const getNextMonday = () => {
    const today = new Date();
    const daysUntilMonday = (8 - today.getDay()) % 7;
    const nextMonday = new Date(today);
    nextMonday.setDate(today.getDate() + daysUntilMonday);
    return nextMonday.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
};

module.exports = {
    getHeadlessJWT,
    findOrCreateDMChat,
    sendDMMessage,
    sendWarningDM,
    sendThankYouDM
};
```

### Integration Points

- **STORY-13**: Enforcement logic calls `sendWarningDM()` and `sendThankYouDM()`
- **Environment Variables**: `CIRCLE_HEADLESS_API`, `CIRCLE_BOT_USER_ID`
- **Message Templates**: Final copy will replace placeholders (user to provide)

### Technical Considerations

**JWT Token Caching**:
- JWTs typically valid for 24 hours
- Cache per enforcement run (function execution) to avoid regenerating for every DM
- Cache invalidates after 23 hours to be safe

**Chat Room Caching**:
- Once chat room found/created, cache UUID for remainder of enforcement run
- Avoids redundant lookups when sending multiple messages to same member

**TipTap JSON Format**:
- Circle.so uses TipTap rich text editor format
- Basic structure: `{type: 'doc', content: [{type: 'paragraph', content: [{type: 'text', text: '...'}]}]}`
- For MVP, plain text is sufficient
- Future enhancement: Support bold, links, emojis

**Error Scenarios**:
1. **Headless API key invalid (401)**: Propagate error, indicates `CIRCLE_HEADLESS_API` misconfigured
2. **Bot user not found (404)**: Check `CIRCLE_BOT_USER_ID` is correct
3. **Recipient user not found (404)**: Log warning, skip DM (user may have been deleted)
4. **Rate limit (429)**: Implement exponential backoff or batch DMs
5. **Timeout**: 15s timeout per operation, propagate if exceeded

**Performance**:
- JWT generation: ~500ms (once per enforcement run)
- Chat room lookup/creation: ~700ms per unique recipient
- Message send: ~500ms per message
- Total per member (first time): ~1.7 seconds
- Total per member (cached chat): ~1.0 seconds

**Non-Blocking Pattern**:
- DM failures in STORY-13 are non-blocking (logged but don't fail enforcement)
- Airtable state updated regardless of DM success (warning count tracks enforcement, not DM delivery)

### Existing Patterns to Follow

- **Axios Configuration**: Similar to Admin API client in `circle.js`
- **Error Logging**: Include full response status and data like Epic 2/3
- **Timeouts**: Set explicit timeouts (15s for Member API operations)
- **Caching**: Cache expensive operations (JWTs, chat rooms) for performance

### Security Considerations

- **API Key Security**: `CIRCLE_HEADLESS_API` must be stored in Netlify env vars, never committed
- **JWT Exposure**: JWTs are short-lived, but cache should be function-scoped (not global/persistent)
- **PII in Logs**: Never log message content or full recipient lists
- **Bot User Permissions**: Bot user should have minimum required permissions in Circle.so

## Dependencies

### Blocks
- **STORY-13**: Enforcement logic depends on DM functions to execute actions

### Blocked By
- None (can be developed in parallel with other stories, integration in STORY-17)

### Related
- **STORY-16**: Admin notifications may also use Member API (or fallback to email)

## Out of Scope

- Advanced TipTap formatting (bold, links, emojis) - plain text is sufficient for MVP
- Message personalization beyond name (e.g., member's check-in count) - not needed
- Message delivery confirmation/read receipts - Circle API may not support
- Batch DM sending API (if available) - sequential sending is acceptable
- Fallback to email if DM fails - non-blocking is sufficient for MVP

## Testing Approach

### Unit Tests (`tests/circle-messaging.test.js`)

```javascript
jest.mock('axios');

describe('getHeadlessJWT', () => {
    it('should generate JWT token via Headless Auth API', async () => {
        // Mock successful JWT generation
        // Verify returns JWT string
    });

    it('should cache JWT token for subsequent calls', async () => {
        // Generate JWT twice
        // Verify Headless Auth API called only once
    });

    it('should propagate auth errors', async () => {
        // Mock 401 error from Headless Auth API
        // Verify error thrown with response details
    });
});

describe('findOrCreateDMChat', () => {
    it('should find existing DM chat room', async () => {
        // Mock chat rooms list with existing DM
        // Verify returns existing chat room UUID
    });

    it('should create new DM chat room if not found', async () => {
        // Mock empty chat rooms list
        // Mock successful chat room creation
        // Verify creates DM and returns UUID
    });

    it('should cache chat room UUID', async () => {
        // Find/create chat twice for same recipient
        // Verify Member API called only once
    });
});

describe('sendDMMessage', () => {
    it('should send message in TipTap format', async () => {
        // Mock successful message send
        // Verify body contains TipTap JSON structure
    });

    it('should propagate Member API errors', async () => {
        // Mock 404 error (chat room not found)
        // Verify error thrown with response details
    });
});

describe('sendWarningDM', () => {
    it('should send standard warning for level 1-3', async () => {
        // Mock JWT, chat room, message send
        // Verify standard warning message sent
    });

    it('should send final warning for level 4', async () => {
        // Verify final warning message sent
    });

    it('should send deactivation notice for level 5', async () => {
        // Verify deactivation notice sent
    });
});
```

### Integration Test

**Prerequisites**:
- Test Glick user (zglicka@gmail.com, ID: a594d38f) exists in Circle.so
- Bot user (716.social Bot, ID: 73e5a590) exists in Circle.so
- `CIRCLE_HEADLESS_API` configured in Netlify env vars

**Test Script** (manual):
```bash
# Test DM sending to Test Glick
curl -X POST http://localhost:8888/.netlify/functions/test-dm \
  -H "Content-Type: application/json" \
  -d '{
    "recipientId": "a594d38f",
    "recipientEmail": "zglicka@gmail.com",
    "recipientName": "Test Glick",
    "warningLevel": 1
  }'

# Verify in Circle.so UI:
# 1. Log in as Test Glick
# 2. Check Messages/DMs
# 3. Verify DM from 716.social Bot received
# 4. Verify message content matches warning template
```

**Expected Result**:
- DM appears in Test Glick's inbox from 716.social Bot
- Message contains warning text with Test Glick's name
- No errors in Netlify function logs

## Notes

**Circle.so Plan Requirements**:
- Headless API typically requires Business plan or higher
- Verify current plan supports Headless Auth before implementation
- If not available, fall back to Option B (email notifications) or Option C (hybrid)

**Message Copy**:
- Placeholder messages included in code for development
- User to provide final copy before production deployment
- Copy should be reviewed for tone, clarity, and community guidelines

**Why Separate Module**:
- Member API uses different auth (JWT vs Bearer token)
- Different base URL from Admin API
- Clean separation of messaging operations from admin operations

**Future Enhancements**:
- Support for rich text formatting (bold, italics, links)
- Attachment support (e.g., profile photo examples)
- Message templates stored in Airtable for admin editing
- Batch DM API if Circle.so adds support

---

**Next Steps**: Implement Member API integration in `circle-messaging.js`, test JWT generation with Headless Auth API, verify DM delivery to Test Glick user, replace placeholder messages with final copy from user.
