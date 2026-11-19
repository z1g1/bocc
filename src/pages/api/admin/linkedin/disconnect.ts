// POST /api/admin/linkedin/disconnect (form: return=account|YYYY-MM-DD): delete the
// signed-in Admin's LinkedIn connection, audited (src/lib/linkedin/linkedin.mjs
// disconnect). Admin only, Origin-checked. 303 back with ?linkedin=disconnected
// (or unchanged)#linkedin; the page links to LinkedIn's Permitted services page, where
// the member removes the app's access on LinkedIn's side.
import type { APIRoute } from "astro";
import { requireRole } from "../../../../lib/admin/roles.mjs";
import { checkOrigin } from "../../../../lib/admin/csrf.mjs";

export const prerender = false;

export const POST: APIRoute = async ({ locals, request }) => {
  const denied = requireRole(locals, "admin") ?? checkOrigin(request);
  if (denied) return denied;
  const li = await import("../../../../lib/linkedin/linkedin.mjs");
  let returnTo: string | null = null;
  try {
    returnTo = li.parseReturnTo((await request.formData()).get("return"));
  } catch { /* falls through to 400 */ }
  if (!returnTo) {
    return new Response("Bad Request: return must be account or a date", { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  const { changed } = await li.disconnect(locals.user!.id);
  return new Response(null, { status: 303, headers: { location: li.returnLocation(returnTo, changed ? "disconnected" : "unchanged") } });
};

export const ALL: APIRoute = ({ locals }) =>
  requireRole(locals, "admin") ?? new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
