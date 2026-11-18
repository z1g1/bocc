// Response headers for the private routes: /admin/*, /api/admin/*, /api/auth/*,
// /login/ and /logout. No database code.
//
// CSP: first-party only. Login and passkeys need nothing beyond 'self' (WebAuthn is
// a browser API; the ceremony talks to /api/auth on the same origin). No analytics,
// no third-party fonts, nothing may frame these pages (frame-ancestors; X-Frame-Options
// is left to the site-wide netlify.toml rule so the two never disagree).
//
// The one exception is the media bucket (ADR 0010): when storage is configured, its
// origin (src/lib/admin/storage.mjs storageOrigin) is added to img-src (gallery images
// through presigned GETs) and connect-src (presigned PUTs from fetch), plus blob: in
// img-src for previews of the browser-resized copies, and media-src for the promo
// video player (Phase 5; the same presigned GETs).

/**
 * @param {{ dev?: boolean, mediaOrigin?: string|null }} [opts]
 *   dev relaxes script-src for Vite's inline dev scripts; mediaOrigin is the bucket's
 *   origin (from storageOrigin()), or null/undefined when media is off
 */
export function adminCsp({ dev = false, mediaOrigin = null } = {}) {
  const media = mediaOrigin ? ` ${new URL(mediaOrigin).origin}` : "";
  return [
    "default-src 'self'",
    `script-src 'self'${dev ? " 'unsafe-inline'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data:${media ? ` blob:${media}` : ""}`,
    "font-src 'self'",
    `media-src 'self'${media}`,
    `connect-src 'self'${media}`,
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
 * @param {{ setCookies?: string[], dev?: boolean, mediaOrigin?: string|null }} [opts]
 */
export function withPrivateHeaders(response, { setCookies = [], dev = false, mediaOrigin = null } = {}) {
  const out = new Response(response.body, response); // headers may be immutable on the original
  out.headers.set("X-Robots-Tag", "noindex, nofollow");
  out.headers.set("Cache-Control", "no-store");
  out.headers.set("Referrer-Policy", "same-origin");
  out.headers.set("X-Content-Type-Options", "nosniff");
  if (!out.headers.has("Content-Security-Policy")) {
    out.headers.set("Content-Security-Policy", adminCsp({ dev, mediaOrigin }));
  }
  for (const c of setCookies) out.headers.append("Set-Cookie", c);
  return out;
}
