# Story 13: Input Validation and Security Foundation

**ID**: STORY-13
**Epic**: Cross-cutting (Phase 0: Project Setup)
**Status**: COMPLETED
**Story Points**: 3
**Tasks**: TASK-04, TASK-05

---

## As a...
System operator, I want all user inputs to be **validated and sanitized** before they are processed or stored, so that injection attacks and malformed data are rejected at the API boundary.

## Acceptance Criteria

- [x] `validateCheckinInput()` validates all fields and returns `{ isValid, errors, sanitized }`
- [x] Email: validated by regex (RFC 5322 compliant), rejects `'` and `\` characters, lowercased and trimmed
- [x] Phone: optional, validated for digit count (7-15) and allowed formatting characters
- [x] EventId: required, non-empty string up to 255 chars
- [x] Token: optional, alphanumeric + hyphens only, up to 128 chars (UUID format)
- [x] Name and businessName: sanitized via `sanitizeText()` which strips HTML tags, script patterns, and `<>` characters
- [x] Debug flag: coerced to boolean (`true` only if string `"1"`)
- [x] okToEmail: coerced to boolean
- [x] 43+ unit tests in `validation.test.js` cover all validation paths
