---
# Task 36: Implement updateMemberCustomField function

**ID**: TASK-36
**Phase**: Phase 3 — Epic 3: Engagement Rewards
**Story**: STORY-8
**Status**: COMPLETED

## Description
Implement a generic function to update any custom field on a Circle.so community member.

## What Was Done
- `updateMemberCustomField(memberId, fieldName, value)` added to `circle.js`
- Sends `PATCH /community_members/{memberId}` with `{ custom_fields_attributes: { [fieldName]: value } }`
- Logs operation and propagates errors with full response detail
- Exported from module

## Acceptance Criteria
- [x] Sends correct PATCH request
- [x] Uses dynamic field name
- [x] Error handling matches existing patterns
