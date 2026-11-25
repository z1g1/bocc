// GET /api/admin/me: who is signed in and their roles. The smallest example of an
// admin API route: the middleware has already returned 401 (no session) or 403 (no
// role); the route still names the roles it admits.
import type { APIRoute } from "astro";
import { ROLES, requireRole } from "../../../lib/admin/roles.mjs";

export const prerender = false;

export const GET: APIRoute = ({ locals }) => {
  const denied = requireRole(locals, ...ROLES);
  if (denied) return denied;
  return Response.json({ user: locals.user, roles: locals.roles });
};
