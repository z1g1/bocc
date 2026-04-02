# Story 7: Circle.so Permissions Documentation

**ID**: STORY-7
**Epic**: EPIC-2 (Circle.so Member Invitations)
**Status**: COMPLETED
**Story Points**: 1
**Tasks**: TASK-26

---

## As a...
Admin, I want clear documentation of the **exact permissions required** for the Circle.so API token, so that I can set up the integration following the principle of least privilege.

## Acceptance Criteria

- [x] `CIRCLE_PERMISSIONS.md` documents the required token type (Admin V2)
- [x] Specifies how to obtain the token (Circle Settings > Developers > Tokens)
- [x] Lists the minimum permissions needed: community member read, community member write
- [x] Notes that the token should NOT have admin-level permissions beyond member management
- [x] References the environment variable name (`CIRCLE_API_TOKEN`) and where to set it (Netlify dashboard)

## Implementation Notes

Per the project's CLAUDE.md security requirements, all third-party API integrations must document required permissions in a dedicated `$SERVICE_PERMISSIONS.md` file. This file serves as the single reference for anyone setting up or auditing the Circle.so integration.
