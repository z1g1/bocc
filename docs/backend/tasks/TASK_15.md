---
# Task 15: Add duplicate detection smoke test

**ID**: TASK-15
**Phase**: Phase 1 — Epic 1: Check-in Deduplication
**Story**: STORY-1
**Status**: COMPLETED

## Description
Add a smoke test case that verifies duplicate detection end-to-end: submit a check-in, then submit the same check-in again and verify the duplicate response.

## What Was Done
- `smoke-test.sh` extended with duplicate test case
- Test submits identical check-in twice and asserts `alreadyCheckedIn: true` in second response
- Commit: `113210e`

## Acceptance Criteria
- [x] Smoke test includes duplicate detection scenario
- [x] Second submission returns duplicate message
---
