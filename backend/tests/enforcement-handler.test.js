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

  test('rejects an anonymous request (no cron signal, no token) with 401', async () => {
    const handler = makeEnforcementHandler();
    const res = await handler({ headers: {}, queryStringParameters: {} });

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('Unauthorized');
  });

  test('rejects with 401 when the token is wrong', async () => {
    const handler = makeEnforcementHandler();
    const res = await handler({ headers: { 'x-enforcement-token': 'wrong' } });

    expect(res.statusCode).toBe(401);
  });

  test('allows the run when the token matches', async () => {
    const handler = makeEnforcementHandler({ filterEmail: 'test@example.com' });
    const res = await handler({
      headers: { 'x-enforcement-token': 'secret-token' },
      queryStringParameters: { dryRun: 'true' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
  });

  test('allows a genuine Netlify scheduled invocation (X-NF-Event) without a token', async () => {
    const handler = makeEnforcementHandler();
    const res = await handler({
      headers: { 'X-NF-Event': 'schedule' },
      queryStringParameters: { dryRun: 'true' },
    });

    expect(res.statusCode).toBe(200);
  });

  test('a spoofed token cannot stand in for the cron signal', async () => {
    // The only paths to 200 are the (unspoofable) X-NF-Event header or a valid
    // token; a wrong token with no cron signal must still be rejected.
    const handler = makeEnforcementHandler();
    const res = await handler({ headers: { 'x-enforcement-token': 'not-it' } });

    expect(res.statusCode).toBe(401);
  });

  test('emits no permissive CORS header', async () => {
    const handler = makeEnforcementHandler();
    const res = await handler({ headers: { 'X-NF-Event': 'schedule' }, queryStringParameters: { dryRun: 'true' } });

    expect(res.headers['Access-Control-Allow-Origin']).toBeUndefined();
  });
});
