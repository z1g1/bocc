# LinkedIn Permissions

Required LinkedIn developer-app products, OAuth scopes, redirect URLs, page roles and
credential handling for the admin app's LinkedIn event (ADR 0012): the weekly LinkedIn event
is created from the event page, `/admin/events/YYYY-MM-DD/`, Event Info tab.

The `bocc-event` Python CLI (`tools/linkedin-events/`) that did this before used the same
app and scopes. It was retired in #30 once the admin app had made a real production create,
and it is only in git history now. Its localhost redirect URL is no longer used.

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
| Share on LinkedIn | Self-serve | `w_member_social`: (1) the Images API upload of the 16:9 Event Image (LinkedIn's event cover); (2) the public LinkedIn post from the admin's LinkedIn profile that publishes each LinkedIn event (the LinkedIn page stays organizer). **Side effect:** the token can post as the authorizing admin personally. Chosen by Zack 2026-10-02 |
| Sign In with LinkedIn using OpenID Connect | Self-serve | `openid profile`, to read the admin's member ID, which is the owner of the 16:9 Event Image upload and the author of the LinkedIn post. LinkedIn rejects `openid` alone; `profile` (name and photo) was chosen over `email` as the less sensitive scope |

**Cover images:** the Events docs upload covers through the Assets API
(`/rest/assets?action=registerUpload`), but LinkedIn restricts that endpoint to partner apps. It
returns 403 (`partnerApiAssets.ACTION-registerUpload`) with `rw_events` alone (2026-10-02) and still
with `w_member_social` (2026-10-14). The app uses the Images API instead
(`/rest/images?action=initializeUpload`, then a PUT to the returned URL), which accepts
`w_member_social`, and passes the image's id to `backgroundImage` as `urn:li:digitalmediaAsset:{id}`.
That's why Share on LinkedIn is requested.

**Publishing:** LinkedIn hides a LinkedIn event until its LinkedIn post is published. Without
`w_organization_social` the admin app can't post or repost as the LinkedIn page, so the
LinkedIn event is published with a LinkedIn post from the admin's own LinkedIn profile.
Verified 2026-10-02 with the 10/13 event. Hidden member posts (`feedDistribution: NONE`) are
rejected as sponsored content, and DRAFT posts can't be created through the API. The LinkedIn
page then makes a LinkedIn repost of the admin's LinkedIn post by hand (the admin app's
reminder after posting says so).

**Not requested:** Community Management API (`w_organization_social`) and Advertising API.
Without them the admin app **cannot post or repost as the LinkedIn page**. Community Management
would remove the manual LinkedIn repost, but it is vetted, limited to registered legal
organizations, and must be requested on a new app with no other products. Revisit it only if
the manual repost becomes a problem.

## Redirect URLs (the web OAuth flow)

The admin app's OAuth redirect URI is `<site origin>` + `/api/admin/linkedin/callback`
(`CALLBACK_PATH` in `src/lib/linkedin/linkedin.mjs`). The origin is the deploy's
`BETTER_AUTH_URL`, never Netlify's `URL` or `DEPLOY_PRIME_URL`. On the app's **Auth** tab,
under "Authorized redirect URLs for your app", list exactly:

| Environment | Redirect URL |
|---|---|
| Production | `https://716coffee.club/api/admin/linkedin/callback` |
| Staging (branch deploy of `dev`) | `https://dev--bocc-backend.netlify.app/api/admin/linkedin/callback` |

LinkedIn matches the URL exactly, so a deploy whose origin isn't listed gets LinkedIn's
redirect-URI error on Authenticate with LinkedIn. Deploy Previews have their own origins and
aren't listed: test LinkedIn on staging. Remove the CLI's old `http://localhost:8765/callback`
from the Auth tab; nothing uses it now. (For a local `npm run dev:admin` against LinkedIn you
would add `http://localhost:4321/api/admin/linkedin/callback` temporarily; the local default is
no LinkedIn configuration at all, and the page then says LinkedIn isn't configured.)

The route keeps its old "callback" name and the `/api/admin/linkedin/connect|callback|disconnect`
paths stayed when "LinkedIn connection" became "LinkedIn authentication" (#58), because the
callback is registered here.

How the flow works:

1. **Authenticate with LinkedIn** (on the event page's Event Info tab, or `/admin/account/`) is a
   GET to `/api/admin/linkedin/connect?return=<date|account>`. It sets a signed, HttpOnly,
   10-minute `state` cookie bound to the signed-in user (`SameSite=Lax`, path
   `/api/admin/linkedin/`) and redirects to LinkedIn's authorize page with the five scopes.
2. LinkedIn sends the browser back to `/api/admin/linkedin/callback?code=…&state=…`. The callback
   needs the admin role, checks `state` against the cookie, exchanges the code for a token
   (the client secret goes only in that request's body), reads the member ID and name, and
   refuses to store anything if LinkedIn granted fewer than the five scopes.
3. The token is stored encrypted, and the browser returns to the page it started from with a
   `?linkedin=<notice>` message.

Staging authenticates for real (the token exchange and profile read are reads), but it never
calls LinkedIn's write endpoints: only production sets `LINKEDIN_LIVE=1` (ADR 0012 decision 5),
so on staging Create live event is a dry run that shows the requests it would have sent.

## OAuth scopes

`r_events rw_events openid profile w_member_social`. Nothing else. The authorizing member must be
**ADMINISTRATOR** or **CONTENT_ADMINISTRATOR** of the LinkedIn page (BOCC's showcase page) itself
(`urn:li:organization:89993057`), not only of a parent company page. Page roles can't be
checked ahead of time without `r_organization_admin`, so a missing role shows up as a 403 at
create time.

## Credentials

Netlify environment variables (`src/lib/linkedin/env.mjs`, fail fast when partly set):

| Variable | Where | Notes |
|---|---|---|
| `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` | Production and branch deploys | From the app's Auth tab. Never committed |
| `LINKEDIN_TOKEN_KEY` | Production and branch deploys | 32 random bytes (`openssl rand -hex 32`). Encrypts the stored tokens (AES-256-GCM) and signs the OAuth `state` cookie, with separate derived keys. Changing it makes every stored token unreadable, so every Admin re-authenticates |
| `LINKEDIN_LIVE` | Production only, `1` | Allows the write endpoints. Unset everywhere else (dry run) |

With none of them set, LinkedIn is simply off on that deploy.

Each Admin's access token is their LinkedIn authentication: one `linkedin_authentications` row,
the token AES-256-GCM encrypted under `LINKEDIN_TOKEN_KEY` (it can post as that Admin
personally, so treat it as sensitive). Tokens last about 60 days and LinkedIn documents refresh
tokens only for approved partners, so the Admin re-authenticates: the expiry shows on the event
page and `/admin/account/` (amber under 7 days, red once expired), and the Thursday check sends
an ntfy alert under 10 days. The app never logs, traces or puts a token, code or state in a URL
or audit row, sends the bearer token only to LinkedIn hosts, and doesn't follow redirects.

## Rotation and revocation

- Rotate the client secret on the app's Auth tab if it is ever exposed, update
  `LINKEDIN_CLIENT_SECRET` in Netlify for production and branch deploys, then redeploy.
  Stored tokens keep working.
- **Remove LinkedIn authentication** on `/admin/account/` (or the event page) deletes the
  Admin's stored token. To revoke the app's access on LinkedIn too, use
  https://www.linkedin.com/psettings/permitted-services.
- Changing the requested scopes invalidates earlier tokens, so every Admin re-authenticates
  afterward.

## Verified behaviour

Found while building the CLI (2026-10-02 unless noted) and carried into the admin app:

- Listing the LinkedIn page's events returns only *posted* events. API-created events don't
  appear until posted, which is why the app keeps its own ledger (`linkedin_events`).
- A cover upload needs `w_member_social`; `rw_events` alone gets a 403.
- The Assets API (`/rest/assets`) 403s even with `w_member_social` (partner-only, 2026-10-14),
  so covers go through the Images API (`/rest/images`), whose id is reused as the
  `digitalmediaAsset` URN.
- A member post (`author: urn:li:person:…`) referencing `urn:li:event:{id}` publishes a
  page-organized event.
- Hidden member posts (`feedDistribution: NONE`) are rejected as sponsored content, and the API
  can't create a DRAFT post, so every publish is a real feed post.
- An event that was created but never posted is invisible and **can't be deleted**: publish it
  (Publish the LinkedIn post). Deleting a published event's post deletes the event.
- `discoveryMode` can be changed after posting (partial update), for example `URL_ONLY` to
  `LISTED`.

## API version

`LinkedIn-Version: 202609` sunsets **2027-09-15**. Bump `LINKEDIN_VERSION` in
`src/lib/linkedin/client.mjs` well before then, after reading the migration notes.
