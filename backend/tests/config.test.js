/**
 * Tests for the config adapter (utils/config.js).
 *
 * The module validates required secrets AT IMPORT, so each test manipulates
 * process.env, resets the module registry, and re-requires it fresh.
 * See docs/adr/0001-config-fail-fast-at-import.md.
 */

const CONFIG_PATH = '../netlify/functions/utils/config';

const DB_URL = 'postgres://checkin_writer@pooler/test';
const TOUCHED = ['CHECKIN_DB_URL', 'DB_POOL_MAX', 'ALLOWED_ORIGIN'];

describe('config adapter', () => {
  let saved;

  beforeEach(() => {
    jest.resetModules();
    saved = {};
    TOUCHED.forEach((k) => { saved[k] = process.env[k]; });
    process.env.CHECKIN_DB_URL = DB_URL;
    delete process.env.DB_POOL_MAX;
  });

  afterEach(() => {
    TOUCHED.forEach((k) => {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    });
  });

  test('loads a deeply frozen config when the required secret is present', () => {
    const config = require(CONFIG_PATH);

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.db)).toBe(true);
    expect(config.db.connectionString).toBe(DB_URL);
    expect(config.db.poolMax).toBe(1);
  });

  test('throws at import when CHECKIN_DB_URL is missing', () => {
    delete process.env.CHECKIN_DB_URL;

    expect(() => require(CONFIG_PATH)).toThrow(/CHECKIN_DB_URL/);
  });

  test('needs no Circle or Airtable secrets', () => {
    const config = require(CONFIG_PATH);
    expect(config.circle).toBeUndefined();
    expect(config.airtable).toBeUndefined();
  });

  test('allowedOrigin defaults to "*" and honors env override', () => {
    delete process.env.ALLOWED_ORIGIN;
    expect(require(CONFIG_PATH).http.allowedOrigin).toBe('*');

    jest.resetModules();
    process.env.ALLOWED_ORIGIN = 'https://716coffee.club';
    expect(require(CONFIG_PATH).http.allowedOrigin).toBe('https://716coffee.club');
  });
});
