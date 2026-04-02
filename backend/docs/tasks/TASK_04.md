---
# Task 4: Implement input validation utilities

**ID**: TASK-04
**Phase**: Phase 0 — Project Setup
**Story**: STORY-13
**Status**: COMPLETED

## Description
Create `validation.js` with functions to validate and sanitize all check-in form inputs: email, phone, eventId, token, name, businessName, debug, okToEmail.

## What Was Done
- `validation.js` created with: `isValidEmail`, `isValidPhone`, `isValidEventId`, `isValidToken`, `sanitizeText`, `escapeAirtableFormula`, `validateCheckinInput`
- Email validation uses RFC 5322-style regex and rejects `'` and `\` characters
- Phone validation allows common formats, checks 7-15 digit range
- Token validation allows alphanumeric + hyphens (UUID format)
- `sanitizeText` strips HTML tags, script patterns, `<>` characters
- `validateCheckinInput` orchestrates all validators, returns `{ isValid, errors, sanitized }`

## Acceptance Criteria
- [x] All input fields validated or sanitized
- [x] Email lowercased and trimmed
- [x] XSS payloads stripped from text fields
- [x] Invalid formats rejected with descriptive error messages
---
