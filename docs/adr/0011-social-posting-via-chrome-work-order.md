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
     `ready` (replaced by `status`, see the amendment below)
   - `social_post_channels`: one row each for `facebook`, `instagram`, `threads`, `tiktok`,
     `linkedin_page`, with `caption`, `first_comment`, `status`
     (`pending → scheduled → live | failed`), `post_url`, `verified_at`, `comment_posted_at`
     and `notes`
   - *Amended 2026-12-01 (#39, QA feedback on Phase 6):* **the post has a status instead of
     the `ready` flag.** `social_posts.status` is the summary of the whole post, set with a
     dropdown on the Social Posts tab (migration `20261201120000_social_post_status.sql`;
     existing rows: ready → `ready`, not ready → `todo`). The channel statuses don't change.

     | Status | Meaning | Set by |
     |---|---|---|
     | `todo` **To do** | being prepared; the Chrome tasks ignore it | an Admin (the default) |
     | `ready` **Ready for Posting** | the work order is offered to the Chrome tasks | an Admin, only when nothing blocks it (the old `ready` checks: video, caption, Luma, caption limits, not cancelled, publish time ahead); the database keeps the video-and-caption rule |
     | `posted` **Posted** | every channel is `scheduled` or `live` | automatically, when a channel update by the social role leaves every channel `scheduled`/`live`; an Admin can also set it |
     | `error` **Error** | at least one channel failed | automatically, when a channel update records `failed`; an Admin can also set it |

     The automatic changes happen in the channel update's transaction, each with its own
     audit row (`social_post.status`, `details.automatic`); an Admin's changes are in the
     post save's audit row (`social_post.update`). The Wednesday and Monday tasks treat
     `ready` as they treated the flag. A post in `error` stays offered too, so the Wednesday
     task can carry on with the other channels after one fails and a failed channel can be
     scheduled again (which, once nothing is pending or failed, makes it `posted`). A `posted`
     post is never handed out again: an Admin who sets Posted by hand ends the Chrome tasks'
     work on that post even while channels are still pending (`findNext` skips it). That is
     intended: it is how an Admin says "done, stop" (the channels were posted by hand, or the
     rest are dropped). The Thursday check counts `ready`, `posted` and `error` as ready, as
     the old flag did (it stayed on after a failure): an `error` post alerts as "N of 5
     channels not scheduled", naming the failed channel, unless it also has problems. The rules are in
     `src/lib/admin/social-rules.mjs` (`POST_STATUSES`, `POST_STATUS_LABELS`,
     `OFFERED_STATUSES`, `postStatusAfterChannelUpdate`).
   - *Amended 2026-12-03 (#56, the glossary rename, spec #49):* **the words follow
     `GLOSSARY.md`.** Nothing about the decision or the behaviour changes; the text above keeps
     the names it was written with. Since #56:
     - One Event's work order is its **Social plan**, the table `social_plans` (was
       `social_posts`; migration `20261203120000_glossary_rename_expand.sql`). Each Channel's row
       is a **social media post**, the table `social_media_posts` (was `social_post_channels`).
     - The plan's status is the **Plan status** (To do, Ready for Posting, Posted, Error). A
       social media post's status is its **Post status** (Pending, Scheduled, Live, Failed;
       values `pending`, `scheduled`, `live`, `failed` as before).
     - The admin event page's tab is **Social plan** (still `?tab=social`), with the **Plan
       status** dropdown and one row per social media post showing its Post status. The social
       role's URLs (`/admin/social/next`, `/admin/social/verify`, `/api/admin/social/*`), their
       element ids and their JSON keys (`status`, `statusLabel`, `reason: "no_post"`) are
       unchanged, so the scheduled Chrome tasks keep working.
     - Code: `src/lib/admin/social-plan.mjs` (was `social.mjs`; `getSocialPlan`, `savePlan`,
       `saveSocialMediaPost`, `setPostResult`) and `src/lib/admin/social-plan-rules.mjs` (was
       `social-rules.mjs`; `PLAN_STATUSES`, `PLAN_STATUS_LABELS`, `OFFERED_PLAN_STATUSES`,
       `planStatusAfterPostUpdate` for the Plan status; `POST_STATUSES`, `POST_STATUS_LABELS`,
       `DONE_POST_STATUSES` for the Post status). The component is `SocialPlan.astro`.
     - Audit actions are `social_plan.update|video|cover|status` and
       `social_media_post.update|result`, with target tables `social_plans` and
       `social_media_posts`. Rows written before #56 keep `social_post.*`,
       `social_post_channel.*`, `social_posts` and `social_post_channels`.
     - The Thursday check reads `social_plans` and `social_media_posts` as `social_checker`,
       and its alerts say "no Social plan", "Social plan not ready" and "N of 5 social media
       posts not scheduled".
2. **Caption rules are code defaults**, not settings.
   - FB and LinkedIn: the caption plus the Luma link.
   - IG and TikTok: the caption plus "Link in bio", with the Luma link as the first comment.
   - TikTok gets a default hashtag list plus an optional per-post `extra_hashtags` field.
   - Threads follows FB, since its links appear clickable (Phase 0). Confirm in the first
     rehearsal.
   - **Luma is the only link used.**
3. **Two Claude in Chrome scheduled tasks on Modron's machine pull the work order.** The app
   never calls them.
   - **Wednesday:** open `/admin/social/next`, schedule each `pending` channel in Business Suite
     (Facebook and Instagram), the **Threads web app**, TikTok Studio and LinkedIn, and save
     each post URL and status back to the page. Threads is its own step because Business Suite
     doesn't post to it and Instagram's "Share to Threads" only works for posts published
     immediately (amended 2026-11-16). The first rehearsal confirms Threads web can schedule.
   - **Monday at about 7:20 AM ET:** open `/admin/social/verify`, confirm each post is live by
     opening its URL, add the first comments, and write back `live` / `failed`.
4. **The pages are built for an agent to read:** plain server-rendered HTML, stable labels, one
   section per channel, explicit form buttons, and a "nothing ready" state. No MCP server for
   now. A JSON API underneath leaves room to add one later.
5. **The app's only scheduler checks that the run happened.** A Netlify scheduled function emails
   you if a channel for the next Tuesday isn't `scheduled` by Thursday. Email here means
   notifying you only, and how to send it is decided in Phase 3.
   - *Amended 2026-11-18 (Zack): the alert is an **ntfy.sh push**, not email.* ntfy is free and
     needs no account. The function POSTs to a private topic. The topic name is the only secret:
     the Netlify env var `SOCIAL_ALERT_NTFY_TOPIC`. `SOCIAL_ALERT_NTFY_SERVER` is optional and
     defaults to `https://ntfy.sh`. Zack subscribes to the topic in the ntfy iPhone app.
   - The function is `backend/netlify/functions/social-check.mjs` (logic in
     `src/lib/social-alert/`). It runs Thursdays at 14:00 UTC, which is 9:00 AM EST or
     10:00 AM EDT.
   - It checks the next Tuesday and alerts when any of these is true: there is no post; the post
     isn't ready (since #39: its status is To do; Ready for Posting, Posted and Error count as ready), or has problems; or a channel isn't `scheduled` or `live`. A cancelled event
     never alerts. When everything is fine it only logs. If it can't read the database, it sends
     a "check failed" push instead.
   - The Click link opens `/admin/social/next` on that context's site.
   - It reads as a new read-only role, `social_checker` (`SOCIAL_CHECK_DB_URL`, migration
     `20261123120000_social_checker.sql`), not `admin_app`.
   - Netlify runs it on its schedule only on the published production deploy. On staging,
     trigger it with the Functions page's **Run now** button.
6. **Modron logs in with a `social` account** (ADR 0008) using a 30-day sliding session. If the
   session expires, the task stops and reports it. It never enters a password.
7. *Added 2026-11-19 (Zack):* **The holiday break.** BOCC never meets on a Tuesday from
   December 22 through January 4 inclusive (the Christmas and New Year weeks), every year.
   Those Tuesdays aren't events: nobody cancels them and they have no `events` rows. The range
   is one constant, `HOLIDAY_BREAK` in `src/lib/holiday-weeks.mjs` (`isHolidayWeek(date)`).
   - The Wednesday pick (`findNext`) skips them like cancelled weeks, so the first normal week
     after the break is next. A normal week is still never skipped.
   - The Thursday check sends nothing for them and logs "skipped as a holiday week".
   - "Open next Tuesday" in the admin skips them. The public `/events/<date>/` page for one says
     "No meeting this week (holiday break)" (still a 404, `noindex`).
   - **Override:** a row someone deliberately saves for a holiday date (opening
     `/admin/events/<date>/` directly and saving anything) is respected. A `scheduled` row on a
     holiday date is a real event everywhere, and a cancelled one stays cancelled. Use this for
     an unusual year.

## Consequences

- One upload and one caption per week replace five uploads, and no platform tokens live in
  Netlify.
- It depends on Modron's machine being awake with Chrome open. Unofficial reports say scheduled
  runs may wait for someone to click, so test that early. The Thursday check catches missed runs.
  Anthropic's help says tasks run "as long as Chrome is open"; the unattended test on Modron's
  machine is still pending (Phase 0).
- *Phase 0 (2026-11-16):* Meta Business Suite reportedly doesn't post to Threads, and Instagram's
  "Share to Threads" only works for posts published immediately. Threads links appear clickable.
  Threads became its own Wednesday step (accepted the same day).
- Browser automation still carries some terms-of-service risk on these platforms. Official APIs
  remain the long-term option, one channel at a time (Facebook scheduling, TikTok after audit).
- Everything the agent can read is exposed to instructions planted in the web pages it visits.
  That is why the `social` role can't see personal data.
