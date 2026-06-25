/**
 * Config adapter — the single contract with the environment.
 *
 * Reads every secret + operational constant once, validates the required
 * secrets, and exports a frozen config object. No other module should touch
 * `process.env`.
 *
 * Validation fails fast AT IMPORT: a Netlify function missing a required secret
 * throws immediately at cold start with one aggregated error, before any
 * half-built client exists. See docs/adr/0001-config-fail-fast-at-import.md.
 *
 * Tests run with no env vars; tests/jest.setup.js seeds dummy secrets so the
 * suite can import this module. See CONTEXT.md → "Config adapter" seam.
 */

const env = process.env;

// --- Required secrets (no default; missing → fail fast) ---------------------
const REQUIRED_SECRETS = {
  AIRTABLE_API_KEY: env.AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID: env.AIRTABLE_BASE_ID,
  CIRCLE_API_TOKEN: env.CIRCLE_API_TOKEN,
  CIRCLE_HEADLESS_API: env.CIRCLE_HEADLESS_API,
};

const missing = Object.entries(REQUIRED_SECRETS)
  .filter(([, value]) => !value)
  .map(([name]) => name);

if (missing.length > 0) {
  throw new Error(
    `[config] Missing required environment variable(s): ${missing.join(', ')}. ` +
    `Set them in the Netlify dashboard (or tests/jest.setup.js for the test suite). ` +
    `See docs/adr/0001-config-fail-fast-at-import.md.`
  );
}

// One concise boot summary replaces the per-module 'Exists / Not set' logs.
console.log('[config] Required secrets present:', Object.keys(REQUIRED_SECRETS).join(', '));

// --- Frozen config object ---------------------------------------------------
const config = Object.freeze({
  airtable: Object.freeze({
    apiKey: REQUIRED_SECRETS.AIRTABLE_API_KEY,
    baseId: REQUIRED_SECRETS.AIRTABLE_BASE_ID,
    endpointUrl: 'https://api.airtable.com', // stable vendor endpoint
  }),

  // Supabase Postgres — the post-migration transactional store (ADR 0003).
  // OPTIONAL at boot: the Supabase path is opt-in until Phase 1 cutover, so a
  // missing connection string does not fail config. utils/supabase-store.js
  // throws a clear error if asked to connect without it. The connection string
  // points at the least-privilege `checkin_writer` role via the transaction
  // pooler — never service_role. See docs/backend/SUPABASE_PERMISSIONS.md.
  supabase: Object.freeze({
    connectionString: env.SUPABASE_CHECKIN_WRITER_URL || null,
    poolMax: Number(env.SUPABASE_POOL_MAX || 1), // serverless: one conn per instance
  }),

  circle: Object.freeze({
    adminToken: REQUIRED_SECRETS.CIRCLE_API_TOKEN,
    headlessToken: REQUIRED_SECRETS.CIRCLE_HEADLESS_API,
    // Stable vendor endpoints (app.circle.so is the LIVE server; api.circle.so
    // and api-headless.circle.so are docs sites, NOT API endpoints).
    adminBaseUrl: 'https://app.circle.so/api/admin/v2',
    headlessBaseUrl: 'https://app.circle.so',
    authBaseUrl: 'https://app.circle.so/api/v1/headless',
  }),

  // Env-overridable identities — default to the current production values so no
  // new required env is introduced. Promote to required env if a distinct
  // staging community ever needs different identities (see ADR-0001 context).
  bot: Object.freeze({
    id: env.BOT_USER_ID || '73e5a590',
    email: env.BOT_USER_EMAIL || 'bocc-bot@zackglick.com',
    name: env.BOT_USER_NAME || '716.social Bot',
  }),

  enforcement: Object.freeze({
    adminMemberId: env.ADMIN_MEMBER_ID || '2d8e9215', // circle@zackglick.com
    testUserEmail: env.TEST_USER_EMAIL || 'zglicka@gmail.com',
    // Shared secret required to trigger the manual enforcement endpoint over
    // HTTP. Optional at boot; when unset the manual endpoint fails closed
    // (rejects all calls). Not used by the scheduled cron run.
    triggerToken: env.ENFORCEMENT_TRIGGER_TOKEN || null,
    // Safety guards are deliberately NOT env-overridable: raising the cap should
    // require a reviewed code change. See docs/backend/SAFETY_LIMITS_SPECIFICATION.md.
    warnThreshold: 500, // log alert but continue
    hardLimit: 1000,    // throw and stop
  }),

  http: Object.freeze({
    allowedOrigin: env.ALLOWED_ORIGIN || '*',
  }),

  isDev: env.NODE_ENV === 'development',
});

module.exports = config;
