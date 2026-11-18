// OpenTelemetry for the SSR function and the backend functions (docs/backend/OBSERVABILITY.md).
//
// Netlify ingests OTel TRACES only, and only when it has turned tracing on for the
// site: the function runtime then installs a tracer provider for the request
// (globalThis.__netlify__getTracer, read by @netlify/otel's getTracer) and exports the
// spans through the function log. Otherwise getTracer() is undefined and every helper
// here is a no-op that just runs the callback: locally, in tests, in astro dev, and on
// Netlify when tracing is off. v1 `exports.handler` functions (checkin.js) never get a
// tracer: the runtime's OTel bootstrap only wraps v2 (default-export) functions.
//
// The four MELT signals:
//   Traces   span(name, attrs, fn)       a child span of the active one, ERROR + rethrow on failure
//   Events   event(name, attrs)          a span event on the active span (no-op without one)
//   Metrics  Netlify has no OTLP metric ingest, so measurements are numeric span
//            attributes (db.rows, ...) plus per-request counters (count()) that the
//            request's summary log line carries (middleware: db_queries, db_ms,
//            duration_ms). Netlify Observability adds its own request/function charts.
//   Logs     log(level, msg, attrs)      one JSON line through the console method of that
//            level, with trace_id/span_id when a span is active, so the function log
//            lines and the trace line up
//
// Privacy: attributes are an allowlist by habit (route names, status codes, event
// dates, counts, ids, role names). Never pass SQL parameters, connection strings, the
// ntfy topic, storage keys or URLs, or attendee data. Every string that goes out is
// still passed through redact() as a backstop.
//
// None of these helpers throws on its own account or changes the callback's result.

import { AsyncLocalStorage } from "node:async_hooks";
import { getTracer } from "@netlify/otel";

const TRACER = "bocc";
const STATUS_ERROR = 2; // SpanStatusCode.ERROR
const MAX_STRING = 300;

/** Strip connection strings, bearer tokens and Netlify tokens from text. */
export const redact = (text) =>
  String(text)
    .replace(/postgres(ql)?:\/\/\S+/gi, "<redacted-url>")
    .replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
    .replace(/nfp_[A-Za-z0-9_-]+/g, "<redacted-token>");

/** "Name: message (code)" of an error, redacted. Never the stack. */
export function describeError(err) {
  const e = /** @type {any} */ (err);
  const detail = e && typeof e === "object" ? `${e.name ?? "Error"}: ${e.message ?? ""}${e.code ? ` (${e.code})` : ""}` : String(err);
  return redact(detail);
}

/** Keep primitive values only; redact and bound strings. */
function clean(attrs) {
  /** @type {Record<string, string|number|boolean>} */
  const out = {};
  if (!attrs || typeof attrs !== "object") return out;
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === "number") { if (Number.isFinite(v)) out[k] = v; }
    else if (typeof v === "boolean") out[k] = v;
    else if (typeof v === "string") out[k] = redact(v).slice(0, MAX_STRING);
  }
  return out;
}

/**
 * The per-request frame: the active span (null without tracing) and the counters
 * shared by every span under the outermost one.
 * @type {AsyncLocalStorage<{ span: any, metrics: Record<string, number> }>}
 */
const store = new AsyncLocalStorage();

/** @type {any} tests only: a tracer that replaces getTracer() */
let injectedTracer;
/** For tests: install (or with undefined, remove) a tracer. */
export function setTracerForTests(tracer) {
  injectedTracer = tracer;
}

function tracer() {
  if (injectedTracer) return injectedTracer;
  try {
    return getTracer(TRACER);
  } catch {
    return undefined;
  }
}

function safe(fn) {
  try {
    fn();
  } catch {
    /* telemetry never breaks the app */
  }
}

/** What span() hands its callback. Every method is safe to call, with or without tracing. */
function handle(span) {
  return {
    /** @param {Record<string, unknown>} attrs */
    setAttributes(attrs) {
      if (span) safe(() => span.setAttributes(clean(attrs)));
    },
    /** Mark the span failed without an exception (e.g. a 5xx, a swallowed failure). */
    setError(message) {
      if (span) safe(() => span.setStatus({ code: STATUS_ERROR, message: redact(message ?? "") }));
    },
  };
}

/** Record a failure on the span with the message redacted (never the stack). */
function onException(err, span) {
  safe(() => {
    const e = /** @type {any} */ (err);
    span.recordException({ name: String(e?.name ?? "Error"), message: describeError(err) });
    span.setStatus({ code: STATUS_ERROR, message: describeError(err) });
  });
}

/**
 * Run fn in a child span of the active one. Without a tracer it just runs fn (still
 * inside a frame, so count() and the request summary work). On a throw or rejection
 * the span gets the (redacted) exception and ERROR status, and the error is rethrown.
 *
 * @template T
 * @param {string} name   low cardinality: "db.query", "GET /events/[date]", ...
 * @param {Record<string, unknown> | ((h: ReturnType<typeof handle>) => T)} attrs
 * @param {(h: ReturnType<typeof handle>) => T} [fn]
 * @returns {T}
 */
export function span(name, attrs, fn) {
  if (typeof attrs === "function") {
    fn = attrs;
    attrs = {};
  }
  const run = /** @type {(h: ReturnType<typeof handle>) => T} */ (fn);
  const parent = store.getStore();
  const metrics = parent?.metrics ?? {};
  const t = tracer();
  if (!t) return store.run({ span: null, metrics }, () => run(handle(null)));

  let entered = false;
  try {
    return t.withActiveSpan(name, { attributes: clean(attrs), onException }, (s) => {
      entered = true;
      return store.run({ span: s, metrics }, () => run(handle(s)));
    });
  } catch (err) {
    if (entered) throw err; // fn's own error
    // The tracer itself failed before running fn: run it untraced.
    return store.run({ span: null, metrics }, () => run(handle(null)));
  }
}

/** Set attributes on the active span (no-op without one). */
export function setAttributes(attrs) {
  handle(store.getStore()?.span ?? null).setAttributes(attrs);
}

/** Mark the active span failed (no-op without one). */
export function setError(message) {
  handle(store.getStore()?.span ?? null).setError(message);
}

/** A span event on the active span, e.g. event("audit", { action }). No-op without one. */
export function event(name, attrs) {
  const s = store.getStore()?.span;
  if (s) safe(() => s.addEvent(String(name), clean(attrs)));
}

/** Add n to a per-request counter (no-op outside span()). */
export function count(name, n = 1) {
  const m = store.getStore()?.metrics;
  if (m && Number.isFinite(n)) m[name] = (m[name] ?? 0) + n;
}

/** The current request's counters (a copy). */
export function metrics() {
  return { ...(store.getStore()?.metrics ?? {}) };
}

/** { trace_id, span_id } of the active span, or {}. */
export function traceIds() {
  const s = store.getStore()?.span;
  if (!s) return {};
  try {
    const c = s.spanContext();
    return c?.traceId ? { trace_id: c.traceId, span_id: c.spanId } : {};
  } catch {
    return {};
  }
}

const CONSOLE = { error: "error", warn: "warn", info: "info", debug: "debug" };
const RESERVED = new Set(["level", "msg", "trace_id", "span_id"]);

/**
 * One JSON line to the function log through the console method of that level (Netlify
 * filters its log view and `netlify logs --level` on it):
 *   {"level":"error","msg":"[site] purge failed: ...","date":"2026-11-24","trace_id":"…","span_id":"…"}
 * msg and string attributes are redacted. Never throws.
 * @param {"error"|"warn"|"info"|"debug"} level
 * @param {string} msg
 * @param {Record<string, unknown>} [attrs]
 */
export function log(level, msg, attrs) {
  try {
    const lvl = CONSOLE[level] ? level : "info";
    const line = { level: lvl, msg: redact(msg) };
    for (const [k, v] of Object.entries(clean(attrs))) if (!RESERVED.has(k)) line[k] = v;
    Object.assign(line, traceIds());
    console[CONSOLE[lvl]](JSON.stringify(line));
  } catch {
    /* never */
  }
}

const OPERATION = /^\s*\(?\s*([a-z]+)/i;

/** "SELECT", "INSERT", "BEGIN", ... from a statement (or a pg QueryConfig). */
export function sqlOperation(textOrConfig) {
  const text = typeof textOrConfig === "string" ? textOrConfig : textOrConfig?.text;
  const m = typeof text === "string" ? OPERATION.exec(text) : null;
  return m ? m[1].toUpperCase() : "UNKNOWN";
}

const PATCHED = Symbol.for("bocc.telemetry.pg");

/**
 * Trace one pg query call: span "db.query" (db.system, db.operation, db.rows, the pool
 * label), and the request counters db_queries / db_ms. Never the statement text or the
 * parameters. Callback and Submittable (cursor/stream) calls pass straight through.
 */
function tracedQuery(original, self, label, args) {
  const [first, second, third] = args;
  if (typeof second === "function" || typeof third === "function" || typeof first?.submit === "function") {
    return original.apply(self, args);
  }
  const started = performance.now();
  return span("db.query", { "db.system": "postgresql", "db.operation": sqlOperation(first), "bocc.db.pool": label }, async (h) => {
    try {
      const res = await original.apply(self, args);
      h.setAttributes({ "db.rows": typeof res?.rowCount === "number" ? res.rowCount : undefined });
      return res;
    } finally {
      count("db_queries");
      count("db_ms", Math.round(performance.now() - started));
    }
  });
}

function patchQuery(target, label) {
  if (!target || target[PATCHED]) return target;
  const original = target.query;
  if (typeof original !== "function") return target;
  target.query = function query(...args) {
    return tracedQuery(original, this, label, args);
  };
  target[PATCHED] = true;
  return target;
}

/**
 * Instrument a pg.Pool (pool.query and every client it hands out) or a pg.Client, in
 * place. Idempotent. Returns its argument.
 * @template T
 * @param {T} poolOrClient
 * @param {string} label  "admin" | "site" | "social": which credential, not a secret
 * @returns {T}
 */
export function instrumentPg(poolOrClient, label) {
  try {
    const p = /** @type {any} */ (poolOrClient);
    patchQuery(p, label);
    // A Pool: its clients are created lazily and reused; patch each one once.
    if (typeof p?.connect === "function" && typeof p?.on === "function" && "totalCount" in p) {
      p.on("connect", (client) => patchQuery(client, label));
    }
  } catch {
    /* leave it uninstrumented */
  }
  return poolOrClient;
}
