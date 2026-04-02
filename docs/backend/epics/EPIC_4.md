# Epic 4: Profile Photo Enforcement System

**ID**: EPIC-4
**Status**: PLANNING
**Story Points**: TBD
**Phase**: Phase 4
**GitHub Issue**: #2

---

## Summary

Implement automated weekly enforcement of the profile photo policy on 716.social. The system identifies members without profile photos using Circle.so's built-in "No Profile Photo" audience segment, sends progressive warnings via bot DMs, tracks warning counts in Airtable, and automatically deactivates accounts after 5 warnings. Admins receive notifications for final warnings and deactivations.

## Business Goal

Ensure all 716.social community members have profile photos to build trust and create a more welcoming community environment. Automate policy enforcement to reduce manual admin work while providing clear communication and progressive escalation.

## Acceptance Criteria

- [ ] Weekly Netlify scheduled function runs enforcement automation
- [ ] Query Circle.so "No Profile Photo" audience segment (ID: 238273)
- [ ] Check if members in segment have added photos since last run
  - [ ] If photo added: Send thank-you message, remove from tracking
- [ ] Track warning count in Airtable "No Photo Warnings" table
- [ ] Progressive warning system:
  - [ ] Warnings 1-3: Send standard warning DM from bot
  - [ ] Warning 4: Send final warning DM from bot
  - [ ] Warning 5: Deactivate account via Circle API, send deactivation notification
- [ ] Admin notifications sent to circle@zackglick.com for:
  - [ ] Final warnings (warning 4)
  - [ ] Account deactivations (warning 5)
  - [ ] Any errors or edge cases
- [ ] When deactivated members are manually re-invited, reset warning count to 0
- [ ] Integration tested with Test Glick user (zglicka@gmail.com)
- [ ] Debug/dry-run mode for testing without actual deactivations

## Stories

- STORY-11: Circle.so audience segment API integration
- STORY-12: Airtable "No Photo Warnings" table schema and operations
- STORY-13: Progressive warning logic and tracking
- STORY-14: Bot user DM integration (Member API)
- STORY-15: Account deactivation implementation
- STORY-16: Admin notification system
- STORY-17: Netlify scheduled function setup
- STORY-18: Testing framework with Test Glick user

## Key Technical Decisions

### 1. Scheduling Mechanism: Netlify Scheduled Functions

**Decision**: Use Netlify Scheduled Functions (cron syntax in `netlify.toml`)

**Rationale**: Keeps all infrastructure within Netlify, no external dependencies, simple deployment model

**Configuration**:
```toml
[[plugins]]
package = "@netlify/plugin-functions-schedule"

[[functions]]
schedule = "0 9 * * 1"  # 9 AM every Monday UTC
function = "photo-enforcement"
```

### 2. Warning Storage: Airtable

**Decision**: Store warning tracking in new Airtable table "No Photo Warnings"

**Schema**:
- `id` (Autonumber) - Primary key
- `Name` (Text) - Member name
- `Email` (Text) - Member email (indexed for lookups)
- `Number of Warnings` (Number) - Current warning count (0-5)
- `Last Warning Date` (Date) - When last warning was sent
- `Created` (Created time) - Auto-populated
- `Status` (Single select) - "Active", "Photo Added", "Deactivated"

**Rationale**: Provides audit trail, flexible querying, matches existing Airtable-based architecture

### 3. Direct Messaging Implementation: Member API (Headless)

**⚠️ TECHNICAL CHALLENGE IDENTIFIED**

**Requirement**: Send DMs from "716.social Bot" to members

**Finding**: Admin API v2 does NOT support sending direct messages. DM functionality requires:
- Member API (Headless): `/api/headless/v1/messages/{chat_room_uuid}/chat_room_messages`
- Member-authenticated JWT tokens (not Admin API tokens)
- Headless Auth API key (separate from `CIRCLE_API_TOKEN`)
- Requires finding/creating DM chat room for each recipient
- May require Business plan or above

**Implementation Options**:

**Option A: Full Member API Integration** (recommended for production)
- Obtain Headless Auth API key from Circle.so
- Implement JWT generation for bot user (716.social Bot, ID: 73e5a590)
- Add `/netlify/functions/utils/circle-messaging.js` module
- Query existing DM chat room or create new one
- Send message via Member API
- **Pros**: Authentic in-app DMs, professional user experience
- **Cons**: Complex, requires additional API key/plan verification

**Option B: Email Notifications** (MVP fallback)
- Integrate SendGrid or similar email service
- Send warning emails instead of DMs
- **Pros**: Simpler implementation, reliable delivery
- **Cons**: Less integrated, may be missed/filtered

**Option C: Hybrid Approach** (phased rollout)
- Phase 1 (MVP): Admin notifications via email, member warnings via email
- Phase 2: Implement Member API for in-app DMs once Headless Auth is verified
- **Pros**: Unblocks development, incremental complexity
- **Cons**: Two notification systems to maintain temporarily

**DECISION PENDING**: Awaiting user input on preferred approach and Headless API access

### 4. Profile Photo Detection

**Decision**: Use Circle.so's built-in "No Profile Photo" audience segment (ID: 238273)

**Segment Filter**: Members with "Has Profile Photo": No

**Rationale**:
- Leverages Circle's native segmentation (reliable, maintained by Circle)
- Avoids custom photo detection logic
- Segment automatically updates as members add/remove photos

**API Access**: `GET /api/admin/v2/community_segments/238273/members` (needs verification)

**Fallback**: If segment member query not available, query all members and filter client-side by `profile_picture` field

### 5. Account Deactivation

**Decision**: Use `DELETE /api/admin/v2/community_members/{id}` endpoint

**Clarification Needed**: Verify whether DELETE performs:
- Soft delete (deactivation) - preferred, allows re-invitation
- Hard delete (permanent removal) - not desired

**Circle.so Documentation Reference**: https://help.circle.so/p/audience/member-management/removing-members-from-your-community

**Fallback**: If DELETE is hard delete, check for status field in PUT endpoint (e.g., `{ status: "inactive" }`)

### 6. Error Handling and Admin Notifications

**Decision**: All errors and edge cases trigger admin notification to circle@zackglick.com (Circle ID: 2d8e9215)

**Notification Triggers**:
- Final warning issued (warning 4)
- Account deactivated (warning 5)
- Circle API errors (segment query, member update, deactivation)
- Airtable errors (table access, record creation)
- Unexpected member states (e.g., warning count > 5)

**Notification Method**: TBD based on DM implementation decision (Option A/B/C above)

### Update: Segment API Limitation (2026-02-06)

**Issue Discovered**: Circle.so Admin API v2 does not support querying audience segments for member lists, despite segments being visible in the Circle.so UI.

**Resolution**: Implemented client-side filtering approach via Epic 5:
- Fetch all community members via `/community_members` endpoint
- Filter client-side by `avatar_url` field (null or empty = no photo)
- Added safety limits: 1000 member hard cap, 500 member warning threshold

**See**: EPIC-5 and `docs/CIRCLE_SEGMENTS_RESEARCH.md` for full details.

## Architecture

### New Components

```
netlify/functions/
├── photo-enforcement.js              # Main scheduled function
└── utils/
    ├── circle-enforcement.js         # Enforcement-specific Circle operations
    ├── circle-messaging.js           # DM/notification handling (if Option A)
    └── airtable-warnings.js          # Warning tracking operations

docs/
└── epics/
    └── EPIC_4.md                     # This file

docs/
└── EPIC_4_PHOTO_ENFORCEMENT.md       # Detailed setup guide (TBD)
```

### Reused Components

- `netlify/functions/utils/circle.js` - Existing Circle API client (member queries)
- `netlify/functions/utils/airtable.js` - Existing Airtable client (base connection)

### Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Netlify Cron Trigger (Monday 9 AM UTC)                  │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. Query Circle "No Profile Photo" Segment (ID: 238273)    │
│    GET /api/admin/v2/community_segments/238273/members      │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. For Each Member in Segment:                             │
│    ├─ Fetch warning record from Airtable (by email)        │
│    ├─ Check current warning count                          │
│    └─ Apply enforcement logic                              │
└──────────────────────┬──────────────────────────────────────┘
                       │
          ┌────────────┼────────────┬──────────────┬─────────┐
          │            │            │              │         │
          ▼            ▼            ▼              ▼         ▼
     Warning 1-3   Warning 4   Warning 5     Photo Added  Error
     ┌────────┐   ┌────────┐   ┌────────┐   ┌─────────┐ ┌────┐
     │Send    │   │Send    │   │DELETE  │   │Thank you│ │Log │
     │warning │   │final   │   │/member │   │message  │ │Notify│
     │DM      │   │warning │   │Deactivate│ │Remove   │ │Admin│
     │        │   │DM      │   │         │  │tracking │ │    │
     │Increment│  │Notify  │   │Send     │  │         │ │    │
     │count   │   │admin   │   │deactivate│ │         │ │    │
     │        │   │        │   │notice   │  │         │ │    │
     │Update  │   │Update  │   │Notify   │  │         │ │    │
     │Airtable│   │Airtable│   │admin    │  │         │ │    │
     └────────┘   └────────┘   └────────┘   └─────────┘ └────┘

┌─────────────────────────────────────────────────────────────┐
│ 4. Log Summary to Netlify Function Logs                    │
│    - Members processed                                      │
│    - Warnings sent (by level)                              │
│    - Deactivations performed                               │
│    - Errors encountered                                     │
└─────────────────────────────────────────────────────────────┘
```

## Message Templates

The system requires **5 distinct message templates**:

### 1. Standard Warning (Warnings 1-3)
**Recipient**: Member without profile photo
**Sender**: 716.social Bot
**Placeholder**:
```
[PLACEHOLDER - Standard Warning Message]

User needs to provide copy that:
- Explains profile photo policy
- Encourages adding a photo
- Mentions progressive enforcement
- Friendly but clear tone
```

### 2. Final Warning (Warning 4)
**Recipient**: Member without profile photo (4th warning)
**Sender**: 716.social Bot
**Placeholder**:
```
[PLACEHOLDER - Final Warning Message]

User needs to provide copy that:
- Explicitly states this is the final warning
- Explains deactivation will occur after next check
- Provides re-invitation instructions if deactivated
- More urgent tone
```

### 3. Deactivation Notice (Warning 5 - sent before deactivation)
**Recipient**: Member being deactivated
**Sender**: 716.social Bot
**Placeholder**:
```
[PLACEHOLDER - Deactivation Notice]

User needs to provide copy that:
- Explains account is being deactivated
- Provides re-invitation contact info
- Explains how to rejoin (contact admin after adding photo)
```

### 4. Thank You Message (Photo added)
**Recipient**: Member who added profile photo
**Sender**: 716.social Bot
**Placeholder**:
```
[PLACEHOLDER - Thank You Message]

User needs to provide copy that:
- Thanks member for adding photo
- Positive reinforcement
- Welcomes them to continue participating
```

### 5. Admin Alert (Final warnings & deactivations)
**Recipient**: circle@zackglick.com (Admin)
**Sender**: System notification
**Template**:
```
[716.social Bot] Profile Photo Enforcement Alert

Action: {FINAL_WARNING | DEACTIVATION | ERROR}
Member: {name} ({email})
Warning Count: {count}
Circle Profile: https://www.716.social/u/{member_id}

{Additional context or error details}

---
Automated enforcement run: {timestamp}
```

## Environment Variables

### Required (Existing)
- `CIRCLE_API_TOKEN` - Admin API v2 token for member queries, updates, deactivation
- `AIRTABLE_API_KEY` - Airtable API key for warning tracking
- `AIRTABLE_BASE_ID` - Base ID for BOCC database

### New (TBD based on DM implementation)
- `CIRCLE_HEADLESS_AUTH_TOKEN` - Headless Auth API key for Member API (if Option A)
- `CIRCLE_BOT_USER_ID` - Bot user ID: `73e5a590` (hard-coded or env var)
- `ADMIN_USER_ID` - Admin user ID: `2d8e9215` (hard-coded or env var)
- `SENDGRID_API_KEY` - SendGrid API key for email notifications (if Option B/C)
- `ADMIN_EMAIL` - Admin email: `circle@zackglick.com` (hard-coded or env var)

## API Permissions Required

### Circle.so Admin API v2 (existing token)
- **Read community segments** - Query "No Profile Photo" segment members
- **Read community members** - Get member details, profile photo status
- **Update community members** - Update custom fields (if needed)
- **Delete community members** - Deactivate accounts (warning 5)

### Circle.so Headless Auth API (if Option A)
- **Read chat rooms** - Find/create DM chat rooms
- **Send messages** - Send DMs from bot user to members

### Airtable
- **Read/Write "No Photo Warnings" table** - Track warning counts and enforcement history

**See**: `CIRCLE_PERMISSIONS.md` (to be updated in this Epic)

## Testing Strategy

### Unit Tests
- Warning count logic (0 → 1, 1 → 2, ..., 4 → 5)
- Status transitions (Active → Photo Added, Active → Deactivated)
- Message template selection based on warning count
- Airtable record creation/update
- Error handling for API failures

### Integration Tests (Test Glick User)
- **Test User**: Test Glick (zglicka@gmail.com, https://www.716.social/u/a594d38f)
- Verify segment membership detection
- Test warning increment (manually remove photo, run enforcement)
- Verify DM delivery (if Option A)
- Verify email delivery (if Option B/C)
- Test deactivation and re-invitation flow

### Manual Testing Script
```bash
# Dry-run mode (no actual deactivations or DMs)
curl -X POST https://bocc-backend.netlify.app/.netlify/functions/photo-enforcement \
  -H "Content-Type: application/json" \
  -d '{"debug": "1", "dryRun": true}'

# Simulate enforcement for specific user
curl -X POST https://bocc-backend.netlify.app/.netlify/functions/photo-enforcement \
  -H "Content-Type: application/json" \
  -d '{"debug": "1", "testEmail": "zglicka@gmail.com"}'
```

## Limitations and Known Issues

### 1. Segment Member Query API Endpoint Unverified
**Risk**: Circle.so API documentation does not clearly show how to query members in a specific segment.

**Mitigation Options**:
- Test `GET /api/admin/v2/community_segments/238273/members` (most likely endpoint)
- Fallback: Query all members `GET /api/admin/v2/community_members` and filter client-side by `profile_picture` field
- Contact Circle.so support for clarification

### 2. Direct Messaging Complexity
**Risk**: Member API DM implementation is significantly more complex than anticipated, requires additional API access.

**Mitigation**: Hybrid approach (Option C) allows MVP with email notifications, upgrade to DMs in Phase 2

### 3. Deactivation vs. Hard Delete
**Risk**: DELETE endpoint may perform hard delete instead of deactivation, making re-invitation impossible.

**Mitigation**:
- Verify behavior in test environment with Test Glick user first
- If hard delete, investigate PUT endpoint status field alternative
- Document re-invitation process based on actual behavior

### 4. Race Conditions on Weekly Runs
**Risk**: If a member adds a photo between segment query and warning send, they may receive unnecessary warning.

**Mitigation**:
- Query member profile photo status immediately before sending warning
- Skip warning if photo detected
- Send thank-you message instead

### 5. Timezone Considerations
**Risk**: Monday 9 AM UTC may not be ideal time for 716.social community (likely Eastern Time).

**Mitigation**: Configure cron schedule for appropriate local time (e.g., `0 14 * * 1` = 9 AM EST / 10 AM EDT)

## Security Considerations

1. **API Key Security**: Headless Auth token (if used) must be stored securely in Netlify env vars, never committed
2. **Rate Limiting**: Batch processing if segment has >100 members to avoid Circle API rate limits
3. **Input Validation**: Sanitize all member names/emails before Airtable writes (reuse `validation.js`)
4. **Admin Notification Privacy**: Admin alerts should not expose sensitive member data in logs
5. **Test Mode Protection**: Dry-run mode must never actually deactivate accounts or send real DMs

## Success Metrics

- **Enforcement Coverage**: 100% of members in "No Profile Photo" segment processed weekly
- **False Positives**: <1% (members who added photos but still received warnings)
- **Deactivation Rate**: <5 per month (indicates warnings are effective)
- **Admin Manual Interventions**: <2 per month (indicates automation is reliable)
- **API Error Rate**: <1% of enforcement runs fail due to API errors

## Dependencies

- **Upstream**: Epic 2 (Circle.so integration established)
- **Blocking**:
  - Circle.so Headless Auth API access verification (for Option A)
  - Airtable "No Photo Warnings" table creation
  - Message copy from user (5 templates)
- **Blocked By**: None

## Rollout Plan

### Phase 1: Infrastructure Setup
- Create Airtable "No Photo Warnings" table
- Configure Netlify scheduled function
- Implement segment query and member detection
- Set up dry-run/debug mode

### Phase 2: Warning System (MVP)
- Implement warning tracking logic
- Implement notification system (email or DM based on decision)
- Test with Test Glick user
- Deploy in dry-run mode for 1 week

### Phase 3: Deactivation
- Verify DELETE endpoint behavior (deactivate vs. hard delete)
- Implement deactivation logic with safeguards
- Test deactivation + re-invitation flow
- Deploy with deactivation enabled

### Phase 4: Production Hardening
- Implement rate limiting and batching
- Add comprehensive error handling
- Create monitoring dashboard (future)
- Document runbooks for common scenarios

## Open Questions

1. ✅ **Scheduling mechanism**: Netlify Scheduled Functions
2. ✅ **Warning storage**: Airtable "No Photo Warnings" table
3. ✅ **Test user**: Test Glick (zglicka@gmail.com)
4. ⏳ **DM implementation**: Awaiting decision on Option A/B/C
5. ⏳ **Headless Auth API access**: Does user have/can get Headless Auth token?
6. ⏳ **Circle.so plan tier**: Is community on Business plan (required for Headless)?
7. ⏳ **Message copy**: User to provide 5 message templates
8. ⏳ **Deactivation behavior**: Does DELETE soft-delete or hard-delete?
9. ⏳ **Segment member query**: What's the correct endpoint to query segment members?

## Next Steps

1. **User Decision**: Choose DM implementation approach (Option A/B/C)
2. **API Verification**: Test segment member query endpoint in Circle.so
3. **Airtable Setup**: Create "No Photo Warnings" table schema
4. **Message Copy**: Draft 5 message templates (or user provides)
5. **Story Breakdown**: Create detailed stories (STORY-11 through STORY-18)
6. **Task Planning**: Use task-planner agent to break down stories into TDD tasks

---

**Epic Owner**: To be assigned
**Technical Lead**: To be assigned
**Estimated Completion**: TBD based on DM implementation complexity
