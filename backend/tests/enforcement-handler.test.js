// Tests for the enforcement handler factory's auth gate (security hardening).
// The heavy dependencies are mocked so runEnforcement completes trivially;
// config is re-read per test via resetModules so the trigger token can be set.

jest.mock('../netlify/functions/utils/circle', () => ({
  getAllMembers: jest.fn().mockResolvedValue([]),
}));
jest.mock('../netlify/functions/utils/airtable-warnings', () => ({
  findWarningByEmail: jest.fn(),
  getActiveWarnings: jest.fn().mockResolvedValue([]),
}));
jest.mock('../netlify/functions/utils/enforcement-logic', () => ({
  determineEnforcementAction: jest.fn(),
  processEnforcementAction: jest.fn(),
}));

describe('makeEnforcementHandler — token gate', () => {
  let makeEnforcementHandler;

  beforeEach(() => {
    jest.resetModules();
    process.env.ENFORCEMENT_TRIGGER_TOKEN = 'secret-token';
    ({ makeEnforcementHandler } = require('../netlify/functions/profile-photo-enforcement'));
  });

  afterEach(() => {
    delete process.env.ENFORCEMENT_TRIGGER_TOKEN;
  });

  test('rejects with 401 when the token header is missing', async () => {
    const handler = makeEnforcementHandler({ requireToken: true });
    const res = await handler({ headers: {} });

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('Unauthorized');
  });

  test('rejects with 401 when the token is wrong', async () => {
    const handler = makeEnforcementHandler({ requireToken: true });
    const res = await handler({ headers: { 'x-enforcement-token': 'wrong' } });

    expect(res.statusCode).toBe(401);
  });

  test('allows the run when the token matches', async () => {
    const handler = makeEnforcementHandler({ requireToken: true });
    const res = await handler({
      headers: { 'x-enforcement-token': 'secret-token' },
      queryStringParameters: { dryRun: 'true' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
  });

  test('scheduled handler runs without requiring a token', async () => {
    const handler = makeEnforcementHandler();
    const res = await handler({ queryStringParameters: { dryRun: 'true' } });

    expect(res.statusCode).toBe(200);
  });

  test('emits no permissive CORS header', async () => {
    const handler = makeEnforcementHandler();
    const res = await handler({ queryStringParameters: { dryRun: 'true' } });

    expect(res.headers['Access-Control-Allow-Origin']).toBeUndefined();
  });
});
