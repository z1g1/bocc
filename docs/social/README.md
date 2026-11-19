

## Weekly promo video

Since Phase 5 ([ADR 0011](../adr/0011-social-posting-via-chrome-work-order.md)), the week's
vertical promo video is one work order in the admin app. It is posted at 7:00 AM ET on the
Monday before the event to Facebook, Instagram, Threads, TikTok and the LinkedIn page. The app
never posts anything itself. The old API plan
([WEEKLY_SOCIAL_POSTING_PLAN.md](../backend/WEEKLY_SOCIAL_POSTING_PLAN.md)) is superseded.

| When | Who | What |
|---|---|---|
| By Tuesday night | Zack (admin) | On `/admin/events/<date>/?tab=social` (the Social Posts tab), "Social post" section: upload the video (MP4/MOV up to 100 MB; an iPhone upload works), write the base caption, and add extra TikTok hashtags or a cover note if wanted. The **Cover image** is the event's Event Image (the BOCC logo by default); choose a Photo from Event instead if it suits the video better, or go back to the Event Image. Check that the Luma listing is there (Online Event Listings, on the Event Info tab). Then set **Status** to **Ready for Posting**. The app refuses until the video, caption and Luma link are all there, every caption is within its platform's limit, and the publish time (default Monday 7:00 AM ET) is in the future. Each channel's final text is shown, and can be overridden per channel |
| Wednesday | Modron's Claude in Chrome task | Opens `/admin/social/next/` as the `social` user. Downloads the video and the cover image, schedules every `pending` channel (setting the cover where the platform takes a custom one: [CHROME_TASKS.md](CHROME_TASKS.md#video-cover-image-per-channel)) for the publish time (Business Suite for Facebook and Instagram, Threads web, TikTok Studio, the LinkedIn page), and saves each channel's status (`scheduled`) and post URL back through its form. If nothing is ready, it stops and reports why |
| Thursday 9 AM ET (10 AM in summer) | the app | A Netlify scheduled function checks the coming Tuesday. If there is no post, the post isn't ready, or a channel isn't `scheduled`/`live`, Zack gets an **ntfy push** whose link opens `/admin/social/next/`. Otherwise nothing is sent. Separately, when a LinkedIn connection has under 10 days left or has expired, it pushes a second alert naming the connection by its LinkedIn display name, with a link to `/admin/account/` to reconnect |
| Monday about 7:20 AM ET | Modron's Claude in Chrome task | Opens `/admin/social/verify/`, opens each post, marks it `live` or `failed`, posts the Luma link as the first comment on Instagram and TikTok, and records that it did |

**Post status** (the Status dropdown in the Social post section; [ADR 0011](../adr/0011-social-posting-via-chrome-work-order.md) decision 1, amended for #39). Each channel keeps its own status (pending, scheduled, live, failed); the post status sums up the whole post:

| Status | Meaning | Set by |
|---|---|---|
| **To do** | being prepared; the Chrome tasks ignore it | Zack (the default) |
| **Ready for Posting** | the work order is offered to the Chrome tasks | Zack, once nothing blocks it (the reasons show next to the dropdown) |
| **Posted** | every channel is scheduled or live | automatically, when the Chrome task's channel updates leave every channel scheduled or live; Zack can also set it |
| **Error** | at least one channel failed | automatically, when a channel is recorded as failed; Zack can also set it. The Wednesday task still schedules the other channels, and a failed channel scheduled again moves the post to Posted |

**Holiday break:** there is no meeting on any Tuesday from December 22 through January 4, so
those weeks have no work order. The Wednesday task gets the first week after the break and the
Thursday check stays quiet. To meet on one of those Tuesdays anyway, open
`/admin/events/<date>/` and save it: a saved row makes it a normal week
([ADR 0011](../adr/0011-social-posting-via-chrome-work-order.md) decision 7).

The prompts for the two Chrome tasks, and what to do when one reports a problem, are in
[CHROME_TASKS.md](CHROME_TASKS.md). Caption rules, in code (`src/lib/admin/social-rules.mjs`):
- Facebook, Threads and LinkedIn get the caption plus "RSVP: <Luma link>".
- Instagram and TikTok get the caption plus "Link in bio", with the Luma link as the first
  comment.
- TikTok also gets the default hashtags plus any extras.
- Luma is the only link ever used.

Zack's personal LinkedIn post is not part of the work order. He still schedules it by hand.

## Handles and Websites

1. Luma (Primary Event) - 
	1. Goal 1 unique event per week. https://luma.com/716coffeeclub
1. EventBrite (secondary Event)
	1. Goal 1 unique event per week. 
1. BOCC LinkedIn Page (Primary Social Network)
	1. https://www.linkedin.com/showcase/buffalo-open-coffee
	1. Goal 1 Unique event. Has to be created by Zack at the CLI using the tool in this repo. Create once per week on Wednesday since you have to create a post on LinkedIn at event post. Modron Cannot post via Chrome/browser since LinkedIn will not allow their account to be an admin on the BOCC Page
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
