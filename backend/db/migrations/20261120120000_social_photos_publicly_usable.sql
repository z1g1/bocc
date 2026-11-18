-- Migration 0008 — every social photo is publicly usable (ADR 0010 decision 2,
-- amended 2026-11-18; Zack's decision of 2026-11-18).
--
-- Every social photo is covered by the photo waiver posted at the event, so there is
-- no per-photo "OK to use publicly" choice any more: the admin app now creates every
-- social_photo row with publicly_usable = true, whatever the client sends, and the
-- toggle route is gone. signin_board rows stay false (event_media_publicly_usable_ck).
-- The column stays: Phase 5 reads it.
--
-- This backfills the social photos uploaded before the change (a few on staging),
-- which were created false unless someone pressed the old toggle. Idempotent: a re-run
-- matches no rows. Not audited row by row: it is a schema-level decision, recorded
-- here and in the ADR.

update public.event_media
   set publicly_usable = true
 where kind = 'social_photo'
   and not publicly_usable;
