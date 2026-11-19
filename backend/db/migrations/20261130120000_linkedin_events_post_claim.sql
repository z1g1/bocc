-- Migration 0018 — linkedin_events.post_claimed_at: one Publish at a time (ADR 0012).
--
-- Applied by backend/scripts/migrate.js in ONE transaction.
--
-- Two concurrent Publish event requests (a double click, a second tab) both read a
-- `created` row and both posted. Before it calls LinkedIn's post endpoint, a request now
-- claims the row with a conditional UPDATE:
--     update ... set post_claimed_at = now() where id = $1 and status = 'created'
--        and (post_claimed_at is null or post_claimed_at < now() - interval '10 minutes')
-- Only one request wins it. A failed post releases the claim (back to null) so the Admin
-- can retry; a post that went out but couldn't be recorded keeps it, and a request that
-- died mid-call leaves it, so nobody posts again for ten minutes (the page says to check
-- LinkedIn first). The live create takes the claim in the same UPDATE that moves the row
-- to `created`, so a Publish can't race the create's own post either.
--
-- The status trigger is unaffected (status doesn't change). admin_app already has
-- UPDATE on the table; no grant changes.

alter table public.linkedin_events add column post_claimed_at timestamptz;

comment on column public.linkedin_events.post_claimed_at is
    'Set while a request is posting the member post for a created row (one at a time); null when free.';

alter table public.linkedin_events add constraint linkedin_events_post_claim_ck
    check (post_claimed_at is null or status in ('created', 'posted'));
