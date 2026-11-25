# ADR 0014 — New Email-list Attendees are added to Luma by a weekly Claude in Chrome task

- **Status:** Accepted (2026-11-25). Spec: GitHub issue #70.
- **Date:** 2026-11-25
- **Deciders:** Zack Glick

## Context

Attendees who tick "ok to email" at their first Check-in join the **Email list** (see
`GLOSSARY.md`). BOCC's emails go out from Luma, so those people also need to be among the
**Luma subscribers**: the people list on the BOCC calendar
(`https://luma.com/calendar/manage/cal-v2LiFTJpdPAP6rW/people`). Until now that was done by
hand from the Email list CSV, with nothing recording who had been added. At the time of this
decision there were 284 Luma subscribers.

Luma's API could add them directly (`import_calendar_contacts`), but the API needs a Luma Plus
subscription, which BOCC doesn't have. So the adding has to happen in Luma's web UI.

## Decision

1. **The app holds a Luma sync per Event; it never touches Luma itself.** This follows the
   ADR 0011 pattern. A Luma sync lists that Event's Attendees who joined the Email list (first
   non-debug Check-in with the box ticked) and are not yet **On Luma**, with name and email.
   The list is read live, not frozen.
   - Statuses: **To do**, **Nothing to add**, **Done**, **Error** (with the agent's note).
     An Admin can set Done by hand to say "stop, I handled it".
   - Every Event has one, even when nobody needs adding, so the agent always gets an explicit
     order. A Cancelled Event's sync is Nothing to add. Holiday-break Tuesdays (ADR 0011 §7)
     are not Events and get no sync. On those nights the page just says to stand down.
2. **A Claude in Chrome scheduled task on Modron's machine does the work, every Tuesday at
   9:00 PM ET.** It opens `/admin/luma-sync/next`, which hands out the oldest unfinished sync
   first (To do or Error). It pastes the emails, separated by spaces, into Luma's **Add people**
   dialog ("You can paste multiple emails into a single input, separated by comma or space"),
   then searches the Luma people list for each email. If every one is found, it marks the sync
   Done and those Attendees On Luma. If any are missing, it marks Error naming them. It loops
   until the page says "Nothing to add, stand down".
3. **New role `email`.** It sees only the Luma sync pages (names and emails of the people to
   add), not the Email list, Attendees, CSV export or opt-out. Modron's existing `social`
   account gets the `email` role too (ADR 0008: a user may hold several roles), so one Chrome
   session runs both tasks.
4. **ntfy pushes only on Error**, to the same topic as the social check (ADR 0011 §5). A normal
   Done or Nothing to add never pushes. A run that never happened (machine asleep, session
   expired) is *not* alerted. The next week's run picks up the oldest unfinished sync first.
5. **"On Luma" means present on Luma, not "we added them".** Someone who subscribed on Luma
   by themselves counts. It is recorded once and never turned off: an unsubscribe through
   Luma's own link is invisible to the app, and unsubscribing is handled entirely by Luma.
6. **Email list columns.** The Email list page and its CSV gain **Date added** (the date of
   the first non-debug Check-in, or the attendee row's creation date if there is none) and
   **On Luma** ("On Luma since <date>", "Before launch" or "Not yet"). The Admin event page
   shows that Event's Luma sync status and its people.
7. **Launch.** Everyone on the Email list at launch is marked On Luma "Before launch". No syncs
   are created for past Events. A one-time manual check, not built into the app, compares the
   Luma subscribers with the Email list and reports anyone missing so they can be added by hand.

## Considered options

- **Luma API from a Netlify function:** the sturdiest option, but it needs Luma Plus. Revisit
  if BOCC ever subscribes.
- **A human volunteer copying the CSV each week:** the status quo. It's forgettable and leaves
  no record of who is on Luma.

## Consequences

- Ticking the box at a *later* Check-in still doesn't opt anyone in, because
  `findOrCreateAttendee` ignores it for existing Attendees. This is deliberate for now.
- Missed runs are silent by design. The Admin event page and "Not yet" on the Email list are
  how someone would notice.
- As with ADR 0011, the agent is exposed to anything planted in the Luma pages it reads.
