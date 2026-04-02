# Story 2: Client-Side Attendee ID Filtering

**ID**: STORY-2
**Epic**: EPIC-1 (Check-in Deduplication)
**Status**: COMPLETED
**Story Points**: 2
**Tasks**: TASK-09, TASK-10

---

## As a...
System operator, I want duplicate detection to **correctly match by attendee identity** even though Airtable linked record fields cannot be queried via formula, so that check-ins are matched to the correct attendee.

## Acceptance Criteria

- [x] After the Airtable formula query returns candidate records, JavaScript filters by `attendeeId`
- [x] The `Attendee` field (a linked record) is accessed via `record.get('Attendee')` which returns an array of record IDs
- [x] The filter uses `Array.includes(attendeeId)` to match
- [x] Records belonging to other attendees (same event, same day, different person) do not trigger a false duplicate
- [x] Unit test confirms correct record is selected when multiple records match the formula

## Implementation Notes

Airtable's `filterByFormula` does not support querying linked record fields directly. The workaround is to omit `attendeeId` from the server-side formula (which filters on scalar fields `eventId`, `token`, date) and apply the attendee match in application code after results are returned. This is the established pattern in the codebase for any query involving linked records.
