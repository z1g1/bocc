// CSRF check for every MUTATING admin endpoint (POST only). No database code.
//
// Layers, outermost first:
//   1. Better Auth's session cookie is SameSite=Lax, so a cross-site POST arrives
//      without it and the middleware answers 401 / a redirect.
//   2. Astro's security.checkOrigin (on by default) refuses cross-site form POSTs.
//   3. This helper: the request's Origin must be exactly BETTER_AUTH_URL's origin.
//      A missing or "null" Origin is refused too (every current browser sends Origin
//      on a POST, so only non-browser clients are affected).
//
//   export const POST: APIRoute = async ({ locals, request }) => {
//     const denied = requireRole(locals, "admin") ?? checkOrigin(request);
//     if (denied) return denied;
//     …
//   };

/** The single origin admin forms may be posted from: BETTER_AUTH_URL, normalised. */
export function expectedOrigin(env = process.env) {
  const raw = env.BETTER_AUTH_URL;
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/**
 * @param {Request} request
 * @param {{ origin?: string|null }} [opts]  defaults to expectedOrigin()
 * @returns {Response|null} null when the request may proceed; otherwise a 403 (or 405)
 */
export function checkOrigin(request, { origin = expectedOrigin() } = {}) {
  if (request.method !== "POST") return refuse(405, "Method Not Allowed", { allow: "POST" });
  const got = request.headers.get("origin");
  if (!origin || !got || got === "null" || got !== origin) {
    return refuse(403, "Forbidden: cross-origin request refused");
  }
  return null;
}

const refuse = (status, text, extra = {}) =>
  new Response(text, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...extra },
  });
