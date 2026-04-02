# Story 1: Duplicate Check-in Detection Query

**ID**: STORY-1
**Epic**: EPIC-1 (Check-in Deduplication)
**Status**: COMPLETED
**Story Points**: 3
**Tasks**: TASK-06, TASK-07, TASK-08

---

## As a...
System operator, I want the backend to **detect when an attendee has already checked in for the same event today**, so that duplicate records are not created in Airtable.

## Acceptance Criteria

- [x] `findExistingCheckin(attendeeId, eventId, token)` queries the `checkins` table
- [x] Query filters on `eventId`, `token`, and `DATESTR(checkinDate) = today`
- [x] Results are sorted descending by `checkinDate` (most recent first)
- [x] Returns the matching record if found, `null` if not
- [x] All string parameters are escaped via `escapeAirtableFormula()` before interpolation
- [x] No `maxRecords` limit is set (needed for client-side attendeeId filtering in STORY-2)

## Implementation Notes

The Airtable formula uses `AND()` to combine three conditions. The `DATESTR()` function extracts the date portion of the `checkinDate` timestamp for day-based comparison. Sorting descending ensures that if somehow multiple records exist, the most recent is returned first.

## Related

- STORY-2 extends this with client-side attendeeId filtering
- STORY-3 adds injection protection to the formula inputs
