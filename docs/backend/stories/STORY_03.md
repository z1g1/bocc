# Story 3: Formula Injection Protection

**ID**: STORY-3
**Epic**: EPIC-1 (Check-in Deduplication)
**Status**: COMPLETED
**Story Points**: 3
**Tasks**: TASK-11, TASK-12

---

## As a...
System operator, I want all user-supplied values used in Airtable formula queries to be **sanitized and escaped**, so that an attacker cannot inject arbitrary Airtable formula logic via the `eventId` or `token` fields.

## Acceptance Criteria

- [x] `escapeAirtableFormula()` escapes backslashes (`\` → `\\`) and single quotes (`'` → `\'`)
- [x] `findExistingCheckin()` passes `eventId` and `token` through `escapeAirtableFormula()` before embedding in the formula string
- [x] Unit test verifies that a single quote in `eventId` produces an escaped formula
- [x] `escapeAirtableFormula()` returns empty string for non-string input
- [x] Email field is validated by `isValidEmail()` which rejects strings containing `'` or `\` outright (defense in depth)

## Implementation Notes

The `escapeAirtableFormula` function in `validation.js` is the single point of truth for formula escaping. It is applied to both `eventId` and `token` in `findExistingCheckin()`. The email field takes a different path — it is validated by regex first (which rejects dangerous characters), so it never reaches a formula query in an unsafe state.
