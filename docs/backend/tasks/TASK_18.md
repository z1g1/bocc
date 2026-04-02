---
# Task 18: Create circle.js API client module

**ID**: TASK-18
**Phase**: Phase 2 — Epic 2: Circle.so Member Invitations
**Story**: STORY-4
**Status**: COMPLETED

## Description
Create `netlify/functions/utils/circle.js` with an axios instance configured for Circle.so Admin API v2 and implement `findMemberByEmail` and `createMember`.

## What Was Done
- `circle.js` created with:
  - `axios.create()` configured with baseURL and Bearer token from env
  - `findMemberByEmail(email)` — GET `/community_members` with `per_page: 100`, client-side case-insensitive email match
  - `createMember(email, name)` — POST `/community_members` with `{ email, name }`
  - Both functions log operations and propagate errors with response detail
- CommonJS exports: `module.exports = { findMemberByEmail, createMember, ... }`

## Acceptance Criteria
- [x] Axios instance uses Admin API v2 base URL
- [x] Bearer token from CIRCLE_API_TOKEN env var
- [x] findMemberByEmail searches and returns member or null
- [x] createMember POSTs new member
