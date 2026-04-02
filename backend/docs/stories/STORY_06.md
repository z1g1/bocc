# Story 6: Circle Invitation Integration with Graceful Degradation

**ID**: STORY-6
**Epic**: EPIC-2 (Circle.so Member Invitations)
**Status**: COMPLETED
**Story Points**: 3
**Tasks**: TASK-22, TASK-23, TASK-24, TASK-25

---

## As a...
Attendee, I want my check-in to **always succeed**, even if the Circle.so invitation fails, so that a third-party service outage does not prevent me from being recorded as checked in.

## Acceptance Criteria

- [x] Circle.so invitation runs after `createCheckinEntry` succeeds
- [x] The invitation block is wrapped in `try/catch` — errors are logged but not propagated
- [x] The check-in HTTP response is returned after the invitation attempt completes (blocking await, not fire-and-forget)
- [x] Debug check-ins (`debug === '1'` or `debug === true`) skip the Circle.so block entirely
- [x] Error logs include `error.message`, `error.response.status`, and `error.response.data`
- [x] `checkin.test.js` mocks the circle module so check-in tests do not depend on Circle.so

## Implementation Notes

The blocking vs. non-blocking decision was driven by a production bug: Netlify Functions kill the runtime after the HTTP response is returned, so fire-and-forget Promises never complete. The invitation must be `await`-ed. The `try/catch` ensures that if Circle.so fails, the function still returns HTTP 200 with `{ message: 'Check-in successful' }`.
