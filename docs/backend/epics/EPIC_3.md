# Epic 3: Engagement Rewards — Check-in Counter

**ID**: EPIC-3
**Status**: CODE COMPLETE — Pending Circle.so custom field setup
**Story Points**: 7
**Phase**: Phase 3
**Completion Commit**: `feadbed` (Implement Epic 3: Engagement Rewards with check-in counter)

---

## Summary

Track each member's total check-in count in a Circle.so custom field (`checkinCount`). The counter increments by 1 after every successful check-in. This count can then be consumed by Circle.so's native workflow engine to automate engagement rewards such as badges, role assignments, and exclusive content access at milestone thresholds (1, 5, 10, 25 check-ins).

## Acceptance Criteria

- [x] After a successful check-in and Circle member creation/lookup, increment the member's `checkinCount` custom field
- [x] Counter update uses `PATCH /community_members/{id}` with `custom_fields_attributes`
- [x] Counter update failure does not block or fail the check-in (non-blocking, nested try/catch)
- [x] Counter update errors are logged with full response details
- [x] Debug check-ins do not trigger counter increment (inherits skip from Epic 2)
- [ ] Integration test verified against live Circle.so (requires custom field creation by admin)
- [ ] Circle.so workflows configured for milestone rewards

## Stories

- STORY-8: Custom field update API integration
- STORY-9: Check-in counter increment logic
- STORY-10: Circle.so workflow design for engagement milestones

## Key Technical Decisions

- **Increment by 1, not absolute set**: Rather than querying Airtable for the total historical count and setting an absolute value, the implementation increments by 1 on each check-in. This is simpler, requires fewer API calls, and works even if Airtable is slow. Trade-off: counts can drift if Circle updates fail silently. A periodic reconciliation job is a future enhancement.
- **`custom_fields_attributes` payload**: The PATCH request body uses `{ custom_fields_attributes: { checkinCount: N } }` based on common Circle.so API patterns. This format requires verification during integration testing — Epic 3 is marked as pending that step.
- **Nested try/catch**: Counter increment is inside its own `try/catch` block nested within the outer Circle.so `try/catch`. This means: if `ensureMember` fails, the counter is never attempted (no member ID to update). If `incrementCheckinCount` fails, the check-in and the Circle invitation both still succeed.
- **Counter initialization**: First-time members have no existing `checkinCount` value. The implementation defaults `currentCount` to `null` and sets the new value to `1` when no current count is provided. This avoids a read-before-write API call.

## Limitations and Known Issues

1. **Race condition on concurrent check-ins**: Two simultaneous check-ins for the same member could both read count=N and both write N+1. Mitigated by deduplication (Epic 1) which prevents same-event same-day duplicates. For different events on the same day, the risk is low in practice for BOCC's event frequency.
2. **No atomic increment**: Circle.so API does not expose an atomic increment operation. The increment is read-modify-write. See race condition note above.
3. **Count drift**: If the Circle update fails (logged but non-blocking), the count will be lower than actual. A future periodic sync from Airtable's rollup count can reconcile this.

## Files Modified

| File | Change |
|------|--------|
| `netlify/functions/utils/circle.js` | Added `updateMemberCustomField()` and `incrementCheckinCount()` |
| `netlify/functions/checkin.js` | Integrated counter increment after ensureMember, nested try/catch |
| `docs/EPIC_3_ENGAGEMENT_REWARDS.md` | Full setup guide and documentation |

## Commit History

| Commit | Message |
|--------|---------|
| `feadbed` | Implement Epic 3: Engagement Rewards with check-in counter |

## Remaining Work

1. **Admin action**: Create `checkinCount` Number custom field in Circle.so (Settings > Member Profile > Custom Fields). Default value: 0.
2. **Integration test**: Make a non-debug check-in and verify the counter increments in the Circle member profile.
3. **Workflow setup** (optional): Create Circle.so workflows triggered at count milestones (1, 5, 10, 25).
4. **Unit tests**: Add specific tests for `updateMemberCustomField()` and `incrementCheckinCount()` functions.
