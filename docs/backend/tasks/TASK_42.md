---
# Task 42: Document custom field creation instructions

**ID**: TASK-42
**Phase**: Phase 3 — Epic 3: Engagement Rewards
**Story**: STORY-10
**Status**: COMPLETED

## Description
Document the step-by-step instructions for creating the `checkinCount` custom field in Circle.so admin UI.

## What Was Done
- Setup instructions in `docs/EPIC_3_ENGAGEMENT_REWARDS.md`:
  1. Log into Circle.so as admin
  2. Navigate to Settings > Member Profile > Custom Fields
  3. Add Custom Field: name `checkinCount`, type Number, default 0
  4. Verify field name matches code (case-sensitive)
- Field name verification note: if a different name is used, update `incrementCheckinCount` in `circle.js`

## Acceptance Criteria
- [x] Step-by-step instructions provided
- [x] Field configuration details specified
- [x] Case-sensitivity warning included
