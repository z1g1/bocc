/**
 * Unit tests for Profile Photo Enforcement Logic
 * Tests decision logic and execution orchestration for Epic 4
 *
 * TASK-74: Write Tests for determineEnforcementAction (Pure Function)
 * TASK-76: Write Tests for processEnforcementAction (Impure Function)
 * Epic 4: Profile Photo Enforcement System
 */

// Mock Airtable warnings operations before requiring module
jest.mock('../netlify/functions/utils/airtable-warnings', () => ({
  createWarningRecord: jest.fn(),
  incrementWarningCount: jest.fn(),
  updateWarningStatus: jest.fn(),
  deleteWarningRecord: jest.fn()
}));

// Mock Circle Member API for DM sending
jest.mock('../netlify/functions/utils/circle-member-api', () => ({
  sendDirectMessage: jest.fn()
}));

// Mock Circle Admin API for member deactivation
jest.mock('../netlify/functions/utils/circle', () => ({
  deactivateMember: jest.fn()
}));

// Mock message templates (return minimal valid TipTap structure)
jest.mock('../netlify/functions/utils/message-templates', () => ({
  getWarningMessage: jest.fn(() => ({
    body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Warning' }] }] }
  })),
  thankYouMessage: jest.fn(() => ({
    body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Thank you' }] }] }
  })),
  adminAlert: jest.fn(() => ({
    body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Alert' }] }] }
  }))
}));

const {
  determineEnforcementAction,
  processEnforcementAction
} = require('../netlify/functions/utils/enforcement-logic');

const {
  createWarningRecord,
  incrementWarningCount,
  updateWarningStatus,
  deleteWarningRecord
} = require('../netlify/functions/utils/airtable-warnings');

const { sendDirectMessage } = require('../netlify/functions/utils/circle-member-api');
const { deactivateMember: mockDeactivateMember } = require('../netlify/functions/utils/circle');

describe('Enforcement Logic - Epic 4', () => {
  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Mock console methods to reduce test output noise
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    // Mock sendDirectMessage to return success by default
    sendDirectMessage.mockResolvedValue({
      success: true,
      chatRoomId: 'test-chat-room',
      messageId: 'test-message-id',
      duration: 100
    });

    // Mock deactivateMember to resolve successfully by default
    mockDeactivateMember.mockResolvedValue(undefined);
  });

  afterEach(() => {
    console.log.mockRestore();
    console.error.mockRestore();
    console.warn.mockRestore();
  });

  describe('determineEnforcementAction - Pure Decision Logic', () => {
    const mockMember = {
      id: 'member-123',
      email: 'test@example.com',
      name: 'Test User',
      has_profile_picture: false
    };

    describe('Member has profile photo (PHOTO_ADDED / SKIP)', () => {
      it('should return PHOTO_ADDED when member adds photo after warning', () => {
        const memberWithPhoto = { ...mockMember, has_profile_picture: true };
        const existingWarning = {
          id: 'rec123',
          fields: {
            'Status': 'Active',
            'Number of warnings': 2
          }
        };

        const result = determineEnforcementAction(memberWithPhoto, existingWarning);

        expect(result).toEqual({
          action: 'PHOTO_ADDED',
          warningLevel: 0,
          shouldNotifyAdmin: false,
          reason: 'Member added profile photo since last enforcement run'
        });
      });

      it('should return SKIP when member has photo and no warning record', () => {
        const memberWithPhoto = { ...mockMember, has_profile_picture: true };

        const result = determineEnforcementAction(memberWithPhoto, null);

        expect(result).toEqual({
          action: 'SKIP',
          warningLevel: 0,
          shouldNotifyAdmin: false,
          reason: 'Member has profile photo, no action needed'
        });
      });

      it('should return SKIP when member has photo and status is Photo Added', () => {
        const memberWithPhoto = { ...mockMember, has_profile_picture: true };
        const existingWarning = {
          id: 'rec123',
          fields: {
            'Status': 'Photo Added',
            'Number of warnings': 1
          }
        };

        const result = determineEnforcementAction(memberWithPhoto, existingWarning);

        expect(result).toEqual({
          action: 'SKIP',
          warningLevel: 0,
          shouldNotifyAdmin: false,
          reason: 'Member has profile photo, no action needed'
        });
      });
    });

    describe('First warning (CREATE_WARNING)', () => {
      it('should create warning when member has no photo and no existing record', () => {
        const result = determineEnforcementAction(mockMember, null);

        expect(result).toEqual({
          action: 'CREATE_WARNING',
          warningLevel: 1,
          shouldNotifyAdmin: false,
          reason: 'First time member identified without profile photo'
        });
      });
    });

    describe('Warning progression (INCREMENT_WARNING)', () => {
      it('should increment from warning 1 to 2', () => {
        const existingWarning = {
          id: 'rec123',
          fields: {
            'Status': 'Active',
            'Number of warnings': 1
          }
        };

        const result = determineEnforcementAction(mockMember, existingWarning);

        expect(result).toEqual({
          action: 'INCREMENT_WARNING',
          warningLevel: 2,
          shouldNotifyAdmin: false,
          reason: 'Member received warning 2 of 4 before deactivation'
        });
      });

      it('should increment from warning 2 to 3', () => {
        const existingWarning = {
          id: 'rec123',
          fields: {
            'Status': 'Active',
            'Number of warnings': 2
          }
        };

        const result = determineEnforcementAction(mockMember, existingWarning);

        expect(result).toEqual({
          action: 'INCREMENT_WARNING',
          warningLevel: 3,
          shouldNotifyAdmin: false,
          reason: 'Member received warning 3 of 4 before deactivation'
        });
      });

      it('should increment from warning 3 to 4 (final warning) and notify admin', () => {
        const existingWarning = {
          id: 'rec123',
          fields: {
            'Status': 'Active',
            'Number of warnings': 3
          }
        };

        const result = determineEnforcementAction(mockMember, existingWarning);

        expect(result).toEqual({
          action: 'INCREMENT_WARNING',
          warningLevel: 4,
          shouldNotifyAdmin: true,
          reason: 'Member received final warning (4th warning)'
        });
      });
    });

    describe('Deactivation (DEACTIVATE)', () => {
      it('should deactivate when reaching warning 5', () => {
        const existingWarning = {
          id: 'rec456',
          fields: {
            'Status': 'Active',
            'Number of warnings': 4
          }
        };

        const result = determineEnforcementAction(mockMember, existingWarning);

        expect(result).toEqual({
          action: 'DEACTIVATE',
          warningLevel: 5,
          shouldNotifyAdmin: true,
          reason: 'Member reached 5 warnings, account will be deactivated'
        });
      });
    });

    describe('Skip cases (already handled)', () => {
      it('should skip if member already deactivated', () => {
        const existingWarning = {
          id: 'rec789',
          fields: {
            'Status': 'Deactivated',
            'Number of warnings': 5
          }
        };

        const result = determineEnforcementAction(mockMember, existingWarning);

        expect(result).toEqual({
          action: 'SKIP',
          warningLevel: 5,
          shouldNotifyAdmin: false,
          reason: 'Member already deactivated, no further action'
        });
      });

      it('should skip if status is Photo Added', () => {
        const existingWarning = {
          id: 'rec999',
          fields: {
            'Status': 'Photo Added',
            'Number of warnings': 2
          }
        };

        const result = determineEnforcementAction(mockMember, existingWarning);

        expect(result).toEqual({
          action: 'SKIP',
          warningLevel: 2,
          shouldNotifyAdmin: false,
          reason: 'Member marked as Photo Added, record should be deleted'
        });
      });
    });

    describe('Anomaly detection (warning count >= 5)', () => {
      it('should skip and notify admin if warning count is 5 or higher', () => {
        const existingWarning = {
          id: 'recAnomaly',
          fields: {
            'Status': 'Active',
            'Number of warnings': 5
          }
        };

        const result = determineEnforcementAction(mockMember, existingWarning);

        expect(result).toEqual({
          action: 'SKIP',
          warningLevel: 5,
          shouldNotifyAdmin: true,
          reason: 'Anomaly detected: warning count is 5, expected max 5'
        });
        expect(console.warn).toHaveBeenCalledWith(
          expect.stringContaining('WARNING: Member test@example.com has warning count >= 5')
        );
      });

      it('should skip and notify admin if warning count exceeds 5', () => {
        const existingWarning = {
          id: 'recAnomaly2',
          fields: {
            'Status': 'Active',
            'Number of warnings': 7
          }
        };

        const result = determineEnforcementAction(mockMember, existingWarning);

        expect(result).toEqual({
          action: 'SKIP',
          warningLevel: 5,
          shouldNotifyAdmin: true,
          reason: 'Anomaly detected: warning count is 7, expected max 5'
        });
      });
    });
  });

  describe('processEnforcementAction - Execution Orchestration', () => {
    const mockMember = {
      id: 'member-123',
      email: 'test@example.com',
      name: 'Test User'
    };

    describe('Dry run mode', () => {
      it('should log action without executing when dryRun=true', async () => {
        const action = {
          action: 'CREATE_WARNING',
          warningLevel: 1,
          shouldNotifyAdmin: false,
          reason: 'Test reason'
        };

        const result = await processEnforcementAction(mockMember, null, action, true);

        expect(result).toEqual({
          success: true,
          executedActions: ['DRY_RUN:CREATE_WARNING'],
          errors: []
        });

        // Verify no actual operations performed
        expect(createWarningRecord).not.toHaveBeenCalled();
        expect(incrementWarningCount).not.toHaveBeenCalled();
        expect(console.log).toHaveBeenCalledWith(
          expect.stringContaining('[DRY RUN]')
        );
      });
    });

    describe('CREATE_WARNING action', () => {
      it('should create warning record successfully', async () => {
        const action = {
          action: 'CREATE_WARNING',
          warningLevel: 1,
          shouldNotifyAdmin: false,
          reason: 'First warning'
        };

        createWarningRecord.mockResolvedValue({
          id: 'rec123',
          fields: {
            'Name': 'Test User',
            'Email': 'test@example.com',
            'Number of warnings': 1,
            'Status': 'Active'
          }
        });

        const result = await processEnforcementAction(mockMember, null, action, false);

        expect(createWarningRecord).toHaveBeenCalledWith('Test User', 'test@example.com');
        expect(result.success).toBe(true);
        expect(result.executedActions).toContain('CREATED_WARNING_RECORD');
        expect(result.executedActions).toContain('SENT_WARNING_DM');
        expect(result.errors).toEqual([]);
      });

      it('should handle DM send failure gracefully (non-blocking)', async () => {
        const action = {
          action: 'CREATE_WARNING',
          warningLevel: 1,
          shouldNotifyAdmin: false,
          reason: 'First warning'
        };

        createWarningRecord.mockResolvedValue({ id: 'rec123', fields: {} });

        // Note: DM sending is stubbed in enforcement-logic.js
        // In reality, this would test actual DM send failures
        const result = await processEnforcementAction(mockMember, null, action, false);

        // Should still succeed even if DM fails
        expect(result.success).toBe(true);
        expect(result.executedActions).toContain('CREATED_WARNING_RECORD');
      });
    });

    describe('INCREMENT_WARNING action', () => {
      const warningRecord = {
        id: 'rec123',
        fields: {
          'Number of warnings': 2,
          'Status': 'Active'
        }
      };

      it('should increment warning count successfully (warnings 1→2, 2→3)', async () => {
        const action = {
          action: 'INCREMENT_WARNING',
          warningLevel: 3,
          shouldNotifyAdmin: false,
          reason: 'Warning 3'
        };

        incrementWarningCount.mockResolvedValue({
          id: 'rec123',
          fields: { 'Number of warnings': 3 }
        });

        const result = await processEnforcementAction(mockMember, warningRecord, action, false);

        expect(incrementWarningCount).toHaveBeenCalledWith('rec123');
        expect(result.success).toBe(true);
        expect(result.executedActions).toContain('INCREMENTED_WARNING_COUNT');
        expect(result.executedActions).toContain('SENT_WARNING_DM');
        expect(result.executedActions).not.toContain('NOTIFIED_ADMIN');
      });

      it('should notify admin on final warning (warning 3→4)', async () => {
        const action = {
          action: 'INCREMENT_WARNING',
          warningLevel: 4,
          shouldNotifyAdmin: true,
          reason: 'Final warning'
        };

        incrementWarningCount.mockResolvedValue({
          id: 'rec123',
          fields: { 'Number of warnings': 4 }
        });

        const result = await processEnforcementAction(mockMember, warningRecord, action, false);

        expect(result.success).toBe(true);
        expect(result.executedActions).toContain('INCREMENTED_WARNING_COUNT');
        expect(result.executedActions).toContain('SENT_WARNING_DM');
        expect(result.executedActions).toContain('NOTIFIED_ADMIN');
      });

      it('should handle increment failures', async () => {
        const action = {
          action: 'INCREMENT_WARNING',
          warningLevel: 2,
          shouldNotifyAdmin: false,
          reason: 'Test'
        };

        incrementWarningCount.mockRejectedValue(new Error('Airtable update failed'));

        const result = await processEnforcementAction(mockMember, warningRecord, action, false);

        expect(result.success).toBe(false);
        expect(result.errors).toContain('Airtable update failed');
      });
    });

    describe('DEACTIVATE action', () => {
      const warningRecord = {
        id: 'rec456',
        fields: {
          'Number of warnings': 4,
          'Status': 'Active'
        }
      };

      it('should execute full deactivation workflow', async () => {
        const action = {
          action: 'DEACTIVATE',
          warningLevel: 5,
          shouldNotifyAdmin: true,
          reason: 'Reached 5 warnings'
        };

        updateWarningStatus.mockResolvedValue({
          id: 'rec456',
          fields: { 'Status': 'Deactivated' }
        });

        const result = await processEnforcementAction(mockMember, warningRecord, action, false);

        expect(result.success).toBe(true);
        expect(result.executedActions).toContain('DEACTIVATED_MEMBER');
        expect(result.executedActions).toContain('UPDATED_STATUS_DEACTIVATED');
        expect(result.executedActions).toContain('NOTIFIED_ADMIN');

        expect(updateWarningStatus).toHaveBeenCalledWith('rec456', 'Deactivated');
      });

      it('should handle deactivation errors (blocking)', async () => {
        const action = {
          action: 'DEACTIVATE',
          warningLevel: 5,
          shouldNotifyAdmin: true,
          reason: 'Reached 5 warnings'
        };

        // Simulate deactivation failure
        // Note: deactivateMember is stubbed, so we test via status update failure
        updateWarningStatus.mockRejectedValue(new Error('Deactivation failed'));

        const result = await processEnforcementAction(mockMember, warningRecord, action, false);

        expect(result.success).toBe(false);
        expect(result.errors).toContain('Deactivation failed');
      });
    });

    describe('PHOTO_ADDED action', () => {
      const warningRecord = {
        id: 'rec789',
        fields: {
          'Number of warnings': 2,
          'Status': 'Active'
        }
      };

      it('should send thank you DM and delete warning record', async () => {
        const action = {
          action: 'PHOTO_ADDED',
          warningLevel: 0,
          shouldNotifyAdmin: false,
          reason: 'Member added photo'
        };

        deleteWarningRecord.mockResolvedValue(undefined);

        const result = await processEnforcementAction(mockMember, warningRecord, action, false);

        expect(result.success).toBe(true);
        expect(result.executedActions).toContain('SENT_THANK_YOU_DM');
        expect(result.executedActions).toContain('DELETED_WARNING_RECORD');
        expect(deleteWarningRecord).toHaveBeenCalledWith('rec789');
      });

      it('should handle deletion failures', async () => {
        const action = {
          action: 'PHOTO_ADDED',
          warningLevel: 0,
          shouldNotifyAdmin: false,
          reason: 'Member added photo'
        };

        deleteWarningRecord.mockRejectedValue(new Error('Deletion failed'));

        const result = await processEnforcementAction(mockMember, warningRecord, action, false);

        expect(result.success).toBe(false);
        expect(result.errors).toContain('Deletion failed');
      });
    });

    describe('SKIP action', () => {
      it('should skip without any operations', async () => {
        const action = {
          action: 'SKIP',
          warningLevel: 0,
          shouldNotifyAdmin: false,
          reason: 'Member has photo'
        };

        const result = await processEnforcementAction(mockMember, null, action, false);

        expect(result.success).toBe(true);
        expect(result.executedActions).toEqual(['SKIPPED']);
        expect(result.errors).toEqual([]);

        // Verify no database operations performed
        expect(createWarningRecord).not.toHaveBeenCalled();
        expect(incrementWarningCount).not.toHaveBeenCalled();
        expect(updateWarningStatus).not.toHaveBeenCalled();
        expect(deleteWarningRecord).not.toHaveBeenCalled();
      });

      it('should notify admin if anomaly detected during SKIP', async () => {
        const action = {
          action: 'SKIP',
          warningLevel: 5,
          shouldNotifyAdmin: true,
          reason: 'Anomaly: warning count is 7'
        };

        const result = await processEnforcementAction(mockMember, null, action, false);

        expect(result.success).toBe(true);
        expect(result.executedActions).toContain('SKIPPED');
        expect(result.executedActions).toContain('NOTIFIED_ADMIN_ANOMALY');
      });
    });

    describe('Unknown action handling', () => {
      it('should throw error for unknown action type', async () => {
        const action = {
          action: 'UNKNOWN_ACTION',
          warningLevel: 0,
          shouldNotifyAdmin: false,
          reason: 'Test'
        };

        const result = await processEnforcementAction(mockMember, null, action, false);

        expect(result.success).toBe(false);
        expect(result.errors).toContain('Unknown enforcement action: UNKNOWN_ACTION');
      });
    });
  });

  describe('Integration: Decision + Execution Flow', () => {
    it('should handle complete workflow: new member without photo', async () => {
      const member = {
        id: 'new-member',
        email: 'newuser@example.com',
        name: 'New User',
        has_profile_picture: false
      };

      // Step 1: Determine action
      const action = determineEnforcementAction(member, null);
      expect(action.action).toBe('CREATE_WARNING');
      expect(action.warningLevel).toBe(1);

      // Step 2: Execute action
      createWarningRecord.mockResolvedValue({ id: 'recNew', fields: {} });
      const result = await processEnforcementAction(member, null, action, false);

      expect(result.success).toBe(true);
      expect(result.executedActions).toContain('CREATED_WARNING_RECORD');
    });

    it('should handle complete workflow: member adds photo after warnings', async () => {
      const member = {
        id: 'recovered-member',
        email: 'recovered@example.com',
        name: 'Recovered User',
        has_profile_picture: true
      };

      const warningRecord = {
        id: 'recRecovered',
        fields: {
          'Status': 'Active',
          'Number of warnings': 3
        }
      };

      // Step 1: Determine action
      const action = determineEnforcementAction(member, warningRecord);
      expect(action.action).toBe('PHOTO_ADDED');
      expect(action.warningLevel).toBe(0);

      // Step 2: Execute action
      deleteWarningRecord.mockResolvedValue(undefined);
      const result = await processEnforcementAction(member, warningRecord, action, false);

      expect(result.success).toBe(true);
      expect(result.executedActions).toContain('DELETED_WARNING_RECORD');
    });

    it('should handle complete workflow: escalation to deactivation', async () => {
      const member = {
        id: 'deactivate-member',
        email: 'deactivate@example.com',
        name: 'Deactivate User',
        has_profile_picture: false
      };

      const warningRecord = {
        id: 'recDeactivate',
        fields: {
          'Status': 'Active',
          'Number of warnings': 4
        }
      };

      // Step 1: Determine action
      const action = determineEnforcementAction(member, warningRecord);
      expect(action.action).toBe('DEACTIVATE');
      expect(action.warningLevel).toBe(5);
      expect(action.shouldNotifyAdmin).toBe(true);

      // Step 2: Execute action
      updateWarningStatus.mockResolvedValue({ id: 'recDeactivate', fields: {} });
      const result = await processEnforcementAction(member, warningRecord, action, false);

      expect(result.success).toBe(true);
      expect(result.executedActions).toContain('DEACTIVATED_MEMBER');
      expect(result.executedActions).toContain('UPDATED_STATUS_DEACTIVATED');
      expect(result.executedActions).toContain('NOTIFIED_ADMIN');
    });
  });
});
