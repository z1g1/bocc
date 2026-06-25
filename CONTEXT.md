# CONTEXT — BOCC Domain & Architecture Glossary

The shared language for the Buffalo Open Coffee Club platform. Use these names in code,
commits, docs, and design discussion. The **domain terms** name the things the business
cares about; the **seams** name the deep modules those things live behind.

Architecture vocabulary (module, interface, depth, seam, adapter, leverage, locality,
deletion test) comes from `/codebase-design` — this file gives those seams domain names.

> Status tags: **(live)** exists in code today · **(planned)** a seam we intend to create.

---

## Domain language

### Attendee
A person who shows up to BOCC. Identified by **email** (the natural key). Stored in the
Airtable `attendees` table with name, phone, optional business name, and an `okToEmail`
consent flag. An Attendee is created lazily on their first check-in.

### Check-in
A single act of an Attendee arriving at one **Event** instance, recorded in the Airtable
`checkins` table. A check-in is **deduplicated** per (attendee, eventId, token, calendar
day) — checking in twice for the same event on the same day is a no-op that returns a
friendly "already checked in" result, not an error.

### Event / eventId / Token
An **Event** is a recurring gathering kind (`bocc`, `bocc-afternoon`, `coffee-and-code`…),
named by `eventId`. A **Token** is the per-occurrence GUID embedded in the QR code
(`/checkin/bocc?token=<GUID>`); together `eventId` + `token` + day identify one occurrence
for dedup purposes.

### Debug check-in
A check-in flagged `debug` (test traffic). Debug check-ins are recorded but **skip Circle
sync** — they never touch the live community. All automated tests submit with `debug: "1"`.

### Circle sync
The non-blocking step that, after a real check-in, ensures the Attendee exists as a
**Member** in Circle and bumps their check-in counter. "Non-blocking" is a domain rule:
**a check-in must succeed even if Circle is down.**

### Member
A person's identity in the Circle.so community at 716.social. Has a profile photo, a
`checkinCount` custom field, and an active/deactivated state. A Member is the same human as
an Attendee, linked by email, but lives in a different system.

### Profile photo enforcement
The weekly job that nudges Members who haven't set a profile photo, escalating through a
fixed **Warning** progression and ultimately **deactivating** repeat offenders. The whole
job is one **Enforcement run**.

### Warning / Warning level
A tracked nudge against a photo-less Member, stored in the Airtable `No Photo Warnings`
table. **Warning level** is 1–4: levels 1–3 send escalating DMs, level 4 deactivates. If
the Member adds a photo, the warning is cleared and a thank-you DM is sent (**Photo added**).

### Enforcement action
The decided outcome for one Member in one run — one of `CREATE_WARNING`,
`INCREMENT_WARNING`, `DEACTIVATE`, `PHOTO_ADDED`, `SKIP`. Deciding the action is pure; doing
it has side effects. (Decide/do are deliberately separate — see *Enforcement decision* seam.)

### Dry run
An Enforcement run that decides every action but performs no side effects (no DMs, no
Airtable writes, no deactivations). The safety valve for testing enforcement against real
data. Triggered by `?dryRun=true`.

### Safety limit
A guard that aborts an Enforcement run if the community is unexpectedly large — warn at 500
Members, hard-stop at 1000 — so a bug can never mass-message or mass-deactivate.

### Bot
The "716.social Bot" Member that sends all enforcement DMs. Authenticates via Circle's
Headless Auth API to obtain a per-bot JWT, then sends messages as itself.

### Sponsor redirect
After a successful check-in the web form may count down and redirect the Attendee to a
sponsor's link (configured in `website/_data/sponsor.yml`). Frontend-only concern.

### Occurrence
One weekly instance of an Event series. Identified **today** by `(eventId, ISO week)` where
the week is computed in **Eastern time** (`America/New_York`), because the QR **Token** is
reused week-to-week and so cannot identify an occurrence. An occurrence is **held** iff at
least one non-debug Check-in exists for it; a week with zero check-ins (e.g. a snow-day
cancellation) is simply **not an occurrence** and creates no gap.

### Occurrence calendar
The ordered set of held Occurrences for one eventId — the answer to "when did this event
actually meet?". A **derived, rebuildable projection**, not a source of truth: on Postgres
it is a SQL query/view (`SELECT DISTINCT date_trunc('week', …)` over non-debug check-ins),
not a maintained table. It is the single **seam** a future authoritative schedule (the
volunteers' Google Sheets calendar) would slot behind without touching the streak math.

### Streak
A per-`(Attendee, eventId)` run of **consecutive held Occurrences attended**, counted in
occurrences — never in calendar days or raw check-ins. A streak **breaks** only when a held
Occurrence is missed; a non-occurrence (snow-day) is skipped, not a break. A streak is
**active** if the Attendee attended the most recent held Occurrence. The **personal best**
is the longest such run the Attendee has ever achieved for that event. Like the occurrence
calendar, a streak is a **recomputable projection** of the check-in history, materialised for
fast reads and celebration — it must always be rebuildable from scratch, never only
incremented. Debug check-ins never affect streaks (same rule as Circle sync).

---

## Seams & deep modules

### Validation (live) — `utils/validation.js`
Pure, dependency-free. Owns every rule for what valid check-in input looks like and the
Airtable formula-injection escaping. Already a **deep** module: small interface, real rules
hidden, trivially testable. *The interface is the test surface.*

### Message templates (live) — `utils/message-templates.js`
Pure. Turns Member name + warning level into the Bot's TipTap-JSON DM body. Messages are
**data, not behaviour** — deep and isolated.

### Enforcement decision (live) — `determineEnforcementAction()` in `utils/enforcement-logic.js`
The pure heart of enforcement: given a Member and their existing Warning, returns the
**Enforcement action** to take. Deliberately separated from execution so the escalation
rules are testable without touching Airtable or Circle.

### Config adapter (live) — `utils/config.js`
The single place that reads and **validates** the platform's contract with its environment:
the four required secrets, the defaulted options, and the named operational constants (Bot
identity, admin identity, API base URLs, safety-limit thresholds). Fails fast at import with
one clear message if anything required is missing. Every other module imports from it and
never touches `process.env`. *Decision recorded in `docs/adr/0001-config-fail-fast-at-import.md`.*

### Check-in use-case (live) — `utils/check-in.js`
The deep module behind the check-in HTTP handler: `checkInAttendee(input) → result`. Owns
the validate → find-or-create Attendee → dedup → record Check-in → Circle sync sequence and
returns a plain discriminated result (`invalid` / `duplicate` / `created`), throwing only on
unexpected infrastructure failures. Lets the handler shrink to an HTTP **adapter** and makes
the whole flow testable by calling one function. The `created` result also carries the
**Streak** for the celebration. A `CHECKIN_STORE` mode selects the storage backend — the
migration ladder `airtable` → `dual` (Airtable authoritative + Supabase shadow write +
streak, the verification mode) → `supabase` (authoritative). The shadow write and streak
read are **non-blocking** (same domain promise as Circle sync). See ADR 0003.

### Circle transport (live) — `utils/circle-http.js`
The shared transport beneath the two Circle domain modules (`circle.js` for Admin v2,
`circle-member-api.js` for Headless DMs). Owns authed axios-client construction and
consistent Circle API error logging, so neither domain module hand-rolls its own
transport. The **Bot JWT** is memoized here for the function-process lifetime, so an
enforcement run authenticates once rather than per DM. (Named domain error classes were
considered and declined — only `getAllMembers` branches on an error status.)

---

### Streak engine (planned) — Postgres view/function
Computes a Streak's `currentStreak`, `longestStreak`, and `isPersonalBest` from check-in
history via a **gaps-and-islands** query over the per-`(Attendee, eventId)` attended weeks
measured against the Occurrence calendar. **Recompute-on-read, no drift, no maintained
counter** — the same query powers the live celebration, the one-time backport, and (later)
reminder targeting. Lives behind the storage seam; see ADR 0004.

### Datastore migration (planned) — Airtable → Supabase Postgres
The transactional store (`attendees`, `checkins`, derived occurrences/streaks) is moving to
Supabase Postgres to escape Airtable's 1,000-record/base cap and make streaks a recomputable
SQL projection. Google Sheets remains the human-edited event **schedule**; `No Photo
Warnings` stays in Airtable. Access is via a **least-privilege** Postgres role (deny-by-default
RLS, no `service_role`), server-only. Phased: migrate check-ins → streaks → reminders.
See ADR 0003. *Until Phase 1 lands, the "Airtable `attendees`/`checkins` table" wording above
still describes today's storage.*

## Naming conventions

- Say **Attendee** for the Airtable/event side, **Member** for the Circle side; they are the
  same human linked by email, but never use the words interchangeably in code.
- Say **Enforcement run** for a whole job, **Enforcement action** for one Member's outcome.
- A "non-blocking" step is a domain promise (the core action survives its failure), not just
  an error-handling style.
