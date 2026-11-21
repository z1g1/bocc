// GET /api/admin/linkedin/connect?return=account|YYYY-MM-DD: start the
// signed-in Admin's LinkedIn authentication (ADR 0012 decision 4, issue #23). Sets the signed,
// HttpOnly, 10-minute state cookie and 302s to LinkedIn's authorize page. A GET link,
// not a form: the admin CSP's form-action 'self' would block a POST that redirects to
// linkedin.com. It changes nothing in the database, so no Origin check is needed.
//   302 -> https://www.linkedin.com/oauth/v2/authorization?…   400 bad return · 401/403 · 503 not configured
import type { APIRoute } from "astro";
import { requireRole } from "../../../../lib/admin/roles.mjs";

export const prerender = false;

const text = (status: number, body: string) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

export const GET: APIRoute = async ({ locals, url }) => {
  const denied = requireRole(locals, "admin");
  if (denied) return denied;
  const li = await import("../../../../lib/linkedin/linkedin.mjs");
  const returnTo = li.parseReturnTo(url.searchParams.get("return"));
  if (!returnTo) return text(400, "Bad Request: return must be account or a date");
  const env = li.linkedInEnv();
  if (!env.enabled) return text(503, env.message);
  const { location, cookie } = li.startConnect(locals.user!.id, { returnTo });
  return new Response(null, {
    status: 302,
    headers: { location, "set-cookie": li.stateCookieHeader(cookie.value, cookie.maxAge), "cache-control": "no-store" },
  });
};

export const ALL: APIRoute = ({ locals }) =>
  requireRole(locals, "admin") ?? new Response("Method Not Allowed", { status: 405, headers: { allow: "GET" } });
