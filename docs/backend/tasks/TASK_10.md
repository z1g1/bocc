---
# Task 10: Write deduplication unit tests

**ID**: TASK-10
**Phase**: Phase 1 — Epic 1: Check-in Deduplication
**Story**: STORY-2
**Status**: COMPLETED

## Description
Write unit tests for `findExistingCheckin` covering all deduplication scenarios.

## What Was Done
- `deduplication.test.js` created with 8 tests:
  1. Returns null when no check-in exists
  2. Returns existing check-in when found
  3. Filters by attendeeId correctly (multiple records, picks correct one)
  4. Sanitizes inputs to prevent formula injection
  5. Filters by same calendar day (DATESTR)
  6. Queries without maxRecords limit (needed for client-side filtering)
  7. Sorts by checkinDate descending
  8. Handles Airtable API errors gracefully

## Acceptance Criteria
- [x] All 8 tests pass
- [x] Both positive and negative cases covered
---
