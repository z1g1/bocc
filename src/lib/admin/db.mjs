// Admin data layer seam (ADR 0008 decision 6). Every admin query runs as `admin_app`
// on the ONE pool owned by src/lib/auth/auth.mjs. Parameterized SQL only.
//
// What admin_app may do (migration 20261116120000_admin_auth.sql):
//   attendees           SELECT; UPDATE only (ok_to_email, name, business_name, phone)
//   checkins            SELECT
//   held_occurrences,
//   streaks             SELECT
//   user_roles          SELECT, INSERT, DELETE
//   audit_log           SELECT, INSERT (append-only; a trigger refuses UPDATE/DELETE)
//   events,
//   event_reports       SELECT, INSERT, UPDATE (migration 20261118120000_events_media.sql)
//   event_media         SELECT, INSERT, UPDATE, DELETE
//   event_links         SELECT, INSERT, UPDATE, DELETE (migration 20261121120000_event_links_site_reader.sql)
//   social_posts,
//   social_post_channels SELECT, INSERT, UPDATE (migration 20261122120000_social_posts.sql)
//   linkedin_connections SELECT, INSERT, UPDATE, DELETE (migration 20261124120000_linkedin_connections.sql)
//   linkedin_events     SELECT, INSERT, UPDATE (migration 20261129120000_linkedin_events.sql; no DELETE:
//                       allow-retry retires a pending row)
//   auth.*              Better Auth's tables
// Anything else is refused by Postgres, whatever the app code says.
//
// Rule: every change goes through withAudit(), so the change and its audit_log row
// commit or roll back together. Sensitive reads (e.g. the email-list CSV export) are
// audited the same way.
//
//   import { withAudit } from "../../lib/admin/db.mjs";
//   await withAudit(locals.user.id, async (client) => {
//     const { rowCount } = await client.query(
//       "update attendees set ok_to_email = false where id = $1", [attendeeId]);
//     if (rowCount !== 1) throw new Error("attendee not found");   // rolls back
//   }, { action: "attendee.opt_out", targetTable: "attendees", targetId: attendeeId });

import { pool } from "../auth/auth.mjs";
import { event, span } from "../telemetry.mjs";

export { pool };

// Tracing (src/lib/telemetry.mjs): the pool is instrumented in auth.mjs, so every
// query below is a "db.query" span; withAudit() adds a "db.transaction" span around
// its queries and an "audit" span event with the action when it commits.

/**
 * One-off read on the shared pool.
 * @param {string} text
 * @param {unknown[]} [params]
 */
export function query(text, params) {
  return pool.query(text, params);
}

/**
 * @typedef {object} AuditEntry
 * @property {string} action          e.g. "attendee.update", "email_list.export", "user_role.grant"
 * @property {string} [targetTable]   e.g. "attendees"
 * @property {string} [targetId]      the row's id, as text
 * @property {Record<string, unknown>} [details]  stored as jsonb; never put passwords or tokens here
 */

/**
 * Insert one audit row with the given client (or the pool).
 * Prefer withAudit(); use this only inside a transaction you already manage.
 * @param {{ query: Function }} db
 * @param {string|null} actorUserId  auth."user".id, or null for the operator CLI
 * @param {AuditEntry} entry
 */
export async function writeAudit(db, actorUserId, entry) {
  if (!entry || typeof entry.action !== "string" || entry.action === "") {
    throw new Error("audit entry needs an action");
  }
  const { rows } = await db.query(
    `insert into public.audit_log (actor_user_id, action, target_table, target_id, details)
     values ($1, $2, $3, $4, $5)
     returning id, occurred_at`,
    [
      actorUserId ?? null,
      entry.action,
      entry.targetTable ?? null,
      entry.targetId == null ? null : String(entry.targetId),
      JSON.stringify(entry.details ?? {}),
    ],
  );
  return rows[0];
}

/**
 * Run `fn` and its audit insert in ONE transaction on one pooled client.
 * If `fn` throws, or the audit insert fails, everything rolls back and the error is
 * rethrown. `auditEntry` may be a function of fn's result (e.g. to record a new id).
 *
 * @template T
 * @param {string|null} actorUserId
 * @param {(client: import("pg").PoolClient) => Promise<T>} fn
 * @param {AuditEntry | ((result: T) => AuditEntry)} auditEntry
 * @returns {Promise<T>}
 */
export function withAudit(actorUserId, fn, auditEntry) {
  return span("db.transaction", { "db.system": "postgresql" }, () => runAudited(actorUserId, fn, auditEntry));
}

/** withAudit's body. */
async function runAudited(actorUserId, fn, auditEntry) {
  const client = await pool.connect();
  let broken;
  try {
    await client.query("begin");
    const result = await fn(client);
    const entry = typeof auditEntry === "function" ? auditEntry(result) : auditEntry;
    await writeAudit(client, actorUserId, entry);
    await client.query("commit");
    event("audit", { action: entry.action, target_table: entry.targetTable });
    return result;
  } catch (err) {
    try {
      await client.query("rollback");
    } catch (rollbackErr) {
      broken = rollbackErr; // the connection is unusable; drop it from the pool
    }
    throw err;
  } finally {
    client.release(broken);
  }
}
