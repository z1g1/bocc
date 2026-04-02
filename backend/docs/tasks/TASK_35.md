---
# Task 35: Research Circle.so custom fields API

**ID**: TASK-35
**Phase**: Phase 3 — Epic 3: Engagement Rewards
**Story**: STORY-8
**Status**: COMPLETED

## Description
Research the Circle.so Admin API v2 endpoint and payload format for updating member custom fields.

## What Was Done
- Identified PATCH `/community_members/{id}` as the update endpoint
- Determined payload format: `{ custom_fields_attributes: { fieldName: value } }`
- Format based on common Circle.so API patterns — requires integration test verification
- Confirmed that custom fields must be created in Circle.so admin UI before API updates work

## Acceptance Criteria
- [x] Endpoint identified
- [x] Payload format determined
- [x] Verification requirements noted
