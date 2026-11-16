// Response headers for the private routes: /admin/*, /api/admin/*, /api/auth/*,
// /login/ and /logout. No database code.
//
// CSP: first-party only. Login and passkeys need nothing beyond 'self' (WebAuthn is
// a browser API; the ceremony talks to /api/auth on the same origin). No analytics,
// no third-party fonts, nothing may frame these pages (frame-ancestors; X-Frame-Options
// is left to the site-wide netlify.toml rule so the two never disagree).

/** @param {{ dev?: boolean }} [opts] dev relaxes script-src for Vite's inline dev scripts */
export function adminCsp({ dev = false } = {}) {
  return [
    "default-src 'self'",
    `script-src 'self'${dev ? " 'unsafe-inline'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join("; ");
}

/**
 * Copy `response` with the private headers set, plus any Set-Cookie values from a
 * session refresh.
 * @param {Response} response
 * @param {{ setCookies?: string[], dev?: boolean }} [opts]
 */
export function withPrivateHeaders(response, { setCookies = [], dev = false } = {}) {
  const out = new Response(response.body, response); // headers may be immutable on the original
  out.headers.set("X-Robots-Tag", "noindex, nofollow");
  out.headers.set("Cache-Control", "no-store");
  out.headers.set("Referrer-Policy", "same-origin");
  out.headers.set("X-Content-Type-Options", "nosniff");
  if (!out.headers.has("Content-Security-Policy")) {
    out.headers.set("Content-Security-Policy", adminCsp({ dev }));
  }
  for (const c of setCookies) out.headers.append("Set-Cookie", c);
  return out;
}
