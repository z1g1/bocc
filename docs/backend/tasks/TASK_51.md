---
# Task 51: Create smoke test script

**ID**: TASK-51
**Phase**: Phase 4 — Final Integration & Documentation
**Story**: STORY-15
**Status**: COMPLETED

## Description
Create an automated smoke test script that exercises the check-in API end-to-end.

## What Was Done
- `tests/smoke-test.sh` created covering: basic check-in, duplicate detection, missing required fields
- All tests use `debug: "1"` for production runs to avoid data pollution
- Parameterized API_URL for local vs production targeting

## Acceptance Criteria
- [x] Smoke test covers basic success, duplicate, and validation error paths
- [x] Debug flag used for production safety
