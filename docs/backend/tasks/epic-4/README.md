# Epic 4: Profile Photo Enforcement - Task Breakdown

**Epic**: [[EPIC-4]] - Profile Photo Enforcement System
**Total Stories**: 8
**Total Tasks**: 52 (TASK-61 through TASK-112)
**Total Estimated Time**: 88-100 hours
**Status**: Ready for Development

---

## Overview

This directory contains comprehensive TDD (Test-Driven Development) task breakdowns for all Epic 4 stories. Each story has been decomposed into atomic, testable tasks following the Red-Green-Refactor cycle.

---

## Story Task Files

### [[STORY-11]]: Circle.so Audience Segment API Integration (6 tasks)
**File**: `STORY-11-tasks.md`
**Tasks**: TASK-61 through TASK-66
**Estimated Time**: 8-10 hours
**Focus**: Query "No Profile Photo" segment, pagination, fallback logic

**Key Tasks**:
- TASK-61: Write segment query tests
- TASK-62: Implement primary endpoint
- TASK-63: Add pagination support
- TASK-64: Implement fallback to all-members query
- TASK-65: Integration test with production segment
- TASK-66: Refactor and edge case handling

---

### [[STORY-12]]: Airtable "No Photo Warnings" Operations (7 tasks)
**File**: `STORY-12-tasks.md`
**Tasks**: TASK-67 through TASK-73
**Estimated Time**: 10-12 hours
**Focus**: CRUD operations for warning tracking table

**Key Tasks**:
- TASK-67: Write tests for all warning operations
- TASK-68: Create airtable-warnings.js module structure
- TASK-69: Implement findWarningByEmail
- TASK-70: Implement createWarningRecord
- TASK-71: Implement incrementWarningCount
- TASK-72: Implement updateWarningStatus and deleteWarningRecord
- TASK-73: Integration test with real Airtable table

---

### [[STORY-13]]: Progressive Warning Logic and Status Transitions (6 tasks)
**File**: `STORY-13-tasks.md`
**Tasks**: TASK-74 through TASK-79
**Estimated Time**: 12-14 hours
**Focus**: Core enforcement decision logic and action execution

**Key Tasks**:
- TASK-74: Write tests for decision logic (pure function)
- TASK-75: Implement determineEnforcementAction
- TASK-76: Write tests for action execution (impure function)
- TASK-77: Implement processEnforcementAction
- TASK-78: Integration test with stubbed dependencies
- TASK-79: Refactor and documentation

---

### [[STORY-14]]: Bot User DM Integration via Member API (8 tasks)
**File**: `STORY-14-tasks.md`
**Tasks**: TASK-80 through TASK-88
**Estimated Time**: 14-16 hours
**Focus**: Circle.so Member API (Headless) for sending DMs

**Key Tasks**:
- TASK-80-81: JWT authentication (test → impl)
- TASK-82-83: Chat room management (test → impl)
- TASK-84-85: Message sending with TipTap (test → impl)
- TASK-86-87: High-level DM functions and templates (test → impl)
- TASK-88: Integration test with Test Glick user

---

### [[STORY-15]]: Account Deactivation Implementation (4 tasks)
**File**: `STORY-15-tasks.md`
**Tasks**: TASK-89 through TASK-92
**Estimated Time**: 6-7 hours
**Focus**: Member deactivation via Circle.so DELETE endpoint

**Key Tasks**:
- TASK-89: Write deactivation tests
- TASK-90: Implement deactivateMember function
- TASK-91: Integration test - verify DELETE behavior (soft vs hard)
- TASK-92: Document re-invitation workflow

---

### [[STORY-16]]: Admin Notification System (5 tasks)
**File**: `STORY-16-tasks.md`
**Tasks**: TASK-93 through TASK-97
**Estimated Time**: 8-9 hours
**Focus**: Alert admin of final warnings, deactivations, errors

**Key Tasks**:
- TASK-93-94: Alert formatting (test → impl)
- TASK-95-96: Notification delivery (test → impl)
- TASK-97: Integration test with admin user

---

### [[STORY-17]]: Netlify Scheduled Function Setup and Orchestration (7 tasks)
**File**: `STORY-17-tasks.md`
**Tasks**: TASK-98 through TASK-104
**Estimated Time**: 12-14 hours
**Focus**: Main scheduled function that orchestrates all enforcement

**Key Tasks**:
- TASK-98-99: Orchestration structure (test → impl skeleton)
- TASK-100: Segment query and error handling
- TASK-101: Member processing loop
- TASK-102: Summary generation and response
- TASK-103: Configure Netlify scheduled function (cron)
- TASK-104: Manual trigger testing and integration test

---

### [[STORY-18]]: Comprehensive Testing Framework (8 tasks)
**File**: `STORY-18-tasks.md`
**Tasks**: TASK-105 through TASK-112
**Estimated Time**: 14-16 hours
**Focus**: Complete test coverage for Epic 4

**Key Tasks**:
- TASK-105: Test data factory and utilities
- TASK-106: Consolidate unit test coverage (80+ tests)
- TASK-107: Full enforcement progression integration test
- TASK-108: DM delivery validation integration test
- TASK-109: Production smoke test script
- TASK-110: Test documentation
- TASK-111: Run full test suite and coverage report
- TASK-112: CI/CD integration plan

---

## Task Execution Strategy

### Critical Path
```
STORY-11 → STORY-12 → STORY-13 → STORY-14/15/16 (parallel) → STORY-17 → STORY-18
```

### Recommended Execution Order

**Phase 1: Foundation (Stories 11-12)** - Week 1
- STORY-11: Segment querying (6 tasks)
- STORY-12: Warning operations (7 tasks)
- **Duration**: 3-4 days
- **Deliverable**: Can query segment, track warnings in Airtable

**Phase 2: Core Logic (Story 13)** - Week 2
- STORY-13: Enforcement decision and execution logic (6 tasks)
- **Duration**: 3-4 days
- **Deliverable**: Decision engine complete (with stubbed DM/deactivation)

**Phase 3: Integrations (Stories 14-16)** - Week 3-4
- STORY-14: DM integration (8 tasks) - Start first, most complex
- STORY-15: Deactivation (4 tasks) - Can develop in parallel
- STORY-16: Admin notifications (5 tasks) - Depends on STORY-14
- **Duration**: 6-8 days (parallel development possible)
- **Deliverable**: All enforcement actions functional

**Phase 4: Orchestration & Testing (Stories 17-18)** - Week 5
- STORY-17: Scheduled function (7 tasks)
- STORY-18: Testing framework (8 tasks)
- **Duration**: 5-6 days
- **Deliverable**: Complete, tested enforcement system

**Total Estimated Duration**: 18-23 days (with some parallel development)

---

## TDD Approach

### Red-Green-Refactor Cycles

Each story follows strict TDD:

1. **Red Phase**: Write failing tests
   - Tests define expected behavior
   - Tests fail because function not implemented
   - Commit: "test: add tests for [feature]"

2. **Green Phase**: Implement minimum code to pass tests
   - Write just enough code to make tests pass
   - Don't worry about perfection yet
   - Commit: "feat: implement [feature]"

3. **Refactor Phase**: Clean up and enhance
   - Improve code quality
   - Add edge case handling
   - Ensure all tests still pass
   - Commit: "refactor: improve [feature]"

### Task Numbering

- **TASK-61 to TASK-112**: Sequential numbering across all Epic 4 tasks
- Follows Epic 1-3 tasks (TASK-01 to TASK-60)
- Each task is 1-3 hours (atomic, completable in single session)

---

## Testing Coverage Goals

### Unit Tests (80+ tests)
- STORY-11: 6 tests (segment query)
- STORY-12: 10 tests (warning operations)
- STORY-13: 19 tests (enforcement logic)
- STORY-14: 18 tests (DM integration)
- STORY-15: 6 tests (deactivation)
- STORY-16: 11 tests (admin notifications)
- STORY-17: 8 tests (orchestration)
- **Total**: 78+ unit tests

### Integration Tests (12+ tests)
- Segment query with production API
- Warning lifecycle (create → increment → update → delete)
- Enforcement progression (1 → 2 → 3 → 4 → 5)
- DM delivery validation
- Deactivation and re-invitation workflow
- Admin notification delivery
- Full orchestration end-to-end

### Smoke Tests (4+ tests)
- Dry-run mode (no side effects)
- Summary structure validation
- Error count check
- Execution time performance

### Coverage Target
- **Enforcement modules**: >90% coverage
- **Overall project**: >80% coverage

---

## Prerequisites

### Manual Setup Required

1. **Airtable Table Creation**:
   - Create "No Photo Warnings" table
   - Schema: `/Users/zack/projects/bocc-backend/docs/AIRTABLE_SCHEMA_PHOTO_WARNINGS.md`
   - **Required before**: STORY-12 development

2. **Environment Variables**:
   - `CIRCLE_API_TOKEN` (existing from Epic 2)
   - `CIRCLE_HEADLESS_API` (new for Epic 4)
   - `AIRTABLE_API_KEY` (existing from Epic 1)
   - `AIRTABLE_BASE_ID` (existing from Epic 1)

3. **Test User Configuration**:
   - Test Glick user: zglicka@gmail.com (ID: a594d38f)
   - Admin user: circle@zackglick.com (ID: 2d8e9215)
   - Bot user: 716.social Bot (ID: 73e5a590)

4. **Circle.so Permissions**:
   - Admin API v2: member read/write/delete
   - Headless Auth: JWT generation for bot user
   - See: `CIRCLE_PERMISSIONS.md`

---

## Development Tools

### Testing
- **Framework**: Jest (existing from Epic 1-3)
- **Coverage**: `npm test -- --coverage`
- **Integration**: Real API calls to Circle.so and Airtable
- **Smoke**: Bash scripts for production validation

### Development
- **Local Testing**: `netlify dev` (runs functions locally)
- **Manual Trigger**: POST to `http://localhost:8888/.netlify/functions/photo-enforcement`
- **Dry-Run Mode**: Add `?dryRun=true` to avoid side effects

### Debugging
- Netlify function logs (local and production)
- Console logs throughout enforcement workflow
- Comprehensive error logging with API response details

---

## Success Criteria

### Epic 4 Complete When:
- [ ] All 52 tasks completed
- [ ] 80+ unit tests passing
- [ ] 12+ integration tests passing
- [ ] 4+ smoke tests passing
- [ ] >90% coverage for enforcement modules
- [ ] Test Glick user full progression validated
- [ ] Admin receives final warning and deactivation notifications
- [ ] Scheduled function runs weekly (Monday 9 AM UTC)
- [ ] All documentation complete
- [ ] Smoke tests validate production deployment

---

## Related Documentation

- **Epic Documentation**: `/Users/zack/projects/bocc-backend/docs/epics/EPIC_4.md`
- **Story Files**: `/Users/zack/projects/bocc-backend/docs/stories/epic-4/`
- **Airtable Schema**: `/Users/zack/projects/bocc-backend/docs/AIRTABLE_SCHEMA_PHOTO_WARNINGS.md`
- **Message Templates**: `/Users/zack/projects/bocc-backend/docs/MESSAGE_TEMPLATES_EPIC_4.md`
- **Circle Permissions**: `/Users/zack/projects/bocc-backend/CIRCLE_PERMISSIONS.md`

---

**Created**: 2026-02-05
**Epic Status**: READY FOR DEVELOPMENT
**Next Action**: Begin with STORY-11, TASK-61 (Write segment query tests)
