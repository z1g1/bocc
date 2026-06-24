/**
 * Circle.so Member API (Headless) Client
 * Handles JWT authentication and direct messaging for bot user
 *
 * Epic 4: Profile Photo Enforcement System
 * STORY-14: Member API DM Integration
 *
 * Documentation: https://api.circle.so/apis/headless/member-api
 * Auth SDK: https://api.circle.so/apis/headless/auth-sdk
 */

const config = require('./config');
const { createCircleClient, logCircleError } = require('./circle-http');

// Circle.so API configuration
const HEADLESS_API_BASE_URL = config.circle.headlessBaseUrl;
const AUTH_API_BASE_URL = config.circle.authBaseUrl;
const CIRCLE_HEADLESS_API_TOKEN = config.circle.headlessToken;

// Bot user configuration
const BOT_USER_ID = config.bot.id; // 716.social Bot URL slug
const BOT_USER_EMAIL = config.bot.email; // Used for Auth API (JWT generation)
const BOT_USER_NAME = config.bot.name;

/**
 * Create Auth API client (uses the headless service token)
 * @returns {object} axios instance configured for the Auth API
 */
const createAuthApi = () =>
  createCircleClient({ baseURL: AUTH_API_BASE_URL, token: CIRCLE_HEADLESS_API_TOKEN });

/**
 * Create Member API client (uses the bot's JWT)
 * @param {string} jwtToken - JWT access token
 * @returns {object} axios instance configured for the Member API
 */
const createMemberApi = (jwtToken) =>
  createCircleClient({ baseURL: HEADLESS_API_BASE_URL, token: jwtToken });

// Bot JWT, memoized for the lifetime of the function process. Enforcement runs
// send many DMs in one invocation; without this each one re-authenticates.
let cachedBotJWT = null;

/**
 * Clear the memoized bot JWT. For tests only.
 */
const _resetAuthCache = () => {
  cachedBotJWT = null;
};

/**
 * Generate (or reuse) the JWT token for the bot user.
 * Uses the Auth API to get a member-specific JWT, cached per process.
 *
 * @returns {Promise<string>} JWT access token
 * @throws {Error} If token generation fails
 */
const getBotUserJWT = async () => {
  if (cachedBotJWT) {
    return cachedBotJWT;
  }

  try {
    console.log('Generating JWT token for bot user:', BOT_USER_EMAIL);

    const authApi = createAuthApi();

    // POST /api/v1/headless/auth_token
    // Body: { email: "bocc-bot@zackglick.com" }
    const response = await authApi.post('/auth_token', {
      email: BOT_USER_EMAIL
    });

    if (!response.data || !response.data.access_token) {
      throw new Error('Auth API response missing access_token');
    }

    console.log('Successfully generated JWT token for bot user');
    cachedBotJWT = response.data.access_token;
    return cachedBotJWT;
  } catch (error) {
    logCircleError('Error generating bot user JWT', error);
    throw error;
  }
};

/**
 * Find existing DM chat room between bot and target member
 * Searches for 'direct' type chat room with specific member
 *
 * @param {string} jwtToken - Bot user's JWT access token
 * @param {string} targetMemberId - Circle member ID to DM
 * @returns {Promise<string|null>} Chat room UUID if found, null otherwise
 */
const findDMChatRoom = async (jwtToken, targetMemberId) => {
  try {
    console.log('Searching for existing DM chat room with member:', targetMemberId);

    const memberApi = createMemberApi(jwtToken);

    // GET /api/headless/v1/messages
    // Circle has no separate chat_rooms endpoint; DMs are chat rooms with kind: 'direct'
    const response = await memberApi.get('/api/headless/v1/messages', {
      params: {
        per_page: 100
      },
      timeout: 30000
    });

    if (!response.data || !response.data.records) {
      console.log('No chat rooms found');
      return null;
    }

    // Filter for direct rooms client-side and find one with target member
    const chatRoom = response.data.records.find(room => {
      // Only consider direct message rooms
      if (room.chat_room_kind !== 'direct') {
        return false;
      }

      // Check if target member is in this room via other_participants_preview
      if (!room.other_participants_preview) {
        return false;
      }

      return room.other_participants_preview.some(
        participant => String(participant.community_member_id) === String(targetMemberId)
      );
    });

    if (chatRoom) {
      console.log('Found existing DM chat room:', chatRoom.uuid);
      return chatRoom.uuid;
    }

    console.log('No existing DM chat room found with member:', targetMemberId);
    return null;
  } catch (error) {
    logCircleError('Error finding DM chat room', error);
    throw error;
  }
};

/**
 * Create new DM chat room between bot and target member
 * Creates a 'direct' type chat room with specific member
 *
 * @param {string} jwtToken - Bot user's JWT access token
 * @param {string} targetMemberId - Circle member ID to DM
 * @returns {Promise<string>} Created chat room UUID
 */
const createDMChatRoom = async (jwtToken, targetMemberId) => {
  try {
    console.log('Creating new DM chat room with member:', targetMemberId);

    const memberApi = createMemberApi(jwtToken);

    // POST /api/headless/v1/messages
    // Body: { chat_room: { kind: 'direct', community_member_ids: [targetMemberId] } }
    const response = await memberApi.post('/api/headless/v1/messages', {
      chat_room: {
        kind: 'direct',
        community_member_ids: [targetMemberId]
      }
    });

    if (!response.data || !response.data.chat_room || !response.data.chat_room.uuid) {
      throw new Error('Create chat room response missing uuid');
    }

    console.log('Successfully created DM chat room:', response.data.chat_room.uuid);
    return response.data.chat_room.uuid;
  } catch (error) {
    logCircleError('Error creating DM chat room', error);
    throw error;
  }
};

/**
 * Find or create DM chat room
 * Convenience function that tries to find existing room, creates new if not found
 *
 * @param {string} jwtToken - Bot user's JWT access token
 * @param {string} targetMemberId - Circle member ID to DM
 * @returns {Promise<string>} Chat room UUID
 */
const findOrCreateDMChatRoom = async (jwtToken, targetMemberId) => {
  // Try to find existing chat room first
  const existingRoomId = await findDMChatRoom(jwtToken, targetMemberId);

  if (existingRoomId) {
    return existingRoomId;
  }

  // Create new chat room if none exists
  return await createDMChatRoom(jwtToken, targetMemberId);
};

/**
 * Send direct message to member
 * Sends TipTap JSON formatted message via Member API
 *
 * @param {string} jwtToken - Bot user's JWT access token
 * @param {string} chatRoomId - Chat room UUID
 * @param {object} messageBody - TipTap JSON message body (from message-templates.js)
 * @returns {Promise<object>} Created message object
 */
const sendChatMessage = async (jwtToken, chatRoomId, messageBody) => {
  try {
    console.log('Sending message to chat room:', chatRoomId);

    const memberApi = createMemberApi(jwtToken);

    // POST /api/headless/v1/messages/{chat_room_id}/chat_room_messages
    // Body: { rich_text_body: { body: { type: "doc", content: [...] } } }
    const response = await memberApi.post(
      `/api/headless/v1/messages/${chatRoomId}/chat_room_messages`,
      {
        rich_text_body: messageBody
      },
      { timeout: 30000 }
    );

    console.log('Successfully sent message to chat room:', chatRoomId);
    return response.data;
  } catch (error) {
    logCircleError('Error sending chat message', error);
    throw error;
  }
};

/**
 * Send direct message to member (high-level function)
 * Orchestrates: JWT generation -> find/create chat room -> send message
 *
 * @param {string} targetMemberId - Circle member ID to send DM to
 * @param {object} messageBody - TipTap JSON message body (from message-templates.js)
 * @returns {Promise<object>} Result { success, chatRoomId, messageId, error }
 */
const sendDirectMessage = async (targetMemberId, messageBody) => {
  const startTime = Date.now();

  try {
    // Input validation
    if (!targetMemberId || targetMemberId === '') {
      throw new Error('targetMemberId is required');
    }

    if (!messageBody || !messageBody.body) {
      throw new Error('messageBody must be a valid TipTap JSON structure');
    }

    console.log('Starting DM send workflow for member:', targetMemberId);

    // Step 1: Generate JWT token for bot user
    const jwtToken = await getBotUserJWT();

    // Step 2: Find or create DM chat room
    const chatRoomId = await findOrCreateDMChatRoom(jwtToken, targetMemberId);

    // Step 3: Send message
    const messageResponse = await sendChatMessage(jwtToken, chatRoomId, messageBody);

    const duration = Date.now() - startTime;
    console.log(`DM sent successfully in ${duration}ms:`, {
      targetMemberId,
      chatRoomId,
      messageId: messageResponse.creation_uuid
    });

    return {
      success: true,
      chatRoomId: chatRoomId,
      messageId: messageResponse.creation_uuid,
      duration: duration
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`DM send failed after ${duration}ms:`, error.message);

    return {
      success: false,
      error: error.message,
      duration: duration
    };
  }
};

module.exports = {
  getBotUserJWT,
  findDMChatRoom,
  createDMChatRoom,
  findOrCreateDMChatRoom,
  sendChatMessage,
  sendDirectMessage,
  // Test helper: clear the memoized bot JWT
  _resetAuthCache,
  // Export constants for testing
  BOT_USER_ID,
  BOT_USER_EMAIL,
  BOT_USER_NAME
};
