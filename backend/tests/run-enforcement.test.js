/**
 * Unit tests for runEnforcement filterEmail parameter and photo-added detection
 * Ensures the manual endpoint only processes the specified email
 * and detects members who have added photos since last enforcement run
 */

// Mock all dependencies before requiring the module
jest.mock('../netlify/functions/utils/circle', () => ({
  getAllMembers: jest.fn()
}));

jest.mock('../netlify/functions/utils/airtable-warnings', () => ({
  findWarningByEmail: jest.fn(),
  getActiveWarnings: jest.fn()
}));

jest.mock('../netlify/functions/utils/enforcement-logic', () => ({
  determineEnforcementAction: jest.fn(),
  processEnforcementAction: jest.fn()
}));

const { getAllMembers } = require('../netlify/functions/utils/circle');
const { findWarningByEmail, getActiveWarnings } = require('../netlify/functions/utils/airtable-warnings');
const { determineEnforcementAction, processEnforcementAction } = require('../netlify/functions/utils/enforcement-logic');
const { runEnforcement } = require('../netlify/functions/profile-photo-enforcement');

// Members without photos (no avatar_url)
const mockMembersNoPhoto = [
  { id: '1', email: 'alice@example.com', name: 'Alice', avatar_url: null },
  { id: '2', email: 'bob@example.com', name: 'Bob', avatar_url: null },
  { id: '3', email: 'carol@example.com', name: 'Carol', avatar_url: null }
];

// All members (includes members with photos)
const mockAllMembers = [
  ...mockMembersNoPhoto,
  { id: '4', email: 'dave@example.com', name: 'Dave', avatar_url: 'https://example.com/dave.jpg' },
  { id: '5', email: 'eve@example.com', name: 'Eve', avatar_url: 'https://example.com/eve.jpg' }
];

beforeEach(() => {
  jest.clearAllMocks();
  // Return all members (including those with photos)
  getAllMembers.mockResolvedValue(mockAllMembers);
  // No active warnings by default
  getActiveWarnings.mockResolvedValue([]);
  findWarningByEmail.mockResolvedValue(null);
  determineEnforcementAction.mockReturnValue({
    action: 'CREATE_WARNING',
    warningLevel: 1,
    reason: 'New warning',
    shouldNotifyAdmin: false
  });
  processEnforcementAction.mockResolvedValue({
    success: true,
    executedActions: ['Created warning'],
    errors: []
  });
});

describe('runEnforcement filterEmail', () => {
  test('no filter processes all no-photo members', async () => {
    const summary = await runEnforcement(true);

    expect(summary.totalMembers).toBe(3);
    expect(summary.processed).toBe(3);
    expect(processEnforcementAction).toHaveBeenCalledTimes(3);
  });

  test('filter matching one email processes only that member', async () => {
    const summary = await runEnforcement(true, 'bob@example.com');

    expect(summary.totalMembers).toBe(1);
    expect(summary.processed).toBe(1);
    // Only 1 call for warning loop (no photo-added since no active warnings)
    expect(processEnforcementAction).toHaveBeenCalledTimes(1);
    expect(processEnforcementAction).toHaveBeenCalledWith(
      mockAllMembers[1],
      null,
      expect.objectContaining({ action: 'CREATE_WARNING' }),
      true
    );
  });

  test('filter matching no emails processes zero members', async () => {
    const summary = await runEnforcement(true, 'nobody@example.com');

    expect(summary.totalMembers).toBe(0);
    expect(summary.processed).toBe(0);
    expect(processEnforcementAction).toHaveBeenCalledTimes(0);
  });

  test('filter is case-insensitive', async () => {
    const summary = await runEnforcement(true, 'ALICE@EXAMPLE.COM');

    expect(summary.totalMembers).toBe(1);
    expect(summary.processed).toBe(1);
    expect(processEnforcementAction).toHaveBeenCalledWith(
      mockAllMembers[0],
      null,
      expect.objectContaining({ action: 'CREATE_WARNING' }),
      true
    );
  });
});

describe('runEnforcement photo-added detection', () => {
  test('member with active warning who now has a photo triggers PHOTO_ADDED', async () => {
    // Dave has a photo and has an active warning
    const activeWarnings = [
      {
        id: 'recWarningDave',
        fields: { 'Email': 'dave@example.com', 'Status': 'Active', 'Number of warnings': 2 }
      }
    ];
    getActiveWarnings.mockResolvedValue(activeWarnings);

    // When determineEnforcementAction is called for Dave (photo-added path),
    // it should return PHOTO_ADDED
    determineEnforcementAction.mockImplementation((member, warning) => {
      if (member.has_profile_picture === true) {
        return {
          action: 'PHOTO_ADDED',
          warningLevel: 0,
          reason: 'Member added profile photo since last enforcement run',
          shouldNotifyAdmin: false
        };
      }
      return {
        action: 'CREATE_WARNING',
        warningLevel: 1,
        reason: 'New warning',
        shouldNotifyAdmin: false
      };
    });

    const summary = await runEnforcement(true);

    // 3 no-photo members + 1 photo-added member
    expect(summary.processed).toBe(4);
    expect(summary.actions.PHOTO_ADDED).toBe(1);
    expect(summary.actions.CREATE_WARNING).toBe(3);

    // Verify processEnforcementAction was called for Dave with the warning record
    expect(processEnforcementAction).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'dave@example.com', has_profile_picture: true }),
      activeWarnings[0],
      expect.objectContaining({ action: 'PHOTO_ADDED' }),
      true
    );
  });

  test('member with active warning who still lacks a photo is not processed in photo-added step', async () => {
    // Alice has no photo and has an active warning
    const activeWarnings = [
      {
        id: 'recWarningAlice',
        fields: { 'Email': 'alice@example.com', 'Status': 'Active', 'Number of warnings': 1 }
      }
    ];
    getActiveWarnings.mockResolvedValue(activeWarnings);

    const summary = await runEnforcement(true);

    // 3 no-photo members processed in warning loop, 0 in photo-added step
    // (alice@example.com is in the no-photo set so should NOT trigger photo-added)
    expect(summary.processed).toBe(3);
    expect(summary.actions.PHOTO_ADDED).toBe(0);
  });

  test('filterEmail is respected in the photo-added step', async () => {
    // Dave and Eve both have photos and active warnings
    const activeWarnings = [
      {
        id: 'recWarningDave',
        fields: { 'Email': 'dave@example.com', 'Status': 'Active', 'Number of warnings': 2 }
      },
      {
        id: 'recWarningEve',
        fields: { 'Email': 'eve@example.com', 'Status': 'Active', 'Number of warnings': 1 }
      }
    ];
    getActiveWarnings.mockResolvedValue(activeWarnings);

    determineEnforcementAction.mockImplementation((member, warning) => {
      if (member.has_profile_picture === true) {
        return {
          action: 'PHOTO_ADDED',
          warningLevel: 0,
          reason: 'Member added profile photo',
          shouldNotifyAdmin: false
        };
      }
      return {
        action: 'CREATE_WARNING',
        warningLevel: 1,
        reason: 'New warning',
        shouldNotifyAdmin: false
      };
    });

    // Filter to dave only
    const summary = await runEnforcement(true, 'dave@example.com');

    // 0 no-photo members match filter + 1 photo-added member matches filter
    expect(summary.totalMembers).toBe(0);
    expect(summary.processed).toBe(1);
    expect(summary.actions.PHOTO_ADDED).toBe(1);

    // Eve should NOT have been processed
    expect(processEnforcementAction).not.toHaveBeenCalledWith(
      expect.objectContaining({ email: 'eve@example.com' }),
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
  });

  test('members with Deactivated warning status are not affected', async () => {
    // getActiveWarnings only returns Status=Active records,
    // so Deactivated records never enter the photo-added step
    const activeWarnings = [];
    getActiveWarnings.mockResolvedValue(activeWarnings);

    const summary = await runEnforcement(true);

    // Only the 3 no-photo members in the warning loop
    expect(summary.processed).toBe(3);
    expect(summary.actions.PHOTO_ADDED).toBe(0);
  });

  test('warning with email not found in allMembers is skipped', async () => {
    // Warning for a member who left the community
    const activeWarnings = [
      {
        id: 'recWarningGone',
        fields: { 'Email': 'gone@example.com', 'Status': 'Active', 'Number of warnings': 3 }
      }
    ];
    getActiveWarnings.mockResolvedValue(activeWarnings);

    const summary = await runEnforcement(true);

    // 3 no-photo members processed, gone@example.com skipped (not in allMembers)
    expect(summary.processed).toBe(3);
    expect(summary.actions.PHOTO_ADDED).toBe(0);
  });
});
