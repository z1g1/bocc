# Observability (OpenTelemetry on Netlify)

What the app emits for each MELT signal (metrics, events, logs, traces), where to find it in
Netlify, and what Netlify can't do. The code is `src/lib/telemetry.mjs`.

## What Netlify takes

Netlify ingests **OpenTelemetry traces only**. It has no OTLP endpoint for metrics or logs.

- **Traces.** When Netlify has tracing turned on for the site, the function runtime
  (`@netlify/serverless-functions-api`, the wrapper around every v2 function) installs a
  tracer provider for each request. It continues the incoming W3C trace context, adds
  fetch and http client instrumentation, and exports spans through the function log. The
  resource carries `service.name` = site name, `service.version` = deploy id and
  `deployment.environment` = deploy context. App code reaches the tracer through
  `@netlify/otel` (`getTracer()`). With tracing off, `getTracer()` returns `undefined` and
  every helper in `telemetry.mjs` just runs its callback.
- **How tracing gets turned on.** The runtime starts the tracer only when Netlify marks
  the request (an internal `x-nf-enable-otel` header). Netlify doesn't publicly document
  how a site opts in, and it may depend on the plan. Check the Observability section of the
  site in the Netlify UI, or ask Netlify support. Nothing in this repo switches it on, and
  no code change is needed once it's on.
- **Only v2 functions are traced.** That means the Astro SSR function (`ssr`: `/admin/*`,
  `/api/admin/*`, `/events/*`, `/sitemap.xml`) and `social-check`. `checkin.js` is a v1
  `exports.handler` function. zip-it-and-ship-it exports a v1 handler directly, with no
  bootstrap, so the runtime's OTel setup never runs for it (see `getEntryFileContents` in
  `@netlify/zip-it-and-ship-it` `dist/runtimes/node/utils/entry_file.js`). Its plain
  console lines still show up in the function log.

## The four signals

| Signal | What the app does | Where to see it |
| --- | --- | --- |
| Traces | `span(name, attrs, fn)`. One span per on-demand request, named `<METHOD> <route pattern>` (e.g. `GET /events/[date]`), from `src/middleware.ts`. Under it: `db.query` (every query on the admin, site and social pools), `db.transaction` (`withAudit`), `cdn.purge`, `storage.presign`, `social.check`, `ntfy.send`, plus the runtime's own fetch/http client spans. | Netlify Observability (traces), once tracing is on |
| Events | `event(name, attrs)` adds a span event. `withAudit` adds `audit` with the `action` and `target_table` when it commits. | On the span in the trace view |
| Metrics | Netlify takes no OTLP metrics, so measurements are numeric span attributes (`db.rows`, `http.response.status_code`) and per-request counters (`count()`). The middleware's `request` log line carries `status`, `duration_ms`, `db_queries` and `db_ms`. | Netlify Observability's built-in request and function charts. Per-request numbers are in the `request` log lines and span attributes |
| Logs | `log(level, msg, attrs)` writes one JSON line: `{"level","msg",...attrs,"trace_id","span_id"}`. The trace ids are there whenever a span is active, so a log line leads to its trace. | Logs → Functions (pick `ssr` or `social-check`), and Observability |

### Log levels

`log()` writes each level through the matching console method (`console.error`,
`console.warn`, `console.info`, `console.debug`). Netlify records that level, so you can
filter on it with the level filter in Logs → Functions or with
`netlify logs --level error`. `netlify logs --json` prints JSON Lines.

### Span attributes

- Request span: `http.request.method`, `http.route`, `http.response.status_code`, and
  `enduser.role` (role names such as `admin` or `social`) when signed in. Never the user
  id or email. A 5xx marks the span ERROR.
- `db.query`: `db.system=postgresql`, `db.operation` (the first SQL keyword), `db.rows`,
  and `bocc.db.pool` (`admin`, `site` or `social`). Never the statement text or the
  parameters.
- An exception records only its name and redacted message, never the stack. The status
  is ERROR and the error is rethrown unchanged.

## Privacy rules

Treat attributes as an allowlist. Route names, status codes, event dates, counts, ids and
role names are fine. Never pass SQL parameters, connection strings, the ntfy topic, storage
keys or URLs, attendee names or emails, or check-in payloads. As a backstop, every string
attribute and every log message goes through `redact()`, which strips postgres URLs,
`Bearer` tokens and `nfp_` tokens.

**Known gap once tracing is on.** The runtime's own fetch instrumentation (not ours)
records outgoing request URLs. Two of ours carry secrets in the URL:

- the ntfy push (`https://ntfy.sh/<topic>`; the topic is the secret)
- the server-side S3 HEAD/DELETE calls (presigned URLs with the access key id and a
  signature that expires after 60 s)

The runtime skips `authorization` and `x-*` headers, but not URL paths or query strings.
Before turning tracing on, consider posting to ntfy's JSON endpoint (the topic goes in the
body), or accept the exposure in the trace store.

## What isn't possible

- No OTLP metrics or logs ingest on Netlify. Custom metrics live in span attributes and
  log lines.
- Log drains (shipping function logs to Datadog, an OTLP collector, etc.) are an
  Enterprise feature.
- Our code can't enable tracing. Netlify decides per request.
- `checkin.js` (v1) gets no traces. To trace it, it would have to become a v2
  default-export function, a change to the live Tuesday check-in path.

## Local development and tests

There's no tracer locally, so spans are no-ops. Log lines are still JSON, and the
middleware prints one `request` line per on-demand request. `tests/admin/telemetry-unit.test.mjs`
covers the no-op path and a fake tracer installed on `globalThis.__netlify__getTracer`.
