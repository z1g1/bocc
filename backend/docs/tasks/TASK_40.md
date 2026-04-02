---
# Task 40: Implement nested try/catch for counter errors

**ID**: TASK-40
**Phase**: Phase 3 — Epic 3: Engagement Rewards
**Story**: STORY-9
**Status**: COMPLETED

## Description
Ensure the counter increment has its own error boundary so that counter failures do not affect the Circle invitation or check-in response.

## What Was Done
- Inner try/catch wraps only `incrementCheckinCount`
- Outer try/catch wraps `ensureMember` and the inner block
- Error hierarchy:
  - ensureMember fails → outer catch logs, check-in succeeds
  - ensureMember succeeds, incrementCheckinCount fails → inner catch logs, check-in succeeds
  - Both succeed → check-in succeeds with all side effects complete
- Error logs include `counterError.response.status` and `counterError.response.data`

## Acceptance Criteria
- [x] Counter errors isolated from invitation errors
- [x] Both error paths logged with full detail
- [x] Check-in always returns 200 regardless of Circle errors
