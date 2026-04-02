---
# Task 7: Implement findExistingCheckin function

**ID**: TASK-07
**Phase**: Phase 1 — Epic 1: Check-in Deduplication
**Story**: STORY-1
**Status**: COMPLETED

## Description
Implement `findExistingCheckin(attendeeId, eventId, token)` in `airtable.js` that queries the `checkins` table for a same-day duplicate.

## What Was Done
- Function added to `airtable.js`
- Builds `AND()` formula with escaped `eventId`, escaped `token`, and `DATESTR` date comparison
- Sorts results descending by `checkinDate`
- Returns first matching record or `null`
- Commit: `b8b418e`

## Acceptance Criteria
- [x] Function queries `checkins` table with correct formula
- [x] Inputs are escaped before interpolation
- [x] Returns matching record or null
---
