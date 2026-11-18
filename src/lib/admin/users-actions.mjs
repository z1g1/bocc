// /admin/users/ (ADR 0008 decision 4, plan Phase 2): list users, create a user with a
// role, reset a password, grant and revoke roles. Admin role only. The page
// (src/pages/admin/users/index.astro) is a thin shell over usersPage() so the whole
// flow can be tested without Astro (tests/admin/users-admin.test.mjs).
//
// Every mutation is a form POST that must carry an Origin equal to BETTER_AUTH_URL
// (checkOrigin in the shared src/lib/admin/csrf.mjs).
// Each one writes an audit_log row. Passwords never go into audit details, logs or
// redirects. After a change the page answers 303 to a GET (post/redirect/get).
//
// Atomicity:
//   - grant / revoke: the role change and its audit row are ONE transaction
//     (withAudit). A revoke of "admin" takes a table lock first, so two admins revoking
//     each other at once can't leave zero admins.
//   - create: Better Auth writes the user on its own connection (createUser), so it
//     can't join the withAudit() transaction that grants the role and writes the audit
//     row. If that transaction fails, the new auth user is deleted again, so a user
//     never exists without the role and audit row the admin asked for.
//   - reset: the audit row is inserted first in an open transaction, then
//     setUserPassword runs (Better Auth's adapter, its own connection, revokes every
//     session), then the transaction commits. A failed reset rolls the audit row back;
//     a reset can't happen without its audit row unless the final COMMIT itself fails.

import { ROLES, requireRole } from "./roles.mjs";
import { checkOrigin } from "./csrf.mjs";
import { log } from "../telemetry.mjs";

/** Fixed notices for the redirect after a change (?done=…); nothing user-supplied is echoed. */
export const NOTICES = Object.freeze({
  created: "User created.",
  reset: "Password reset. Their sessions were signed out.",
  granted: "Role granted.",
  revoked: "Role removed.",
  unchanged: "Nothing to change.",
});

const MAX_NAME = 100;
const MAX_EMAIL = 254;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class UserActionError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => { throw new UserActionError(status, message); };

const plain = (status, text) =>
  new Response(text, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });

const field = (form, name) => {
  const v = form.get(name);
  return typeof v === "string" ? v : "";
};

const roleField = (form) => {
  const role = field(form, "role");
  if (!ROLES.includes(role)) fail(400, `Role must be one of: ${ROLES.join(", ")}.`);
  return role;
};

const userIdField = (form) => {
  const id = field(form, "userId").trim();
  if (!id || id.length > 200) fail(400, "Missing user.");
  return id;
};

/** Better Auth's APIError keeps the readable text in body.message. */
const authMessage = (err) => err?.body?.message ?? err?.message ?? "Unknown error";

async function userExists(db, userId) {
  const { rowCount } = await db.query(`select 1 from auth."user" where id = $1`, [userId]);
  return rowCount === 1;
}

async function createAction(form, actorId) {
  const { createUser, grantRole } = await import("./users.mjs");
  const { withAudit, query } = await import("./db.mjs");
  const email = field(form, "email").trim().toLowerCase();
  const name = field(form, "name").trim();
  const password = field(form, "password");
  const role = roleField(form);
  if (!EMAIL.test(email) || email.length > MAX_EMAIL) fail(400, "Enter a valid email address.");
  if (!name || name.length > MAX_NAME) fail(400, `Enter a name (at most ${MAX_NAME} characters).`);

  let user;
  try {
    user = await createUser({ email, name, password });
  } catch (err) {
    const msg = authMessage(err);
    if (/already exists/i.test(msg)) fail(409, "A user with that email already exists.");
    if (/password is too (short|long)/i.test(msg)) fail(400, msg.replace(/^password/, "Password"));
    throw err;
  }
  try {
    await withAudit(actorId, (client) => grantRole(client, user.id, role), {
      action: "user.create",
      targetTable: "auth.user",
      targetId: user.id,
      details: { email: user.email, name: user.name, role },
    });
  } catch (err) {
    // Undo: a user without the role and audit row must not be left behind.
    // (admin_app may DELETE in auth.*; the FK cascades remove the credential account.)
    await query(`delete from auth."user" where id = $1`, [user.id]).catch((undoErr) => {
      log("error", `[admin users] could not remove half-created user: ${undoErr.message}`, { user_id: user.id });
    });
    throw err;
  }
  return "created";
}

async function resetAction(form, actorId) {
  const { setUserPassword } = await import("./users.mjs");
  const { writeAudit, pool } = await import("./db.mjs");
  const userId = userIdField(form);
  const password = field(form, "password");
  if (!(await userExists(pool, userId))) fail(404, "That user no longer exists.");
  // Audit row first, in a transaction left open across the reset (see "Atomicity").
  const client = await pool.connect();
  let broken;
  try {
    await client.query("begin");
    await writeAudit(client, actorId, {
      action: "user.password_reset",
      targetTable: "auth.user",
      targetId: userId,
      details: { sessionsRevoked: true },
    });
    try {
      await setUserPassword(userId, password, { revokeSessions: true });
    } catch (err) {
      const msg = authMessage(err);
      if (/password is too (short|long)/i.test(msg)) fail(400, msg.replace(/^password/, "Password"));
      if (/user not found/i.test(msg)) fail(404, "That user no longer exists.");
      throw err;
    }
    await client.query("commit");
  } catch (err) {
    try {
      await client.query("rollback");
    } catch (rollbackErr) {
      broken = rollbackErr;
    }
    throw err;
  } finally {
    client.release(broken);
  }
  return "reset";
}

async function grantAction(form, actorId) {
  const { grantRole } = await import("./users.mjs");
  const { withAudit } = await import("./db.mjs");
  const userId = userIdField(form);
  const role = roleField(form);
  // A no-op is not written to the audit log: withAudit rolls back when fn throws.
  const NOOP = Symbol("noop");
  try {
    await withAudit(actorId, async (client) => {
      if (!(await userExists(client, userId))) fail(404, "That user no longer exists.");
      if (!(await grantRole(client, userId, role))) throw NOOP;
    }, { action: "user_role.grant", targetTable: "user_roles", targetId: userId, details: { role } });
  } catch (err) {
    if (err === NOOP) return "unchanged";
    throw err;
  }
  return "granted";
}

async function revokeAction(form, actorId) {
  const { revokeRole } = await import("./users.mjs");
  const { withAudit } = await import("./db.mjs");
  const userId = userIdField(form);
  const role = roleField(form);
  const NOOP = Symbol("noop");
  try {
    await withAudit(actorId, async (client) => {
      if (role === "admin") {
        // Serializes admin revokes (this mode conflicts with itself; admin_app's DELETE
        // grant is enough to take it). SELECT … FOR UPDATE would need UPDATE.
        await client.query("lock table public.user_roles in share row exclusive mode");
      }
      if (!(await revokeRole(client, userId, role))) throw NOOP;
      if (role === "admin") {
        const { rows } = await client.query(
          "select count(*)::int as n from public.user_roles where role = 'admin'");
        if (rows[0].n === 0) fail(409, "That is the last admin. Make someone else an admin first.");
      }
    }, { action: "user_role.revoke", targetTable: "user_roles", targetId: userId, details: { role } });
  } catch (err) {
    if (err === NOOP) return "unchanged";
    throw err;
  }
  return "revoked";
}

const ACTIONS = { create: createAction, reset: resetAction, grant: grantAction, revoke: revokeAction };

/**
 * Everything /admin/users/ does, for one request.
 * @param {Request} request
 * @param {{ user?: { id: string }|null, roles?: string[] }} locals  set by the middleware
 * @param {{ expectedOrigin?: string }} [opts]  defaults to BETTER_AUTH_URL's origin
 * @returns {Promise<
 *   { response: Response } |
 *   { response: null, status: number, users: object[], notice: string|null, error: string|null,
 *     form: { email: string, name: string, role: string } }>}
 */
export async function usersPage(request, locals, opts = {}) {
  const denied = requireRole(locals, "admin");
  if (denied) return { response: denied };

  const url = new URL(request.url);
  let status = 200;
  let error = null;
  let form = { email: "", name: "", role: "social" };

  if (request.method === "POST") {
    const expectedOrigin = opts.expectedOrigin ?? (await import("../auth/auth.mjs")).adminEnv.baseURL;
    const bad = checkOrigin(request, { origin: expectedOrigin });
    if (bad) return { response: bad };

    let data;
    try {
      data = await request.formData();
    } catch {
      return { response: plain(400, "Bad request") };
    }
    const action = ACTIONS[field(data, "action")];
    if (!action) return { response: plain(400, "Bad request: unknown action") };
    try {
      const done = await action(data, locals.user.id);
      return {
        response: new Response(null, { status: 303, headers: { location: `/admin/users/?done=${done}` } }),
      };
    } catch (err) {
      if (!(err instanceof UserActionError)) {
        log("error", `[admin users] ${field(data, "action")} failed: ${err?.message}`, { action: field(data, "action") });
        throw err;
      }
      status = err.status;
      error = err.message;
      if (field(data, "action") === "create") {
        // Re-fill the create form, never the password.
        form = { email: field(data, "email"), name: field(data, "name"), role: field(data, "role") };
      }
    }
  } else if (request.method !== "GET" && request.method !== "HEAD") {
    return { response: new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } }) };
  }

  const { listUsersWithRoles } = await import("./users.mjs");
  const users = await listUsersWithRoles();
  const notice = NOTICES[url.searchParams.get("done") ?? ""] ?? null;
  return { response: null, status, users, notice: error ? null : notice, error, form };
}
