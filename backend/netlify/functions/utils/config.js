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
// CHECKIN_DB_URL is the POOLED connection string for the least-privilege
// `checkin_writer` role — never the owner. See docs/backend/NEON_PERMISSIONS.md.
const REQUIRED_SECRETS = {
  CHECKIN_DB_URL: env.CHECKIN_DB_URL,
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
  // Neon Postgres — the only check-in store (ADR 0005, ADR 0006).
  db: Object.freeze({
    connectionString: REQUIRED_SECRETS.CHECKIN_DB_URL,
    poolMax: Number(env.DB_POOL_MAX || 1), // serverless: one conn per instance
  }),

  http: Object.freeze({
    allowedOrigin: env.ALLOWED_ORIGIN || '*',
  }),

  isDev: env.NODE_ENV === 'development',
});

module.exports = config;
