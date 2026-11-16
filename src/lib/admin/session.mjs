// Loads who is calling: the Better Auth session (from the shared instance) and the
// user's roles from public.user_roles. Used by src/middleware.ts for /admin/* and
// /api/admin/*, and usable by a CommonJS function through `await import()`.

import { auth, pool } from "../auth/auth.mjs";

/**
 * @param {Headers} headers  the incoming request's headers (cookie, x-nf-client-connection-ip, …)
 * @returns {Promise<{
 *   user: { id: string, email: string, name: string } | null,
 *   session: { id: string, expiresAt: Date } | null,
 *   roles: string[],
 *   setCookies: string[],
 * }>} setCookies must be copied onto the response: when the sliding session is
 *   extended (at most once a day) Better Auth re-issues the cookie with a new Max-Age.
 */
export async function loadAdminContext(headers) {
  const { headers: outHeaders, response } = await auth.api.getSession({
    headers,
    returnHeaders: true,
  });
  const setCookies = outHeaders?.getSetCookie?.() ?? [];
  if (!response?.user) return { user: null, session: null, roles: [], setCookies };

  const { rows } = await pool.query(
    "select role from public.user_roles where user_id = $1 order by role",
    [response.user.id],
  );
  const { id, email, name } = response.user;
  return {
    // Deliberately NOT the admin plugin's user.role: roles come only from user_roles.
    user: { id, email, name },
    session: { id: response.session.id, expiresAt: response.session.expiresAt },
    roles: rows.map((r) => r.role),
    setCookies,
  };
}
