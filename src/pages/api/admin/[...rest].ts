// Every /api/admin/* path no other route matches: a plain JSON 404, never an HTML page
// (without this, an unknown path would get the public site's prerendered 404). On
// demand, so the middleware's guard runs first: signed out -> 401, no role -> 403, a non-admin role -> 403
// (its allowlist, roles.mjs ROLE_PATHS).
// Astro ranks a rest parameter below every static or named route, so this never
// shadows a real admin API.
import type { APIRoute } from "astro";
import { requireRole } from "../../../lib/admin/roles.mjs";

export const prerender = false;

export const ALL: APIRoute = ({ locals }) => {
  const denied = requireRole(locals, "admin", "social", "email");
  if (denied) return denied;
  return Response.json({ error: "not found" }, { status: 404, headers: { "cache-control": "no-store" } });
};
