# Epic 4: Profile Photo Enforcement - Stories

**Epic**: [[EPIC-4]] - Profile Photo Enforcement System
**Total Stories**: 8
**Total Story Points**: 29
**Status**: READY FOR DEVELOPMENT

---

## Overview

This directory contains detailed user stories for Epic 4, which implements an automated profile photo enforcement system for 716.social. The system identifies members without profile photos using Circle.so's audience segmentation, sends progressive warnings via bot DMs, tracks enforcement state in Airtable, and automatically deactivates accounts after 5 warnings.

**Key Features**:
- Weekly automated enforcement via Netlify scheduled function (Monday 9 AM UTC)
- Progressive warning system (1-3: standard, 4: final, 5: deactivate)
- In-app DMs from 716.social Bot via Circle.so Member API (Headless)
- Admin notifications for final warnings, deactivations, and errors
- Airtable-based warning tracking with full audit trail
- Comprehensive testing framework with Test Glick user validation

---

## Stories

### Foundation Stories (Parallel Development)

#### [[STORY-11]]: Circle.so Audience Segment API Integration
**Points**: 3 | **Complexity**: Medium | **Status**: READY

Query Circle.so's "No Profile Photo" audience segment (ID: 238273) to identify members needing enforcement. Implements primary endpoint with fallback to all-members query if segment members endpoint unavailable.

**Key Deliverables**:
- `getSegmentMembers(segmentId)` function in `circle.js`
- Pagination support for segments >100 members
- Fallback to all-members query with client-side filtering
- Unit and integration tests

**Depends On**: None (uses existing Circle.so Admin API from Epic 2)

---

#### [[STORY-12]]: Airtable "No Photo Warnings" Operations
**Points**: 3 | **Complexity**: Medium | **Status**: READY

Implement CRUD operations for Airtable "No Photo Warnings" table to track warning counts, status transitions, and enforcement history.

**Key Deliverables**:
- New module: `netlify/functions/utils/airtable-warnings.js`
- Functions: `findWarningByEmail`, `createWarningRecord`, `incrementWarningCount`, `updateWarningStatus`, `deleteWarningRecord`
- Case-insensitive email lookups with formula injection protection
- Unit and integration tests with Test Glick user

**Depends On**: STORY-11 (needs member data from segment query)

---

### Core Logic Stories

#### [[STORY-13]]: Progressive Warning Logic and Status Transitions
**Points**: 4 | **Complexity**: Medium-High | **Status**: READY

Implement the enforcement decision engine that determines actions based on warning count and orchestrates execution (create warning, increment, deactivate, thank).

**Key Deliverables**:
- New module: `netlify/functions/utils/enforcement-logic.js`
- Pure decision function: `determineEnforcementAction(member, existingWarning)`
- Impure execution function: `processEnforcementAction(member, warningRecord, action, dryRun)`
- Support for all actions: CREATE_WARNING, INCREMENT_WARNING, DEACTIVATE, PHOTO_ADDED, SKIP
- Dry-run mode for testing
- Comprehensive unit tests for all state transitions

**Depends On**: STORY-11 (segment members), STORY-12 (warning operations)

---

### Messaging Stories

#### [[STORY-14]]: Bot User DM Integration via Member API
**Points**: 5 | **Complexity**: High | **Status**: READY

Implement Circle.so Member API (Headless) integration for sending in-app direct messages from 716.social Bot to members for warnings and thank-you messages.

**Key Deliverables**:
- New module: `netlify/functions/utils/circle-messaging.js`
- JWT authentication via Headless Auth API
- Find/create DM chat room functionality
- Send messages in TipTap JSON format
- High-level functions: `sendWarningDM`, `sendThankYouDM`
- Message templates (placeholders, final copy from user)
- Unit and integration tests with Test Glick user

**Technical Challenges**:
- Different authentication (JWT vs Bearer token)
- Multi-step DM process (auth → find/create chat → send message)
- TipTap formatting requirements

**Depends On**: STORY-13 (enforcement logic calls DM functions)

---

#### [[STORY-16]]: Admin Notification System
**Points**: 3 | **Complexity**: Medium | **Status**: READY

Implement admin notification system to alert circle@zackglick.com of final warnings, deactivations, and enforcement errors via in-app DM.

**Key Deliverables**:
- Module: `netlify/functions/utils/admin-notifications.js` or extend `circle-messaging.js`
- Function: `notifyAdmin(alertData)` with alert types: FINAL_WARNING, DEACTIVATION, ERROR
- Alert formatting with member details, warning count, profile link, timestamp
- Non-blocking error handling (notification failures don't crash enforcement)
- Unit and integration tests

**Depends On**: STORY-13 (enforcement logic triggers notifications), STORY-14 (may reuse DM infrastructure)

---

### Enforcement Actions

#### [[STORY-15]]: Account Deactivation Implementation
**Points**: 2 | **Complexity**: Small-Medium | **Status**: READY

Implement Circle.so member deactivation via Admin API DELETE endpoint when members reach warning level 5.

**Key Deliverables**:
- Function: `deactivateMember(memberId)` in `circle.js`
- DELETE endpoint: `/api/admin/v2/community_members/{memberId}`
- Verify soft delete vs hard delete behavior with Test Glick user
- Document re-invitation workflow based on DELETE behavior
- Idempotent operation (handles 404 gracefully)
- Unit and integration tests

**Depends On**: STORY-13 (enforcement logic calls deactivation)

---

### Orchestration & Testing

#### [[STORY-17]]: Netlify Scheduled Function Setup and Orchestration
**Points**: 4 | **Complexity**: Medium | **Status**: READY

Implement main scheduled function that orchestrates all enforcement components and runs weekly (Monday 9 AM UTC) via Netlify scheduled functions plugin.

**Key Deliverables**:
- Main function: `netlify/functions/photo-enforcement.js`
- Netlify configuration in `netlify.toml` with cron schedule
- Orchestration: query segment → process each member → generate summary
- Non-blocking error handling (continue processing if individual member fails)
- Comprehensive logging and execution summary
- Dry-run mode support
- Manual trigger capability (POST request)
- Unit and integration tests

**Depends On**: All previous stories (orchestrates complete workflow)

---

#### [[STORY-18]]: Comprehensive Testing Framework and Integration Validation
**Points**: 5 | **Complexity**: High | **Status**: READY

Implement comprehensive unit and integration tests for all enforcement modules, including full workflow validation with Test Glick user.

**Key Deliverables**:
- Unit tests: 56+ tests across all modules (>90% coverage goal)
- Integration tests: Full enforcement progression (1→5), DM delivery, deactivation/re-invite
- Smoke tests: Production validation script (dry-run mode)
- Test utilities: Mock factories, Test Glick setup/cleanup, test data generators
- Test documentation: Prerequisites, setup, execution instructions
- CI/CD integration support

**Depends On**: STORY-17 (needs complete enforcement function for end-to-end tests)

---

## Story Dependencies Graph

```
STORY-11 (Segment Query)
    ↓
STORY-12 (Warning Operations) ←──┐
    ↓                             │
STORY-13 (Enforcement Logic) ─────┤
    ↓                             │
    ├──→ STORY-14 (DM Integration)
    ├──→ STORY-15 (Deactivation)  │
    └──→ STORY-16 (Admin Notify) ─┘
              ↓
         STORY-17 (Orchestration)
              ↓
         STORY-18 (Testing)
```

**Critical Path**: STORY-11 → STORY-12 → STORY-13 → STORY-17 (minimum for basic enforcement)

**Parallel Tracks**:
- STORY-14 (DM Integration) - High complexity, can be developed alongside STORY-13
- STORY-15 (Deactivation) - Simple, can be developed early
- STORY-16 (Admin Notifications) - Depends on STORY-14's Member API patterns

---

## Development Approach

### Phase 1: Foundation (Stories 11-12)
**Duration**: 3-4 days
- Implement segment querying and warning operations
- These are prerequisites for all other stories
- Can be developed and tested independently

### Phase 2: Core Logic (Story 13)
**Duration**: 4-5 days
- Implement decision and execution logic
- Most critical story - heart of enforcement system
- Includes dry-run mode for safe testing

### Phase 3: Integrations (Stories 14-16)
**Duration**: 6-8 days (parallel development possible)
- **STORY-14** (DM Integration): Most complex, start early
- **STORY-15** (Deactivation): Simplest, can finish quickly
- **STORY-16** (Admin Notify): Reuses STORY-14 patterns

### Phase 4: Orchestration & Testing (Stories 17-18)
**Duration**: 5-6 days
- **STORY-17**: Ties everything together, scheduled function setup
- **STORY-18**: Comprehensive testing, full validation with Test Glick

**Total Estimated Duration**: 18-23 days (with some parallel development)

---

## Test User Configuration

**Test Glick User**:
- **Email**: zglicka@gmail.com
- **Circle ID**: a594d38f
- **Profile**: https://www.716.social/u/a594d38f
- **Purpose**: Integration testing for all enforcement scenarios

**Admin User**:
- **Email**: circle@zackglick.com
- **Circle ID**: 2d8e9215
- **Purpose**: Receiving admin notifications

**Bot User**:
- **Name**: 716.social Bot
- **Circle ID**: 73e5a590
- **Profile**: https://www.716.social/u/73e5a590
- **Purpose**: Sending DMs to members and admin

---

## Environment Variables

### Required (New for Epic 4)
- `CIRCLE_HEADLESS_API` - Headless Auth API key for generating JWTs (Member API)
- `CIRCLE_BOT_USER_ID` - Bot user ID: `73e5a590` (optional, can hardcode)
- `ADMIN_USER_ID` - Admin Circle ID: `2d8e9215` (optional, can hardcode)

### Required (Existing from Epic 2)
- `CIRCLE_API_TOKEN` - Admin API v2 token
- `AIRTABLE_API_KEY` - Airtable API key
- `AIRTABLE_BASE_ID` - Airtable base ID

---

## Airtable Setup

**Table Required**: `No Photo Warnings` (must be created before development)

**Schema Documentation**: `/Users/zack/projects/bocc-backend/docs/AIRTABLE_SCHEMA_PHOTO_WARNINGS.md`

**Fields**:
1. `id` (Autonumber) - Primary key
2. `Name` (Text) - Member name
3. `Email` (Email) - Member email (indexed)
4. `Number of Warnings` (Number) - Warning count (1-5)
5. `Last Warning Date` (Date) - Last enforcement date
6. `Status` (Single Select) - Active, Photo Added, Deactivated
7. `Created` (Created Time) - Auto-populated

**Manual Setup Required**: Admin must create table in Airtable before starting development.

---

## Message Templates

**Template Documentation**: `/Users/zack/projects/bocc-backend/docs/MESSAGE_TEMPLATES_EPIC_4.md`

**Templates Required** (user to provide final copy):
1. Standard Warning (Warnings 1-3)
2. Final Warning (Warning 4)
3. Deactivation Notice (Warning 5)
4. Thank You Message (Photo added)
5. Admin Alert (auto-generated, no user input needed)

**Current Status**: Placeholder messages in code, awaiting final copy from user.

---

## Success Criteria

- [ ] All 8 stories completed and tested
- [ ] 56+ unit tests passing (>90% coverage for enforcement modules)
- [ ] 12+ integration tests passing (full workflow validated with Test Glick)
- [ ] Scheduled function deployed and running weekly
- [ ] Test Glick receives warning DMs correctly
- [ ] Admin receives final warning and deactivation notifications
- [ ] Warning count tracked accurately in Airtable
- [ ] Deactivation verified and re-invitation workflow documented
- [ ] Smoke tests validate production deployment
- [ ] All documentation complete and accurate

---

## Related Documentation

- **Epic Documentation**: `/Users/zack/projects/bocc-backend/docs/epics/EPIC_4.md`
- **Airtable Schema**: `/Users/zack/projects/bocc-backend/docs/AIRTABLE_SCHEMA_PHOTO_WARNINGS.md`
- **Message Templates**: `/Users/zack/projects/bocc-backend/docs/MESSAGE_TEMPLATES_EPIC_4.md`
- **Circle Permissions**: `/Users/zack/projects/bocc-backend/CIRCLE_PERMISSIONS.md` (will be updated)

---

**Created**: 2026-02-05
**Epic Status**: PLANNING → READY FOR DEVELOPMENT
**Next Action**: Begin development with STORY-11 and STORY-12 (foundation stories)
