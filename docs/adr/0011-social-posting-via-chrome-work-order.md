# ADR 0011 — Weekly social posts are done by Claude in Chrome tasks that read a work order from the app

- **Status:** Accepted (2026-11-16). This supersedes the API-based approach in
  [`WEEKLY_SOCIAL_POSTING_PLAN.md`](../backend/WEEKLY_SOCIAL_POSTING_PLAN.md) for the weekly
  promo video.
- **Date:** 2026-11-16
- **Deciders:** Zack Glick

## Context

Each week, one vertical promo video is scheduled for 7:00 AM ET on the Monday before the event,
to Facebook + Instagram (one reel in Meta Business Suite, shared to Threads), TikTok (TikTok
Studio) and the LinkedIn page. Modron does this by hand through Claude in Chrome, uploading once
per platform.

Platform APIs, checked 2026-11-16:
- **Facebook Page:** the only one that can schedule a post through its API
- **Instagram:** can't schedule through the API, and an unpublished post expires after 24 h
- **Threads:** can't schedule through the API, and only fetches video from a public URL
- **TikTok:** can't schedule through the API, and posts stay private until the app passes an
  audit
- **LinkedIn:** can't schedule through the API, and posting as the Page needs the vetted
  Community Management API
- **Meta Business Suite:** no API was found

All of these platforms let you schedule from their own web UI.

Anthropic options, checked the same day:
- Claude in Chrome supports recurring scheduled tasks, but has no API trigger
- `claude --chrome` and `-p` are not documented for unattended use
- Desktop computer use can only view browsers, not click in them

Browserbase works, but needs new logins from datacenter IPs, a $20/month plan, and stealth
features. Those features are built to get past bot detection, and using them puts the BOCC
accounts at risk under the platforms' terms.

## Decision

1. **The app holds a work order. The app itself never posts.**
   - `social_posts` (one per event): `video_media_id`, `cover_note`, `base_caption`,
     `publish_at` (defaults to Monday 7:00 AM America/New_York, shown in both ET and UTC), and
     `ready`
   - `social_post_channels`: one row each for `facebook`, `instagram`, `threads`, `tiktok`,
     `linkedin_page`, with `caption`, `first_comment`, `status`
     (`pending → scheduled → live | failed`), `post_url`, `verified_at`, `comment_posted_at`
     and `notes`
2. **Caption rules are code defaults**, not settings.
   - FB and LinkedIn: the caption plus the Luma link.
   - IG and TikTok: the caption plus "Link in bio", with the Luma link as the first comment.
   - TikTok gets a default hashtag list plus an optional per-post `extra_hashtags` field.
   - Threads follows FB if its links turn out to be clickable, otherwise IG.
   - **Luma is the only link used.**
3. **Two Claude in Chrome scheduled tasks on Modron's machine pull the work order.** The app
   never calls them.
   - **Wednesday:** open `/admin/social/next`, schedule each `pending` channel in Business Suite,
     TikTok Studio and LinkedIn, and save each post URL and status back to the page.
   - **Monday at about 7:20 AM ET:** open `/admin/social/verify`, confirm each post is live by
     opening its URL, add the first comments, and write back `live` / `failed`.
4. **The pages are built for an agent to read:** plain server-rendered HTML, stable labels, one
   section per channel, explicit form buttons, and a "nothing ready" state. No MCP server for
   now. A JSON API underneath leaves room to add one later.
5. **The app's only scheduler checks that the run happened.** A Netlify scheduled function emails
   you if a channel for the next Tuesday isn't `scheduled` by Thursday. Email here means
   notifying you only, and how to send it is decided in Phase 3.
6. **Modron logs in with a `social` account** (ADR 0008) using a 30-day sliding session. If the
   session expires, the task stops and reports it. It never enters a password.

## Consequences

- One upload and one caption per week replace five uploads, and no platform tokens live in
  Netlify.
- It depends on Modron's machine being awake with Chrome open. Unofficial reports say scheduled
  runs may wait for someone to click, so test that early. The Thursday check catches missed runs.
  Anthropic's help says tasks run "as long as Chrome is open"; the unattended test on Modron's
  machine is still pending (Phase 0).
- *Phase 0 (2026-11-16):* Meta Business Suite reportedly doesn't post to Threads, and Instagram's
  "Share to Threads" only works for posts published immediately. Threads links appear clickable.
  *Proposed change, waiting for Zack:* see "Proposed ADR changes" item 1 in the plan.
- Browser automation still carries some terms-of-service risk on these platforms. Official APIs
  remain the long-term option, one channel at a time (Facebook scheduling, TikTok after audit).
- Everything the agent can read is exposed to instructions planted in the web pages it visits.
  That is why the `social` role can't see personal data.
