---
name: bocc-linkedin-event
description: Create the weekly Buffalo Open Coffee Club LinkedIn event from the BOCC admin app (716coffee.club/admin), then repost Zack Glick's publishing post from the BOCC LinkedIn page. Use when asked to make, create or publish the BOCC LinkedIn event, or to recover one that got stuck.
---

# BOCC LinkedIn event (admin app)

The weekly LinkedIn event is created by the BOCC admin app, not by hand in LinkedIn's UI and
not by the old `bocc-event` command-line tool (retired). The app builds the event (name,
description, time, address, venue note, Luma link, 16:9 Event Image), creates it with the BOCC
LinkedIn page as organizer, and publishes it with a public LinkedIn post from Zack's own
LinkedIn profile. LinkedIn won't let the app post as the BOCC page, so the last step is a
manual repost from the page.

Only Zack can do this: it needs his admin sign-in, his LinkedIn authentication, and his role as
an admin of the BOCC LinkedIn page. Do it on Tuesday afternoon for the **next** week's BOCC.

## Ground rules

- Use the built-in browser. Zack signs in to the admin app (passkey) and to LinkedIn himself:
  if a sign-in page appears, ask him to sign in. Never type or ask for credentials.
- **Create live event** and **Publish the LinkedIn post** make real, public things that can't be
  undone (an unpublished LinkedIn event can't even be deleted). Before clicking the final
  confirm button in either dialog, show Zack what the dialog says and get an explicit "yes".
- Never click **I checked: nothing was created, allow retry** without checking LinkedIn first
  (step 7).
- If anything on the page doesn't match these steps, stop and describe what you see.

## Steps

1. **Date ($DATE).** Ask which Tuesday; suggest next week's Tuesday (YYYY-MM-DD). There is no
   meeting from December 22 through January 4.

2. **Open the event page:** `https://716coffee.club/admin/events/$DATE/?tab=info` (the
   **Event Info** tab). Read the Event readiness summary at the top.
   - If the **LinkedIn event** section already says *Listed: the LinkedIn event* or the ledger
     says **Posted on LinkedIn**, this week is done: stop and give Zack the link. (The create
     tools are then folded under *LinkedIn authentication and create*.)
   - If the ledger says **Pending** or **Created**, skip to step 7.

3. **Check the location** in **Status and location**. Status must not be **Cancelled** (a
   cancelled event is refused). Location decides the wording:
   - **Lobby** or *Not set (Lobby assumed)*: the normal text, "Please join me at Buffalo Open
     Coffee Club".
   - **Food hall**: the food hall text ("…This week the event will be in the Seneca One Food hall
     vs our normal lobby location").
   - **Other** is refused (there is no LinkedIn wording for it). Ask Zack to pick Lobby or Food
     hall.
   Ask Zack to confirm the location is right for $DATE. If he changes it, click **Save status
   and location**.

4. **Check the Event Image** (the Event Image section). The LinkedIn cover is its **16:9 Event
   Image**: the uploaded image, a picked Photo from Event, or the BOCC logo by default. Ask
   whether Zack wants a different one for this week; if so he uploads it (**Upload Event
   Image** / **Replace Event Image**, a square PNG or JPEG, up to 8 MB) or picks a recent photo
   (**Use this photo**). If the section offers **Make the 16:9 Event Image** or **Remake the 16:9
   Event Image**, click it first: an outdated 16:9 image is not sent to LinkedIn.

5. **LinkedIn authentication** (top of the LinkedIn event section).
   - *Not authenticated with LinkedIn*, or a red *…expired…* line: click **Authenticate with
     LinkedIn** (or **Re-authenticate**). LinkedIn's consent page opens; Zack signs in if asked
     and clicks **Allow**, leaving every permission ticked. The browser returns to this tab with
     *Authenticated with LinkedIn.* If it says LinkedIn didn't grant every permission, do it
     again and allow all of them.
   - Amber (under 7 days left): fine for today, but tell Zack to re-authenticate soon.
   - The line must say **Live: Create live event sends to LinkedIn.** If it says *Dry run on
     this deploy*, you're on staging or a preview, not 716coffee.club: stop.

6. **Review and create.**
   - Read the **Preview** back to Zack: Name ("Buffalo Open Coffee Club for <Month> <Nth>"),
     When (Tuesday 7:30 to 9:00 AM Eastern), Address (1 Seneca St, Buffalo, New York 14203),
     Venue details, External link (https://luma.com/716coffeeclub), Visibility LISTED, the 16:9
     Event Image, the Post commentary, and *Posted as* (Zack's name).
   - If a red *Can't create the LinkedIn event:* box lists reasons, fix each one (they say
     what to do: authenticate, change the location, set the status back to Scheduled, fix the
     Event Image) and reload the tab. *LinkedIn already lists a BOCC event with the same name
     or on the same day* means one exists: stop and tell Zack.
   - Click **Create live event**. A dialog names the date, title, visibility and author and
     quotes the post. Show it to Zack; after his "yes", click **Yes, create it on LinkedIn**.
   - Success: the ledger line reads **Ledger: Posted on LinkedIn.** with links to the LinkedIn
     event and the post, and the page may also say *LinkedIn event created and its LinkedIn post
     published.* The
     LinkedIn listing under Online Event Listings is filled in automatically. Go to step 8.

7. **Recover if it didn't finish.** The page shows LinkedIn's error and the ledger state:
   - **Created** (*Created on LinkedIn, but its LinkedIn post isn't published yet*): the event
     exists but is hidden until it's posted, and it is never created twice. Fix the cause if the
     error names one (for example re-authenticate), then click **Publish the LinkedIn post**,
     show Zack its dialog and, after his "yes", click **Yes, post it on LinkedIn**. If the page
     says *The post may be out*, open that link first and don't publish again if the post is
     there. If it says another publish is in progress, wait a few minutes and check Zack's
     LinkedIn posts before trying again.
   - **Pending** (*a create was started and its outcome is unknown*): open the BOCC LinkedIn
     page's events as a page admin
     (https://www.linkedin.com/showcase/89993057/admin/dashboard/, or the page's Events tab)
     and look for an event on $DATE. An event that was never posted is hidden from everyone
     else, so look as the admin. If it's there, **don't retry**: tell Zack the ledger needs
     fixing. Only if nothing was created, click **I checked: nothing was created, allow
     retry**, then go back to step 6.
   - If LinkedIn refused before creating anything, the page says *nothing was created. Fix the
     cause, then allow retry below.* Fix it, allow retry, and go back to step 6.
   - A 403 or page-role error means the LinkedIn profile isn't an admin of the BOCC page: stop.

8. **Repost from the BOCC page.** The app can't post as the page, so:
   1. Open the **post** link from the ledger line (Zack's post, "Please join me at Buffalo Open
      Coffee Club" with the event card).
   2. Click **Repost**, then **Repost with thoughts**.
   3. Click the triangle next to Zack's name and set *Post as* to **Buffalo Open Coffee Club**
      (the BOCC page).
   4. Add a short line if Zack wants one (for example "Join us next Tuesday at 7:30 AM"), check
      the text, and click **Repost**.
   5. Confirm the "Repost successful" toast and that the event card shows the right date and
      7:30 AM.

9. **Report back** to Zack: the LinkedIn event link, his post link, that the page repost is
   done, and anything that needed recovery.

## Later in the week

- If the location or Event Image is changed after posting, the event page says *LinkedIn is
  out of date*: fix it on LinkedIn by hand (the app doesn't sync).
- If the event is cancelled after posting, Status and location shows *Cancel the LinkedIn
  event on LinkedIn*: open the LinkedIn event, cancel it there, then click **Done on
  LinkedIn**.

Background: ADR 0012 and `docs/backend/LINKEDIN_PERMISSIONS.md` in the BOCC repo.
