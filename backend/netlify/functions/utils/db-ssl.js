/**
 * Connection + TLS config for the Postgres check-in store (Neon). See ADR 0005 and
 * docs/backend/NEON_PERMISSIONS.md.
 *
 * TLS is always verified in full (chain + hostname): `rejectUnauthorized: true`.
 * Neon serves publicly-trusted certificates, so Node's default trust store is
 * enough. DB_CA_CERT (PEM) is an optional override for a host with a private CA.
 * Verification is never disabled.
 *
 * SSL is governed HERE, not by the URL. `pg` lets connection-string params
 * override the `ssl` object, and a pasted Neon URL carries `sslmode=require`, which
 * `pg` v9 will treat with weaker libpq semantics. So we strip the ssl* params
 * before handing the string to `pg`.
 */

const SSL_URL_PARAMS = ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat'];
const looksLikeCert = (s) => typeof s === 'string' && s.includes('BEGIN CERTIFICATE');

/**
 * @returns {{rejectUnauthorized: true, ca?: string}} ssl config for pg
 * @throws if DB_CA_CERT is set but is not a PEM certificate (fail closed)
 */
const getSslConfig = () => {
  const ca = process.env.DB_CA_CERT;
  if (!ca) return { rejectUnauthorized: true };
  if (!looksLikeCert(ca)) {
    throw new Error('[db-ssl] DB_CA_CERT is set but is not a PEM certificate.');
  }
  return { ca, rejectUnauthorized: true };
};

/** Remove ssl-related query params so the `ssl` object is authoritative. */
const stripSslParams = (connectionString) => {
  const url = new URL(connectionString);
  SSL_URL_PARAMS.forEach((p) => url.searchParams.delete(p));
  return url.toString();
};

/**
 * Build a pg Pool/Client config with verify-full TLS.
 * @param {string} connectionString
 * @param {object} [extra] - additional pg options (e.g. { max: 1 })
 */
const toPgConfig = (connectionString, extra = {}) => ({
  ...extra,
  connectionString: stripSslParams(connectionString),
  ssl: getSslConfig(),
});

module.exports = { getSslConfig, stripSslParams, toPgConfig };
