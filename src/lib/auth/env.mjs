// Environment contract for the admin app (ADR 0008). Plain ESM, no Astro APIs, so
// Astro routes, CommonJS functions (through `await import()`) and the CLI all read
// the same rules.
//
// Fail fast (ADR 0001): `readAdminEnv()` throws ONE error listing every missing or
// invalid variable. src/lib/auth/auth.mjs calls it at import, and that module is only
// ever imported lazily, on a request to an on-demand admin/auth route or by a CLI.
// The static build and the backend jest suite never import it, so they need none
// of these variables.
//
// Variables:
//   ADMIN_DB_URL        pooled Neon URL for the `admin_app` role (never the owner URL)
//   BETTER_AUTH_SECRET  >= 32 chars (`openssl rand -hex 32`); signs session cookies
//   BETTER_AUTH_URL     the site origin, no path:
//                         production  https://716coffee.club
//                         staging     https://dev--bocc-backend.netlify.app
//                         local       http://localhost:4321
//   ADMIN_DB_POOL_MAX   optional, pool size per function instance (default 3, minimum 2)
//   DB_CA_CERT          optional PEM CA override (same as the check-in function)
//
// Why BETTER_AUTH_URL has no fallback to Netlify's URL / DEPLOY_PRIME_URL: on a
// branch deploy `URL` is still the production domain, and in production
// `DEPLOY_PRIME_URL` is the main--… deploy host. Either guess would bind passkeys
// (rpID) and the CSRF origin check to the wrong host, and the Phase 0 spike found
// some Netlify metadata variables null at function runtime. An explicit value per
// deploy context (Production / Branch deploys) is the only safe choice.

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** True for loopback hosts, where plain http and non-TLS Postgres are allowed. */
export const isLocalHost = (hostname) => LOCAL_HOSTS.has(hostname);

/**
 * Validate the admin environment.
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ dbUrl: string, secret: string, baseURL: string, rpID: string, poolMax: number }}
 * @throws {Error} listing every problem at once
 */
export function readAdminEnv(env = process.env) {
  const problems = [];

  const dbUrl = env.ADMIN_DB_URL;
  if (!dbUrl) problems.push("ADMIN_DB_URL is not set (pooled admin_app connection string)");
  else {
    try {
      const u = new URL(dbUrl);
      if (!/^postgres(ql)?:$/.test(u.protocol)) problems.push("ADMIN_DB_URL must be a postgres:// URL");
    } catch {
      problems.push("ADMIN_DB_URL is not a valid URL");
    }
  }

  const secret = env.BETTER_AUTH_SECRET;
  if (!secret) problems.push("BETTER_AUTH_SECRET is not set (openssl rand -hex 32)");
  else if (secret.length < 32) problems.push("BETTER_AUTH_SECRET must be at least 32 characters");

  let baseURL;
  let rpID;
  const rawUrl = env.BETTER_AUTH_URL;
  if (!rawUrl) problems.push("BETTER_AUTH_URL is not set (the site origin, e.g. https://716coffee.club)");
  else {
    try {
      const u = new URL(rawUrl);
      if (u.pathname !== "/" || u.search || u.hash) {
        problems.push("BETTER_AUTH_URL must be an origin with no path, query or fragment");
      } else if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocalHost(u.hostname))) {
        problems.push("BETTER_AUTH_URL must use https (plain http only for localhost)");
      } else {
        baseURL = u.origin;
        rpID = u.hostname;
      }
    } catch {
      problems.push("BETTER_AUTH_URL is not a valid URL");
    }
  }

  let poolMax = 3;
  if (env.ADMIN_DB_POOL_MAX !== undefined && env.ADMIN_DB_POOL_MAX !== "") {
    poolMax = Number(env.ADMIN_DB_POOL_MAX);
    // At least 2: a password reset holds one connection (its audit transaction) while
    // Better Auth writes on another.
    if (!Number.isInteger(poolMax) || poolMax < 2) problems.push("ADMIN_DB_POOL_MAX must be an integer of at least 2");
  }

  if (problems.length) {
    throw new Error(`[admin env] Misconfigured:\n  - ${problems.join("\n  - ")}`);
  }
  return { dbUrl, secret, baseURL, rpID, poolMax };
}
