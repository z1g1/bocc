# ADR 0004 — Streak computation model: occurrence-based, derived, recomputable

- **Status:** Accepted
- **Date:** 2026-06-25
- **Deciders:** Zack Glick

## Context

BOCC wants to celebrate weekly check-in **streaks**: when an attendee checks in,
tell them how many consecutive weeks they've shown up. Requirements named up front:
track a **personal best**, support **back-porting** streaks from existing check-in
history, keep streaks alive across **event cancellations** (e.g. a snow-day), and
not preclude a later **reminders** feature.

The hard modeling questions were: what unit is a streak counted in, what breaks
it, and where the "truth" about which weeks the event was held comes from. This ADR
records the model; ADR 0003 records the datastore (Supabase Postgres) that makes it
affordable. The platform realities that shaped it: the QR **Token** is *reused*
week-to-week (so it cannot identify an occurrence), the event is weekly on Tuesday
mornings in Buffalo (`America/New_York`), and the canonical event schedule currently
lives in a separate Google Sheet maintained by volunteers.

## Decision

1. **Scope: per `(Attendee, eventId)`.** A `bocc` streak is distinct from a
   `bocc-afternoon` or `codeCoffee` streak. Attending one event does not advance
   another's streak.

2. **Unit: consecutive held *occurrences*, not calendar days or raw check-ins.** An
   **Occurrence** is one weekly instance of an event series, identified today by
   `(eventId, ISO week)` with the week computed in **Eastern time**. The Token is
   *not* used as an occurrence key (it's reused), only for same-day dedup.

3. **"Held" = ≥1 non-debug check-in by anyone.** A week with zero check-ins is not
   an occurrence. Debug check-ins never count (same rule as Circle sync).

4. **Break rule.** A streak breaks only when a *held* occurrence is missed. A
   non-occurrence (snow-day: nobody checked in that week) is skipped, not a break.
   So an attendee who attends weeks 1–3, misses a held week 4, then returns week 5
   restarts at 1 (personal best stays 3); an attendee whose week 4 was snowed out
   continues to 4 at week 5. Snow-days "just work" with no special handling.

5. **Derived, not authoritative — behind a seam.** The set of held weeks is
   *derived* from check-ins, not from an authoritative schedule. The derivation is
   isolated as an **Occurrence calendar** seam so a future implementation can read
   the volunteers' Google Sheets schedule instead, without changing streak math.

6. **Recompute-on-read via SQL gaps-and-islands.** On Postgres, streaks are a
   view/function over check-in history, not a maintained counter. The same query
   powers the live celebration, the one-time **backport** (just run it over
   imported history), and later reminder targeting. `longestStreak`/personal-best
   come from the same pass. **No incremental counter, no drift.**

7. **Celebration contract: blocking but non-fatal.** The streak is computed inline
   and returned in the check-in response so the frontend can celebrate
   immediately — but if the query fails, the **check-in still succeeds** (no
   celebration), exactly like the non-blocking Circle-sync promise.

8. **v1 surface: `currentStreak` only.** The response/UI shows the current run
   ("N weeks in a row"), celebrated at ≥2. `longestStreak`/personal-best and
   milestones are **computed and stored** but not displayed yet; the frontend owns
   presentation thresholds so copy changes need no backend deploy.

## Alternatives considered

- **Calendar-week unit with a cancellation exception list.** Count consecutive ISO
  weeks with a check-in, and maintain a list of "cancelled" weeks to bridge. Viable,
  but requires actively logging every cancellation; the occurrence model makes a
  snow-day a non-event automatically. Rejected for the extra bookkeeping.
- **Token as the occurrence key.** Clean *if* a fresh token were minted per week —
  but the token is reused, so it can't distinguish occurrences. Rejected on
  operational reality.
- **Authoritative occurrence registry now (read the Google Sheet).** More precise
  (distinguishes a real-but-unattended week from a cancellation), but a larger
  integration and the Sheet/Airtable systems are deliberately kept separate for now.
  Deferred — the Occurrence calendar seam keeps this a cheap future swap.
- **Incremental counter (increment on each check-in).** The only viable option on
  Airtable's free tier (history can't be retained), but it cannot be recomputed
  from source and drifts on any backfill/edit/bug. Made obsolete by moving to
  Postgres (ADR 0003), where recompute-on-read is cheap.

## Consequences

- Snow-days require **no special handling** in v1: a cancelled week has no check-ins,
  so it's not an occurrence and bridges the streak automatically.
- Back-porting is free: the recompute query run over imported history *is* the
  backport — there is no separate seeding algorithm to get wrong.
- Because "held" is derived from attendance, a **real-but-unattended week looks
  identical to a cancellation** (both have zero check-ins). For a well-attended
  weekly event this is a non-issue; if it ever bites, the fix is the already-planned
  authoritative Occurrence calendar (read the schedule), enabled by the seam.
- `isPersonalBest` is "currently at your best" (`currentStreak = longestStreak`); it
  cannot by itself distinguish *tying* a record from *beating* it. Acceptable for the
  deferred personal-best UI.
- Reminders (Phase 3) need no model change — the same view exposes active streaks +
  `lastCheckinDate` + contactability.
- The frontend check-in handler must change to **read the response body** (it
  currently discards it) to surface the streak.
