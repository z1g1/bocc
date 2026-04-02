# Story 4: Circle.so API Client Module

**ID**: STORY-4
**Epic**: EPIC-2 (Circle.so Member Invitations)
**Status**: COMPLETED
**Story Points**: 3
**Tasks**: TASK-16, TASK-17, TASK-18, TASK-19

---

## As a...
Developer, I want a **reusable Circle.so API client module** that wraps the Admin API v2 endpoints, so that Circle.so operations are isolated, testable, and consistently authenticated.

## Acceptance Criteria

- [x] Module exported from `netlify/functions/utils/circle.js` using CommonJS (`module.exports`)
- [x] Uses `axios.create()` with `baseURL: 'https://app.circle.so/api/admin/v2'` and `Authorization: Bearer` header
- [x] Token sourced from `process.env.CIRCLE_API_TOKEN`
- [x] `findMemberByEmail(email)` — GET `/community_members` with `per_page: 100`, client-side case-insensitive `.find()` by email
- [x] `createMember(email, name)` — POST `/community_members` with `{ email, name }`
- [x] Both functions log key operations and propagate errors with full response detail
- [x] Only Admin API v2 is used (no v1 endpoints)

## Implementation Notes

The axios instance is created at module load time with the token from the environment. This means the token must be set before the module is first `require()`-d. In Netlify Functions, environment variables are available at function start, so this is not an issue. In tests, the axios module is mocked entirely via `jest.mock('axios')`.
