---
# Task 12: Apply formula escaping to findExistingCheckin

**ID**: TASK-12
**Phase**: Phase 1 — Epic 1: Check-in Deduplication
**Story**: STORY-3
**Status**: COMPLETED

## Description
Ensure that `eventId` and `token` parameters in `findExistingCheckin` are passed through `escapeAirtableFormula` before being embedded in the Airtable formula string.

## What Was Done
- `findExistingCheckin` calls `escapeAirtableFormula(eventId)` and `escapeAirtableFormula(token)` before formula construction
- Unit test (`deduplication.test.js` test 4) verifies escaped single quotes appear in the generated formula

## Acceptance Criteria
- [x] Formula injection via eventId is prevented
- [x] Formula injection via token is prevented
- [x] Unit test confirms escaping behavior
---
