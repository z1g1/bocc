# Story 11: Project Setup and Dependency Management

**ID**: STORY-11
**Epic**: Cross-cutting (Phase 0: Project Setup)
**Status**: COMPLETED
**Story Points**: 2
**Tasks**: TASK-01, TASK-02

---

## As a...
Developer, I want the project to have **proper dependency management and a working local development environment**, so that I can run the application and tests without manual configuration.

## Acceptance Criteria

- [x] `package.json` declares all production and dev dependencies
- [x] `airtable` SDK is listed as a production dependency
- [x] `axios` is listed as a production dependency (added for Circle.so)
- [x] `jest` is listed as a dev dependency
- [x] `npm install` installs all dependencies cleanly
- [x] `.gitignore` excludes `node_modules/`
- [x] npm test scripts are defined: `test`, `test:smoke-local`, `test:smoke-prod`
