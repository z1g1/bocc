---
# Task 1: Initialize package.json and dependencies

**ID**: TASK-01
**Phase**: Phase 0 — Project Setup
**Story**: STORY-11
**Status**: COMPLETED

## Description
Set up `package.json` with the `airtable` SDK as a production dependency and `jest` as a dev dependency. Define npm scripts for test, smoke-local, and smoke-prod.

## What Was Done
- `package.json` created with `airtable: ^0.12.2` and `jest: ^29.7.0`
- Scripts defined: `test` (jest), `test:smoke-local` (bash tests/start-local-test.sh), `test:smoke-prod` (API_URL-parameterized smoke test)
- Later: `axios: ^1.13.4` added for Circle.so integration (Epic 2)

## Acceptance Criteria
- [x] `npm install` completes without errors
- [x] `npm test` runs jest
- [x] All production dependencies listed
---
