---
# Task 23: Fix blocking vs fire-and-forget bug

**ID**: TASK-23
**Phase**: Phase 2 — Epic 2: Circle.so Member Invitations
**Story**: STORY-6
**Status**: COMPLETED

## Description
Fix the critical bug where the Circle.so invitation was implemented as a fire-and-forget Promise, causing it to be killed by the Netlify runtime before completion.

## What Was Done
- Root cause: `.then().catch()` pattern does not keep the function alive after `return`
- Netlify Functions terminate the runtime immediately after the HTTP response is sent
- The GET request (findMemberByEmail) partially completed because it was initiated before return
- The POST request (createMember) never executed because it was chained after the GET in the Promise
- Fix: changed to `try { const member = await ensureMember(...) } catch { ... }`
- Commit: `4604554`
- Verified in production: Circle.so analytics showed POST after fix

## Acceptance Criteria
- [x] Invitation completes before function returns
- [x] Production test confirms member creation in Circle.so
