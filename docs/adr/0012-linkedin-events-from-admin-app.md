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

1. **The event page prefactor (tabs).** The Readiness summary stays at the top, above three
   server-rendered tabs that work without JavaScript:
   - **Event Info:** Status and location, Online Event Listings, Event Image, Cancel this event
   - **Social Posts:** Social post, LinkedIn event
   - **Post Event:** Report, Sign-in board, Photos from Event

   The tab is picked by `?tab=info|social|post`. With no tab, or an unknown one, a future date
   opens Event Info and today or a past date opens Post Event, in Eastern time. Every form
   carries its tab, so the post/redirect/get returns to it, and validation errors show on that
   tab. The `social` role's fence (ADR 0008) is unchanged: the event page stays Admin only.
2. **Two label-only renames.** "Listings" becomes **Online Event Listings** and "Social photos"
   becomes **Photos from Event**. The media kind stays `social_photo` and the `event_links`
   slots don't change: no schema or data change.
3. **One Event Image per event.** A new media kind `event_image`, at most one per event: either
   an uploaded image (original, display, thumb and a 16:9 centre-crop cover copy made in the
   browser) or a reference to a publicly usable `social_photo` from one of about the last 8
   events. Resolution: uploaded, then referenced, then the square BOCC logo (with a checked-in
   16:9 version on brand cream). Deleting a photo some event uses as its Event Image is refused.
   The Social Post gains a cover image that defaults to the Event Image.
4. **A per-user LinkedIn connection.** An Admin connects their own LinkedIn account once with the
   CLI's scopes (`r_events rw_events openid profile w_member_social`). The token is encrypted
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
  per-user connection means a future helper with the role just works.
- Tokens expire after about 60 days: the page shows the expiry, and the Thursday check sends an
  ntfy alert under 10 days.
- `LinkedIn-Version: 202609` sunsets on 2027-09-15. The release runbook carries a reminder to
  move to a newer version before then.
- The tabs add a `tab` query parameter to every redirect from the event page and from the media
  delete route. Links to the bare page still work, landing on the date's default tab.
