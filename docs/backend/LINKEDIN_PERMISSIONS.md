# LinkedIn Permissions

Required LinkedIn developer-app products, OAuth scopes, page roles and credential
handling for `tools/linkedin-events` (the `bocc-event` CLI).
Follows the root `CLAUDE.md` policy: **least privilege, document exact permissions,
never commit secrets.**

Sources (API version `202609`, checked 2026-10-02):
[Event Management overview](https://learn.microsoft.com/en-us/linkedin/marketing/event-management/event-management-overview),
[Events API](https://learn.microsoft.com/en-us/linkedin/marketing/event-management/events),
[Authorization code flow](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow),
[Version migrations](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/migrations).

## Developer app

One app at https://www.linkedin.com/developers/apps, associated with the BOCC page
(a page admin approves the association).

| Product | Access | Why |
|---|---|---|
| Event Management API | Self-serve, on request | `r_events`, `rw_events`: list and create the page's events |
| Sign In with LinkedIn using OpenID Connect | Self-serve | `openid profile`, to read the admin's member ID, which is the cover-image upload owner. LinkedIn rejects `openid` alone; `profile` (name and photo) was chosen over `email` as the less sensitive scope |

**Not requested:** Community Management API (`w_organization_social`), Share on LinkedIn
(`w_member_social`), Advertising API. Without them the tool **cannot post or reshare**.
The admin publishes the created event from LinkedIn's UI, and that is the human approval step.
Community Management is vetted, limited to registered legal organizations, and must be
requested on a new app with no other products. Revisit it only if the one-click publish
turns out not to work.

Auth tab: add redirect URL `http://localhost:8765/callback` (override with `LINKEDIN_REDIRECT_URI`).

## OAuth scopes

`r_events rw_events openid profile`. Nothing else. The authorizing member must be
**ADMINISTRATOR** or **CONTENT_ADMINISTRATOR** of the BOCC showcase page itself
(`urn:li:organization:89993057`), not only of a parent company page.

## Credentials

| Secret | Lives in | Notes |
|---|---|---|
| `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` | Environment / CI secret | Only needed for `bocc-event auth`. Never committed. |
| Access token + expiry + member URN | `~/.config/bocc-linkedin/token.env` (mode 0600, dir 0700), or the env vars `LINKEDIN_ACCESS_TOKEN`, `LINKEDIN_TOKEN_EXPIRES_AT`, `LINKEDIN_PERSON_URN` | 60-day lifetime. The tool warns 7 days ahead and refuses to run once it expires. Refresh tokens are documented only for approved partners. |

The tool refuses to read a token file that other users can read. It never prints tokens,
sends the bearer token only to `https://*.linkedin.com`, and does not follow redirects.

## Rotation and revocation

- Rotate the client secret on the app's Auth tab if it is ever exposed, then rerun `bocc-event auth`.
- Revoke the member token at https://www.linkedin.com/psettings/permitted-services.
- Changing the requested scopes invalidates earlier tokens, so rerun `bocc-event auth` afterward.

## API version

`LinkedIn-Version: 202609` sunsets **2027-09-15**. Bump `LINKEDIN_VERSION` in
`tools/linkedin-events/bocc_events/config.py` well before then, after reading the migration notes.
