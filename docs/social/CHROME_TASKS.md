# Chrome tasks: the weekly social posts

These are the two scheduled tasks Modron's machine runs
([ADR 0011](../adr/0011-social-posting-via-chrome-work-order.md) decision 3):

- **Wednesday:** schedule the week's promo video on every channel
- **Monday at about 7:20 AM ET:** verify that each post is live and add the first comments

Both tasks read a work order from the admin app and write results back through its forms. The
app never calls the tasks and never posts anything itself. The weekly flow around them is in
[README.md](README.md#weekly-promo-video).

## How they run

Each task is Claude Code run unattended (`claude -p`), driving a dedicated Chrome window through
the [Chrome DevTools MCP server](https://github.com/ChromeDevTools/chrome-devtools-mcp). The
runner script [`scripts/social/run-task.sh`](../../scripts/social/run-task.sh) does all of it:

- starts the task Chrome if it isn't running: its own profile in `~/bocc-chrome/profile`, remote
  debugging on `127.0.0.1:9222` only, a normal visible window (never headless)
- clears `~/bocc-chrome/downloads`, fills `{SITE}` and `{DOWNLOADS}` into the prompt, and runs
  `claude -p` from an empty folder, without the user's Claude Code settings, in `dontAsk`
  mode with each allowed browser tool named (`ALLOWED_TOOLS` in the script). Anything not on
  that list is refused rather than waiting for approval, including script evaluation, the
  network and console readers, the shell and the file tools. (Allowing the whole server by
  name, `mcp__chrome-devtools`, left `click` unapproved in the first staging run.)
- writes the run's report to `~/bocc-chrome/logs/<task>-<date>.log`, and after the Wednesday
  run deletes the downloaded video and cover

The prompts are [`scripts/social/prompts/schedule.txt`](../../scripts/social/prompts/schedule.txt)
(Wednesday) and [`scripts/social/prompts/verify.txt`](../../scripts/social/prompts/verify.txt)
(Monday).

**Why not Claude in Chrome** (the original runner, changed 2026-11-20): its upload tool only
takes files attached to a chat, up to 10 MB. A scheduled task has no chat, and a promo video is
often bigger (the first rehearsal's was 20.5 MB), so it couldn't attach the video or the cover
anywhere. The DevTools server's `upload_file` takes a local path. The prompts, the work order and
its forms are otherwise unchanged.

## Setup (once, on Modron's machine)

1. Zack creates Modron's `social` account in the admin: `/admin/users/`, role **social** only.
   That role sees the work order and nothing else: no attendees, check-ins, reports or users.
2. Install Node.js 20 or later, Google Chrome and Claude Code. Clone this repo (or copy
   `scripts/social/`). For the scheduled runs, make a long-lived token with
   `claude setup-token` and set it as `CLAUDE_CODE_OAUTH_TOKEN` in the crontab (step 5): a
   `/login` sign-in expires within days, and an unattended run can't renew it. The sign-in
   page can open in any browser (Firefox works if Chrome shows a captcha); copy the URL the
   terminal prints.
3. Start the task Chrome: `scripts/social/run-task.sh chrome`. On first run this creates the
   profile with downloads going to `~/bocc-chrome/downloads` without asking (check
   `chrome://settings/downloads` once). In that window, Modron signs in by hand to the admin
   (`{SITE}/login/`, with a passkey or password) and to Meta Business Suite, Threads, TikTok
   Studio. Not LinkedIn: the tasks leave it to Zack (step 6). The admin session lasts 30 days
   and is extended on each visit, so the
   weekly tasks keep it alive. The task never handles a password. Keep this Chrome open; don't
   use it for anything else. If it was closed, the runner starts it again with the same
   sign-ins.
4. Try one run by hand, against staging:
   `BOCC_SITE=https://dev--bocc-backend.netlify.app scripts/social/run-task.sh verify`
   (harmless: "Nothing to verify" most days). The first run downloads the MCP server with `npx`
   (`chrome-devtools-mcp`, pinned in the script as `MCP_PACKAGE`; raise it deliberately).
5. Schedule the two runs, with `BOCC_SITE` set to:
   - for the rehearsal: `https://dev--bocc-backend.netlify.app` (staging, which has its own
     admin accounts)
   - for real use: `https://716coffee.club`

   On Linux, `crontab -e` (cron needs the desktop session's display to open Chrome):

   ```cron
   CLAUDE_CODE_OAUTH_TOKEN=<token from claude setup-token>
   CRON_TZ=America/New_York
   0 10 * * 3  DISPLAY=:0 BOCC_SITE=https://716coffee.club /path/to/bocc/scripts/social/run-task.sh schedule
   20 7 * * 1  DISPLAY=:0 BOCC_SITE=https://716coffee.club /path/to/bocc/scripts/social/run-task.sh verify
   ```

   On macOS, use two launchd user agents (`~/Library/LaunchAgents/`) with
   `StartCalendarInterval` (Weekday 3, Hour 10; Weekday 1, Hour 7, Minute 20, in the Mac's
   local time, which should be Eastern) and `EnvironmentVariables` for `BOCC_SITE` and `PATH`
   (so `claude`, `npx` and `curl` are found). launchd runs a job missed while the Mac slept
   once it wakes; cron doesn't.
6. **LinkedIn is not in the tasks** (2026-11-20). LinkedIn won't let Modron's account be an
   admin of the BOCC page ([README.md](README.md)), so both prompts leave the `linkedin_page`
   channel alone: they don't open LinkedIn or save its form. Zack schedules the LinkedIn page
   post by hand and saves the channel himself (`scheduled` on `/admin/social/next/`, `live` on
   `/admin/social/verify/`; the admin role can use both pages). Until he does, the post stays
   out of **Posted** and the Thursday check reports LinkedIn as not scheduled. If Modron gets
   page admin access later, put the LinkedIn step back in the prompts.
7. Rehearse both against staging before pointing them at production
   ([PHASE5_RELEASE.md](../admin/PHASE5_RELEASE.md), "Chrome task rehearsal"). Watch the first
   Wednesday run in the task Chrome window: the platforms may treat a browser driven over remote
   debugging with more suspicion than the extension. If one shows a verification prompt, the
   task marks that channel failed and carries on.

The pages are built for the agent to read. They are plain HTML with no script. Each channel has
its own `<section id="channel-<key>">` holding its exact caption and first comment, and one form
with one save button. When there is nothing to do, a section `id="nothing"` says so. The keys
are `facebook`, `instagram`, `threads`, `tiktok` and `linkedin_page`. A JSON copy of the same
data is at `/api/admin/social/next` and `/api/admin/social/verify`. The prompts use the pages,
because the forms are where results are saved.

## Wednesday: schedule

Schedule: weekly, Wednesday, 10:00 AM ET (any time Wednesday works; the Thursday check runs at
9 or 10 AM ET the next day). Prompt:
[`scripts/social/prompts/schedule.txt`](../../scripts/social/prompts/schedule.txt).

It opens `/admin/social/next/`, downloads the video and the cover image into
`~/bocc-chrome/downloads`, and attaches them with `upload_file` and their full paths. It
schedules each `pending` channel for the publish time (Business Suite for Facebook and Instagram,
Threads web, TikTok Studio; not the LinkedIn page, which Zack does) and saves `scheduled`, or
`failed` with a note, through each channel's form. A problem with the setup itself (a tool error, a file that won't
attach) leaves the channel `pending` instead of `failed`, because a failed channel is skipped on
the next run.

### Video cover image per channel

The work order's **Cover image** (ticket #22) is the event's Event Image (the square BOCC logo
by default), unless an Admin chose a Photo from Event for this post on the Social Posts tab. The
link is `id="cover-download"` on `/admin/social/next/` and `cover` in `/api/admin/social/next`.
It is the image's display copy (a JPEG up to 1600px on its long edge, in the image's own
shape; the logo default is a 2000×2000 PNG): the platforms crop covers themselves.

The Wednesday prompt asks for a custom cover only where the platform's own current docs say a
cover image can be uploaded. Checked against official docs on 2026-11-19. The live check per
channel, in the task Chrome, happens at the release (ticket #29); update this table and the
prompt from it.

| Channel | Custom cover upload | Prompt | Source |
|---|---|---|---|
| Facebook (Business Suite reel) | **Unconfirmed.** Meta documents a custom thumbnail (up to 10 MB) for ordinary Page videos, not for Reels or the Business Suite scheduler | frame only (Thumbnail timecode) | facebook.com/business/help/163131210928551, /2683452421955589 |
| Instagram (reel) | **Confirmed on instagram.com** ("Select from computer"; about 420×654, 1:1.55; can't be changed after posting). Not documented for the Business Suite scheduler | upload it if the composer offers it, else frame + note | help.instagram.com/225190788256708, about.instagram.com/features/reels |
| Threads (web) | **Unconfirmed.** No help-center article found | frame only (Thumbnail timecode) | none |
| TikTok (TikTok Studio web) | **Unconfirmed for the web.** Creator Academy describes "upload local cover" (9:16, 1080×1920) without saying which app | frame only (Thumbnail timecode) | tiktok.com/creator-academy/article/video-covers-thumbnails |
| LinkedIn page | **Confirmed** ("Video thumbnail" -> "Upload video thumbnail"). Third parties say JPG/PNG, the video's aspect ratio, up to 2 MB: not in the official doc | not in the task (Zack posts by hand) | linkedin.com/help/linkedin/answer/a527229 |

At #29, also check: whether a square cover looks right on the 9:16 reels (Instagram crops to
its grid).

## Monday: verify (about 7:20 AM ET)

Schedule: weekly, Monday, 7:20 AM ET (20 minutes after the posts go out at 7:00). Prompt:
[`scripts/social/prompts/verify.txt`](../../scripts/social/prompts/verify.txt).

It opens `/admin/social/verify/`, opens each post (or finds it on the BOCC profile), marks it
`live` or `failed`, posts the first comment on Instagram and TikTok word for word, and records
that it did. It never uploads anything. It ends with "All done", or a per-channel list of what
is left.

## Post status

The Social post's **Status** (ticket #39) decides whether the tasks see the post at all. The
prompts don't change: the tasks only save channel statuses, and the post status follows.

| Status | Meaning | Set by |
|---|---|---|
| **To do** | being prepared; `/admin/social/next/` shows "Nothing ready" (reason `not_ready`) | an Admin (the default) |
| **Ready for Posting** | the work order is offered to the Wednesday task | an Admin, only when nothing blocks it |
| **Posted** | every channel is `scheduled` or `live`; never handed out again | automatically, when a task's channel save leaves every channel `scheduled`/`live`; an Admin can also set it |
| **Error** | a channel failed | automatically, when a task saves a channel as `failed`; an Admin can also set it. Still offered, so the Wednesday task carries on with the other channels and a failed channel can be scheduled again (then the post becomes Posted) |

Each automatic change is audited as `social_post.status`; its actor is whoever records the channel update (the `social` user, or an Admin saving a channel result).

## When a task reports a problem

- **Signed out:** Modron signs in by hand once in the task Chrome window, then re-runs the task
  (`scripts/social/run-task.sh schedule` or `verify`, with `BOCC_SITE` set).
- **No report at all:** read `~/bocc-chrome/logs/`. `chrome.log` shows whether Chrome started;
  the task's own log shows whether `claude` ran (signed out of Claude Code, `npx` not found on
  the job's `PATH`, or Chrome's port 9222 taken by another Chrome).
- **Nothing ready:** fix what it lists on `/admin/events/<date>/` and set the post's Status to
  Ready for Posting.
  Then run the Wednesday task again by hand (any day before Monday morning). The page is
  always about the earliest upcoming week that still has work: a later week's post that is
  ready waits until that week is done (or its Monday publish time passes, or it is cancelled).
- **A channel failed:** the notes say why, and the post is **Error**. Schedule that channel by
  hand, then set its status on `/admin/social/next/` (the post becomes Posted once no channel is
  pending or failed).
- **The Thursday ntfy push** fires if a channel isn't `scheduled` or `live` by Thursday morning.
  It is the backstop for a Wednesday run that never happened, for example because the machine
  was asleep or off.
