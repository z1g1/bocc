# Story 8: Custom Field Update API Integration

**ID**: STORY-8
**Epic**: EPIC-3 (Engagement Rewards)
**Status**: COMPLETED (code), PENDING integration test
**Story Points**: 2
**Tasks**: TASK-35, TASK-36, TASK-37

---

## As a...
Developer, I want a **reusable function to update any custom field** on a Circle.so member, so that the engagement system and any future custom field integrations share a single, tested code path.

## Acceptance Criteria

- [x] `updateMemberCustomField(memberId, fieldName, value)` sends `PATCH /community_members/{memberId}`
- [x] Request body uses `{ custom_fields_attributes: { [fieldName]: value } }`
- [x] Function logs the operation and propagates errors with full response detail
- [x] Exported from `circle.js` alongside existing Circle.so functions
- [ ] Integration test confirms the API accepts `custom_fields_attributes` payload format (pending custom field creation)

## Implementation Notes

The `custom_fields_attributes` payload format is based on common Circle.so API patterns observed in documentation references. Verification requires the admin to first create the `checkinCount` custom field in Circle.so, then run a test check-in and inspect Netlify logs for the PATCH response.
