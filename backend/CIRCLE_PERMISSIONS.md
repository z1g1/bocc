# Circle.so API Permissions

This document outlines the required permissions for the Circle.so Admin API v2 integration.

## Required API Token

**Token Type:** Admin API v2

**How to Obtain:**
1. Log into your Circle.so community as an admin
2. Navigate to: **Settings → Developers → Tokens**
3. Create a new token and select **"Admin V2"** as the type
4. Copy the generated token

## Required Permissions

The API token needs the following permissions to support BOCC backend functionality:

### Community Members
- **Read community members** - Required to search for existing members by email
- **Create/Invite community members** - Required to automatically invite new attendees after check-in
- **Update community members** - Required to update member custom fields (Epic 3, Epic 4)
- **Delete community members** - Required to deactivate members without profile photos (Epic 4)

### Member Custom Fields
- **Read member custom fields** - Required to read `checkinCount` field (Epic 3)
- **Write member custom fields** - Required to update `checkinCount` after each check-in (Epic 3)

### Audience Segments (Epic 4: Profile Photo Enforcement)
- **Read community segments** - Required to query "No Profile Photo" audience segment
- **Read segment members** - Required to get list of members in specific segment

## Environment Variable Configuration

Add the following environment variable to your Netlify deployment:

```
CIRCLE_API_TOKEN=<your-admin-v2-token>
```

**Important Security Notes:**
- Use the **minimum required permissions** (Admin V2 with member read/write only)
- **Never** use a full admin token or secret key
- **Never** commit the token to version control
- Store the token **only** in Netlify environment variables
- Rotate the token periodically for security

## API Endpoints Used

### Epic 2: Circle Integration (Check-in Invitations)
- `GET /api/admin/v2/community_members` - Search for existing members by email
- `POST /api/admin/v2/community_members` - Create/invite new members after check-in

### Epic 3: Engagement Rewards (Check-in Counter)
- `PATCH /api/admin/v2/community_members/:id` - Update member custom fields (checkinCount)

### Epic 4: Profile Photo Enforcement
- `GET /api/admin/v2/community_segments` - List all audience segments
- `GET /api/admin/v2/community_segments/:id` - Get specific segment details
- `GET /api/admin/v2/community_segments/:id/members` - Query members in "No Profile Photo" segment (endpoint path TBD)
- `DELETE /api/admin/v2/community_members/:id` - Deactivate members after 5 warnings

### Potential Future Requirement (Epic 4 - Member API)
If in-app DMs are implemented (instead of email notifications):
- **Headless Auth API** - Separate API token type required
- `POST /api/headless/v1/auth/member_token` - Generate JWT for bot user
- `POST /api/headless/v1/messages/{chat_room_uuid}/chat_room_messages` - Send DM from bot to member

## Rate Limits

Circle.so API v2 has rate limits. Follow these best practices:
- Cache member lookups when possible
- Batch operations where supported
- Implement exponential backoff for retry logic
- Monitor API usage via Circle.so dashboard

## Testing

Test the API integration with:
- A test Circle.so community (if available)
- Use `debug: "1"` flag in check-in requests to mark test data
- Verify API token has correct permissions before deploying to production

## Environment Variables

### Admin API v2 (Current)
```
CIRCLE_API_TOKEN=<your-admin-v2-token>
```

### Headless Auth API (Future - if implementing DMs in Epic 4)
```
CIRCLE_HEADLESS_AUTH_TOKEN=<your-headless-auth-token>
```

**Note**: Headless Auth tokens are separate from Admin API tokens and require different permissions. Only needed if implementing in-app DM functionality instead of email notifications.

---

## Epic-Specific Permission Requirements

### Epic 2: Circle Integration ✅ COMPLETE
**Status**: Implemented, tested, in production

**Permissions Used**:
- Read community members
- Create community members

**Token Type**: Admin API v2

---

### Epic 3: Engagement Rewards ✅ COMPLETE
**Status**: Code complete, pending Circle custom field setup

**Permissions Used**:
- Read community members (inherited from Epic 2)
- Update community members (custom fields)

**Token Type**: Admin API v2

**Manual Setup Required**:
- Create `checkinCount` Number custom field in Circle.so (Settings > Member Profile > Custom Fields)

---

### Epic 4: Profile Photo Enforcement ⏳ PLANNING
**Status**: Planning phase

**Permissions Required**:
- Read community segments (query "No Profile Photo" segment)
- Read segment members (get members in segment)
- Read community members (get member details)
- Delete community members (deactivate accounts after 5 warnings)

**Token Type**: Admin API v2

**Optional Enhancement** (DM sending):
- If implementing in-app DMs: Requires Headless Auth token + Member API access
- Alternative: Email notifications (no additional Circle permissions needed)

**Manual Setup Required**:
- Verify "No Profile Photo" audience segment exists (https://www.716.social/settings/segments/238273)
- Create Airtable "No Photo Warnings" table (see `docs/AIRTABLE_SCHEMA_PHOTO_WARNINGS.md`)
- Provide message copy (see `docs/MESSAGE_TEMPLATES_EPIC_4.md`)

---

## Verification Checklist

Before deploying Epic 4, verify these permissions are enabled:

- [ ] Admin API v2 token exists in Netlify env vars (`CIRCLE_API_TOKEN`)
- [ ] Token has "Read community segments" permission
- [ ] Token has "Read segment members" permission
- [ ] Token has "Delete community members" permission
- [ ] Test segment query: `GET /api/admin/v2/community_segments/238273`
- [ ] Test member deletion with Test Glick user (then re-invite)
- [ ] If using DMs: Headless Auth token configured, JWT generation tested

---

## References

- [Circle.so Admin API Documentation](https://api.circle.so/apis/admin-api)
- [Circle.so API Quick Start](https://api.circle.so/apis/admin-api/quick-start)
- [Circle.so Developer Portal](https://api.circle.so/)
- [Circle.so Swagger UI (Admin API v2)](https://api-headless.circle.so/?urls.primaryName=Admin+API+V2)
- [Circle.so Member API (Headless)](https://api.circle.so/apis/headless/member-api)
- [Circle.so: Removing Members](https://help.circle.so/p/audience/member-management/removing-members-from-your-community)
- [Circle.so: Re-inviting Deactivated Members](https://help.circle.so/p/audience/member-management/re-invite-a-deactivated-member)
