#!/usr/bin/env node
/**
 * Apply SQL migrations in backend/db/migrations to the Postgres check-in store.
 *
 * Runs as the database OWNER (DDL + role creation), never as checkin_writer, and
 * is an operator-only tool: the owner URL lives in a local gitignored env file and
 * is NEVER set in Netlify. Each file runs in its own transaction and is recorded in
 * `schema_migrations`, so re-running only applies new files.
 *
 * Usage (from backend/):
 *   node --env-file=../.env.local scripts/migrate.js            # apply pending
 *   node --env-file=../.env.local scripts/migrate.js --status   # list, no writes
 *
 * Env: DATABASE_URL_UNPOOLED (preferred for DDL) or DATABASE_URL.
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { toPgConfig } = require('../netlify/functions/utils/db-ssl');

const STATUS_ONLY = process.argv.includes('--status');
const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  console.error('Missing DATABASE_URL_UNPOOLED / DATABASE_URL (owner connection string).');
  process.exit(1);
}

(async () => {
  const client = new Client(toPgConfig(url));
  try {
    await client.connect();
    await client.query(
      `create table if not exists schema_migrations (
         filename   text primary key,
         applied_at timestamptz not null default now()
       )`
    );
    // schema_migrations is operator bookkeeping; the app role must never see it.
    await client.query('revoke all on schema_migrations from public');

    const applied = new Set(
      (await client.query('select filename from schema_migrations')).rows.map((r) => r.filename)
    );
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`  applied   ${file}`);
        continue;
      }
      if (STATUS_ONLY) {
        console.log(`  pending   ${file}`);
        continue;
      }
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (filename) values ($1)', [file]);
        await client.query('commit');
        console.log(`  APPLIED   ${file}`);
      } catch (err) {
        await client.query('rollback');
        throw new Error(`${file}: ${err.message}`);
      }
    }
    console.log('done');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
})();
