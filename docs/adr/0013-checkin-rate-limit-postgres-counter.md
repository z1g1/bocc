# ADR 0013 — Per-IP check-in rate limit as a Postgres counter

- **Status:** Accepted (2026-11-22). Spec: GitHub issue #67 (parent #5, finding L1 of the
  pre-go-live security review).
- **Date:** 2026-11-22
- **Deciders:** Zack Glick

## Context

`/.netlify/functions/checkin` is public on purpose (people reach it from the QR code), and
nothing throttled it. One script could post unlimited valid check-ins with made-up emails,
putting addresses on the email list (`okToEmail`) and filling the attendee list with junk.

The limit must never stop a real Tuesday. Most attendees check in within the same 15
minutes, many over the venue's shared Wi-Fi, so a whole crowd can share one public IP.
Today's crowd is about 30 to 35 people. Before the pandemic it reached about 150.

## Decision

- **A fixed window per client IP, counted in Postgres.** Every check-in POST (valid or not,
  before the body is parsed) records one row in `checkin_rate_limit_hits`:
  `(client_key, window_start)`. One statement inserts the row only if the window holds
  fewer than the limit, and returns whether it did
  (`pg-store.recordAttemptUnderLimit`). Over the limit, the function returns **429** with
  `Retry-After` (seconds left in the window) and a JSON `message` naming the minutes left
  ("Too many check-in attempts. Please try again in about N minutes."), and writes no
  attendee, check-in or counter row. The check-in page shows that message and keeps the form.
- **Limits: 200 attempts per IP per clock hour** (`CHECKIN_RATE_LIMIT=200`,
  `CHECKIN_RATE_WINDOW_SECONDS=3600`). An hour covers the whole event's arrival peak, so
  the limit is effectively "per event". A 150-person crowd, the largest BOCC has had, all on
  one Wi-Fi IP, still has 50 attempts spare for typos and retries, and today's crowd uses
  under a fifth of it. A script gets at most 200 rows an hour per IP, against unlimited
  before. Both are Netlify environment variables, so each environment can set its own
  (staging sets small ones to demo it).
- **The IP is `x-nf-client-connection-ip`**, which Netlify sets and the client can't.
  Never `X-Forwarded-For` or `Client-IP`.
- **Only a SHA-256 of the IP is stored**, never the IP. A check constraint rejects anything
  but a 64-character hex digest. Logs carry neither the IP nor the body.
- **Fail open.** If the counter fails (database unreachable, missing table) or a request has
  no client IP, the check-in is allowed and the failure is logged (message only). The
  limiter exists to stop floods, and it must never be why a real attendee can't check in.
- **Insert-only.** `checkin_writer` gets `SELECT, INSERT` on the new table and still has no
  `UPDATE` or `DELETE` anywhere (docs/backend/NEON_PERMISSIONS.md).

## Alternatives considered

- **Netlify's built-in rate limiting.** Code-based rules are on every plan, including the
  credit-based Free plan (2 rules per project). Rejected because:
  - Function rules live in the function's exported `config` (with a `path`), which is the
    v2 function format. `checkin.js` is a v1 CommonJS `exports.handler`. Rules can't be
    set for a function in `netlify.toml`. Using it means rewriting the handler (Request
    and Response, a custom path) for this one feature.
  - Netlify says it "can take up to 10 seconds" before it starts blocking a client.
    A script sending 50 requests a second writes about 500 rows before the first 429.
  - The window is at most 180 seconds, so the limit can't be "per event".
  - It can't run in the Jest suite or locally, so the limit logic can't be tested.
  - Its 429 body is Netlify's page, not the API's JSON.

  A counter in Postgres (the decision above) costs one more statement per check-in, against
  the database the function already uses.

## Consequences

- Each check-in costs one extra indexed statement on Neon (the same pooled connection).
- Concurrent requests can overshoot the limit by a few, because the count and the insert
  are one statement but not serialized. That's acceptable for flood control.
- A fixed window lets an IP send up to twice the limit across a window boundary. Also
  acceptable: a real crowd never comes close, and a script is still bounded.
- Rows are never deleted by the app. Growth is bounded (at most 200 rows per IP per hour,
  a few dozen per normal week). The owner can prune old windows:
  `delete from checkin_rate_limit_hits where window_start < now() - interval '1 day'`.
- A real crowd behind one carrier-grade NAT shares the same budget as one Wi-Fi network,
  which the 200 limit also covers.
- Migration `20261204120000_checkin_rate_limit.sql` must reach a Neon branch before this
  code. The "Migrate and deploy" workflow does that (docs/backend/DEPLOYS.md). If the code
  ran first, the limiter would fail open, not break check-in.
- Per-email or per-day limits, and accepting only that week's token, are not part of this
  decision (#5 leaves the token question to a separate ticket).
