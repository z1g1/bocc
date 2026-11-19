-- Migration 0014 — social_checker reads LinkedIn connection expiry for the Thursday
-- check (ADR 0012, issue #24).
--
-- Applied by backend/scripts/migrate.js in ONE transaction; plain grants, so it also
-- applies on a vanilla Postgres (scripts/test-db.sh).
--
-- The Thursday social check (src/lib/social-alert/run.mjs) pushes an ntfy alert when a
-- LinkedIn connection has under 10 days left or has expired, naming the connection by
-- its LinkedIn display name. It needs the expiry and that name, and nothing else:
--
--   social_checker
--     SELECT (user_id, expires_at, display_name) on public.linkedin_connections: never
--                   the token ciphertext, member URN or scope
--     Nothing in schema auth (no USAGE): the Better Auth user name, email, sessions,
--                   accounts and passkeys stay out of reach
--   Still no INSERT/UPDATE/DELETE anywhere.

grant select (user_id, expires_at, display_name) on public.linkedin_connections to social_checker;
