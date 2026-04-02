/**
 * Unit tests for Circle.so Member API (Headless) Client
 * Tests JWT authentication and DM sending functionality
 *
 * TASK-81, TASK-83, TASK-85: Tests for JWT, chat rooms, and DM sending
 * Epic 4: Profile Photo Enforcement System
 */

// Mock axios before requiring module
let mockAuthPost;
let mockMemberGet;
let mockMemberPost;

const mockAxiosCreate = jest.fn((config) => {
  // Auth API uses baseURL: https://app.circle.so/api/v1/headless
  // Member API uses baseURL: https://app.circle.so
  if (config.baseURL && config.baseURL.includes('/v1/headless')) {
    return { post: mockAuthPost };
  } else {
    return { get: mockMemberGet, post: mockMemberPost };
  }
});

jest.mock('axios', () => ({
  create: mockAxiosCreate
}));

const {
  getBotUserJWT,
  findDMChatRoom,
  createDMChatRoom,
  findOrCreateDMChatRoom,
  sendChatMessage,
  sendDirectMessage,
  BOT_USER_ID,
  BOT_USER_EMAIL
} = require('../netlify/functions/utils/circle-member-api');

describe('Circle Member API - DM Integration', () => {
  beforeEach(() => {
    // Initialize mock functions
    mockAuthPost = jest.fn();
    mockMemberGet = jest.fn();
    mockMemberPost = jest.fn();

    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    console.log.mockRestore();
    console.error.mockRestore();
  });

  describe('getBotUserJWT - JWT Token Generation', () => {
    it('should generate JWT token for bot user successfully', async () => {
      const mockJWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test';

      mockAuthPost.mockResolvedValue({
        data: {
          access_token: mockJWT,
          refresh_token: 'refresh_token_here',
          expires_in: 3600
        }
      });

      const result = await getBotUserJWT();

      expect(result).toBe(mockJWT);
      expect(mockAuthPost).toHaveBeenCalledWith('/auth_token', {
        email: BOT_USER_EMAIL
      });
    });

    it('should throw error if access_token missing from response', async () => {
      mockAuthPost.mockResolvedValue({
        data: {
          // Missing access_token
          refresh_token: 'refresh_token_here'
        }
      });

      await expect(getBotUserJWT()).rejects.toThrow('Auth API response missing access_token');
    });

    it('should throw error if Auth API returns 401', async () => {
      const error = new Error('Request failed with status code 401');
      error.response = {
        status: 401,
        data: { error: 'Unauthorized' }
      };

      mockAuthPost.mockRejectedValue(error);

      await expect(getBotUserJWT()).rejects.toThrow();
    });

    it('should handle network errors gracefully', async () => {
      const error = new Error('Network error');
      error.code = 'ECONNREFUSED';

      mockAuthPost.mockRejectedValue(error);

      await expect(getBotUserJWT()).rejects.toThrow();
    });
  });

  describe('findDMChatRoom - Find Existing Chat Room', () => {
    const mockJWT = 'test.jwt.token';
    const targetMemberId = 'target-member-123';

    it('should find existing DM chat room with target member', async () => {
      const mockChatRooms = [
        {
          uuid: 'room-1-uuid',
          chat_room_kind: 'direct',
          other_participants_preview: [
            { community_member_id: targetMemberId, name: 'Target User' }
          ]
        },
        {
          uuid: 'room-2-uuid',
          chat_room_kind: 'direct',
          other_participants_preview: [
            { community_member_id: 'other-member', name: 'Other User' }
          ]
        }
      ];

      mockMemberGet.mockResolvedValue({
        data: {
          records: mockChatRooms,
          pagination: { total: 2 }
        }
      });

      const result = await findDMChatRoom(mockJWT, targetMemberId);

      expect(result).toBe('room-1-uuid');
      expect(mockMemberGet).toHaveBeenCalledWith(
        '/api/headless/v1/messages',
        expect.objectContaining({
          params: {
            per_page: 100
          }
        })
      );
    });

    it('should return null if no existing DM chat room found', async () => {
      mockMemberGet.mockResolvedValue({
        data: {
          records: [
            {
              uuid: 'room-2-uuid',
              chat_room_kind: 'direct',
              other_participants_preview: [
                { community_member_id: 'other-member', name: 'Other User' }
              ]
            }
          ],
          pagination: { total: 1 }
        }
      });

      const result = await findDMChatRoom(mockJWT, targetMemberId);

      expect(result).toBeNull();
    });

    it('should return null if no chat rooms exist', async () => {
      mockMemberGet.mockResolvedValue({
        data: {
          records: [],
          pagination: { total: 0 }
        }
      });

      const result = await findDMChatRoom(mockJWT, targetMemberId);

      expect(result).toBeNull();
    });

    it('should filter out non-direct chat rooms', async () => {
      mockMemberGet.mockResolvedValue({
        data: {
          records: [
            {
              uuid: 'group-room-uuid',
              chat_room_kind: 'group_chat',
              other_participants_preview: [
                { community_member_id: targetMemberId },
                { community_member_id: 'third-member' }
              ]
            }
          ]
        }
      });

      const result = await findDMChatRoom(mockJWT, targetMemberId);

      expect(result).toBeNull();
    });

    it('should match target member using string comparison', async () => {
      // Test that numeric IDs match string IDs (e.g., Admin API returns number, participant has number)
      const numericMemberId = 55423517;

      mockMemberGet.mockResolvedValue({
        data: {
          records: [
            {
              uuid: 'numeric-room-uuid',
              chat_room_kind: 'direct',
              other_participants_preview: [
                { community_member_id: 55423517, name: 'Numeric User' }
              ]
            }
          ]
        }
      });

      const result = await findDMChatRoom(mockJWT, numericMemberId);

      expect(result).toBe('numeric-room-uuid');
    });

    it('should handle Member API errors', async () => {
      const error = new Error('Request failed with status code 403');
      error.response = {
        status: 403,
        data: { error: 'Forbidden' }
      };

      mockMemberGet.mockRejectedValue(error);

      await expect(findDMChatRoom(mockJWT, targetMemberId)).rejects.toThrow();
    });
  });

  describe('createDMChatRoom - Create New Chat Room', () => {
    const mockJWT = 'test.jwt.token';
    const targetMemberId = 'target-member-123';

    it('should create new DM chat room successfully', async () => {
      const mockRoomUuid = 'new-room-uuid';

      mockMemberPost.mockResolvedValue({
        data: {
          chat_room: {
            uuid: mockRoomUuid,
            kind: 'direct'
          }
        }
      });

      const result = await createDMChatRoom(mockJWT, targetMemberId);

      expect(result).toBe(mockRoomUuid);
      expect(mockMemberPost).toHaveBeenCalledWith('/api/headless/v1/messages', {
        chat_room: {
          kind: 'direct',
          community_member_ids: [targetMemberId]
        }
      });
    });

    it('should throw error if response missing uuid', async () => {
      mockMemberPost.mockResolvedValue({
        data: {
          chat_room: {
            // Missing uuid
            kind: 'direct'
          }
        }
      });

      await expect(createDMChatRoom(mockJWT, targetMemberId)).rejects.toThrow(
        'Create chat room response missing uuid'
      );
    });

    it('should throw error if response missing chat_room', async () => {
      mockMemberPost.mockResolvedValue({
        data: {
          // Missing chat_room wrapper
          kind: 'direct'
        }
      });

      await expect(createDMChatRoom(mockJWT, targetMemberId)).rejects.toThrow(
        'Create chat room response missing uuid'
      );
    });

    it('should handle API errors when creating chat room', async () => {
      const error = new Error('Request failed with status code 422');
      error.response = {
        status: 422,
        data: { error: 'Validation failed' }
      };

      mockMemberPost.mockRejectedValue(error);

      await expect(createDMChatRoom(mockJWT, targetMemberId)).rejects.toThrow();
    });
  });

  describe('findOrCreateDMChatRoom - Find or Create Logic', () => {
    const mockJWT = 'test.jwt.token';
    const targetMemberId = 'target-member-123';

    it('should return existing chat room if found', async () => {
      const existingRoomUuid = 'existing-room-uuid';

      mockMemberGet.mockResolvedValue({
        data: {
          records: [
            {
              uuid: existingRoomUuid,
              chat_room_kind: 'direct',
              other_participants_preview: [
                { community_member_id: targetMemberId }
              ]
            }
          ]
        }
      });

      const result = await findOrCreateDMChatRoom(mockJWT, targetMemberId);

      expect(result).toBe(existingRoomUuid);
      expect(mockMemberPost).not.toHaveBeenCalled(); // Should not create new room
    });

    it('should create new chat room if none exists', async () => {
      const newRoomUuid = 'new-room-uuid';

      // Find returns empty
      mockMemberGet.mockResolvedValue({
        data: {
          records: []
        }
      });

      // Create succeeds
      mockMemberPost.mockResolvedValue({
        data: {
          chat_room: {
            uuid: newRoomUuid,
            kind: 'direct'
          }
        }
      });

      const result = await findOrCreateDMChatRoom(mockJWT, targetMemberId);

      expect(result).toBe(newRoomUuid);
      expect(mockMemberGet).toHaveBeenCalled();
      expect(mockMemberPost).toHaveBeenCalled();
    });
  });

  describe('sendChatMessage - Send Message to Chat Room', () => {
    const mockJWT = 'test.jwt.token';
    const chatRoomUuid = 'chat-room-uuid';
    const mockMessageBody = {
      body: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Test message' }
            ]
          }
        ]
      }
    };

    it('should send message to chat room successfully', async () => {
      const mockCreationUuid = 'creation-uuid-123';

      mockMemberPost.mockResolvedValue({
        data: {
          creation_uuid: mockCreationUuid,
          sent_at: '2025-02-05T12:00:00Z'
        }
      });

      const result = await sendChatMessage(mockJWT, chatRoomUuid, mockMessageBody);

      expect(result.creation_uuid).toBe(mockCreationUuid);
      expect(mockMemberPost).toHaveBeenCalledWith(
        `/api/headless/v1/messages/${chatRoomUuid}/chat_room_messages`,
        { rich_text_body: mockMessageBody },
        { timeout: 30000 }
      );
    });

    it('should handle message send errors', async () => {
      const error = new Error('Request failed with status code 500');
      error.response = {
        status: 500,
        data: { error: 'Internal server error' }
      };

      mockMemberPost.mockRejectedValue(error);

      await expect(sendChatMessage(mockJWT, chatRoomUuid, mockMessageBody)).rejects.toThrow();
    });
  });

  describe('sendDirectMessage - High-Level DM Workflow', () => {
    const targetMemberId = 'target-member-123';
    const mockMessageBody = {
      body: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Warning message' }]
          }
        ]
      }
    };

    it('should complete full DM workflow successfully', async () => {
      const mockJWT = 'test.jwt.token';
      const mockChatRoomUuid = 'chat-room-uuid';
      const mockCreationUuid = 'creation-uuid-123';

      // Mock JWT generation
      mockAuthPost.mockResolvedValue({
        data: { access_token: mockJWT }
      });

      // Mock chat room find (not found)
      mockMemberGet.mockResolvedValue({
        data: { records: [] }
      });

      // Mock chat room creation
      mockMemberPost
        .mockResolvedValueOnce({
          data: { chat_room: { uuid: mockChatRoomUuid, kind: 'direct' } }
        })
        // Mock message send
        .mockResolvedValueOnce({
          data: { creation_uuid: mockCreationUuid, sent_at: '2025-02-05T12:00:00Z' }
        });

      const result = await sendDirectMessage(targetMemberId, mockMessageBody);

      expect(result.success).toBe(true);
      expect(result.chatRoomId).toBe(mockChatRoomUuid);
      expect(result.messageId).toBe(mockCreationUuid);
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('should return error if targetMemberId is missing', async () => {
      const result = await sendDirectMessage('', mockMessageBody);

      expect(result.success).toBe(false);
      expect(result.error).toContain('targetMemberId is required');
    });

    it('should return error if messageBody is invalid', async () => {
      const result = await sendDirectMessage(targetMemberId, {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('messageBody must be a valid TipTap JSON structure');
    });

    it('should return error object if JWT generation fails', async () => {
      mockAuthPost.mockRejectedValue(new Error('Auth failed'));

      const result = await sendDirectMessage(targetMemberId, mockMessageBody);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Auth failed');
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('should return error object if chat room creation fails', async () => {
      const mockJWT = 'test.jwt.token';

      mockAuthPost.mockResolvedValue({
        data: { access_token: mockJWT }
      });

      mockMemberGet.mockResolvedValue({
        data: { records: [] }
      });

      mockMemberPost.mockRejectedValue(new Error('Chat room creation failed'));

      const result = await sendDirectMessage(targetMemberId, mockMessageBody);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Chat room creation failed');
    });

    it('should return error object if message send fails', async () => {
      const mockJWT = 'test.jwt.token';
      const mockChatRoomUuid = 'chat-room-uuid';

      mockAuthPost.mockResolvedValue({
        data: { access_token: mockJWT }
      });

      mockMemberGet.mockResolvedValue({
        data: {
          records: [
            {
              uuid: mockChatRoomUuid,
              chat_room_kind: 'direct',
              other_participants_preview: [
                { community_member_id: targetMemberId }
              ]
            }
          ]
        }
      });

      mockMemberPost.mockRejectedValue(new Error('Message send failed'));

      const result = await sendDirectMessage(targetMemberId, mockMessageBody);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Message send failed');
    });
  });

  describe('Integration Tests', () => {
    it('should reuse existing chat room on subsequent messages', async () => {
      const targetMemberId = 'target-member-123';
      const mockJWT = 'test.jwt.token';
      const existingRoomUuid = 'existing-room-uuid';
      const mockMessageBody = {
        body: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Test' }] }]
        }
      };

      // JWT generation
      mockAuthPost.mockResolvedValue({
        data: { access_token: mockJWT }
      });

      // Chat room already exists
      mockMemberGet.mockResolvedValue({
        data: {
          records: [
            {
              uuid: existingRoomUuid,
              chat_room_kind: 'direct',
              other_participants_preview: [
                { community_member_id: targetMemberId }
              ]
            }
          ]
        }
      });

      // Message send
      mockMemberPost.mockResolvedValue({
        data: { creation_uuid: 'message-1', sent_at: '2025-02-05T12:00:00Z' }
      });

      const result = await sendDirectMessage(targetMemberId, mockMessageBody);

      expect(result.success).toBe(true);
      expect(result.chatRoomId).toBe(existingRoomUuid);

      // Verify no chat room creation attempted
      expect(mockMemberPost).toHaveBeenCalledTimes(1); // Only message send, no room creation
    });
  });
});
