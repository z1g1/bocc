---
# Task 2: Create .gitignore

**ID**: TASK-02
**Phase**: Phase 0 — Project Setup
**Story**: STORY-11
**Status**: COMPLETED

## Description
Create `.gitignore` to exclude `node_modules/` and any other generated files from version control.

## What Was Done
- `.gitignore` created excluding `node_modules/`
- Removed accidentally committed `node_modules/.package-lock.json` (commit `fd50e13`)

## Acceptance Criteria
- [x] `node_modules/` is not tracked by git
- [x] `npm install` artifacts do not appear in `git status`
---
