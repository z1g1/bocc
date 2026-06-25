# Supabase Permissions

Required permissions, roles, and key handling for BOCC's Supabase Postgres store.
Mirrors the policy in the root `CLAUDE.md`: **least privilege, never the full admin
key, document the exact permissions, verify with restricted creds in a test project
first.** Decision context: ADR 0003 (datastore) and ADR 0004 (streak model).

## Identities (principle of least privilege)

| Identity | Used by | Privileges | Notes |
|---|---|---|---|
| `checkin_writer` | the check-in Netlify function | `USAGE` on `public`; `SELECT, INSERT` on `attendees`, `checkins`; `SELECT` on `held_occurrences`, `streaks` | No `DELETE`, no `UPDATE`, no DDL, no other schema. Created by migration `…120200`. |
| `service_role` | **nothing** | (bypasses RLS) | **Do not use.** It is the "full admin key" the policy forbids. Keep its key out of Netlify entirely. |
| `anon` / `authenticated` | nothing (browser never hits Supabase) | none | RLS-denied + grants revoked by migration `…120200`. |

The browser continues to POST to `/.netlify/functions/checkin`; it never holds a
Supabase key. Only the server-side function talks to Postgres.

## Connection — pick ONE path, enable it out-of-band

The migration creates `checkin_writer` as `NOLOGIN`. Enable exactly one access path
manually so no secret lands in git:

- **(a) Direct Postgres via the Supabase pooler (recommended for serverless).**
  ```sql
  alter role checkin_writer login password '<generated-strong-secret>';
  ```
  Connect with the `pg` driver using the **Transaction pooler** connection string
  (port `6543`) to survive Netlify's serverless connection churn. Store the full
  connection string as `SUPABASE_CHECKIN_WRITER_URL` in Netlify (never committed).

- **(b) PostgREST / `supabase-js` with a custom-role JWT.** Mint a short-lived JWT
  signed with the project JWT secret containing `{"role":"checkin_writer"}`
  server-side. The migration already runs `grant checkin_writer to authenticator`.
  Store the JWT secret as `SUPABASE_JWT_SECRET` in Netlify.

Path (a) is the cleaner least-privilege mapping (role = privileges, no token
minting) and is the default recommendation.

## TLS / SSL (verify-full, not disabled)

Supabase enforces SSL. We verify the full chain + hostname against Supabase's CA
rather than disabling verification (`rejectUnauthorized: false` is **not** used).

- The connection string carries **no `sslmode`** — SSL is configured in code
  (`utils/supabase-ssl.js`) so `pg` doesn't fall back to a CA-less `verify-full`
  and throw `self-signed certificate in certificate chain`.
- The CA is the **public** Supabase cert (download: dashboard → Database → SSL
  Configuration). Provide it one of two ways:
  - paste the PEM into `netlify/functions/utils/supabase-ca.js` (committed; esbuild
    bundles it into the function), **or**
  - set `SUPABASE_CA_CERT` to the PEM (env var; takes precedence).
- If no CA is configured, the connection **fails closed** — it never silently
  downgrades to an unverified connection.

Note: passwords with special characters must be **URL-encoded** in the connection
string (e.g. `^` → `%5E`, `%` → `%25`). A hex password (`openssl rand -hex 32`)
avoids this entirely.

## Required environment variables (Netlify, never committed)

| Var | Path | Purpose |
|---|---|---|
| `SUPABASE_URL` | both | project URL |
| `SUPABASE_CHECKIN_WRITER_URL` | (a) | pooler connection string for `checkin_writer` |
| `SUPABASE_JWT_SECRET` | (b) | sign the custom-role JWT |

`service_role` / `SUPABASE_SERVICE_ROLE_KEY` is intentionally **absent**.

## What the check-in function does with these grants

1. `INSERT … ON CONFLICT DO NOTHING` into `attendees` (find-or-create by lowercased
   email), then `SELECT` the row.
2. `INSERT … ON CONFLICT DO NOTHING` into `checkins`; "no row returned" ⇒ same-day
   duplicate (DB-enforced by `checkins_dedup_key`).
3. `SELECT current_streak, longest_streak, is_personal_best FROM streaks WHERE
   attendee_id = $1 AND event_id = $2` for the celebration (blocking but non-fatal —
   a failure here never fails the check-in).

`SELECT/INSERT` is sufficient for all of the above; that is the entire grant.

## Verification checklist (do this in a test project first)

- [ ] As `anon` (public key): `select * from attendees` → **permission denied / 0 rows**.
- [ ] As `checkin_writer`: insert an attendee + check-in → **succeeds**.
- [ ] As `checkin_writer`: `delete from checkins` / `update attendees …` → **denied**.
- [ ] As `checkin_writer`: `select * from streaks` → **succeeds**.
- [ ] `service_role` key is **not** present in Netlify env.
- [ ] Backfill dry-run row counts match Airtable before the real cutover.
