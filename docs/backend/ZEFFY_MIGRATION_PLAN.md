# Plan: Replace the Circle.so integration with Zeffy

Status: **Proposed** (2026-10-27, revised the same day to a smaller scope). Nothing here is
built yet.

## Goal

1. BOCC's email audience lives in **Bootsector's Zeffy account** as a BOCC list.
2. A one-time import moves the attendees already in Neon who opted in.
3. A new attendee who checks in and wants updates gets onto that list.
4. **Zeffy does the rest:** welcome email, list assignment, communication preferences,
   newsletters and unsubscribes. Our code sends no email and keeps no mailing state.
5. The Circle.so integration (invites, check-in counter, photo enforcement) is retired.

## The constraint that shapes the design

Zeffy's automated emails start **only when someone submits a Zeffy sign-up form**:

> "Automations currently work with sign-up forms only. Every contact who signs up through
> the form is enrolled automatically…"
> ([Set up automated emails](https://support.zeffy.com/set-up-automated-emails-for-a-newsletter-sign-up-form-b9tb3))

The public API ([api docs](https://www.zeffy.com/api/docs)) can create contacts, but it
cannot put them on a list, enroll them in an automation, send email, or set subscription
status. A contact our backend pushed in through the API would sit in Zeffy with no welcome
email and no BOCC list.

So the attendee has to submit the Zeffy form themselves. **Our job is to put the form in
front of them at the right moment**, right after a first check-in.

This also means **no Zeffy API key is needed**. That removes the biggest risk in the first
draft: Zeffy keys are created by the organization owner, have no scopes, and could read or
delete all of Bootsector's donor and payment data.

## How it works

```
Check-in form (716coffee.club)
  └─ POST /.netlify/functions/checkin  → Neon (unchanged; Circle call removed)
  └─ Thank-you screen
       └─ if first check-in AND "send me updates" ticked:
            show the embedded Zeffy sign-up form (sponsor redirect waits)
              └─ attendee submits → Zeffy:
                   • adds contact to the "BOCC" list (+ preference lists)
                   • runs the BOCC welcome automation
                   • handles unsubscribe from then on
```

Existing attendees reach the same "BOCC" list through a one-time CSV import. An import does
not trigger the automation, so they get no welcome email, which is what we want for people
who already know BOCC.

## Phases

### Phase 0: Set up in Zeffy (Bootsector owner or admin; no code)

- [ ] **Contacts → Sign-up Forms → Create Form** "BOCC Updates". Keep first name, last
      name and email.
- [ ] Set the form's default list to a new manual list **"BOCC"**, so every submission
      lands there.
- [ ] Optional: add a **Communication Preferences** question whose options are assigned
      to their own lists (e.g. "Weekly event reminders", "Sponsor & community news").
- [ ] **Set up automations:** a Welcome sequence (email, then a delay, then a follow-up
      if wanted), with objective **No objective**. Save & turn on.
- [ ] Copy the **Embed** code and the **Share link**.
- [ ] Verify the things the help pages don't say, using a test email:
  - which domains the embed loads from (for our CSP),
  - whether fields can be prefilled (URL parameters), so attendees don't retype name
    and email,
  - whether the welcome email has an unsubscribe link and Bootsector's postal address
    (CAN-SPAM),
  - what happens when an existing contact, or one who has unsubscribed, submits the form
    again (re-subscribe? duplicate welcome?),
  - whether there's a double opt-in option.

### Phase 1: Show the Zeffy form after check-in (website)

`website/js/checkin.js`, `website/checkin/bocc.html`, `bocc-afternoon.html`:

- Keep the "send me updates" checkbox as the trigger. Reword its label to say the
  updates come from Bootsector, e.g. *"Email me about future BOCC events (BOCC is a
  program of Bootsector)."* Zeffy's form records the real consent.
- In `showThankYou`, when the check-in succeeded, the box was ticked, it's the attendee's
  **first** check-in, and this browser hasn't already shown the form:
  - render the Zeffy embed in the thank-you area,
  - hold the sponsor countdown until the form is submitted or the attendee taps "Skip",
  - set a `localStorage` flag (in try/catch) so the form isn't shown to them again.
- "First check-in": the thank-you screen already gets a streak and celebration from the
  API, and "Welcome to the community!" is the first-visit message. Reuse that signal. If
  it can't tell first visits apart reliably, add a `firstCheckin` boolean to the check-in
  response. That is the only backend change Phase 1 might need.
- If prefill works (Phase 0), pass the name and email the attendee just typed.
- Fallback: if the embed fails to load, show the Zeffy share link instead.
- Update the CSP in `website/_includes/head/custom.html`: add the Zeffy embed domains to
  `frame-src`, plus `script-src` if the embed is a script. Add only the exact domains
  found in Phase 0.
- Also put the share link somewhere permanent, such as the site footer or a printed QR
  code at the event, for people who skip it at check-in.

Nothing in Phase 1 needs a server secret.

### Phase 2: One-time import of existing attendees

`backend/scripts/zeffy-export.js` (run by an operator, not deployed):

- Reads Neon (owner URL from `.env.local`, or a read-only role).
- Selects `attendees WHERE ok_to_email AND NOT debug`, de-duplicated by lowercased email.
- Writes Zeffy's import template columns: `First Name, Last Name, Email, Phone,
  Company Name, Lists, Subscription Status`. `Lists = BOCC` and
  `Subscription Status = subscribed`.
- **Skips emails already in Bootsector's Zeffy.** The operator exports Bootsector's
  contacts from the Zeffy dashboard and passes that file to the script. Re-importing an
  existing email overwrites its fields and could re-subscribe someone who unsubscribed
  from Bootsector. Skipped emails go to a separate count; adding them to the BOCC list is
  a manual decision in the dashboard.
- Escapes CSV formula injection (cells starting with `= + - @`), logs counts only (no
  PII), writes to a gitignored path, and is dry-run by default. Unit-tested.

The operator uploads it under Contacts → Import, 5,000 rows or fewer per file, then deletes
the local files.

### Phase 3: Remove Circle (backend)

- `utils/check-in.js`: delete `syncCheckinToCircle` and the `circleSynced` result field.
  Check-in becomes validate → Neon → streak.
- Delete `circle.js`, `circle-http.js`, `circle-member-api.js`,
  `profile-photo-enforcement.js`, `profile-photo-enforcement-manual.js`,
  `enforcement-logic.js`, `message-templates.js`, `airtable-warnings.js`, their tests,
  and the enforcement cron in `netlify.toml`.
- `utils/config.js`: remove `CIRCLE_API_TOKEN`, `CIRCLE_HEADLESS_API`, `ADMIN_MEMBER_ID`.
  Remove them from Netlify and **revoke the tokens in Circle**.
- Archive the Circle docs (`CIRCLE_*.md`, `716-bot-final-messaging.md`, related epics) in
  `docs/backend/archive/`. Add ADR 0006 "Zeffy sign-up form replaces Circle". Update
  `CLAUDE.md`, `architecture.md` and `onboarding.md`.
- The Airtable "No Photo Warnings" table stops being used. Leave it as read-only history.

### Phase 4: Release

- `npm test` and the Jekyll build pass. Merge `dev` → `main` once (15 credits).
- A debug check-in on production still works (`test:smoke-prod`).
- One real first check-in with a test email: the form appears, submitting it puts the
  contact on "BOCC", and the welcome email arrives. Delete the test contact afterwards.

## Decisions for you and Bootsector

1. **Unsubscribes cover all of Bootsector.** Zeffy unsubscribes are account-wide, so
   leaving BOCC email stops all Bootsector bulk email too, and the reverse.
   Communication-preference lists help people choose *what* they get, but they are not a
   per-list unsubscribe.
2. **Bootsector's own sends.** Bootsector staff need to leave the BOCC list out of "all
   contacts" sends, or BOCC attendees get mail they didn't sign up for.
3. **The 716.social community.** Shut it down, or keep it running without automatic
   invites? Phase 3 removes the integration either way. The answer decides what the
   website says about the community.
4. **The extra step at check-in.** Showing a second form is friction at a coffee event,
   and prefill (Phase 0) would make it small. The alternative is the share link or QR
   only, which is less friction but means fewer sign-ups.

## Compliance checklist

- Consent comes from the attendee submitting Zeffy's form. Our checkbox only decides
  whether the form is shown, and stays unchecked by default.
- Zeffy owns subscription status; our code never touches it. `ok_to_email` in Neon is
  consent at capture, used only for the one-time import.
- The import never overwrites existing Zeffy contacts, so it can't re-subscribe anyone.
- Every Zeffy bulk email carries an unsubscribe link automatically. Phase 0 confirms that
  the welcome automation emails do too.

## Sources

- Newsletter sign-up form: https://support.zeffy.com/create-a-newsletter-sign-up-form-93zh0
- Automated emails for sign-up forms: https://support.zeffy.com/set-up-automated-emails-for-a-newsletter-sign-up-form-b9tb3
- Lists: https://support.zeffy.com/creating-segments-and-lists-1qg9z
- Importing contacts: https://support.zeffy.com/importing-contacts-into-zeffy-po19h
- Email and unsubscribes: https://www.zeffy.com/en-au/home/newsletter-emailing
- Zeffy API reference: https://www.zeffy.com/api/docs
