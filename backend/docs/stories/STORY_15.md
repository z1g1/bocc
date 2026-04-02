# Story 15: Smoke and Integration Testing

**ID**: STORY-15
**Epic**: Cross-cutting (Phase 4: Final Integration)
**Status**: COMPLETED
**Story Points**: 2
**Tasks**: TASK-51, TASK-52, TASK-53, TASK-54

---

## As a...
Developer, I want **automated smoke tests** that exercise the full check-in flow against a running server, so that regressions are caught before they reach production.

## Acceptance Criteria

- [x] `tests/smoke-test.sh` tests: basic check-in, duplicate detection, missing fields
- [x] `tests/start-local-test.sh` starts a local Netlify dev server, runs smoke tests, cleans up
- [x] `tests/manual-dedup-test.sh` provides 5 manual deduplication scenarios
- [x] `tests/circle-diagnostic.sh` tests Circle.so API connectivity independently
- [x] npm scripts: `test:smoke-local` and `test:smoke-prod` run the appropriate test suites
- [x] All smoke tests use `debug: "1"` flag when targeting production to avoid polluting data
