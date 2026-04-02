# Epic 1: Check-in Deduplication

**ID**: EPIC-1
**Status**: COMPLETED
**Story Points**: 8
**Phase**: Phase 1
**Completion Commit**: `6d4be57` (Update deduplication tests to match new implementation)

---

## Summary

Implement duplicate check-in prevention so that the same attendee cannot check in more than once for the same event on the same calendar day. Returns a friendly user-facing message when a duplicate is detected rather than silently creating a second record.

## Acceptance Criteria

- [x] System detects when an attendee has already checked in for the same event on the same day
- [x] Duplicate check-in returns HTTP 200 with `{ alreadyCheckedIn: true }` and the original check-in date
- [x] Detection matches on: attendee ID, event ID, token, and calendar day (DATESTR)
- [x] Formula injection is prevented in the Airtable query via `escapeAirtableFormula()`
- [x] Airtable linked record field (`Attendee`) is filtered client-side in JavaScript (not via formula)
- [x] New attendees (not yet in `attendees` table) can still check in normally
- [x] Different events on the same day are allowed
- [x] Comprehensive unit tests cover all deduplication paths

## Stories

- STORY-1: Duplicate check-in detection query
- STORY-2: Client-side attendee ID filtering for linked records
- STORY-3: Formula injection protection

## Key Technical Decisions

- **Client-side filtering**: Airtable formulas cannot reliably query linked record fields. The `Attendee` field in the `checkins` table is a linked record (returns an array of IDs). Server-side formula filters on scalar fields (`eventId`, `token`, `DATESTR(checkinDate)`), then JavaScript `.find()` matches the `attendeeId` from the returned records.
- **DATESTR comparison**: Uses Airtable's `DATESTR()` function to compare only the date portion of `checkinDate`, making the check day-based regardless of time zone differences in the timestamp.
- **HTTP 200 for duplicates**: Returns 200 (not 409 Conflict) because from the user's perspective, their check-in is already recorded — this is a success state, not an error.

## Files Modified

| File | Change |
|------|--------|
| `netlify/functions/utils/airtable.js` | Added `findExistingCheckin(attendeeId, eventId, token)` |
| `netlify/functions/checkin.js` | Integrated duplicate check before `createCheckinEntry` |
| `tests/deduplication.test.js` | 8 unit tests for all deduplication paths |
| `tests/smoke-test.sh` | Added duplicate detection smoke test case |

## Commit History

| Commit | Message |
|--------|---------|
| `b8b418e` | Add duplicate check-in query function |
| `96a17a9` | Integrate duplicate detection in check-in flow |
| `002f382` | Add comprehensive tests for check-in deduplication |
| `48f6495` | Fix duplicate detection to use attendeeId instead of email |
| `f07796f` | Fix duplicate detection with client-side attendeeId filtering |
| `113210e` | Enhance smoke test to verify duplicate detection |
| `6d4be57` | Update deduplication tests to match new implementation |

## Bugs Encountered and Fixed

1. **Initial implementation matched on email instead of attendeeId** — The first version tried to match duplicates by email in the Airtable formula. Airtable linked records don't support formula-based email matching. Fixed by switching to client-side `attendeeId` matching against the `Attendee` array field.
2. **Formula injection in eventId/token parameters** — Raw user inputs were being interpolated directly into the Airtable `filterByFormula` string. Fixed by routing all inputs through `escapeAirtableFormula()` which escapes backslashes and single quotes.
