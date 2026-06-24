# ADR 0002 — Authorization gate for the enforcement endpoints

- **Status:** Accepted
- **Date:** 2026-06-24
- **Deciders:** Zack Glick

## Context

The profile-photo enforcement logic is exposed through two Netlify functions:
`profile-photo-enforcement` (scheduled weekly via `netlify.toml`) and
`profile-photo-enforcement-manual` (on-demand). A run can send bot DMs to members
and **deactivate** Circle accounts.

A pre-go-live security review found that the scheduled function was **publicly
invocable over HTTP** — a `GET https://716coffee.club/.netlify/functions/profile-photo-enforcement`
returned 200 and executed a real, unfiltered enforcement run (verified with
`?dryRun=true`). Netlify *documents* that scheduled functions return 404 to direct
requests, but a function whose schedule is declared in `netlify.toml` (rather than
in-code) is still served on its normal HTTP path. The handler also reads
`dryRun` from the query string, so without a param a public caller triggers a
**production** run (mass DMs / deactivations, bounded only by the 1000-member
safety cap). Neither endpoint had any authentication.

## Decision

Both enforcement handlers share one authorization gate (in
`makeEnforcementHandler`). A request may run enforcement only if **either**:

1. it is a **genuine Netlify scheduled invocation**, detected via the
   `X-NF-Event: schedule` request header; **or**
2. it carries a valid **`x-enforcement-token`** header, compared in constant time
   against the `ENFORCEMENT_TRIGGER_TOKEN` env var.

Anonymous requests get `401`. The gate **fails closed**: if the token env var is
unset, only the cron signal authorizes a run.

The cron signal is trustworthy because **Netlify strips client-supplied `X-Nf-*`
headers** (platform change, 2022-03), so an external caller cannot forge
`X-NF-Event: schedule`. This is the load-bearing fact — see Consequences.

## Alternatives considered

- **Require the token for all invocations.** Breaks the weekly cron, which cannot
  send a custom header.
- **Detect the scheduled invocation via the `next_run` request body.** The body is
  *not* stripped, so a caller could POST `{"next_run": ...}` to bypass the gate.
  Rejected — only the `X-Nf-*` header is unspoofable.
- **Convert the schedule to in-code config (`schedule()` from `@netlify/functions`)**
  so Netlify returns 404 to public requests at the platform layer. Viable as
  defense-in-depth, but adds a dependency and changes deploy mechanics, and can't
  be verified without deploying. The header gate makes it unnecessary; it remains
  an optional future hardening.

## Consequences

- The publicly-invocable enforcement hole is closed; cron keeps working with no
  configuration, and operators trigger manually with the token.
- **The security of the scheduled path depends on Netlify continuing to strip
  inbound `X-Nf-*` headers.** Do not replace the `X-NF-Event` check with a
  body/`next_run` check or remove it — that would reopen the endpoint. A future
  maintainer seeing "why gate on a Netlify header?" should read this ADR.
- If Netlify ever stops sending `X-NF-Event` on scheduled invocations, the cron
  run fails closed (401) — enforcement silently stops rather than running
  unauthorized. This is detectable (no weekly run) and recoverable (trigger with
  the token); the fail-safe direction is intentional.
- Requires `ENFORCEMENT_TRIGGER_TOKEN` to be set in Netlify for the manual
  endpoint to be usable.
