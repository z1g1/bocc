# Story 9: Check-in Counter Increment Logic

**ID**: STORY-9
**Epic**: EPIC-3 (Engagement Rewards)
**Status**: COMPLETED (code), PENDING integration test
**Story Points**: 2
**Tasks**: TASK-38, TASK-39, TASK-40

---

## As a...
System operator, I want the check-in counter to **increment by exactly 1** after each successful check-in, so that member engagement is tracked accurately over time.

## Acceptance Criteria

- [x] `incrementCheckinCount(memberId, currentCount)` calls `updateMemberCustomField(memberId, 'checkinCount', newCount)`
- [x] When `currentCount` is provided, sets the field to `currentCount + 1`
- [x] When `currentCount` is `null` (default), sets the field to `1` (handles first check-in)
- [x] Counter increment is nested inside the Circle.so try/catch — failure does not block check-in
- [x] Counter increment only fires after `ensureMember` succeeds (has a valid `member.id`)
- [ ] Integration test verifies counter increments in Circle.so member profile

## Implementation Notes

The default behavior of setting to `1` when no `currentCount` is provided means the first check-in always sets the counter to 1, regardless of whether the member existed previously. For returning members where the count is already > 0, the caller would need to pass the current count. In the current integration in `checkin.js`, `incrementCheckinCount(member.id)` is called without a `currentCount` argument — this means the counter resets to 1 on every check-in. A future enhancement should read the current count from the member object before incrementing.
