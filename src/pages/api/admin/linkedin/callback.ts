// GET /api/admin/linkedin/callback?code=…&state=…: LinkedIn sends the browser back here
// after the member approves (or ?error=… when they don't). Admin only: the middleware
// refuses anyone else before this runs (401 signed out, 403 no role or social), and the
// route checks again. The `state` must match the signed cookie set by connect for this
// same user, or the request is refused with 400 and LinkedIn is never called.
// On success the encrypted token is stored (src/lib/linkedin/linkedin.mjs finishConnect)
// and the browser goes back to where Connect was pressed, ?linkedin=<notice>#linkedin.
// The state cookie is cleared on every answer.
//
// The code and state are never logged: the middleware's request span and log line carry
// the route pattern, not the URL, and nothing here logs the query.
import type { APIRoute } from "astro";
import { requireRole } from "../../../../lib/admin/roles.mjs";

export const prerender = false;

export const GET: APIRoute = async ({ locals, url, request }) => {
  const denied = requireRole(locals, "admin");
  if (denied) return denied;
  const li = await import("../../../../lib/linkedin/linkedin.mjs");
  const clear = li.stateCookieHeader("", 0);
  const headers = { "set-cookie": clear, "cache-control": "no-store" };
  if (!li.linkedInEnv().enabled) {
    return new Response("LinkedIn is not configured", { status: 503, headers: { ...headers, "content-type": "text/plain; charset=utf-8" } });
  }
  const q = url.searchParams;
  const result = await li.finishConnect(locals.user!.id, {
    code: q.get("code"),
    state: q.get("state"),
    error: q.get("error"),
    cookie: li.readStateCookie(request.headers.get("cookie")),
  });
  if ("status" in result) {
    return new Response("Bad Request: the LinkedIn sign-in could not be verified. Start again from Authenticate with LinkedIn.", {
      status: result.status, headers: { ...headers, "content-type": "text/plain; charset=utf-8" },
    });
  }
  return new Response(null, { status: 303, headers: { ...headers, location: li.returnLocation(result.returnTo, result.notice) } });
};

export const ALL: APIRoute = ({ locals }) =>
  requireRole(locals, "admin") ?? new Response("Method Not Allowed", { status: 405, headers: { allow: "GET" } });
