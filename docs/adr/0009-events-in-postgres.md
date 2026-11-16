# ADR 0009 — Events live in Postgres, and event pages render on request

- **Status:** Accepted (2026-11-16)
- **Date:** 2026-11-16
- **Deciders:** Zack Glick

## Context

Event facts are spread across three places:
- `website/_data/luma_events.yml`, which drives the SEO pages
- the URL table in `docs/social/README.md` (Luma, LinkedIn, Facebook, Eventbrite)
- a Google Form and its Sheet, for after-event data

Each new Luma date means a 15-credit deploy. The Google Form allows typo dates (one row reads
`7/14/0026`), and its answers can't be edited afterwards.

There is one event per day. The `bocc-afternoon` series has ended.

## Decision

1. **`events` (key: `event_date`)**:
   - `status`: `scheduled` / `held` / `cancelled`
   - `location`: `lobby` / `food_hall` / `other`, plus free text for `other`. Location belongs
     to the event, not the report
   - `cancel_reason`: `weather` / `facility` / `other_event` / `other`, plus free text
   - `cancel_announced`: boolean

   A past date still marked `scheduled` shows as **"report missing"** on the admin dashboard.
2. **`event_reports`** (one per held event) replaces the Google Form:
   - `gives_asks_count`
   - `notes`
   - `bling_given`, and `bling_details` as free text
   - `submitted_by`, the logged-in user
   - timestamps

   Submitting a report moves the event to `held`. The calculated check-in count is shown next to
   the Gives and Asks count but never stored, and nothing relies on it, since not everyone checks
   in.
3. **`event_links (event_date, platform, url)`**, with platform one of `luma`, `eventbrite`,
   `facebook_event`, `linkedin_event`. All four are expected every week, and the admin event
   page shows a readiness checklist calculated from the data.
4. **`/events/YYYY-MM-DD/` is rendered from Neon on request** and cached at Netlify's CDN. A save
   in the admin clears that page from the cache.
   - **Luma is the only call to action.** The other listings are used for discovery off the
     site and appear only as hidden JSON-LD `sameAs` links.
   - Unknown dates return a real 404 or redirect to the calendar, which replaces the 302
     catch-all.
5. **Check-ins join to events on `checkin_date`.** The `checkins` table is unchanged, and streaks
   (ADR 0004) are unchanged. Cancelled events don't affect streaks in this work.
6. **One-time imports:** `luma_events.yml` plus the README URL table, then the Google Form CSV,
   with the `7/14/0026` date fixed from its timestamp. The YAML file and README table are deleted
   after the import.

## Consequences

- Event edits no longer cost deploys. The public event page needs the database to render, which
  a static rebuild did not. The CDN cache absorbs most of the load.
- Admin URLs follow the date: `/admin/events/2026-11-24`.
- *Phase 0 (2026-11-16):* pages set `Netlify-CDN-Cache-Control` and `Netlify-Cache-Tag`
  themselves, and saves call `purgeCache` from `@netlify/cache`. Astro's own route cache is
  experimental and not used. Purges cover every deploy unless they pass `deployAlias`.
  *Still unverified:* a scoped purge from the branch deploy leaving production alone.
- *Proposed change, waiting for Zack:* see "Proposed ADR changes" item 4 in the plan.
