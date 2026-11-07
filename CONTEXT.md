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
Postgres `attendees` table (Neon) with name, phone, optional business name, and an
`ok_to_email` consent flag. An Attendee is created lazily on their first check-in.

### Check-in
A single act of an Attendee arriving at one **Event** instance, recorded in the Postgres
`checkins` table. A check-in is **deduplicated** per (attendee, eventId, token, Eastern
calendar day), enforced by a unique index. Checking in twice for the same event on the
same day is a no-op that returns a friendly "already checked in" result, not an error.

### Event / eventId / Token
An **Event** is a recurring gathering kind (`bocc`, `bocc-afternoon`, `coffee-and-code`…),
named by `eventId`. A **Token** is the per-occurrence GUID embedded in the QR code
(`/checkin/bocc?token=<GUID>`); together `eventId` + `token` + day identify one occurrence
for dedup purposes.

### Debug check-in
A check-in flagged `debug` (test traffic). Debug check-ins are recorded but never affect
streaks. All automated tests submit with `debug: "1"`.

### Sponsor redirect
After a successful check-in the web form may count down and redirect the Attendee to a
sponsor's link (configured in `website/_data/sponsor.yml`). Frontend-only concern. Currently
disabled.

### Occurrence
One weekly instance of an Event series. Identified **today** by `(eventId, ISO week)` where
the week is computed in **Eastern time** (`America/New_York`), because the QR **Token** is
reused week-to-week and so cannot identify an occurrence. An occurrence is **held** iff at
least one non-debug Check-in exists for it; a week with zero check-ins (e.g. a snow-day
cancellation) is simply **not an occurrence** and creates no gap.

### Occurrence calendar
The ordered set of held Occurrences for one eventId — the answer to "when did this event
actually meet?". A **derived, rebuildable projection**, not a source of truth: the
`held_occurrences` view (`SELECT DISTINCT date_trunc('week', …)` over non-debug check-ins),
not a maintained table. It is the single **seam** a future authoritative schedule (the
volunteers' Google Sheets calendar) would slot behind without touching the streak math.

### Streak
A per-`(Attendee, eventId)` run of **consecutive held Occurrences attended**, counted in
occurrences — never in calendar days or raw check-ins. A streak **breaks** only when a held
Occurrence is missed; a non-occurrence (snow-day) is skipped, not a break. A streak is
**active** if the Attendee attended the most recent held Occurrence. The **personal best**
is the longest such run the Attendee has ever achieved for that event. Like the occurrence
calendar, a streak is a **recomputable projection** of the check-in history — it must always
be rebuildable from scratch, never only incremented. Debug check-ins never affect streaks.

### Celebration
The small toast an Attendee sees right after a successful, non-debug check-in, chosen from
their Streak for that event. Exactly one kind applies (first match wins):
`first_visit` (first check-in ever) → `top_streak` (sole holder of the event's longest
active streak, ≥ 2) → `first_streak` (first time reaching 2 in a row) → `tied_top` (shares
the longest active streak) → `continued` (≥ 2 in a row) → `restart` (back after a missed
held occurrence; quotes the previous streak). The rule is pure backend logic
(`utils/streak-celebration.js`); the copy and emoji live in the frontend. No celebration for
duplicates, debug check-ins, or when the streak can't be read. Never a full-screen takeover.

---

## Seams & deep modules

### Validation (live) — `utils/validation.js`
Pure, dependency-free. Owns every rule for what valid check-in input looks like. Already a
**deep** module: small interface, real rules
hidden, trivially testable. *The interface is the test surface.*

### Config adapter (live) — `utils/config.js`
The single place that reads and **validates** the platform's contract with its environment:
the required `CHECKIN_DB_URL` and the defaulted options. Fails fast at import with one clear
message if anything required is missing. Every other module imports from it and never touches
`process.env`. *Decision recorded in `docs/adr/0001-config-fail-fast-at-import.md`.*

### Check-in use-case (live) — `utils/check-in.js`
The deep module behind the check-in HTTP handler: `checkInAttendee(input) → result`. Owns
the validate → find-or-create Attendee → dedup → record Check-in sequence and returns a plain discriminated result (`invalid` / `duplicate` / `created`), throwing only on
unexpected infrastructure failures. Lets the handler shrink to an HTTP **adapter** and makes
the whole flow testable by calling one function. The `created` result also carries the
**Streak** for the celebration (blocking but non-fatal). Postgres is the only store; see
ADR 0006.

### Postgres check-in store (live) — `utils/pg-store.js` + `backend/db/migrations/`
The storage adapter for Attendees and Check-ins on **Neon Postgres**. It connects as the
least-privilege `checkin_writer` role (SELECT/INSERT only, RLS on, owner credential never
deployed) over verify-full TLS (`utils/db-ssl.js`). Same-day dedup is enforced by a unique
index. See ADR 0003 (model), ADR 0005 (host), `docs/backend/NEON_PERMISSIONS.md`.

### Streak engine (live) — `streaks` / `held_occurrences` views
Computes a Streak's `current_streak`, `longest_streak`, and `is_personal_best` from check-in
history via a **gaps-and-islands** query over the per-`(Attendee, eventId)` attended weeks
measured against the Occurrence calendar. **Recompute-on-read, no drift, no maintained
counter** — the same query powers the live celebration, the backfilled history, and (later)
reminder targeting. See ADR 0004.

---

## Naming conventions

- Say **Attendee** for a person who checks in, identified by email.
- A "non-fatal" step is a domain promise (the core action survives its failure), not just an
  error-handling style.
