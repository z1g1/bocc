# Testing Guide: Epic 4 - Profile Photo Enforcement System

**Epic**: Profile Photo Enforcement System
**Test User**: Test Glick (zglicka@gmail.com)
**Circle Profile**: https://www.716.social/u/a594d38f
**Status**: Ready for Manual Testing
**Date**: 2025-02-05

---

## Overview

This guide provides step-by-step instructions for testing the complete profile photo enforcement system with the Test Glick user account.

**System Components:**
- Circle.so member detection via `getMembersWithoutPhotos()` (client-side filtering by `avatar_url`)
- Airtable "No Photo Warnings" table
- Netlify Scheduled Function (weekly Monday 9 AM EST)
- DM notifications via 716.social Bot
- Admin notifications to circle@zackglick.com

**Note**: Original design used Circle.so "No Profile Photo" segment (ID: 238273), but Epic 5 refactored to client-side filtering as Circle.so Admin API v2 does not expose segment member lists. See `docs/CIRCLE_SEGMENTS_RESEARCH.md`.

---

## Prerequisites

### Environment Variables (Netlify Dashboard)

Ensure all required environment variables are configured:

```
CIRCLE_API_TOKEN=<Admin API v2 token>
CIRCLE_HEADLESS_API=<Headless Auth token for bot user>
AIRTABLE_API_KEY=<Airtable API key>
AIRTABLE_BASE_ID=<Airtable base ID>
```

### Test User Setup

**Test Glick Account:**
- Email: zglicka@gmail.com
- Circle ID: a594d38f
- Profile: https://www.716.social/u/a594d38f
- **Action Required**: Remove profile photo before testing

### Admin Account

**Admin (for notifications):**
- Email: circle@zackglick.com
- Circle ID: 2d8e9215
- Will receive final warning and deactivation alerts

---

## Testing Phases

### Phase 1: Initial Warning (Warning 1)

**Objective**: Verify first warning creation for member without profile photo

**Setup:**
1. Ensure Test Glick has **NO profile photo** on Circle (avatar_url should be null or empty)
2. Verify `getMembersWithoutPhotos()` returns Test Glick in results (client-side filter)
3. Verify **NO existing record** in Airtable "No Photo Warnings" table for zglicka@gmail.com

**Execute:**
```bash
# Trigger enforcement function (dry run first)
curl "https://bocc-backend.netlify.app/.netlify/functions/profile-photo-enforcement-manual?dryRun=true"

# If dry run looks good, run for real
curl "https://bocc-backend.netlify.app/.netlify/functions/profile-photo-enforcement-manual"
```

**Expected Results:**
- ✅ Airtable record created:
  - Name: Test Glick
  - Email: zglicka@gmail.com
  - Number of Warnings: 1
  - Status: Active
  - Last Warning Date: Today
- ✅ DM sent to Test Glick:
  - Content: "The Introduction" — robot personality, "Beep boop!", reminder 1 of 4, 3 remaining
  - Sender: 716.social Bot
- ✅ Function returns success summary:
  - Total members: 1+
  - Actions: CREATE_WARNING: 1
  - Processed: 1+
  - Errors: 0

**Verification Steps:**
1. Check Airtable table for new record
2. Check Test Glick's Circle DMs for warning message
3. Review Netlify function logs for execution details
4. Verify no admin notification (only sent on final warning/deactivation)

---

### Phase 2: Warning Escalation (Warnings 2-3)

**Objective**: Verify warning increment logic and DM updates

**Setup:**
1. Test Glick still has NO profile photo
2. Airtable record exists with Warning Count = 1

**Execute:**
```bash
# Run enforcement again (simulate 2nd week)
curl "https://bocc-backend.netlify.app/.netlify/functions/profile-photo-enforcement-manual"
```

**Expected Results (Week 2):**
- ✅ Airtable record updated:
  - Number of Warnings: 2
  - Last Warning Date: Updated to today
- ✅ DM sent: "The Persistent One" — "Round 2", reminder 2 of 4, 2 left
- ✅ No admin notification

**Execute Again (Week 3):**
```bash
curl "https://bocc-backend.netlify.app/.netlify/functions/profile-photo-enforcement-manual"
```

**Expected Results (Week 3):**
- ✅ Airtable record updated:
  - Number of Warnings: 3
  - Last Warning Date: Updated to today
- ✅ DM sent: "The Serious One" — "this is getting real", reminder 3 of 4
- ✅ No admin notification

---

### Phase 3: Final Warning (Warning 4)

**Objective**: Verify final warning triggers admin notification

**Setup:**
1. Test Glick still has NO profile photo
2. Airtable record shows Warning Count = 3

**Execute:**
```bash
curl "https://bocc-backend.netlify.app/.netlify/functions/profile-photo-enforcement-manual"
```

**Expected Results:**
- ✅ Airtable record updated:
  - Number of Warnings: 4
  - Status: Active (not deactivated yet)
  - Last Warning Date: Updated to today
- ✅ DM sent to Test Glick:
  - Content: "The Goodbye" — 🚨, "final warning from the bot", next Monday date, "One last beep boop"
- ✅ **Admin DM sent to circle@zackglick.com**:
  - Subject: "Final Warning Issued: Test Glick"
  - Content: Member details, warning count, profile link
  - Action type: FINAL_WARNING

**Verification Steps:**
1. Check Airtable shows Warning Count = 4
2. Check Test Glick receives FINAL WARNING DM
3. **Check admin account (circle@zackglick.com) receives notification DM**
4. Review function logs for admin notification success
5. Verify summary shows: finalWarnings: 1

---

### Phase 4: Deactivation (Warning 5)

**Objective**: Verify account deactivation after 5th check without photo

**Setup:**
1. Test Glick **STILL** has NO profile photo
2. Airtable record shows Warning Count = 4
3. Admin is prepared to receive deactivation notice

**Execute:**
```bash
curl "https://bocc-backend.netlify.app/.netlify/functions/profile-photo-enforcement-manual"
```

**Expected Results:**
- ✅ **No DM sent to Test Glick** — the final warning (phase 3) was the last message
- ✅ **Test Glick account deactivated** via DELETE API
- ✅ Airtable record updated:
  - Number of Warnings: 5
  - Status: **Deactivated**
  - Last Warning Date: Updated to today
- ✅ **Admin DM sent to circle@zackglick.com**:
  - Subject: "Member Deactivated: Test Glick"
  - Content: Deactivation details
  - Action type: DEACTIVATION

**Verification Steps:**
1. **Verify Test Glick cannot log into 716.social**
2. Check Airtable shows Status = "Deactivated"
3. **Verify NO new DM was sent to Test Glick** (last DM should be the final warning from phase 3)
4. **Check admin received deactivation alert DM**
5. Review function logs for deactivation success
6. Verify summary shows: deactivations: 1

---

### Phase 5: Photo Added (Recovery Path)

**Objective**: Verify thank you message and warning record deletion when member adds photo

**Setup:**
1. **Manually re-invite Test Glick** to Circle (admin action)
2. **Test Glick adds a profile photo** before next enforcement run
3. Airtable record exists with Status = "Deactivated" or "Active"

**Execute:**
```bash
curl "https://bocc-backend.netlify.app/.netlify/functions/profile-photo-enforcement-manual"
```

**Expected Results:**
- ✅ System detects Test Glick now has profile photo
- ✅ Thank you DM sent to Test Glick:
  - Content: "The Celebration" — "BEEP BOOP BEEP BOOP!!", "thrilled", "Happy beep boop" 🎉
- ✅ **Airtable warning record DELETED**
- ✅ No admin notification (positive outcome)

**Verification Steps:**
1. Check Test Glick receives thank you DM
2. **Verify Airtable record for zglicka@gmail.com is DELETED**
3. Review function logs for PHOTO_ADDED action
4. Verify summary shows: PHOTO_ADDED: 1

---

## Edge Cases & Error Scenarios

### Test Case 6: Anomaly Detection (Warning Count >= 5)

**Setup:**
- Manually set Airtable record to Warning Count = 7 (simulated data corruption)

**Expected:**
- Action: SKIP
- Admin notification sent with anomaly details
- No further warnings or deactivation
- Console warning logged

### Test Case 7: DM Send Failure (Non-Blocking)

**Setup:**
- Temporarily break CIRCLE_HEADLESS_API token

**Expected:**
- Warning record still created/updated
- Error logged: "DM send failed"
- Function continues processing
- Error captured in summary.errorDetails

### Test Case 8: Deactivation Failure (Blocking)

**Setup:**
- Temporarily break CIRCLE_API_TOKEN permissions

**Expected:**
- Deactivation attempt fails
- Error logged with API response
- Airtable record NOT updated to "Deactivated"
- Summary shows error for that member

### Test Case 9: Segment Fetch Failure (Fatal)

**Setup:**
- Temporarily break CIRCLE_API_TOKEN completely

**Expected:**
- Function fails early (no members processed)
- Fatal error logged
- 500 response returned
- summary.errorDetails contains fatal error

---

## Testing Checklist

### Pre-Flight Checks
- [ ] All environment variables configured in Netlify
- [ ] Test Glick account exists and accessible
- [ ] Admin account can receive DMs
- [ ] Airtable table accessible with API key
- [ ] Test Glick has no profile photo (avatar_url null/empty) for detection

### Phase 1: First Warning
- [ ] Airtable record created correctly
- [ ] DM sent to Test Glick
- [ ] Warning content matches template
- [ ] No admin notification
- [ ] Function logs show success

### Phase 2: Escalation (Warnings 2-3)
- [ ] Warning count increments correctly
- [ ] DMs sent with updated counts
- [ ] Airtable dates updated
- [ ] No admin notifications

### Phase 3: Final Warning
- [ ] Warning count = 4
- [ ] Final warning DM sent to Test Glick
- [ ] **Admin notification sent**
- [ ] Summary shows finalWarnings: 1

### Phase 4: Deactivation
- [ ] **No DM sent** to Test Glick (final warning was the last message)
- [ ] **Account actually deactivated**
- [ ] Airtable status = "Deactivated"
- [ ] **Admin deactivation alert sent**
- [ ] Summary shows deactivations: 1

### Phase 5: Recovery
- [ ] Photo added detected
- [ ] Thank you DM sent
- [ ] **Airtable record deleted**
- [ ] Member removed from enforcement tracking

### Edge Cases
- [ ] Anomaly detection works (count >= 5)
- [ ] DM failures are non-blocking
- [ ] Deactivation failures are handled
- [ ] Fatal errors return proper response

---

## Manual Testing Commands

### Dry Run (Safe Testing)
```bash
# Test without making any changes (use manual endpoint for testing)
curl "https://bocc-backend.netlify.app/.netlify/functions/profile-photo-enforcement-manual?dryRun=true"
```

### Production Run
```bash
# Execute enforcement for real (use manual endpoint)
curl "https://bocc-backend.netlify.app/.netlify/functions/profile-photo-enforcement-manual"
```

**Note:** The scheduled function (`profile-photo-enforcement`) cannot be called via HTTP in production - it only runs on the Monday 9 AM EST schedule. Use the `-manual` version for on-demand testing and execution.

### Check Logs
1. Go to Netlify Dashboard
2. Navigate to Functions → profile-photo-enforcement
3. View recent invocations
4. Check logs for detailed execution trace

### Verify Airtable
1. Open Airtable "No Photo Warnings" table
2. Filter by Email = "zglicka@gmail.com"
3. Check fields: Number of Warnings, Status, Last Warning Date

### Verify Circle DMs
1. Log into Test Glick account: zglicka@gmail.com
2. Check DMs from 716.social Bot
3. Verify message content matches expected template

### Verify Admin Notifications
1. Log into admin account: circle@zackglick.com
2. Check DMs from 716.social Bot
3. Verify final warning and deactivation alerts received

---

## Rollback Procedures

### If Testing Goes Wrong

**Reset Test Glick Account:**
1. Manually re-invite to Circle if deactivated
2. Add profile photo to stop enforcement
3. Delete Airtable warning record
4. Wait for next enforcement run or trigger manually

**Clear Airtable Records:**
```bash
# Manually delete test records from Airtable UI
# Or use Airtable API to bulk delete if needed
```

**Disable Scheduled Function:**
1. Go to Netlify Dashboard
2. Functions → profile-photo-enforcement
3. Temporarily disable scheduled trigger
4. Re-enable after testing complete

---

## Success Criteria

All phases must pass for system to be considered production-ready:

✅ **Phase 1**: First warning created and sent
✅ **Phase 2**: Warnings 2-3 escalate correctly
✅ **Phase 3**: Final warning (4th) triggers admin alert
✅ **Phase 4**: Deactivation (5th) works + admin notified
✅ **Phase 5**: Photo added sends thank you + deletes record

**Additional Requirements:**
- All DMs delivered successfully
- All admin notifications received
- All Airtable records accurate
- No unexpected errors in logs
- Summary reports accurate

---

## Post-Testing Actions

After successful testing:

1. **Remove Test Data**:
   - Delete Test Glick's Airtable warning record
   - Ensure Test Glick has profile photo
   - Clean up any test artifacts

2. **Deploy to Production**:
   - Merge `dev` branch to `staging`
   - Test on staging environment
   - Merge `staging` to `main` for production
   - Monitor first scheduled run

3. **Monitor First Week**:
   - Review logs after first automated Monday run
   - Verify all members processed correctly
   - Check admin notifications working
   - Confirm no unexpected errors

4. **Document Results**:
   - Update README with production status
   - Document any issues encountered
   - Create runbook for ongoing operations

---

## Troubleshooting

### DMs Not Sending
- Check `CIRCLE_HEADLESS_API` token is valid
- Verify bot user (73e5a590) has DM permissions
- Check Member API logs for JWT generation errors
- Test JWT generation manually with Auth API

### Deactivation Not Working
- Check `CIRCLE_API_TOKEN` has delete member permission
- Verify Admin API v2 endpoint accessible
- Check Circle API response for permission errors
- Test DELETE endpoint manually with curl

### Airtable Writes Failing
- Verify `AIRTABLE_API_KEY` has write permissions
- Check base ID and table name are correct
- Test Airtable connection manually
- Review Airtable API rate limits

### Member Detection Not Working
- Verify `CIRCLE_API_TOKEN` is set correctly
- Test `/community_members` endpoint manually
- Check members have `avatar_url` field in response
- Verify client-side filter logic (null or empty string)
- Review `getMembersWithoutPhotos()` function logs
- Check safety limits not exceeded (1000 member hard cap)

---

## Contact & Support

**Developer**: Claude Code
**Project Owner**: Zack Glick (circle@zackglick.com)
**Documentation**: `/docs/epics/EPIC_4.md`
**Test Results**: Document in this file after testing

---

**Testing Status**: 🟡 Awaiting Manual Testing
**Last Updated**: 2026-02-13
**Epic**: EPIC-4 Profile Photo Enforcement
