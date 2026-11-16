// Shared helpers for the admin DB tests. Run through scripts/test-db.sh, which starts
// a throwaway Postgres, applies every migration with backend/scripts/migrate.js and
// passes TEST_OWNER_URL / TEST_ADMIN_URL / TEST_CHECKIN_URL / DB_CA_CERT_FILE.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";

for (const k of ["TEST_OWNER_URL", "TEST_ADMIN_URL", "TEST_CHECKIN_URL"]) {
  if (!process.env[k]) throw new Error(`${k} is not set: run these tests with npm run test:db`);
}

export const OWNER_URL = process.env.TEST_OWNER_URL;
export const ADMIN_URL = process.env.TEST_ADMIN_URL;
export const CHECKIN_URL = process.env.TEST_CHECKIN_URL;
export const BASE_URL = "http://localhost:4321";

/** Point the shared auth module at the test DB as admin_app. Call before importing it. */
export function useAdminEnv() {
  process.env.ADMIN_DB_URL = ADMIN_URL;
  process.env.BETTER_AUTH_URL = BASE_URL;
  process.env.BETTER_AUTH_SECRET ??= randomBytes(32).toString("hex");
}

/** A single connection as the given role; remember to end() it. */
export async function connect(url) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

/** Run `fn` in a transaction that is always rolled back. */
export async function inRollback(client, fn) {
  await client.query("begin");
  try {
    return await fn();
  } finally {
    await client.query("rollback");
  }
}

/** Assert that a statement is refused (in a savepoint, so the transaction survives). */
export async function assertRefused(client, sql, params = [], pattern = /permission denied|append-only|violates row-level security/) {
  await client.query("savepoint s");
  try {
    await assert.rejects(client.query(sql, params), pattern, `expected refusal: ${sql}`);
  } finally {
    await client.query("rollback to savepoint s");
  }
}

/** Assert that a statement succeeds (in a savepoint that is rolled back). */
export async function assertAllowed(client, sql, params = []) {
  await client.query("savepoint s");
  try {
    return await client.query(sql, params);
  } finally {
    await client.query("rollback to savepoint s");
  }
}

export const unique = (prefix) => `${prefix}-${randomBytes(4).toString("hex")}`;

/** Seed one attendee + check-in as the owner; returns their ids. */
export async function seedAttendee(owner, overrides = {}) {
  const email = overrides.email ?? `${unique("seed")}@example.com`;
  const { rows: [a] } = await owner.query(
    `insert into attendees (email, name, phone, business_name, ok_to_email)
     values ($1, $2, $3, $4, true) returning id`,
    [email, "Seed Person", "716-555-0100", "Seed Co"],
  );
  const { rows: [c] } = await owner.query(
    `insert into checkins (attendee_id, event_id, token, checkin_date)
     values ($1, 'bocc', 'tok', current_date) returning id`,
    [a.id],
  );
  return { attendeeId: a.id, checkinId: c.id, email };
}
