// Logs an admin/auth failure to the function log (Netlify → Logs → Functions → ssr)
// and returns a bare 500. Without this, a config or database error at startup reached
// the client as an empty 500 and left nothing in the log (production, 2026-11-17).
// readAdminEnv's messages name the variable, never its value; any connection string
// in an error message is still redacted, in case a driver error quotes one.

// The line is JSON with the request's trace id (src/lib/telemetry.mjs log()).

import { describeError, log, setError } from "../telemetry.mjs";

/**
 * @param {string} where  short label, e.g. "middleware" or "api/auth"
 * @param {unknown} err
 * @returns {Response}
 */
export function adminFailure(where, err) {
  const detail = describeError(err);
  setError(detail);
  log("error", `[admin] ${where} failed: ${detail}`);
  return new Response("Internal Server Error", {
    status: 500,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
