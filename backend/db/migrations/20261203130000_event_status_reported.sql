-- Migration 0022 — Event status value 'held' -> 'reported' (ticket #51, parent #49)
--
-- GLOSSARY.md: an Event's status is Scheduled, Reported or Cancelled. Saving an Event
-- Report moves it from Scheduled to Reported. "Held" is no longer a status; it means the
-- Event took place.
--
-- Migration 20261203120000_glossary_rename_expand.sql (#50) let the CHECK accept both
-- 'held' and 'reported' and left the value switch to this file, which ships with the
-- code that reads and writes only 'reported' (see its VALUES note). CI runs it a few
-- minutes before that code deploys, so for the code live in between:
--   - existing 'held' rows are backfilled to 'reported' (updated_at trigger disabled:
--     no content changes);
--   - a BEFORE INSERT OR UPDATE OF status trigger rewrites a write of 'held' to
--     'reported' (the old report flow's `set status = 'held'`, the old imports' inserts
--     and upserts). DEPRECATED.
-- Audit rows that say `after: "held"` are history and stay as they are.
--
-- CONTRACT LATER (with #50's contract migration): drop the trigger and its function and
-- tighten events_status_check to ('scheduled', 'reported', 'cancelled').
--
-- Grants: none new. admin_app's UPDATE on events covers the column; the function is
-- revoked from public (a trigger function needs no EXECUTE grant to fire).

alter table public.events disable trigger events_set_updated_at;
update public.events set status = 'reported' where status = 'held';
alter table public.events enable trigger events_set_updated_at;

create function public.events_status_held_compat() returns trigger
    language plpgsql
as $$
begin
    if new.status = 'held' then
        new.status := 'reported';
    end if;
    return new;
end;
$$;
comment on function public.events_status_held_compat() is
    'DEPRECATED (migration 20261203130000): rewrites a write of status ''held'' to ''reported'' for the code live before the deploy. Dropped by the contract migration.';
revoke all on function public.events_status_held_compat() from public;

create trigger events_status_held_compat
    before insert or update of status on public.events
    for each row execute function public.events_status_held_compat();
