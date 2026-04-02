---
# Task 11: Implement escapeAirtableFormula

**ID**: TASK-11
**Phase**: Phase 1 — Epic 1: Check-in Deduplication
**Story**: STORY-3
**Status**: COMPLETED

## Description
Implement the `escapeAirtableFormula` function that escapes special characters in strings before they are interpolated into Airtable `filterByFormula` expressions.

## What Was Done
- Function escapes backslashes first (`\` → `\\`), then single quotes (`'` → `\'`)
- Returns empty string for non-string input
- Located in `validation.js`, exported and used by `airtable.js`

## Acceptance Criteria
- [x] Single quotes in input are escaped
- [x] Backslashes in input are escaped
- [x] Non-string input returns empty string
---
