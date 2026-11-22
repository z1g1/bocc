-- Migration 0025 — per-IP rate limit on check-in (issue #67, parent #5, ADR 0013)
--
-- Applied by backend/scripts/migrate.js in ONE transaction, before the code that uses it
-- (docs/backend/DEPLOYS.md). Additive: the live code never reads this table, so applying
-- it early changes nothing.
--
-- One row per ALLOWED check-in attempt: the SHA-256 of the client IP (never the IP) and
-- the start of the fixed window it fell in. The check-in function
-- (utils/pg-store.js recordAttemptUnderLimit) inserts a row only while the window holds
-- fewer than the limit, in one statement, so a refused attempt writes nothing and the
-- table grows by at most `limit` rows per IP per window.
--
-- Grants follow docs/backend/NEON_PERMISSIONS.md: checkin_writer gets SELECT, INSERT and
-- nothing else, so it still has no UPDATE or DELETE anywhere. No other app role gets
-- access. Old rows are harmless (only the current window is ever counted); the owner can
-- prune them: delete from checkin_rate_limit_hits where window_start < now() - interval '1 day'.

create table public.checkin_rate_limit_hits (
    client_key   text        not null check (client_key ~ '^[0-9a-f]{64}$'),
    window_start timestamptz not null
);

comment on table public.checkin_rate_limit_hits is
    'Check-in attempts per client IP hash and fixed window, for the per-IP rate limit '
    '(issue #67, ADR 0013). Insert-only for checkin_writer. Prunable by the owner.';

create index checkin_rate_limit_hits_key_window
    on public.checkin_rate_limit_hits (client_key, window_start);

alter table public.checkin_rate_limit_hits enable row level security;

grant select, insert on public.checkin_rate_limit_hits to checkin_writer;

create policy checkin_writer_rw on public.checkin_rate_limit_hits
    for all to checkin_writer using (true) with check (true);
