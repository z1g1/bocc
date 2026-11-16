// Post-login destination check. Pure and dependency-free: it is bundled into the
// browser script of /login/ as well as used on the server (src/lib/admin/guard.mjs).

/** Only same-site /admin paths are allowed as a post-login destination. */
export function safeNext(next) {
  if (typeof next !== "string") return "/admin/";
  if (!/^\/admin(\/|$|\?)/.test(next) || next.startsWith("//") || next.includes("\\")) {
    return "/admin/";
  }
  return next;
}
