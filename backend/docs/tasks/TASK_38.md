---
# Task 38: Implement incrementCheckinCount function

**ID**: TASK-38
**Phase**: Phase 3 — Epic 3: Engagement Rewards
**Story**: STORY-9
**Status**: COMPLETED

## Description
Implement the `incrementCheckinCount` function that wraps `updateMemberCustomField` with check-in counter-specific logic.

## What Was Done
- `incrementCheckinCount(memberId, currentCount = null)` added to `circle.js`
- When `currentCount` is provided: sets field to `currentCount + 1`
- When `currentCount` is null (default): sets field to `1`
- Calls `updateMemberCustomField(memberId, 'checkinCount', newCount)`
- Exported from module

## Acceptance Criteria
- [x] Increments from provided count
- [x] Defaults to 1 when no count provided
- [x] Uses 'checkinCount' as the field name
