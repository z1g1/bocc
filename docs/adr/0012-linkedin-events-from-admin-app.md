# ADR 0012 — The weekly LinkedIn event is created from the admin app, and the event page gets tabs and an Event Image

- **Status:** Accepted (2026-11-19). Spec: GitHub issue #18. Plan: Phase 6 of
  [`ADMIN_APP_PLAN.md`](../admin/ADMIN_APP_PLAN.md#phase-6-linkedin-events-and-the-event-page-prefactor-adr-0012).
- **Date:** 2026-11-19
- **Deciders:** Zack Glick

## Context

Each week Zack creates the BOCC LinkedIn event by hand with the `bocc-event` Python CLI
(`tools/linkedin-events/`) on his own machine. Everything else about the week (status,
location, listings, the social work order, the report and the photos) already lives on
`/admin/events/YYYY-MM-DD/` (ADRs 0009, 0010, 0011). The CLI needs a local Python setup, a local
OAuth token and a local JSON ledger nobody else can see, and it knows nothing about the event's
location, cancellation or listings in Postgres, so the wording (lobby or food hall) and the
`linkedin_event` listing are kept in step by hand.

The event page has also grown into one long scroll of H2 sections that mixes three jobs:
setting the event up, reaching people on social, and collecting data afterwards. There is no
single image for the week, so each listing and the promo video's cover get their image chosen
separately. And "Social photos" wrongly suggests those photos are only for social.

LinkedIn facts that shape this (carried over from the CLI):
- Only page ADMINISTRATOR or CONTENT_ADMINISTRATOR members can create organization events, with
  the member's own token. Page roles can't be checked ahead of time without
  `r_organization_admin`.
- LinkedIn hides an event until it is posted, and an unposted event can't be fetched or deleted.
- The API is versioned. `LinkedIn-Version: 202609` **sunsets on 2027-09-15**.

## Decision

1. **The event page prefactor (tabs).** The Readiness summary (since #59, two sections: Event readiness and Social plan readiness) stays at the top, above three
   server-rendered tabs that work without JavaScript:
   - **Event Info:** Status and location, Online Event Listings, Event Image, LinkedIn event

   *Corrected 2026-11-20 (#58):* there is no "Cancel this event" section. An event is
   cancelled from **Status and location**: Status → Cancelled (with its reason fields). Once a
   posted LinkedIn event's Event is cancelled, the red "Cancel the LinkedIn event on LinkedIn"
   item and its "Done on LinkedIn" form show under it, in the same section (decision 8).
   - **Social Posts:** Social post
   - **Post Event:** Report, Sign-in board, Photos from Event

   *Amended 2026-11-19 (#38):* the LinkedIn event section (LinkedIn authentication status, preview,
   dialog, dry run and live create, Publish-retry and allow-retry, the "LinkedIn is out of date"
   notice) is on Event Info, after the Event Image, not on Social Posts. The LinkedIn event
   is made on Tuesday afternoon for the next week's BOCC, alongside the other online
   listings; the social post is later in the week. Its actions and the OAuth return land on
   `?tab=info`.

   The tab is picked by `?tab=info|social|post`. With no tab, or an unknown one, a future date
   opens Event Info and today or a past date opens Post Event, in Eastern time. Every form
   carries its tab, so the post/redirect/get returns to it, and validation errors show on that
   tab. The `social` role's fence (ADR 0008) is unchanged: the event page stays Admin only.
2. **Two label-only renames.** "Listings" becomes **Online Event Listings** and "Social photos"
   becomes **Photos from Event**. The media kind stays `social_photo` and the `event_links`
   slots don't change: no schema or data change.
3. **One Event Image per event.** A new media kind `event_image`, at most one per event: either
   an uploaded image (original, display, thumb and its **16:9 Event Image** made in the
   browser: since ticket #40 the image at full height centred on the "Just the Beans"
   background, never cropped; it was a centre crop before) or a reference to a publicly usable `social_photo` from one of about the last 8
   events. Resolution: uploaded, then referenced, then the square BOCC logo (with a checked-in
   16:9 Event Image, on brand cream until ticket #40 and now on the beans background). Deleting a photo some event uses as its Event Image is refused.
   The Social Post gains a cover image that defaults to the Event Image.
4. **A per-Admin LinkedIn authentication** (called a "LinkedIn connection" until #58). An Admin
   authenticates with their own LinkedIn profile once with the CLI's scopes (`r_events rw_events openid profile w_member_social`). The token is encrypted
   at rest (AES-256-GCM under `LINKEDIN_TOKEN_KEY`), never logged, traced or put in a URL, and
   sent only to LinkedIn hosts without following redirects. OAuth `state` is a signed,
   HttpOnly, short-lived cookie, and the callback needs the admin role.
5. **Dry run by default, live only in production.** Only where `LINKEDIN_LIVE=1` (production)
   does the app call LinkedIn's write endpoints. Everywhere else a recording client returns the
   payloads it would have sent. A live create also needs an explicit confirmation field from the
   confirm dialog.
6. **Wording by location.** `food_hall` gets the food-hall description, venue note and
   commentary; `lobby` or unset the normal text; `other` is refused (wording deferred). The
   fixed facts are code constants carried over from the CLI: organizer
   `urn:li:organization:89993057`, `LinkedIn-Version: 202609`, Tuesday 7:30-9:00 AM
   America/New_York, 1 Seneca St, Buffalo NY 14203, the Luma page as the external link, LISTED.
7. **A Postgres ledger with a recoverable state machine.** `linkedin_events`, unique on
   `event_date`: `pending` (committed before the create call) → `created` → `posted`, each
   transition audited. A failure leaves the last committed state and the page offers the
   matching recovery: Publish-retry after `created`, and "I checked: nothing was created, allow
   retry" for a stuck `pending`. Duplicates are refused from the ledger and from LinkedIn's
   organizer listing (same name or same Eastern day). Posting fills the `linkedin_event`
   listing.
8. **Flag drift, don't sync.** The ledger stores the location, image and commentary sent. When
   the location or Event Image changes after posting, the page says LinkedIn is out of date;
   when a posted event is cancelled, a "Cancel the LinkedIn event on LinkedIn" item shows until
   ticked. API sync is deferred (#14).
9. **Retire the CLI.** Its ledger is imported into `linkedin_events` before the first webapp
   create. After the first successful live create from production, the CLI is deleted (it stays
   in git history), and the permissions doc and the `bocc-linkedin-event` skill are rewritten
   for the web flow.
10. **One combined production release.** The prefactor and the LinkedIn work ship in a single
    production deploy (each costs 15 credits; staging is free). The release runbook checks the
    prefactor on staging and then production **before** the first live create. The docs-only
    follow-ups after that create are batched into a later deploy.

## Consequences

- The weekly LinkedIn step needs no local setup and is visible to every Admin, with a history
  in Postgres.
- In practice only Zack can create events (LinkedIn won't give a helper a page role), but the
  per-Admin LinkedIn authentication means a future helper with the role just works.
- Tokens expire after about 60 days: the page shows the expiry, and the Thursday check sends an
  ntfy alert under 10 days.
- `LinkedIn-Version: 202609` sunsets on 2027-09-15. The release runbook carries a reminder to
  move to a newer version before then.
- The tabs add a `tab` query parameter to every redirect from the event page and from the media
  delete route. Links to the bare page still work, landing on the date's default tab.

## Amendments from the build (2026-11-19)

Deliberate extras beyond the spec, recorded so they aren't mistaken for drift:

- **Authenticating is refused when LinkedIn grants fewer scopes** than the five asked for (the
  member unticked one): no LinkedIn authentication is stored and the page asks to authenticate
  again allowing all of them (`notice=scopes`),
  rather than storing a token that fails later at create time.
- **The Thursday check alerts when it can't read the LinkedIn authentications**, as well as on
  expiry: a "the Thursday check couldn't read the LinkedIn authentications" ntfy push, so a broken grant or database outage
  doesn't hide an expiring token.
- **The CLI ledger import does more than copy rows** (`backend/scripts/import-linkedin-ledger.js`):
  it creates a missing `events` row (`scheduled`) for an imported week, fills a posted week's
  `linkedin_event` listing when it has none, writes one summary `linkedin_event.import` audit
  row per run that changed something, and has `--prefer-db` to keep the stored row on a
  conflict instead of refusing `--apply`.
- **One Publish the LinkedIn post at a time** ("Publish event" until #58). Two concurrent requests (double click, second
  tab) could both post. Migration `20261130120000_linkedin_events_post_claim.sql` adds
  `post_claimed_at`: a request claims the `created` row with a conditional UPDATE before
  calling LinkedIn (the live create takes it in the same UPDATE that moves the row to
  `created`); a failed post releases it; an unreleased claim (posted but not recorded, or a
  request that died) expires after ten minutes. The claim is a lock, not a change, so it isn't
  audited; the post it guards is. Publish the LinkedIn post also confirms in its own dialog and is refused
  for a past date or a cancelled event, through the same allowed-actions matrix as create.
- **LinkedIn's signed image `uploadUrl` never reaches a trace.** The runtime's fetch tracing
  records full outgoing URLs, and that URL is the one the app doesn't build. The upload PUT runs
  with OpenTelemetry's suppress-tracing context key set (`telemetry.mjs`
  `withoutClientTracing`), so the runtime records no client span for it
  ([OBSERVABILITY.md](../backend/OBSERVABILITY.md#what-the-runtimes-fetch-tracing-records)).
- **`site_reader` and `social_checker` see `events.event_image_media_id`** through their
  table-level `SELECT` on `events`: an opaque uuid, reviewed and kept
  ([NEON_PERMISSIONS.md](../backend/NEON_PERMISSIONS.md)).
- **The 16:9 Event Image is composed, not cropped (ticket #40).** The Event Image is asked for as a
  1:1 square (a warning when it isn't). Its 16:9 Event Image is the image at full height (or full
  width, if wider than 16:9) centred on the 1920x1080 "Just the Beans" background
  (`public/assets/images/brand/just-the-beans-16x9.jpg`), made in the browser
  (`admin-media-lib.js` `compose16x9`), for an upload and for a picked Photo from Event alike.
  Migration `20261202120000_event_media_cover_outdated.sql` marks every one made before
  (`event_media.cover_outdated`, now `image_16x9_outdated`, ticket #55); the event page remakes its own as it opens, and
  **`/admin/media/covers/`** remakes them all at once (a one-off for an Admin after the
  migration and deploy). A remake overwrites the same object key, so a LinkedIn event already
  posted records no image drift and is not touched; while one is outdated it is not sent
  to LinkedIn. The object key stays `…/cover.jpg` and the route `/admin/media/covers/`: only
  the words and the columns changed (ticket #55, GLOSSARY.md).

## Amendment: LinkedIn authentication and the LinkedIn words (2026-11-20, #58)

GLOSSARY.md (spec #49) fixes the LinkedIn words, and the app now uses them:

- **LinkedIn authentication**, not "LinkedIn connection", for an Admin's permission for the app
  to act on LinkedIn (a LinkedIn connection is LinkedIn's own term for two linked people). The
  page says Authenticate with LinkedIn, Re-authenticate, Remove LinkedIn authentication and
  "The LinkedIn authentication expires on …"; the Thursday check's alert says the same. The
  table is `linkedin_authentications` (migration `20261203120000`, #50). Kept as they were:
  the routes `/api/admin/linkedin/connect|callback|disconnect` (the callback is the OAuth
  redirect URI registered with LinkedIn), the `?linkedin=` notice values, the audit actions
  `linkedin_connection.connect|disconnect` with target `linkedin_connections`, and the token's
  AES-GCM associated data `linkedin_connections:<user id>`, so every stored token still
  decrypts and nobody has to re-authenticate.
- **No posting as the LinkedIn page.** Posting or reposting as the LinkedIn page needs
  `w_organization_social` from LinkedIn's Community Management API, which BOCC can't get
  ([LINKEDIN_PERMISSIONS.md](../backend/LINKEDIN_PERMISSIONS.md)). So the LinkedIn event is
  hosted by the LinkedIn page, but the **LinkedIn post** that publishes it still comes from the
  Admin's **LinkedIn profile** (`w_member_social`), and the LinkedIn page makes a **LinkedIn
  repost** of it by hand. The reminder after posting says exactly that.
- **"Publish event" is "Publish the LinkedIn post"**, and its confirmation names the post's
  author (the Admin's LinkedIn profile name). The `created` state says LinkedIn keeps the
  LinkedIn event hidden until its LinkedIn post is published.

The steps, ledger statuses, scopes, retries and audit are unchanged.
