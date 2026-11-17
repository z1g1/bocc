// Request handler behind /api/auth/* (src/pages/api/auth/[...all].ts).
//
// The admin plugin's HTTP endpoints (/api/auth/admin/*: create-user, set-role,
// impersonate-user, …) are refused here before Better Auth sees them. They already
// refuse everyone, because nobody holds the plugin's own "admin" role, but the app
// never relies on that column (ADR 0008 decision 4). Server code reaches the plugin
// through src/lib/admin/users.mjs instead.

const BLOCKED = /^\/api\/auth\/admin(\/|$)/;

/** @param {Request} request */
export async function handleAuthRequest(request) {
  const { pathname } = new URL(request.url);
  if (BLOCKED.test(pathname)) {
    return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
  }
  try {
    const { auth } = await import("./auth.mjs");
    return await auth.handler(request);
  } catch (err) {
    const { adminFailure } = await import("../admin/log.mjs");
    return adminFailure("api/auth", err);
  }
}
