---
# Task 20: Implement ensureMember function

**ID**: TASK-20
**Phase**: Phase 2 — Epic 2: Circle.so Member Invitations
**Story**: STORY-5
**Status**: COMPLETED

## Description
Implement the `ensureMember(email, name)` find-or-create function that provides idempotent member creation.

## What Was Done
- `ensureMember` calls `findMemberByEmail` first
- If member exists, returns it immediately (no POST)
- If not found, calls `createMember` and returns the new member
- Exported from `circle.js`

## Acceptance Criteria
- [x] Returns existing member without creating duplicate
- [x] Creates new member when not found
- [x] Single entry point used by checkin.js
