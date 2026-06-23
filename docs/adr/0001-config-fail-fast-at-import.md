# ADR 0001 — Config adapter validates and fails fast at import

- **Status:** Accepted
- **Date:** 2026-06-23
- **Deciders:** Zack Glick

## Context

Configuration (env secrets + operational constants) was read directly via
`process.env` in five backend modules, each printing its own `'Exists' / 'Not set'`
line at import. There was no single place that answered "is this environment correctly
configured?", and a missing secret surfaced as a different, late failure depending on
which function ran first (e.g. a Circle 401 three calls deep, or a broken Airtable
client on first query).

We are introducing a single config adapter (`utils/config.js`) — the "config adapter"
seam named in `CONTEXT.md` — that centralizes all config and validates required secrets.
The open question was **when** validation should fire, complicated by the test suite:
the ~299 Jest tests run with **no env vars set** and instead `jest.mock()` the service
modules, so `process.env.AIRTABLE_API_KEY` is `undefined` during tests today and it
simply doesn't matter.

## Decision

`config.js` validates the four required secrets (`AIRTABLE_API_KEY`,
`AIRTABLE_BASE_ID`, `CIRCLE_API_TOKEN`, `CIRCLE_HEADLESS_API`) **at import time** and
throws a single aggregated error listing everything missing. Because every handler
transitively imports `config.js`, this means a Netlify function that is missing a secret
fails immediately at cold start with one clear message in the logs, before any
half-built client exists.

To keep the test suite green (it sets no env), we add `tests/jest.setup.js` wired via
Jest `setupFiles`, which seeds dummy values for the required secrets before any module
loads.

## Alternatives considered

- **Lazy `requireConfig()` inside each handler** — avoids the import-time test problem,
  but is invasive (every handler must remember to call it) and downgrades "fail-fast at
  boot" to "fail-fast at first invocation."
- **Throw at import but skip validation when `NODE_ENV=test`** — keeps tests green with
  no setup file, but then tests never exercise the real boot path, hiding regressions in
  the validation logic itself.

## Consequences

- Misconfiguration is caught once, at cold start, with a single actionable message.
- New required secrets are added in exactly one place; the validation list is the
  canonical contract with the environment.
- Tests depend on `tests/jest.setup.js` providing dummy secrets. A future reader seeing
  fake credentials in that file, or an import-time throw, should read this ADR.
- Reversing to a lazy strategy later would require touching every handler — the reason
  this decision is recorded rather than left implicit.
