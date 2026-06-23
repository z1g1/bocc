/**
 * Tests for the config adapter (utils/config.js).
 *
 * The module validates required secrets AT IMPORT, so each test manipulates
 * process.env, resets the module registry, and re-requires it fresh.
 * See docs/adr/0001-config-fail-fast-at-import.md.
 */

const CONFIG_PATH = '../netlify/functions/utils/config';

const REQUIRED = [
  'AIRTABLE_API_KEY',
  'AIRTABLE_BASE_ID',
  'CIRCLE_API_TOKEN',
  'CIRCLE_HEADLESS_API',
];

const TOUCHED = [
  ...REQUIRED,
  'BOT_USER_EMAIL',
  'ADMIN_MEMBER_ID',
  'HARD_LIMIT_MAX_MEMBERS',
  'ALLOWED_ORIGIN',
];

describe('config adapter', () => {
  let saved;

  beforeEach(() => {
    jest.resetModules();
    saved = {};
    TOUCHED.forEach((k) => { saved[k] = process.env[k]; });
  });

  afterEach(() => {
    TOUCHED.forEach((k) => {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    });
  });

  const setRequired = () => REQUIRED.forEach((k) => { process.env[k] = `test-${k}`; });

  test('loads a deeply frozen config when all required secrets are present', () => {
    setRequired();
    const config = require(CONFIG_PATH);

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.circle)).toBe(true);
    expect(config.airtable.apiKey).toBe('test-AIRTABLE_API_KEY');
    expect(config.circle.adminBaseUrl).toBe('https://app.circle.so/api/admin/v2');
  });

  test('throws at import listing every missing required secret', () => {
    REQUIRED.forEach((k) => delete process.env[k]);

    let error;
    try {
      require(CONFIG_PATH);
    } catch (e) {
      error = e;
    }

    expect(error).toBeDefined();
    REQUIRED.forEach((k) => expect(error.message).toContain(k));
  });

  test('throws when even one required secret is missing', () => {
    setRequired();
    delete process.env.CIRCLE_HEADLESS_API;

    expect(() => require(CONFIG_PATH)).toThrow(/CIRCLE_HEADLESS_API/);
  });

  test('identity values fall back to defaults but honor env overrides', () => {
    setRequired();
    process.env.BOT_USER_EMAIL = 'override@example.com';
    delete process.env.ADMIN_MEMBER_ID;

    const config = require(CONFIG_PATH);
    expect(config.bot.email).toBe('override@example.com');
    expect(config.enforcement.adminMemberId).toBe('2d8e9215');
  });

  test('safety limits are NOT env-overridable', () => {
    setRequired();
    process.env.HARD_LIMIT_MAX_MEMBERS = '99999';

    const config = require(CONFIG_PATH);
    expect(config.enforcement.warnThreshold).toBe(500);
    expect(config.enforcement.hardLimit).toBe(1000);
  });

  test('allowedOrigin defaults to "*" and honors env override', () => {
    setRequired();
    delete process.env.ALLOWED_ORIGIN;
    expect(require(CONFIG_PATH).http.allowedOrigin).toBe('*');

    jest.resetModules();
    setRequired();
    process.env.ALLOWED_ORIGIN = 'https://716coffee.club';
    expect(require(CONFIG_PATH).http.allowedOrigin).toBe('https://716coffee.club');
  });
});
