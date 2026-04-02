---
# Task 22: Integrate Circle invitation into checkin.js

**ID**: TASK-22
**Phase**: Phase 2 — Epic 2: Circle.so Member Invitations
**Story**: STORY-6
**Status**: COMPLETED

## Description
Add the Circle.so invitation call into `checkin.js` after the check-in record is created, wrapped in error handling so that failures do not block the check-in response.

## What Was Done
- Added `require('./utils/circle')` importing `ensureMember`
- After `createCheckinEntry` succeeds and if `debug` is falsy or `'0'`:
  - Calls `await ensureMember(email, name)` inside try/catch
  - Logs success or error with response details
- Initially implemented as fire-and-forget `.then().catch()` — this was the primary Epic 2 bug (see TASK-23)

## Acceptance Criteria
- [x] Circle invitation runs after successful check-in
- [x] Errors are caught and logged, not propagated
- [x] Debug check-ins skip the invitation
