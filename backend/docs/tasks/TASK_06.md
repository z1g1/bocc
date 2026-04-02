---
# Task 6: Design duplicate detection query

**ID**: TASK-06
**Phase**: Phase 1 — Epic 1: Check-in Deduplication
**Story**: STORY-1
**Status**: COMPLETED

## Description
Design the Airtable query strategy for detecting duplicate check-ins. Determine which fields to filter server-side vs. client-side, and how to handle the linked record constraint.

## What Was Done
- Identified that the `Attendee` field is a linked record and cannot be reliably filtered via Airtable formula
- Designed two-phase approach: server-side formula filters on `eventId`, `token`, `DATESTR(checkinDate)`; client-side `.find()` matches `attendeeId`
- Confirmed `DATESTR()` function for day-based comparison

## Acceptance Criteria
- [x] Query strategy documented
- [x] Linked record limitation identified and mitigated
---
