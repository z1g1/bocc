-- Migration 0014 — social_checker reads LinkedIn connection expiry for the Thursday
-- check (ADR 0012, issue #24).
--
-- Applied by backend/scripts/migrate.js in ONE transaction; plain grants, so it also
-- applies on a vanilla Postgres (scripts/test-db.sh).
--
-- The Thursday social check (src/lib/social-alert/run.mjs) pushes an ntfy alert when a
-- LinkedIn connection has under 10 days left or has expired, naming whose it is. It
-- needs the expiry and the user link to name it, and nothing else:
--
--   social_checker
--     SELECT (user_id, expires_at) on public.linkedin_connections: never the token
--                   ciphertext, member URN, LinkedIn display name or scope
--     USAGE on schema auth, SELECT (id, name) on auth."user": the Admin's name for the
--                   alert; never the email, sessions, accounts or passkeys
--   Still no INSERT/UPDATE/DELETE anywhere.

grant select (user_id, expires_at) on public.linkedin_connections to social_checker;

grant usage on schema "auth" to social_checker;
grant select (id, name) on "auth"."user" to social_checker;
