---
# Task 32: Production smoke test for Circle invitation

**ID**: TASK-32
**Phase**: Phase 2 — Epic 2: Circle.so Member Invitations
**Story**: STORY-6
**Status**: COMPLETED

## Description
Execute a production smoke test that verifies the full check-in + Circle invitation flow against the deployed Netlify function.

## What Was Done
- curl POST to `https://bocc-backend.netlify.app/.netlify/functions/checkin` with `debug: "0"`
- Verified in Netlify logs: full flow from "Inviting attendee" through "Successfully ensured Circle member"
- Verified in Circle.so: new member appeared in community
- Verified in Airtable: check-in record created

## Acceptance Criteria
- [x] Check-in record in Airtable
- [x] Member in Circle.so community
- [x] Full log trail in Netlify
