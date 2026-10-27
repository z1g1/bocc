# Plan: Replace the Circle.so integration with Zeffy

Status: **Proposed** (2026-10-27). Nothing here is built yet.

## Goal

1. BOCC attendees live in **Bootsector's Zeffy account**, held apart in a BOCC list.
2. A one-time script imports the attendees already in Neon.
3. A new attendee who checks in and ticks "send me updates" is added to Zeffy, gets a
   welcome email, and lands on the BOCC email list.
4. Every marketing email can be unsubscribed from (CAN-SPAM; CASL for Canadian attendees).
5. The Circle.so integration (invites, check-in counter, photo enforcement) is retired.

## What the Zeffy API can and cannot do

Source: the OpenAPI 3.1 spec embedded in https://www.zeffy.com/api/docs (base URL
`https://api.zeffy.com`, v1), plus Zeffy's help center (support.zeffy.com).

| Need | API? | Notes |
|---|---|---|
| Create / update a contact | **Yes** | `PUT /api/v1/contacts` upserts by email (201 created / 200 updated). Fields: `email`, `first_name`, `last_name`, `phone_number`, `address`. |
| Find a contact by email | **Yes** | `GET /api/v1/contacts?email=` |
| Put a contact on a list or tag | **No** | The API has no lists, tags or segments. `metadata` is "reserved for future" and custom fields are not writable. |
| Send an email (welcome or other) | **No** | No email endpoint. The one exception: `POST /api/v1/payments` with `send_confirmation_email: true` sends a campaign's confirmation email (see below). |
| Read or set subscribed / unsubscribed | **No** | Not in the contact schema. CSV import *can* set `Subscription Status`. |
| Webhooks | Yes | `contact.created/updated/deleted`, `payment.*`, HMAC-SHA256 signed (`Zeffy-Signature`). Not needed for v1. |
| Rate limits | | 100 req/min and 20 req/s **per organization**, shared with everything else Bootsector runs. |

Zeffy features that exist only in the dashboard:

- **Lists.** *Manual* lists are snapshots; *automatic* lists re-evaluate filters
  (Fundraising Campaign, Manual List, Email, Company, Location…). Tags became manual lists.
- **CSV import.** Up to 5,000 rows per file (one page says 15,000). It can assign `Lists`
  and set `Subscription Status`. Re-importing an email **overwrites** the existing fields.
- **Email.** Every bulk email gets an unsubscribe link and footer automatically.
  Unsubscribes are **account-wide**: they apply to the whole Bootsector organization, not
  to one list. Receipts and confirmations ignore unsubscribes.
- **Automation.** Zeffy's own FAQ says a welcome series triggered by joining a list
  "isn't there yet" (its marketing bullets claim otherwise).

### Consequences for the design

- The API alone cannot put someone on a BOCC list or send a welcome email.
- **Proposed mechanism: a free BOCC ticketing campaign.** Bootsector creates a free
  Zeffy ticketing campaign called "BOCC Community". For each newly opted-in attendee, the
  backend calls `POST /api/v1/payments` with a $0 ticket on that campaign and
  `send_confirmation_email: true`.
  - Zeffy creates or finds the contact by email.
  - Zeffy sends the campaign's confirmation email. Its custom message *is* the welcome.
  - An **automatic list** "BOCC" filtered on *Fundraising Campaign = BOCC Community*
    picks the contact up without any further call.
  - Cost: one $0 "payment" per new subscriber appears in Bootsector's payment records
    (`payment_method: other`, source `PublicApi`). Bootsector has to accept that.
- **Fallback if Phase 0 rules this out:** upsert the contact with `PUT /contacts`, send
  the welcome from a transactional email service with its own unsubscribe link, and add
  the contact to a manual BOCC list in a weekly batch CSV import. This is worse because it
  needs a second vendor, a second suppression list, and a manual weekly step.

## Decisions needed before building

1. **Account-wide unsubscribe.** Someone who unsubscribes from a BOCC email is also
   unsubscribed from all Bootsector bulk email, and a Bootsector unsubscriber won't get BOCC
   mail. Is that acceptable? The only alternative is a separate Zeffy organization for
   BOCC, which Zeffy ties to a registered nonprofit, so it is probably not an option.
2. **Bootsector's own sends.** Bootsector staff must not email "all contacts" without
   excluding the BOCC list, or BOCC attendees get mail they never agreed to. This needs an
   agreement with Bootsector, not code.
3. **API key scope.** The Zeffy key is created by the **organization owner** and has *no
   scopes*. It can read every Bootsector donor and **delete payments and contacts**. That
   breaks our least-privilege rule, and nothing on our side fixes it. Mitigations are
   listed below, but someone should ask Zeffy support for a scoped key first. Rate this a
   **medium** risk to accept with eyes open.
4. **Circle community.** Does 716.social (Circle) shut down, or keep running without the
   backend sync? This plan removes the backend integration either way. Whether the website
   keeps linking to the community is the remaining question.
5. **$0 payments.** Is Bootsector's bookkeeper OK with a $0 ticket record per new
   subscriber?

## Phases

### Phase 0: Spike in Zeffy (manual, ~1 hour, needs the Bootsector owner)

Use a test email throughout, and delete the test records afterwards.

- [ ] Create the free "BOCC Community" ticketing campaign with one $0 rate. Write the
      welcome text into its confirmation email.
- [ ] Generate the API key (Settings → Integrations). Store it only in Netlify env and
      a gitignored `.env.zeffy`.
- [ ] `GET /api/v1/campaigns/{id}` to get the `rate_id`. Then `POST /api/v1/payments` with
      a $0 ticket and `send_confirmation_email: true`. Confirm that the email arrives, what
      it looks like, and whether it has an unsubscribe link.
- [ ] Create the automatic list "BOCC" (Fundraising Campaign = BOCC Community) and
      confirm the test contact appears in it.
- [ ] Check what subscription status an API-created contact starts with.
- [ ] Send a test bulk email to the list. Confirm the unsubscribe link and footer,
      including Bootsector's postal address (CAN-SPAM).
- [ ] Check whether an automatic list can combine "Manual List = BOCC Import" OR
      "Fundraising Campaign = BOCC Community". This decides how the import joins the
      same list.

If any box fails, switch to the fallback above before writing code.

### Phase 1: Consent wording (website)

The checkbox on `website/checkin/bocc.html` (and `bocc-afternoon.html`) currently reads
"Send me updates about future BOCC events". The data now goes to Bootsector, so the label
should say so:

> Email me about future BOCC events. BOCC is a program of Bootsector; unsubscribe anytime.

The checkbox stays unchecked by default, which is express consent under CASL. Link a short
privacy note. Only attendees with `ok_to_email = true` are ever sent to Zeffy.

### Phase 2: One-time import of existing attendees

`backend/scripts/zeffy-export.js` (operator-only, not deployed):

- Reads Neon using the owner URL from `.env.local`, or better, a new read-only role.
- Selects `attendees WHERE ok_to_email AND NOT debug`, de-duplicated by lowercased email.
- Splits `name` into first and last name. Columns: `First Name, Last Name, Email,
  Phone, Company Name, Lists, Subscription Status`, with `Lists = BOCC Import` and
  `Subscription Status = subscribed`.
- **Excludes emails already in Bootsector's Zeffy.** It looks each one up with
  `GET /contacts?email=` (throttled to 100/min). Re-importing overwrites fields and
  would **re-subscribe** someone who had unsubscribed from Bootsector. The excluded
  emails go in a separate report; whether they join the BOCC list is a manual decision.
- Writes to a gitignored path, prints counts only (no PII in logs), and reminds the
  operator to delete the file after uploading.
- Dry-run by default. Unit-tested for the name split, filtering and CSV escaping
  (formula-injection: prefix cells starting with `= + - @`).

Then upload the CSV in Zeffy (Contacts → Import), in chunks of 5,000 rows or fewer.
Imported contacts get **no** welcome email; they already know BOCC.

### Phase 3: Check-in → Zeffy (backend)

**New migration** `db/migrations/<ts>_zeffy_sync.sql`:

```sql
create table zeffy_sync (
  attendee_id      uuid primary key references attendees(id),
  zeffy_contact_id text,
  zeffy_payment_id text,
  synced_at        timestamptz not null default now()
);
grant select, insert on zeffy_sync to checkin_writer;
```

It is insert-only, so `checkin_writer` stays SELECT/INSERT. A row means "welcomed once",
which makes the sync idempotent. Imported attendees get rows too (with null payment id),
so they are never welcomed.

**New `utils/zeffy.js`.** It deliberately exposes only two operations, and has no
generic request helper:
- `findContactByEmail(email)` → `GET /api/v1/contacts?email=`
- `enrollInBocc({ email, firstName, lastName })` → `POST /api/v1/payments` (free ticket,
  `send_confirmation_email: true`, `generate_tax_receipt: false`, `payment_method: 'other'`)
- It honors `Retry-After` on 429, uses a timeout, and never logs PII. A test asserts the
  module cannot issue `DELETE`, `PATCH` or `PUT` against payments.

**`utils/check-in.js`:** replace `syncCheckinToCircle` with `syncCheckinToZeffy`:
- Skip if `debug`, if `!okToEmail`, or if a `zeffy_sync` row exists.
- Otherwise call `enrollInBocc`, then insert the `zeffy_sync` row.
- Non-blocking, like Circle today: a failure is logged and never fails the check-in.
- The result field `circleSynced` becomes `zeffySynced`.

**Retry:** a scheduled function `zeffy-reconcile.js` takes over the Monday cron slot that
photo enforcement frees up. It enrolls opted-in, non-debug attendees that have no
`zeffy_sync` row, capped at 50 per run to stay well under the shared rate limit.

**Config (`utils/config.js`):** add `ZEFFY_API_KEY`, `ZEFFY_BOCC_CAMPAIGN_ID` and
`ZEFFY_BOCC_RATE_ID`, which fail fast at import (ADR 0001). Remove the Circle secrets.

**Docs:** create `docs/backend/ZEFFY_PERMISSIONS.md` (who creates the key, the fact that it
has no scopes, what our code is allowed to call, the rotation procedure, and whom to tell
if it leaks). Add an ADR "0006 Zeffy replaces Circle". Update `CLAUDE.md`,
`architecture.md` and `onboarding.md`.

**Tests:** unit tests for `zeffy.js` (mocked HTTP: 201/200/409/429/500 and timeout), for
the check-in branches (debug, no consent, already synced, success, Zeffy failure still
returns `created`), and for the reconcile job. Add a gated integration test that uses the
test email against the real campaign.

### Phase 4: Remove Circle

Do this in the same release as Phase 3, or straight after it:

- Delete `circle.js`, `circle-http.js`, `circle-member-api.js`,
  `profile-photo-enforcement*.js`, `enforcement-logic.js`, `message-templates.js`,
  `airtable-warnings.js`, their tests, and the cron in `netlify.toml`.
- Remove `CIRCLE_API_TOKEN`, `CIRCLE_HEADLESS_API` and `ADMIN_MEMBER_ID` from Netlify, and
  **revoke the tokens in Circle**.
- Archive the Circle docs (`CIRCLE_*.md`, `716-bot-final-messaging.md`, the epics) under
  `docs/backend/archive/`.
- Update any website copy that promises a 716.social invite (depends on decision 4).
- The Airtable "No Photo Warnings" table is no longer used. Keep it read-only as history.

### Phase 5: Release

- Run `npm test` and the Jekyll build. Apply the migration to Neon **before** merging.
- Set the Netlify env vars, then merge `dev` → `main` once (15 credits).
- Run `test:smoke-prod` with a debug check-in. It must **not** reach Zeffy.
- Run one real opt-in check-in with a test email and confirm the welcome email arrives,
  the contact is on the automatic list, and the `zeffy_sync` row exists. Then delete the
  test contact and the $0 payment in Zeffy.

## Unsubscribe and compliance checklist

- Opt-in is an unchecked box with clear wording naming BOCC and Bootsector (Phase 1).
- Only opted-in attendees are sent to Zeffy, in the import and on check-in.
- Bulk BOCC emails are sent from Zeffy, which adds the unsubscribe link and footer.
- Zeffy owns subscription status from now on. Our code never sets it, and the API can't.
  `PUT`/`POST` never re-subscribe anyone, and the import skips existing contacts so it
  can't either.
- The welcome (confirmation) email is transactional and ignores unsubscribes, so keep
  it a plain welcome with no promotions. Ask Zeffy whether a footer line pointing to
  email preferences can be added.
- Our `ok_to_email` column records consent at capture. It is not a live subscription
  flag, and docs should say so.

## Sources

- Zeffy API reference (OpenAPI spec embedded in the page): https://www.zeffy.com/api/docs
- Lists: https://support.zeffy.com/creating-segments-and-lists-1qg9z
- Importing contacts: https://support.zeffy.com/importing-contacts-into-zeffy-po19h
- Email, unsubscribes, automation FAQ: https://www.zeffy.com/en-au/home/newsletter-emailing
- How contacts are created: https://support.zeffy.com/how-contacts-are-created-in-zeffy-5opxn
