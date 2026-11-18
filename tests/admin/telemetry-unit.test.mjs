// src/lib/telemetry.mjs: no-op without a tracer; with a fake one (shaped like the
// SugaredTracer the Netlify runtime installs on globalThis.__netlify__getTracer) spans
// end, failures get ERROR and rethrow, events land, logs are JSON with trace ids and
// redacted. No database.
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  count, event, instrumentPg, log, metrics, redact, setTracerForTests, span, sqlOperation, traceIds,
} from "../../src/lib/telemetry.mjs";

/** A fake SugaredTracer: withActiveSpan(name, opts, fn) with Netlify's semantics. */
function fakeTracer() {
  const spans = [];
  let n = 0;
  return {
    spans,
    withActiveSpan(name, opts, fn) {
      const id = (++n).toString(16).padStart(16, "0");
      const s = {
        name, attributes: { ...opts.attributes }, events: [], exceptions: [], status: null, ended: false,
        setAttributes(a) { Object.assign(this.attributes, a); },
        addEvent(name, attributes) { this.events.push({ name, attributes }); },
        recordException(e) { this.exceptions.push(e); },
        setStatus(st) { this.status = st; },
        end() { this.ended = true; },
        spanContext: () => ({ traceId: "a".repeat(32), spanId: id }),
      };
      spans.push(s);
      const fail = (err) => { (opts.onException ?? ((e, sp) => sp.recordException(e)))(err, s); s.end(); throw err; };
      try {
        const r = fn(s);
        return typeof r?.then === "function" ? r.then((v) => { s.end(); return v; }, fail) : (s.end(), r);
      } catch (err) {
        return fail(err);
      }
    },
  };
}

/** Capture every console level for the duration of fn. */
async function capture(fn) {
  const lines = [];
  const saved = { ...console };
  for (const k of ["log", "info", "warn", "error", "debug"]) console[k] = (...a) => lines.push({ k, text: a.join(" ") });
  try { await fn(); } finally { Object.assign(console, { log: saved.log, info: saved.info, warn: saved.warn, error: saved.error, debug: saved.debug }); }
  return lines;
}

afterEach(() => {
  setTracerForTests(undefined);
  delete globalThis.__netlify__getTracer;
});

describe("without a tracer (local, tests, tracing off)", () => {
  test("span runs fn and returns its result unchanged, sync and async", async () => {
    const obj = { a: 1 };
    assert.equal(span("x", {}, () => obj), obj);
    assert.equal(await span("x", async () => 42), 42);
    assert.deepEqual(traceIds(), {});
  });

  test("errors pass through untouched", async () => {
    const err = new Error("boom");
    assert.throws(() => span("x", () => { throw err; }), (e) => e === err);
    await assert.rejects(span("x", async () => { throw err; }), (e) => e === err);
  });

  test("event and the handle are no-ops; counters still work inside a span", async () => {
    await span("req", async (h) => {
      h.setAttributes({ a: 1 });
      h.setError("x");
      event("audit", { action: "x" });
      count("db_queries");
      await span("child", async () => count("db_queries", 2));
      assert.deepEqual(metrics(), { db_queries: 3 });
    });
    assert.deepEqual(metrics(), {}, "outside any span: nothing");
  });

  test("log lines have no trace ids", async () => {
    const lines = await capture(() => log("info", "hello", { n: 1 }));
    assert.deepEqual(JSON.parse(lines[0].text), { level: "info", msg: "hello", n: 1 });
  });
});

describe("with a tracer", () => {
  test("found through globalThis.__netlify__getTracer (what the Netlify runtime installs)", () => {
    const t = fakeTracer();
    globalThis.__netlify__getTracer = (name) => (name === "bocc" ? t : undefined);
    assert.equal(span("GET /events/[date]", { "http.route": "/events/[date]" }, () => "ok"), "ok");
    assert.equal(t.spans.length, 1);
    assert.equal(t.spans[0].name, "GET /events/[date]");
    assert.equal(t.spans[0].attributes["http.route"], "/events/[date]");
    assert.equal(t.spans[0].ended, true);
  });

  test("a rejection sets ERROR with a redacted exception, and is rethrown as is", async () => {
    const t = fakeTracer();
    setTracerForTests(t);
    const err = new Error("connect postgresql://admin_app:hunter2@ep.example/neondb failed");
    await assert.rejects(span("db.query", async () => { throw err; }), (e) => e === err);
    const [s] = t.spans;
    assert.equal(s.ended, true);
    assert.equal(s.status.code, 2);
    assert.equal(s.exceptions.length, 1);
    assert.doesNotMatch(JSON.stringify(s.exceptions) + s.status.message, /hunter2/);
  });

  test("a synchronous throw is rethrown too", () => {
    const t = fakeTracer();
    setTracerForTests(t);
    assert.throws(() => span("x", () => { throw new TypeError("bad"); }), TypeError);
    assert.equal(t.spans[0].status.code, 2);
  });

  test("events and attributes land on the active span, cleaned", async () => {
    const t = fakeTracer();
    setTracerForTests(t);
    await span("outer", async (h) => {
      await span("inner", async () => event("audit", { action: "attendee.update", obj: { no: 1 }, u: undefined }));
      h.setAttributes({ "http.response.status_code": 200, junk: null, url: "postgres://x:y@h/d" });
    });
    const [outer, inner] = t.spans;
    assert.deepEqual(inner.events, [{ name: "audit", attributes: { action: "attendee.update" } }]);
    assert.equal(outer.attributes["http.response.status_code"], 200);
    assert.equal("junk" in outer.attributes, false);
    assert.equal(outer.attributes.url, "<redacted-url>");
  });

  test("log JSON carries the active span's trace and span ids, level picks the console method", async () => {
    const t = fakeTracer();
    setTracerForTests(t);
    const lines = await capture(() => span("x", () => {
      log("error", "bad", { status: 500, level: "spoofed" });
      log("warn", "w");
      log("info", "i");
      log("debug", "d");
    }));
    assert.deepEqual(lines.map((l) => l.k), ["error", "warn", "info", "debug"]);
    const first = JSON.parse(lines[0].text);
    assert.deepEqual(first, { level: "error", msg: "bad", status: 500, trace_id: "a".repeat(32), span_id: t.spans[0].spanContext().spanId });
  });

  test("a tracer that throws before running fn: fn still runs once, untraced", () => {
    setTracerForTests({ withActiveSpan() { throw new Error("tracer broken"); } });
    let calls = 0;
    assert.equal(span("x", () => { calls++; return 7; }), 7);
    assert.equal(calls, 1);
  });
});

describe("redaction and logs", () => {
  test("redact strips connection strings, bearer tokens and nfp_ tokens", () => {
    assert.equal(
      redact("a postgresql://u:pw@h/db b Bearer abc.def c nfp_Tok-en_1"),
      "a <redacted-url> b Bearer <redacted> c <redacted-token>",
    );
  });

  test("log redacts the message and string attributes and never throws", async () => {
    const lines = await capture(() => {
      log("error", "x postgres://u:pw@h/db", { error: "Bearer secret" });
      const cyclic = {}; cyclic.self = cyclic;
      log("info", "fine", cyclic); // objects are dropped, not serialized
    });
    const text = lines.map((l) => l.text).join("\n");
    assert.doesNotMatch(text, /pw@h|secret/);
    assert.equal(lines.length, 2);
  });
});

describe("instrumentPg", () => {
  test("sqlOperation reads the first keyword, not the statement", () => {
    assert.equal(sqlOperation("  select 1"), "SELECT");
    assert.equal(sqlOperation({ text: "insert into x values ($1)" }), "INSERT");
    assert.equal(sqlOperation("(select 1)"), "SELECT");
    assert.equal(sqlOperation(undefined), "UNKNOWN");
  });

  test("traces promise-form queries without text or params, counts them; results identical", async () => {
    const t = fakeTracer();
    setTracerForTests(t);
    const res = { rowCount: 3, rows: [1, 2, 3] };
    const client = { query: async (text, params) => (params?.[0] === "fail" ? Promise.reject(new Error("no")) : res) };
    instrumentPg(client, "site");
    instrumentPg(client, "site"); // idempotent
    let m;
    await span("req", async () => {
      assert.equal(await client.query("select * from t where a = $1", ["secret-param"]), res);
      await assert.rejects(client.query("select 1", ["fail"]), /no/);
      m = metrics();
    });
    const q = t.spans.filter((s) => s.name === "db.query");
    assert.equal(q.length, 2);
    assert.deepEqual(q[0].attributes, { "db.system": "postgresql", "db.operation": "SELECT", "bocc.db.pool": "site", "db.rows": 3 });
    assert.equal(q[1].status.code, 2);
    assert.doesNotMatch(JSON.stringify(t.spans), /secret-param|where a/);
    assert.equal(m.db_queries, 2);
  });

  test("callback-form calls (pg.Pool's own internal use) pass straight through", () => {
    const t = fakeTracer();
    setTracerForTests(t);
    let got;
    const client = { query: (text, values, cb) => { cb(null, { rowCount: 1 }); return "orig"; } };
    instrumentPg(client, "admin");
    assert.equal(client.query("select 1", [], (e, r) => { got = r; }), "orig");
    assert.equal(got.rowCount, 1);
    assert.equal(t.spans.length, 0);
  });

  test("a Pool's clients are patched on connect", async () => {
    const listeners = {};
    const pool = { totalCount: 0, query: async () => ({ rowCount: 0 }), connect() {}, on(ev, fn) { listeners[ev] = fn; } };
    instrumentPg(pool, "admin");
    const client = { query: async () => ({ rowCount: 1 }) };
    listeners.connect(client);
    const t = fakeTracer();
    setTracerForTests(t);
    await client.query("update x set y = 1");
    assert.equal(t.spans[0].attributes["db.operation"], "UPDATE");
  });
});
