# Story 10: Circle.so Workflow Design for Engagement Milestones

**ID**: STORY-10
**Epic**: EPIC-3 (Engagement Rewards)
**Status**: PENDING (requires admin action in Circle.so)
**Story Points**: 3
**Tasks**: TASK-41, TASK-42, TASK-43

---

## As a...
Community admin, I want to **configure automated rewards** in Circle.so that trigger when a member reaches attendance milestones, so that member engagement is recognized without manual intervention.

## Acceptance Criteria

- [ ] Circle.so `checkinCount` custom field (Number type, default 0) is created by admin
- [ ] Workflow documentation is provided covering milestone thresholds: 1, 5, 10, 25 check-ins
- [ ] Each workflow example specifies: trigger condition, actions (badge, message, role, content access)
- [ ] Documentation is in `docs/EPIC_3_ENGAGEMENT_REWARDS.md`

## Suggested Workflow Milestones

| Threshold | Badge/Role | Action |
|-----------|-----------|--------|
| 1 | Newcomer | Welcome badge assigned |
| 5 | Regular | Congratulations message + access to Regulars Lounge |
| 10 | VIP | VIP role + personalized thank you |
| 25 | Super Fan | Community spotlight + leadership opportunities |

## Implementation Notes

This story is documentation and admin-configuration work — no code changes are required. The `checkinCount` field is updated by the backend (Epic 3 code). Circle.so's native workflow engine monitors field changes and executes configured actions. The workflow setup is performed entirely within the Circle.so admin UI.
