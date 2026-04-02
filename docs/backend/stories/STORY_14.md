# Story 14: Netlify Deployment Configuration

**ID**: STORY-14
**Epic**: Cross-cutting (Phase 0: Project Setup)
**Status**: COMPLETED
**Story Points**: 1
**Tasks**: TASK-13, TASK-14

---

## As a...
DevOps operator, I want the Netlify deployment to be **correctly configured** so that functions deploy reliably and test files are excluded from the serverless function bundle.

## Acceptance Criteria

- [x] `netlify.toml` configures CORS headers for the functions
- [x] Test files in `tests/` are excluded from Netlify function deployment
- [x] Functions directory is set to `netlify/functions/`
- [x] `.netlify/state.json` tracks deployment state
- [x] Auto-deployment on push to main branch is confirmed working

## Implementation Notes

Netlify Functions scans the functions directory for `.js` files and deploys each as a serverless endpoint. Test files must not be in the functions directory — they were moved to `tests/` at the project root (commit `88e5906`).
