---
# Task 52: Create local smoke test automation

**ID**: TASK-52
**Phase**: Phase 4 — Final Integration & Documentation
**Story**: STORY-15
**Status**: COMPLETED

## Description
Create a script that starts a local Netlify dev server, runs smoke tests, and cleans up — enabling fully automated local integration testing.

## What Was Done
- `tests/start-local-test.sh` created:
  - Starts `netlify dev` in background
  - Waits for server to be ready
  - Runs `smoke-test.sh` against `http://localhost:8888`
  - Kills the dev server on completion
- npm script `test:smoke-local` wraps this

## Acceptance Criteria
- [x] Fully automated start → test → cleanup cycle
- [x] npm script provided for easy invocation
