// User-admin seam (ADR 0008 decisions 3 and 4): create accounts, reset passwords and
// assign roles. Server-side only. The CALLER must already have checked
// requireRole(locals, "admin"); nothing here checks roles, and the admin plugin's own
// `role` column is never consulted.
//
//   createUser({ email, name, password })         -> { id, email, name }
//   setUserPassword(userId, newPassword, opts?)   -> void (revokes sessions by default)
//   grantRole(client, userId, role)               -> boolean (false if already held)
//   revokeRole(client, userId, role)              -> boolean (false if not held)
//   getUserRoles(db, userId)                      -> string[]
//   listUsersWithRoles()                          -> [{ id, email, name, createdAt, roles }]
//
// grantRole/revokeRole take a client so they run inside withAudit():
//   await withAudit(locals.user.id, (c) => grantRole(c, userId, "social"),
//     { action: "user_role.grant", targetTable: "user_roles", targetId: userId, details: { role: "social" } });
//
// createUser and setUserPassword go through Better Auth on the same pool but their
// own connection, so they can't share a withAudit() transaction. Write their audit row
// right after (writeAudit / withAudit). A user created without a role sees nothing.

import { auth, pool } from "../auth/auth.mjs";
import { ROLES } from "./roles.mjs";

const assertRole = (role) => {
  if (!ROLES.includes(role)) throw new Error(`unknown role "${role}"`);
};

/** Better Auth's own length limits (minPasswordLength is set in auth.mjs). */
async function assertPasswordLength(password) {
  const { minPasswordLength, maxPasswordLength } = (await auth.$context).password.config;
  if (typeof password !== "string" || password.length < minPasswordLength) {
    throw new Error(`password is too short: at least ${minPasswordLength} characters`);
  }
  if (password.length > maxPasswordLength) {
    throw new Error(`password is too long: at most ${maxPasswordLength} characters`);
  }
}

/**
 * Create a password account. Signup is disabled, so this uses the admin plugin's
 * createUser, called server-side without request headers (the plugin allows that).
 * The plugin only checks the MAXIMUM password length, so the minimum is checked here.
 * @param {{ email: string, name: string, password: string }} input
 */
export async function createUser({ email, name, password }) {
  await assertPasswordLength(password);
  const { user } = await auth.api.createUser({
    body: { email: String(email).trim().toLowerCase(), name: String(name).trim(), password },
  });
  return { id: user.id, email: user.email, name: user.name };
}

/**
 * Admin password reset. Uses Better Auth's own hashing and internal adapter: the
 * plugin's setUserPassword endpoint would check the plugin `role` column, which we
 * never set. By default every session of the user is revoked.
 * @param {string} userId
 * @param {string} newPassword
 * @param {{ revokeSessions?: boolean }} [opts]
 */
export async function setUserPassword(userId, newPassword, { revokeSessions = true } = {}) {
  await assertPasswordLength(newPassword);
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.findUserById(userId);
  if (!user) throw new Error("user not found");
  const hash = await ctx.password.hash(newPassword);
  if (await ctx.internalAdapter.findCredentialAccount(userId)) {
    await ctx.internalAdapter.updatePassword(userId, hash);
  } else {
    await ctx.internalAdapter.createAccount({
      userId, providerId: "credential", accountId: userId, password: hash,
    });
  }
  if (revokeSessions) await ctx.internalAdapter.deleteUserSessions(userId);
}

/** @returns {Promise<boolean>} true if the role was added */
export async function grantRole(client, userId, role) {
  assertRole(role);
  const { rowCount } = await client.query(
    "insert into public.user_roles (user_id, role) values ($1, $2) on conflict do nothing",
    [userId, role],
  );
  return rowCount === 1;
}

/** @returns {Promise<boolean>} true if the role was removed */
export async function revokeRole(client, userId, role) {
  assertRole(role);
  const { rowCount } = await client.query(
    "delete from public.user_roles where user_id = $1 and role = $2",
    [userId, role],
  );
  return rowCount === 1;
}

/** @param {{ query: Function }} db  the pool or a client */
export async function getUserRoles(db, userId) {
  const { rows } = await db.query(
    "select role from public.user_roles where user_id = $1 order by role",
    [userId],
  );
  return rows.map((r) => r.role);
}

export async function listUsersWithRoles() {
  const { rows } = await pool.query(
    `select u.id, u.email, u.name, u."createdAt" as "createdAt",
            coalesce(array_agg(r.role order by r.role) filter (where r.role is not null), '{}') as roles
       from auth."user" u
       left join public.user_roles r on r.user_id = u.id
      group by u.id
      order by u.email`,
  );
  return rows;
}
