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
| Traces | `span(name, attrs, fn)`. One span per on-demand request, named `<METHOD> <route pattern>` (e.g. `GET /events/[date]`), from `src/middleware.ts`. Under it: `db.query` (every query on the admin, site and social pools), `db.transaction` (`withAudit`), `cdn.purge`, `storage.presign` (browser URLs), `storage.sign` (server HEAD/DELETE), `social.check`, `ntfy.send`, plus the runtime's own fetch/http client spans. | Netlify Observability (traces), once tracing is on |
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

### What the runtime's fetch tracing records

The runtime's own fetch and http client instrumentation (not ours) records the **full URL**
of every outgoing request, path and query included, plus the method and status. It skips
headers matching `authorization|x-.*|via|alt-svc|server`. Request and response bodies are
not recorded. So no secret may sit in an outgoing URL; secrets go in a skipped header or
the body. What the server sends, and what its span shows:

| Request | URL recorded | Where the secret is |
| --- | --- | --- |
| ntfy push (`social-check`) | `https://ntfy.sh/` (the server root; `SOCIAL_ALERT_NTFY_SERVER` + `/` if set) | the topic is only in the JSON body ([publish as JSON](https://docs.ntfy.sh/publish/#publish-as-json)) |
| Storage HEAD (media complete) and DELETE (media removal) | `<STORAGE_ENDPOINT>/<bucket>/<key>`, no query | SigV4 header signing: `Authorization`, `x-amz-date`, `x-amz-content-sha256` (all skipped). The object key is in the URL; it is built from the event date and a random uuid, not from user input |
| Cache purge (`@netlify/cache` `purgeCache`) | `https://api.netlify.com/api/v1/purge` | the purge token is a `Bearer` `Authorization` header (skipped); tags and scope are in the body |

Postgres (Neon) is TCP, not HTTP, and shows up only as our `db.query` spans. Better Auth
makes no outgoing HTTP calls in this setup (no social providers or email flows, its
telemetry is off, passkeys verify locally). The browser-facing presigned URLs (upload
PUT, gallery and download GET) carry query-string credentials, but the server only
builds them and hands them to the browser; it never fetches them, so they never reach a
span. The operator scripts (`scripts/storage-cors.mjs`, `scripts/signin-photos/`) run on
a laptop, outside any traced function.

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
