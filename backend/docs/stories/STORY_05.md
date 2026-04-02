# Story 5: Idempotent ensureMember Orchestration

**ID**: STORY-5
**Epic**: EPIC-2 (Circle.so Member Invitations)
**Status**: COMPLETED
**Story Points**: 2
**Tasks**: TASK-20, TASK-21

---

## As a...
System operator, I want member creation to be **idempotent** — safe to call multiple times without creating duplicate members — so that retries and race conditions do not pollute the community.

## Acceptance Criteria

- [x] `ensureMember(email, name)` first calls `findMemberByEmail(email)`
- [x] If a member is found, returns the existing member without calling `createMember`
- [x] If no member is found, calls `createMember(email, name)` and returns the new member
- [x] Unit tests verify both paths (existing member returned, new member created)
- [x] Error paths tested: lookup failure propagates, creation failure propagates

## Implementation Notes

The find-or-create pattern is a standard approach for idempotent resource creation. The `ensureMember` function is the only entry point used by `checkin.js` — it never calls `findMemberByEmail` or `createMember` directly. This keeps the idempotency guarantee at the call site.
