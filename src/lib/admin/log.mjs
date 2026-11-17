// Logs an admin/auth failure to the function log (Netlify → Logs → Functions → ssr)
// and returns a bare 500. Without this, a config or database error at startup reached
// the client as an empty 500 and left nothing in the log (production, 2026-11-17).
// readAdminEnv's messages name the variable, never its value; any connection string
// in an error message is still redacted, in case a driver error quotes one.

const redact = (text) => String(text).replace(/postgres(ql)?:\/\/\S+/gi, "<redacted-url>");

/**
 * @param {string} where  short label, e.g. "middleware" or "api/auth"
 * @param {unknown} err
 * @returns {Response}
 */
export function adminFailure(where, err) {
  const e = /** @type {any} */ (err);
  const detail = e && typeof e === "object" ? `${e.name ?? "Error"}: ${e.message ?? ""}${e.code ? ` (${e.code})` : ""}` : String(err);
  console.error(`[admin] ${where} failed: ${redact(detail)}`);
  return new Response("Internal Server Error", {
    status: 500,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
