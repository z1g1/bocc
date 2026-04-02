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

const axios = require('axios');

// Circle.so API configuration
const HEADLESS_API_BASE_URL = 'https://app.circle.so';
const AUTH_API_BASE_URL = 'https://app.circle.so/api/v1/headless';
const CIRCLE_HEADLESS_API_TOKEN = process.env.CIRCLE_HEADLESS_API;

console.log('Circle Headless API Token:', CIRCLE_HEADLESS_API_TOKEN ? 'Exists' : 'Not set');

// Bot user configuration
const BOT_USER_ID = '73e5a590'; // 716.social Bot URL slug
const BOT_USER_EMAIL = 'bocc-bot@zackglick.com'; // Used for Auth API (JWT generation)
const BOT_USER_NAME = '716.social Bot';

/**
 * Create Auth API axios instance
 * @returns {object} Axios instance configured for Auth API
 */
const createAuthApi = () => {
  return axios.create({
    baseURL: AUTH_API_BASE_URL,
    headers: {
      'Authorization': `Bearer ${CIRCLE_HEADLESS_API_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
};

/**
 * Create Member API axios instance
 * @param {string} jwtToken - JWT access token
 * @returns {object} Axios instance configured for Member API
 */
const createMemberApi = (jwtToken) => {
  return axios.create({
    baseURL: HEADLESS_API_BASE_URL,
    headers: {
      'Authorization': `Bearer ${jwtToken}`,
      'Content-Type': 'application/json'
    }
  });
};

/**
 * Generate JWT token for bot user
 * Uses Auth API to get member-specific JWT token
 *
 * @returns {Promise<string>} JWT access token
 * @throws {Error} If token generation fails
 */
const getBotUserJWT = async () => {
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
    return response.data.access_token;
  } catch (error) {
    console.error('Error generating bot user JWT:', error.message);
    if (error.response) {
      console.error('Auth API response status:', error.response.status);
      console.error('Auth API response data:', JSON.stringify(error.response.data));
    }
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
    console.error('Error finding DM chat room:', error.message);
    if (error.response) {
      console.error('Member API response status:', error.response.status);
      console.error('Member API response data:', JSON.stringify(error.response.data));
    }
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
    console.error('Error creating DM chat room:', error.message);
    if (error.response) {
      console.error('Member API response status:', error.response.status);
      console.error('Member API response data:', JSON.stringify(error.response.data));
    }
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
    console.error('Error sending chat message:', error.message);
    if (error.response) {
      console.error('Member API response status:', error.response.status);
      console.error('Member API response data:', JSON.stringify(error.response.data));
    }
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
  // Export constants for testing
  BOT_USER_ID,
  BOT_USER_EMAIL,
  BOT_USER_NAME
};
