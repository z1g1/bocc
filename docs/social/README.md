

## Weekly promo video

Since Phase 5 ([ADR 0011](../adr/0011-social-posting-via-chrome-work-order.md)), the week's
vertical promo video is one **Social plan** in the admin app: one social media post per Channel,
handed to the Chrome tasks as a work order. It is posted at 7:00 AM ET on the
Monday before the event to Facebook, Instagram, Threads, TikTok and the LinkedIn page. The app
never posts anything itself. The old API plan
([WEEKLY_SOCIAL_POSTING_PLAN.md](../backend/WEEKLY_SOCIAL_POSTING_PLAN.md)) is superseded.

| When | Who | What |
|---|---|---|
| By Tuesday night | Zack (admin) | On `/admin/events/<date>/?tab=social` (the Social plan tab): upload the video (MP4/MOV up to 100 MB; an iPhone upload works), write the base caption, and add extra TikTok hashtags or a **Thumbnail timecode** (the frame of the video to use as the Thumbnail where a Thumbnail can't be uploaded, e.g. "0:03") if wanted. The **Thumbnail** is the event's Event Image (the BOCC logo by default); choose a Photo from Event instead if it suits the video better, or go back to the Event Image. Check that the Luma listing is there (Online Event Listings, on the Event Info tab). Then set **Plan status** to **Ready for Posting**. The app refuses until the video, caption and Luma link are all there, every caption is within its platform's limit, and the publish time (default Monday 7:00 AM ET) is in the future. Each social media post's final text is shown, and can be overridden per post |
| Wednesday | Modron's Claude in Chrome task | Opens `/admin/social/next/` as the `social` user. Downloads the video and the Thumbnail, schedules every `pending` social media post (uploading the Thumbnail where the platform takes one: [CHROME_TASKS.md](CHROME_TASKS.md#video-thumbnail-per-channel)) for the publish time (Business Suite for Facebook and Instagram, Threads web, TikTok Studio, the LinkedIn page), and saves each post's Post status (`scheduled`) and post URL back through its form. If nothing is ready, it stops and reports why |
| Thursday 9 AM ET (10 AM in summer) | the app | A Netlify scheduled function checks the coming Tuesday. If there is no Social plan, the plan isn't ready, or a social media post isn't `scheduled`/`live`, Zack gets an **ntfy push** whose link opens `/admin/social/next/`. Otherwise nothing is sent. Separately, when a LinkedIn authentication has under 10 days left or has expired, it pushes a second alert naming the LinkedIn authentication by its LinkedIn display name, with a link to `/admin/account/` to re-authenticate |
| Monday about 7:20 AM ET | Modron's Claude in Chrome task | Opens `/admin/social/verify/`, opens each social media post, marks it `live` or `failed`, posts the Luma link as the first comment on Instagram and TikTok, and records that it did |

***Plan status** (the Plan status dropdown on the Social plan tab; [ADR 0011](../adr/0011-social-posting-via-chrome-work-order.md) decision 1, amended for #39 and #56). Each social media post keeps its own **Post status** (Pending, Scheduled, Live, Failed); the Plan status sums up the whole Social plan:

| Plan status | Meaning | Set by |
|---|---|---|
| **To do** | being prepared; the Chrome tasks ignore it | Zack (the default) |
| **Ready for Posting** | the work order is offered to the Chrome tasks | Zack, once nothing blocks it (the reasons show next to the dropdown) |
| **Posted** | every social media post is scheduled or live | automatically, when the Chrome task's post updates leave every post scheduled or live; Zack can also set it |
| **Error** | at least one social media post failed | automatically, when a post is recorded as failed; Zack can also set it. The Wednesday task still schedules the other posts, and a failed post scheduled again moves the plan to Posted |

**Holiday break:** there is no meeting on any Tuesday from December 22 through January 4, so
those weeks have no Social plan. The Wednesday task gets the first week after the break and the
Thursday check stays quiet. To meet on one of those Tuesdays anyway, open
`/admin/events/<date>/` and save it: a saved row makes it a normal week
([ADR 0011](../adr/0011-social-posting-via-chrome-work-order.md) decision 7).

The prompts for the two Chrome tasks, and what to do when one reports a problem, are in
[CHROME_TASKS.md](CHROME_TASKS.md). Caption rules, in code (`src/lib/admin/social-plan-rules.mjs`):
- Facebook, Threads and LinkedIn get the caption plus "RSVP: <Luma link>".
- Instagram and TikTok get the caption plus "Link in bio", with the Luma link as the first
  comment.
- TikTok also gets the default hashtags plus any extras.
- Luma is the only link ever used.

Zack's personal LinkedIn post is not part of the work order. He still schedules it by hand.

## Weekly LinkedIn event

The week's LinkedIn event (hosted by the LinkedIn page, published by a LinkedIn post from
Zack's LinkedIn profile) is made from the admin app, not the Social plan
([ADR 0012](../adr/0012-linkedin-events-from-admin-app.md)). On Tuesday afternoon, for the next
week's BOCC, Zack opens `/admin/events/<date>/` (Event Info tab), checks the location and the
Event Image, uses **Create live event** in the LinkedIn event section, then makes a LinkedIn
repost of his LinkedIn post from the LinkedIn page by hand. The app can't post as the LinkedIn
page ([LINKEDIN_PERMISSIONS.md](../backend/LINKEDIN_PERMISSIONS.md)).

The step-by-step, including recovery, is the `bocc-linkedin-event` Claude skill:
[skills/bocc-linkedin-event/SKILL.md](skills/bocc-linkedin-event/SKILL.md). To update the
skill on claude.ai, zip the `bocc-linkedin-event` folder and upload it in claude.ai's skill
settings, replacing the old one. The `bocc-event` Python CLI it used to point at
was retired in #30 (it is in git history).

## Handles and Websites

1. Luma (Primary Event) - 
	1. Goal 1 unique event per week. https://luma.com/716coffeeclub
1. EventBrite (secondary Event)
	1. Goal 1 unique event per week. 
1. BOCC LinkedIn Page (Primary Social Network)
	1. https://www.linkedin.com/showcase/buffalo-open-coffee
	1. Goal 1 Unique event. Created by Zack from the admin app (see "Weekly LinkedIn event" above), since creating it also publishes a LinkedIn post from his LinkedIn profile. Modron cannot do it via Chrome/browser since LinkedIn will not allow their account to be an admin on the BOCC Page
1. Zack's Personal LinkedIn Page
	1. Goal 1 vertical video post each week Monday at 7 AM to drive to the event. Zack has to schedule manually 1/week since Claude will not have access to his personal LinkedIn
1. Instagram (Secondary Social Network) 
	1. https://www.instagram.com/716coffeeclub
	1. Goal 1 vertical video to reels each week Monday at 7 AM to drive to the event. Scheduled by the Wednesday Chrome task in Meta Business Suite, from the work order. Needs a caption for the video. Try to keep to 5-8 words to show up on the first line of the video. Sub 20 second video. 
1. Facebook Page (Secondary Social Network)
	1.  https://www.facebook.com/716coffeeclub
	1. Goal 1 vertical video post to the page each week Monday at 7 AM to drive to the event. Scheduled by the Wednesday Chrome task in Meta Business Suite, the same video as the Instagram reel, with the Facebook caption from the work order
	1. Goal 1 Facebook Event created once per week on Wednesdays since it notifies all followers of the page. 
1. TikTok (Secondary Social Network)
	1. https://www.tiktok.com/@716coffee.club
	1. Goal 1 vertical video post to the page each week Monday at 7 AM to drive to the event. Scheduled by the Wednesday Chrome task in TikTok Studio, from the work order.  Need caption for the video, as well as hashtags. Try to keep to 5-8 words to show up on the first line of the video. Sub 20 second video
1. Threads (tertiary Social Network)
	1.  https://www.facebook.com/716coffeeclub
	1. Goal 1 vertical video post to the profile each week Monday at 7 AM to drive to the event. Scheduled by the Wednesday Chrome task in the Threads web app, a separate step, because Business Suite doesn't post to Threads and Instagram's "Share to Threads" only works for posts published immediately (ADR 0011)
	1. Lower priority than the other channels

## Event URLS
The Luma, Eventbrite, Facebook and LinkedIn listings for each date live in the admin, on each event page under [/admin/events/](https://716coffee.club/admin/events/) (the source of truth since Phase 4, ADR 0009).

## SEO / Discovery
1. Google Webmaster console setup via Zack's Google Account. Modon added as an admin for access via Chrome
1. Bing Webmaster console setup via Zack's Google Account. Modon added as an admin for access via Chrome
1. Anthropic/OpenAI don't have consoles yet 
1. llms.txt created and uploaded to website
1. 1 unique event page per week with a luma event created and embeded 
