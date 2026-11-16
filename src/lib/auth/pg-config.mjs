// pg connection config for the admin_app pool. ESM twin of
// backend/netlify/functions/utils/db-ssl.js (which is CommonJS and stays untouched):
// TLS is verify-full (`rejectUnauthorized: true`, Node's trust store, optional
// DB_CA_CERT PEM override that fails closed), and ssl* params are stripped from the
// URL so a pasted `sslmode=require` can't weaken it.
//
// One exception: a URL whose host is loopback (localhost / 127.0.0.1 / ::1) connects
// without TLS. That is the local Docker test database (scripts/test-db.sh); Neon is
// never reached through a loopback host.

import { isLocalHost } from "./env.mjs";

const SSL_URL_PARAMS = ["sslmode", "sslcert", "sslkey", "sslrootcert", "uselibpqcompat"];

const sslConfig = (env) => {
  const ca = env.DB_CA_CERT;
  if (!ca) return { rejectUnauthorized: true };
  if (!ca.includes("BEGIN CERTIFICATE")) {
    throw new Error("[admin db] DB_CA_CERT is set but is not a PEM certificate.");
  }
  return { ca, rejectUnauthorized: true };
};

/**
 * @param {string} connectionString
 * @param {import("pg").PoolConfig} [extra]
 * @param {Record<string, string|undefined>} [env]
 * @returns {import("pg").PoolConfig}
 */
export function toAdminPgConfig(connectionString, extra = {}, env = process.env) {
  const url = new URL(connectionString);
  SSL_URL_PARAMS.forEach((p) => url.searchParams.delete(p));
  const local = isLocalHost(url.hostname);
  return {
    ...extra,
    connectionString: url.toString(),
    ssl: local ? false : sslConfig(env),
  };
}
