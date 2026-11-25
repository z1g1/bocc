-- Migration 0026 — Luma sync schema: the `email` role, On Luma per Attendee, the
-- luma_syncs table and the launch backfill (issue #72, spec #70, ADR 0014).
--
-- Applied by backend/scripts/migrate.js in ONE transaction, before the code that uses it
-- (docs/backend/DEPLOYS.md). Additive: the live code never reads these columns or the
-- table, and no user holds `email` until an Admin grants it.
--
-- 1. user_roles.role also allows 'email'. Granting it opens nothing yet: the guard
--    (src/lib/admin/roles.mjs mayReach) refuses a role without an allowlist. Its fence
--    (the Luma sync pages) comes with those pages.
--
-- 2. On Luma, per Attendee (GLOSSARY.md "On Luma", ADR 0014 §5):
--      on_luma_at             when the app recorded them On Luma (a Luma sync marked Done)
--      on_luma_before_launch  already on the Email list when Luma syncs launched
--    Both unset = "Not yet". The app only ever sets them; the trigger below refuses
--    turning either off, because unsubscribing happens entirely in Luma and the app
--    can't see it. admin_app gets column-level UPDATE on just these two columns.
--
-- 3. luma_syncs: one row per Event (keyed by event date, like social_plans), created
--    lazily by the first status write. No row = To do or Nothing to add, as computed
--    on read from the live list. Grants: admin_app SELECT, INSERT, UPDATE (no DELETE:
--    the history stays). checkin_writer and site_reader nothing.
--      status      todo | nothing_to_add | done | error
--      note        the Error text (required for error, kept afterwards as history)
--      updated_by  the auth user id who last set it. No foreign key, like
--                  audit_log.actor_user_id: deleting a user must not touch history.
--
-- 4. Launch backfill: every Attendee with ok_to_email and not debug is On Luma
--    "before launch". No luma_syncs rows are created for past Events.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The email role
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.user_roles drop constraint user_roles_role_check;
alter table public.user_roles add constraint user_roles_role_check
    check (role in ('admin', 'social', 'email'));

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. On Luma
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.attendees
    add column on_luma_at            timestamptz,
    add column on_luma_before_launch boolean not null default false;

comment on column public.attendees.on_luma_at is
    'When the app recorded the Attendee On Luma (a Luma sync marked Done). Never cleared (ADR 0014 §5).';
comment on column public.attendees.on_luma_before_launch is
    'On the Email list when Luma syncs launched, so On Luma "before launch". Never cleared (ADR 0014 §5).';

create function public.attendees_on_luma_never_cleared() returns trigger
    language plpgsql
as $$
begin
    if (old.on_luma_at is not null and new.on_luma_at is null)
       or (old.on_luma_before_launch and not new.on_luma_before_launch) then
        raise exception 'On Luma is never turned off (ADR 0014 §5)'
            using errcode = 'check_violation';
    end if;
    return new;
end;
$$;

revoke all on function public.attendees_on_luma_never_cleared() from public;

create trigger attendees_on_luma_never_cleared
    before update of on_luma_at, on_luma_before_launch on public.attendees
    for each row execute function public.attendees_on_luma_never_cleared();

grant update (on_luma_at, on_luma_before_launch) on public.attendees to admin_app;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. luma_syncs
-- ─────────────────────────────────────────────────────────────────────────────
create table public.luma_syncs (
    event_date  date        primary key references public.events (event_date),
    status      text        not null default 'todo'
                            check (status in ('todo', 'nothing_to_add', 'done', 'error')),
    note        text        check (note is null or (btrim(note) <> '' and length(note) <= 2000)),
    updated_by  text,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    constraint luma_syncs_error_note_ck check (status <> 'error' or note is not null)
);

comment on table public.luma_syncs is
    'One Luma sync per Event (ADR 0014). Created lazily by the first status write; '
    'who is in it is computed on read.';

create trigger luma_syncs_set_updated_at
    before update on public.luma_syncs
    for each row execute function public.set_updated_at();

revoke all on public.luma_syncs from public;
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'anon') then
        revoke all on public.luma_syncs from anon;
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
        revoke all on public.luma_syncs from authenticated;
    end if;
end $$;

grant select, insert, update on public.luma_syncs to admin_app;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Launch backfill
-- ─────────────────────────────────────────────────────────────────────────────
update public.attendees
   set on_luma_before_launch = true
 where ok_to_email = true and debug = false;
