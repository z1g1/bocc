// Environment contract for the LinkedIn authentication (ADR 0012 decision 4, issue #23).
// Plain ESM, no Astro APIs, no imports.
//
// Variables (Netlify env, both Production and Branch deploys unless noted):
//   LINKEDIN_CLIENT_ID      the existing LinkedIn app's client id
//   LINKEDIN_CLIENT_SECRET  its client secret (sent only in the token request's body)
//   LINKEDIN_TOKEN_KEY      32 random bytes, as 64 hex characters (`openssl rand -hex 32`)
//                           or base64. Encrypts the access tokens at rest (AES-256-GCM)
//                           and signs the OAuth `state` cookie (separate HKDF-derived keys)
//   LINKEDIN_LIVE           "1" in Production only: the app may call LinkedIn's write
//                           endpoints. Unset everywhere else (dry run, ADR 0012 decision 5)
//
// Fail fast (ADR 0001): a partial or invalid configuration throws ONE error listing
// every problem, naming variables and never values. With none of the three set the
// feature is simply off ({ enabled: false }), like media storage, so a deploy or test
// run without LinkedIn still works and the page says LinkedIn isn't configured.

const REQUIRED = ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET", "LINKEDIN_TOKEN_KEY"];
const HEX_KEY = /^[0-9a-fA-F]{64}$/;
const B64_KEY = /^[A-Za-z0-9+/_-]{43}=?$/;

/**
 * @typedef {object} LinkedInConfig
 * @property {string} clientId
 * @property {string} clientSecret
 * @property {Buffer} tokenKey   32 bytes
 * @property {boolean} live      LINKEDIN_LIVE=1
 */

/** The 32-byte key from hex or base64(url), or null. */
function decodeKey(raw) {
  if (HEX_KEY.test(raw)) return Buffer.from(raw, "hex");
  if (B64_KEY.test(raw)) {
    const buf = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (buf.length === 32) return buf;
  }
  return null;
}

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ enabled: true, config: LinkedInConfig } | { enabled: false, message: string }}
 * @throws {Error} when the variables are partly set or invalid
 */
export function readLinkedInEnv(env = process.env) {
  const set = (k) => env[k] !== undefined && env[k] !== "";
  if (![...REQUIRED, "LINKEDIN_LIVE"].some(set)) {
    return { enabled: false, message: `LinkedIn is not configured (set ${REQUIRED.join(", ")}).` };
  }
  const problems = REQUIRED.filter((k) => !set(k)).map((k) => `${k} is not set`);

  let tokenKey = null;
  if (set("LINKEDIN_TOKEN_KEY")) {
    tokenKey = decodeKey(env.LINKEDIN_TOKEN_KEY);
    if (!tokenKey) problems.push("LINKEDIN_TOKEN_KEY must be 32 bytes, as 64 hex characters (openssl rand -hex 32) or base64");
  }
  if (set("LINKEDIN_LIVE") && env.LINKEDIN_LIVE !== "1") problems.push('LINKEDIN_LIVE must be "1" or unset');

  if (problems.length) throw new Error(`[linkedin env] Misconfigured:\n  - ${problems.join("\n  - ")}`);
  return {
    enabled: true,
    config: {
      clientId: env.LINKEDIN_CLIENT_ID,
      clientSecret: env.LINKEDIN_CLIENT_SECRET,
      tokenKey,
      live: env.LINKEDIN_LIVE === "1",
    },
  };
}
