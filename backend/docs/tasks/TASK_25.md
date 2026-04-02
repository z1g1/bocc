---
# Task 25: Update checkin.test.js mocks for Circle

**ID**: TASK-25
**Phase**: Phase 2 — Epic 2: Circle.so Member Invitations
**Story**: STORY-6
**Status**: COMPLETED

## Description
Update `checkin.test.js` to mock the circle module so that existing check-in handler tests do not fail when the Circle.so integration is present.

## What Was Done
- Added `jest.mock('../netlify/functions/utils/circle', () => ({ ensureMember: jest.fn().mockResolvedValue({ id: 'circle123' }) }))`
- Added `findExistingCheckin: jest.fn()` to the airtable mock
- Added `findExistingCheckin.mockResolvedValue(null)` to `beforeEach` (default: no duplicate)
- All 23 checkin handler tests pass after updates

## Acceptance Criteria
- [x] Circle module is mocked in checkin tests
- [x] findExistingCheckin is mocked with default null
- [x] All existing tests continue to pass
