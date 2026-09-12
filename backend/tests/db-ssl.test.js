// Unit tests for utils/db-ssl.js — TLS must always be verify-full, and ssl params
// in a pasted connection string must never override the code-governed ssl object.

const { getSslConfig, stripSslParams, toPgConfig } = require('../netlify/functions/utils/db-ssl');

describe('db-ssl', () => {
  const prevCa = process.env.DB_CA_CERT;
  afterEach(() => {
    if (prevCa === undefined) delete process.env.DB_CA_CERT; else process.env.DB_CA_CERT = prevCa;
  });

  test('verifies against the default trust store when no CA override is set', () => {
    delete process.env.DB_CA_CERT;
    expect(getSslConfig()).toEqual({ rejectUnauthorized: true });
  });

  test('uses a PEM CA override when provided', () => {
    process.env.DB_CA_CERT = '-----BEGIN CERTIFICATE-----\nMIIDUMMY\n-----END CERTIFICATE-----';
    expect(getSslConfig()).toEqual({ ca: process.env.DB_CA_CERT, rejectUnauthorized: true });
  });

  test('fails closed on a malformed CA override', () => {
    process.env.DB_CA_CERT = 'not-a-cert';
    expect(() => getSslConfig()).toThrow(/not a PEM certificate/);
  });

  test('strips sslmode but keeps other params', () => {
    const out = stripSslParams(
      'postgresql://u:p@ep-x-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require'
    );
    expect(out).not.toMatch(/sslmode/);
    expect(out).toMatch(/channel_binding=require/);
    expect(out).toMatch(/^postgresql:\/\/u:p@ep-x-pooler\.us-east-2\.aws\.neon\.tech\/neondb/);
  });

  test('toPgConfig merges extra options with verify-full ssl', () => {
    delete process.env.DB_CA_CERT;
    const cfg = toPgConfig('postgresql://u:p@host/db?sslmode=disable', { max: 1 });
    expect(cfg).toEqual({
      max: 1,
      connectionString: 'postgresql://u:p@host/db',
      ssl: { rejectUnauthorized: true },
    });
  });
});
