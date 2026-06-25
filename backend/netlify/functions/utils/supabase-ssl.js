/**
 * SSL config for the Supabase Postgres connection.
 *
 * Supabase requires SSL. We use full verification (verify-full equivalent):
 * `rejectUnauthorized: true` + Supabase's CA, rather than disabling the check.
 * This is why the connection string should NOT carry `?sslmode=...` — SSL is
 * governed here by the `ssl` object, which keeps `pg` from falling back to its
 * own (CA-less) verify-full and throwing "self-signed certificate in chain".
 *
 * CA source, in order: the SUPABASE_CA_CERT env var, else the committed PEM in
 * supabase-ca.js. See docs/backend/SUPABASE_PERMISSIONS.md.
 */

const { SUPABASE_CA_PEM } = require('./supabase-ca');

const PLACEHOLDER = '__PASTE_SUPABASE_CA_PEM_HERE__';
const looksLikeCert = (s) => typeof s === 'string' && s.includes('BEGIN CERTIFICATE');

const resolveCa = () => {
  const fromEnv = process.env.SUPABASE_CA_CERT;
  if (looksLikeCert(fromEnv)) return fromEnv;
  if (SUPABASE_CA_PEM !== PLACEHOLDER && looksLikeCert(SUPABASE_CA_PEM)) return SUPABASE_CA_PEM;
  return null;
};

/**
 * @returns {{ca: string, rejectUnauthorized: true}} ssl config for pg.Pool
 * @throws if no CA certificate is configured (fail closed — never silently
 *         downgrade to an unverified connection).
 */
const getSslConfig = () => {
  const ca = resolveCa();
  if (!ca) {
    throw new Error(
      '[supabase-ssl] No Supabase CA certificate configured. Paste the dashboard ' +
      'CA into netlify/functions/utils/supabase-ca.js, or set SUPABASE_CA_CERT. ' +
      'See docs/backend/SUPABASE_PERMISSIONS.md.'
    );
  }
  return { ca, rejectUnauthorized: true };
};

module.exports = { getSslConfig };
