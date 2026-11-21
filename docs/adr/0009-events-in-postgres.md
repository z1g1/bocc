# ADR 0009 — Events live in Postgres, and event pages render on request

- **Status:** Accepted (2026-11-16); amended 2026-11-18 (Phase 4 build, see below)
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
   - The page sets `Netlify-CDN-Cache-Control` (`durable`) and `Netlify-Cache-Tag:
     event-YYYY-MM-DD` itself. Astro's experimental route cache is not used.
   - **Every purge passes `deployAlias`** (the branch, read from
     `Astro.locals.netlify.context.deploy`, since Netlify's `CONTEXT`/`BRANCH` env vars are null
     at runtime) **or `domain`**, and refuses to run without one outside production, because a
     purge otherwise covers every deploy. The purging function uses the modern default-export
     style, so Netlify supplies the purge token (amended 2026-11-16).
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
- *Phase 0 hands-on (2026-11-16):* a tagged page was served from the durable cache and a scoped
  purge re-rendered it within 5 s. That the scoped purge leaves production alone is re-checked
  after the production release, once production serves tagged pages
  ([PHASE4_RELEASE.md](../admin/PHASE4_RELEASE.md) step 14).

## Amendments (2026-11-18, Phase 4 build)

Settled while building Phase 4 on `dev`. Code: `src/pages/events/[date].astro`,
`src/pages/sitemap.xml.ts`, `src/lib/site/` (`db.mjs`, `http.mjs`, `purge.mjs`).

1. **Purge scope, per deploy context** (refines decision 4), from
   `Astro.locals.netlify.context.deploy`:
   - `production`: `{ domain }`, the hostname of the site URL (`716coffee.club`). Netlify:
     a domain-scoped purge "targets the currently published production deploy on the
     specified domain".
   - `branch-deploy`: `{ deployAlias: deploy.branch }`, e.g. `dev`. That `deploy.branch`
     holds the alias is observed, not documented by Netlify.
   - deploy previews, or a missing branch or domain: **refused** and logged. There is no
     unscoped purge.
   - `astro dev`, or no Netlify context: skipped.

   One `purgeCache` call per save carries every tag. It is raced against a 3 s timeout with
   no retry on 429, and it never throws: the save is already committed, so a failed purge
   is logged and the page refreshes when its CDN max-age ends.
2. **Cache lifetime.**
   - `Netlify-CDN-Cache-Control: public, durable, max-age=<seconds to the next Eastern
     midnight, at most a day>, stale-while-revalidate=3600`. The purge is the normal way a
     page changes, and the midnight expiry is the backstop: it lets a page roll from
     upcoming to past, and its "Next" link move on, without anyone saving.
   - The browser gets `Cache-Control: public, max-age=0, must-revalidate`, so it sees a
     purge on its next load.
   - Query strings make separate CDN entries. Netlify documents no way to ignore them, so
     none is set. They carry the same tags, so they are purged with the plain URL.
3. **Tags.**
   - Every event page is tagged `event-YYYY-MM-DD`.
   - Pages that show other dates also carry `event-list`: the sitemap, and the past and
     cancelled pages with their "Next" link. Every purge includes `event-list`.
   - An upload that creates an event's row (the first photo for a date) purges that date
     too, so a cached 404 clears.
4. **What each URL returns** (replaces the last bullet of decision 4):
   - **Unknown well-formed date:** a real 404 ("Out of Coffee"), CDN-cached for 5 minutes
     with the date's tag.
   - **Malformed date:** a 404 that is never cached and never queries the database.
   - **Past dates (held, or scheduled but past):** stay at 200 with a "this one has passed"
     notice and a link to the next scheduled event. They are `noindex` and have no Event
     JSON-LD.
   - **Cancelled dates:** a cancelled notice with JSON-LD `EventCancelled`, `noindex` once
     past.
   - `/events/` is a 302 to `/`.
   - If the database can't be reached: 503, `no-store`, `Retry-After: 60`.
5. **The sitemap needs the database.** `/sitemap.xml` is rendered on request, lists only
   upcoming scheduled events (`lastmod` is the event's last change), and is tagged
   `event-list`. If Neon is down it returns 503 rather than a sitemap without its events,
   so crawlers retry.
6. **A separate read-only login for public pages.** The pages read Neon as `site_reader`
   (`SITE_DB_URL`, pooled), which has SELECT on `events` and `event_links` only. Public
   traffic never holds `admin_app`'s credentials. The pool gives each query a 6 s timeout
   (`query_timeout`). The pooler accepts a `statement_timeout` startup parameter but
   ignores it, so none is set.
7. **`event_links` details** (refines decision 3):
   - `external_id` holds a platform's own id where the site needs it; for Luma, the
     `evt-…` id the RSVP embed is built from.
   - `admin_app` may DELETE listings (ADR 0008 amended the same day). The audit row in the
     same transaction records what was removed.
8. **Imports done** (decision 6):
   - The YAML file and the README table were imported by
     `backend/scripts/import-event-links.js`, then deleted. The script reads them back from
     git history (`829155c`) for the production run.
   - The Google Form CSV was imported by `backend/scripts/import-google-form.js`.
9. **Dependency.** `purge.mjs` imports `@netlify/cache`, at the version 4.2.1 that
   `@astrojs/netlify` already brings in. It is pinned in the root `package.json` once that
   version is two weeks old (on or after 2026-11-20).

## Amendment (2026-12-03, Event status: Scheduled / Reported / Cancelled, #51)

Follows GLOSSARY.md (spec #49). Supersedes the `held` value in decisions 1 and 2 and the
"held" wording in amendment 3 above (the Public event page rules are unchanged).

1. **`events.status` is `scheduled` / `reported` / `cancelled`**, labelled Scheduled,
   Reported and Cancelled in the admin app (Admin event page, events list, admin home).
   Saving an Event Report moves the event from Scheduled to Reported in the same
   transaction, and its audit row records `eventStatus: { before, after: "reported" }`.
   "Report missing" is still a past date that is still `scheduled`.
2. **"Held" is no longer a status.** It means the Event took place (GLOSSARY.md), which is
   what Streaks count; deciding Held is not the status column's job.
3. **Public event page**: a Reported event's page behaves exactly as a held one did (past
   date: "this one has passed"); the page only branches on `cancelled`.
4. **Data**: migration `20261203130000_event_status_reported.sql` backfills `held` rows to
   `reported` and, until the contract migration, rewrites any write of `held` to `reported`
   for the code live between migrate and deploy. The Google Form import writes
   `reported`. The sign-in photo import writes `scheduled`: a photo is no Event Report, so
   those dates show "Report missing" (their imported check-ins still make them Held). The
   Airtable backfill never touched events. Audit rows
   that already say `held` are history and stay.
