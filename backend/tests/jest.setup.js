/**
 * Jest global setup — runs before any module is imported (via `setupFiles`).
 *
 * The suite mocks `pg` and utils/pg-store.js, so it never touches a real database.
 * But utils/config.js validates the required secrets AT IMPORT and throws if any
 * are missing (see docs/adr/0001-config-fail-fast-at-import.md). This dummy value
 * lets config.js import cleanly under test.
 *
 * Only set a var if the real environment hasn't already provided one.
 */
const dummySecrets = {
  CHECKIN_DB_URL: 'postgres://checkin_writer@pooler/test',
};

for (const [key, value] of Object.entries(dummySecrets)) {
  if (!process.env[key]) {
    process.env[key] = value;
  }
}
