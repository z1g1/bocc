# LinkedIn Permissions

Required LinkedIn developer-app products, OAuth scopes, page roles and credential
handling for `tools/linkedin-events` (the `bocc-event` CLI) and the admin app's LinkedIn
event (ADR 0012), which uses the same app and scopes.

Words (GLOSSARY.md): the **LinkedIn page** is BOCC's company page; a **LinkedIn profile** is
a person's own account; a **LinkedIn post** is made by either; a **LinkedIn repost** shares an
existing LinkedIn post or LinkedIn event. In the admin app, an Admin's permission for the app
to act on LinkedIn is their **LinkedIn authentication** (table `linkedin_authentications`),
never a "LinkedIn connection", which is LinkedIn's term for two linked people.
Follows the root `CLAUDE.md` policy: **least privilege, document exact permissions,
never commit secrets.**

Sources (API version `202609`, checked 2026-10-02):
[Event Management overview](https://learn.microsoft.com/en-us/linkedin/marketing/event-management/event-management-overview),
[Events API](https://learn.microsoft.com/en-us/linkedin/marketing/event-management/events),
[Authorization code flow](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow),
[Version migrations](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/migrations).

## Developer app

One app at https://www.linkedin.com/developers/apps, associated with the LinkedIn page
(a page admin approves the association).

| Product | Access | Why |
|---|---|---|
| Event Management API | Self-serve, on request | `r_events`, `rw_events`: list and create the LinkedIn page's LinkedIn events |
| Share on LinkedIn | Self-serve | `w_member_social`: (1) the Images API cover upload; (2) the public LinkedIn post from the admin's LinkedIn profile that publishes each LinkedIn event (the LinkedIn page stays organizer). **Side effect:** the token can post as the authorizing admin personally. Chosen by Zack 2026-10-02 |
| Sign In with LinkedIn using OpenID Connect | Self-serve | `openid profile`, to read the admin's member ID, which is the cover-image upload owner. LinkedIn rejects `openid` alone; `profile` (name and photo) was chosen over `email` as the less sensitive scope |

**Cover images:** the Events docs upload covers through the Assets API
(`/rest/assets?action=registerUpload`), but LinkedIn restricts that endpoint to partner apps. It
returns 403 (`partnerApiAssets.ACTION-registerUpload`) with `rw_events` alone (2026-10-02) and still
with `w_member_social` (2026-10-14). The tool uses the Images API instead
(`/rest/images?action=initializeUpload`, then a PUT to the returned URL), which accepts
`w_member_social`, and passes the image's id to `backgroundImage` as `urn:li:digitalmediaAsset:{id}`.
That's why Share on LinkedIn is requested.

**Publishing:** LinkedIn hides a LinkedIn event until its LinkedIn post is published. Without
`w_organization_social` neither the tool nor the admin app can post or repost as the LinkedIn
page, so the LinkedIn event is published with a LinkedIn post from the admin's own LinkedIn
profile. Verified 2026-10-02 with the 10/13 event. Hidden member posts
(`feedDistribution: NONE`) are rejected as sponsored content, and DRAFT posts can't be created
through the API. The LinkedIn page then makes a LinkedIn repost of the admin's LinkedIn post by
hand (the admin app's reminder after posting says so).

**Not requested:** Community Management API (`w_organization_social`) and Advertising API.
Without them the tool and the admin app **cannot post or repost as the LinkedIn page**.
Community Management would remove the manual LinkedIn repost but is vetted and needs a
dedicated app.
The admin publishes the created event from LinkedIn's UI, and that is the human approval step.
Community Management is vetted, limited to registered legal organizations, and must be
requested on a new app with no other products. Revisit it only if the one-click publish
turns out not to work.

Auth tab: add redirect URL `http://localhost:8765/callback` (override with `LINKEDIN_REDIRECT_URI`).

## OAuth scopes

`r_events rw_events openid profile w_member_social`. Nothing else. The authorizing member must be
**ADMINISTRATOR** or **CONTENT_ADMINISTRATOR** of the LinkedIn page (BOCC's showcase page) itself
(`urn:li:organization:89993057`), not only of a parent company page.

## Credentials

| Secret | Lives in | Notes |
|---|---|---|
| `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` | Environment / CI secret | Only needed for `bocc-event auth`. Never committed. |
| Access token + expiry + member URN (can post as the admin personally; treat as sensitive) | `~/.config/bocc-linkedin/token.env` (mode 0600, dir 0700), or the env vars `LINKEDIN_ACCESS_TOKEN`, `LINKEDIN_TOKEN_EXPIRES_AT`, `LINKEDIN_PERSON_URN` | 60-day lifetime. The tool warns 7 days ahead and refuses to run once it expires. Refresh tokens are documented only for approved partners. |

In the admin app each Admin's access token is their LinkedIn authentication: one
`linkedin_authentications` row, AES-256-GCM encrypted under `LINKEDIN_TOKEN_KEY` (Netlify
env), with its expiry shown on `/admin/account/` and the Thursday check alerting under 10
days. The admin app's redirect URL is `<site>/api/admin/linkedin/callback`: the route keeps
its old name because it is registered on the app's Auth tab.

The tool refuses to read a token file that other users can read. It never prints tokens,
sends the bearer token only to `https://*.linkedin.com`, and does not follow redirects.

## Rotation and revocation

- Rotate the client secret on the app's Auth tab if it is ever exposed, then rerun `bocc-event auth`.
- Revoke the member token at https://www.linkedin.com/psettings/permitted-services.
- Changing the requested scopes invalidates earlier tokens, so rerun `bocc-event auth` afterward.

## API version

`LinkedIn-Version: 202609` sunsets **2027-09-15**. Bump `LINKEDIN_VERSION` in
`tools/linkedin-events/bocc_events/config.py` well before then, after reading the migration notes.
