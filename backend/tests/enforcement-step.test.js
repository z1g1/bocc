// Tests for the per-member enforcement step extracted from runEnforcement
// (candidate 05). recordOutcome is pure; enforceMember orchestrates the
// decision + execution, so enforcement-logic is mocked.

jest.mock('../netlify/functions/utils/enforcement-logic', () => ({
  determineEnforcementAction: jest.fn(),
  processEnforcementAction: jest.fn(),
}));

const { enforceMember, recordOutcome } = require('../netlify/functions/profile-photo-enforcement');
const { determineEnforcementAction, processEnforcementAction } = require('../netlify/functions/utils/enforcement-logic');

const freshSummary = () => ({
  processed: 0,
  errors: 0,
  finalWarnings: 0,
  deactivations: 0,
  actions: { CREATE_WARNING: 0, INCREMENT_WARNING: 0, DEACTIVATE: 0, PHOTO_ADDED: 0, SKIP: 0 },
  errorDetails: [],
});

describe('enforceMember', () => {
  beforeEach(() => jest.clearAllMocks());

  test('decides the action then executes it, returning both', async () => {
    const action = { action: 'CREATE_WARNING', warningLevel: 1, reason: 'no photo' };
    const result = { success: true, executedActions: ['Created warning'], errors: [] };
    determineEnforcementAction.mockReturnValue(action);
    processEnforcementAction.mockResolvedValue(result);

    const member = { email: 'a@b.com', name: 'A' };
    const out = await enforceMember(member, null, false);

    expect(determineEnforcementAction).toHaveBeenCalledWith(member, null);
    expect(processEnforcementAction).toHaveBeenCalledWith(member, null, action, false);
    expect(out).toEqual({ action, result });
  });
});

describe('recordOutcome', () => {
  test('success increments processed and the action counter', () => {
    const summary = freshSummary();
    recordOutcome(summary, { email: 'a@b.com' }, { action: 'CREATE_WARNING', warningLevel: 1 },
      { success: true, executedActions: ['x'], errors: [] });

    expect(summary.processed).toBe(1);
    expect(summary.actions.CREATE_WARNING).toBe(1);
    expect(summary.errors).toBe(0);
  });

  test('a 4th warning needing admin notice counts as a final warning', () => {
    const summary = freshSummary();
    recordOutcome(summary, { email: 'a@b.com' }, { action: 'INCREMENT_WARNING', warningLevel: 4, shouldNotifyAdmin: true },
      { success: true, executedActions: ['x'], errors: [] });

    expect(summary.finalWarnings).toBe(1);
  });

  test('a DEACTIVATE action counts as a deactivation', () => {
    const summary = freshSummary();
    recordOutcome(summary, { email: 'a@b.com' }, { action: 'DEACTIVATE', warningLevel: 4 },
      { success: true, executedActions: ['x'], errors: [] });

    expect(summary.deactivations).toBe(1);
    expect(summary.actions.DEACTIVATE).toBe(1);
  });

  test('failure increments errors and records the detail', () => {
    const summary = freshSummary();
    recordOutcome(summary, { email: 'a@b.com' }, { action: 'CREATE_WARNING', warningLevel: 1 },
      { success: false, executedActions: [], errors: ['boom'] });

    expect(summary.errors).toBe(1);
    expect(summary.processed).toBe(0);
    expect(summary.errorDetails).toEqual([{ member: 'a@b.com', action: 'CREATE_WARNING', errors: ['boom'] }]);
  });
});
