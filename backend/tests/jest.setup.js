/**
 * Jest global setup — runs before any module is imported (via `setupFiles`).
 *
 * The suite mocks the Airtable/Circle/axios modules, so it never makes real API
 * calls. But utils/config.js validates the required secrets AT IMPORT and throws
 * if any are missing (see docs/adr/0001-config-fail-fast-at-import.md). These
 * dummy values let config.js import cleanly under test.
 *
 * Only set a var if the real environment hasn't already provided one, so
 * integration runs (RUN_INTEGRATION_TESTS=true with real tokens) are untouched.
 */
const dummySecrets = {
  AIRTABLE_API_KEY: 'test-airtable-key',
  AIRTABLE_BASE_ID: 'test-base-id',
  CIRCLE_API_TOKEN: 'test-circle-admin-token',
  CIRCLE_HEADLESS_API: 'test-circle-headless-token',
};

for (const [key, value] of Object.entries(dummySecrets)) {
  if (!process.env[key]) {
    process.env[key] = value;
  }
}

// Pin the check-in store mode for every test file. setupFiles runs before each
// file's config import, so this guarantees a clean baseline even if a prior file in
// the same worker mutated CHECKIN_STORE. 'airtable' is pinned (not the production
// default 'postgres') because the handler suites mock utils/airtable.js and have no
// DB URL. The postgres default is covered by config.test.js and
// check-in-stores.test.js, which override this locally.
process.env.CHECKIN_STORE = 'airtable';
