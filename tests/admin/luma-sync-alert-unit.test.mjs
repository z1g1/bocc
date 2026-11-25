// The Luma sync Error push (spec #70, ticket #74): src/lib/admin/luma-sync-alert.mjs with
// an injected fetch, like social-alert-unit.test.mjs. No database. That handleLumaSyncPost
// pushes once on Error, never on Done, and still saves the Error when the push fails is in
// luma-sync.test.mjs (it needs the database).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lumaSyncErrorAlert, pushLumaSyncError } from "../../src/lib/admin/luma-sync-alert.mjs";

const DATE = "2026-12-01";
const SITE = "https://716coffee.club";
const env = { SOCIAL_ALERT_NTFY_TOPIC: "bocc-secret-topic", BETTER_AUTH_URL: SITE };
const result = { date: DATE, note: "jo@example.com: Luma said the email is invalid", people: 3, before: null };

/** A fetch double that records its calls. */
function fakeFetch(respond = () => new Response("{}", { status: 200 })) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init }); return respond(url, init); };
  f.calls = calls;
  return f;
}

async function captureLogs(fn) {
  const lines = [];
  const { log, info, error, warn } = console;
  console.log = console.info = console.error = console.warn = (...a) => lines.push(a.join(" "));
  try { return { result: await fn(), lines }; } finally { Object.assign(console, { log, info, error, warn }); }
}

describe("lumaSyncErrorAlert", () => {
  test("title names the Event date, body carries the note, Click opens the Admin event page", () => {
    const a = lumaSyncErrorAlert({ ...result, siteUrl: SITE });
    assert.equal(a.title, "BOCC Luma sync: Error for Tue Dec 1");
    assert.ok(a.message.startsWith(result.note), "the note comes first");
    assert.match(a.message, /Event: Tuesday, December 1, 2026\./);
    assert.match(a.message, /3 people are still to add to Luma\./);
    assert.match(a.message, /\/admin\/events\/2026-12-01\//);
    assert.equal(a.click, "https://716coffee.club/admin/events/2026-12-01/");
    assert.equal(a.priority, "high");
    assert.deepEqual(a.tags, ["warning"]);
  });

  test("one person; no site URL means no Click link", () => {
    const a = lumaSyncErrorAlert({ date: DATE, note: "x", people: 1 });
    assert.match(a.message, /1 person is still to add/);
    assert.equal(a.click, null);
  });
});

describe("pushLumaSyncError", () => {
  test("sends exactly one push to the server root, the topic only in the body", async () => {
    const f = fakeFetch();
    const { result: r, lines } = await captureLogs(() => pushLumaSyncError(result, { env, fetch: f }));
    assert.equal(r.outcome, "sent");
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, "https://ntfy.sh/");
    const body = JSON.parse(f.calls[0].init.body);
    assert.equal(body.topic, "bocc-secret-topic");
    assert.equal(body.title, "BOCC Luma sync: Error for Tue Dec 1");
    assert.ok(body.message.startsWith(result.note));
    assert.equal(body.click, "https://716coffee.club/admin/events/2026-12-01/");
    assert.equal(body.priority, 4);
    for (const l of lines) {
      assert.doesNotMatch(l, /bocc-secret-topic/);
      assert.doesNotMatch(l, /jo@example\.com/, "the note is never logged");
    }
  });

  test("SOCIAL_ALERT_NTFY_SERVER is honoured", async () => {
    const f = fakeFetch();
    await captureLogs(() => pushLumaSyncError(result, { env: { ...env, SOCIAL_ALERT_NTFY_SERVER: "https://ntfy.example.org" }, fetch: f }));
    assert.equal(f.calls[0].url, "https://ntfy.example.org/");
  });

  test("no topic configured: nothing sent, nothing thrown", async () => {
    const f = fakeFetch();
    const { result: r } = await captureLogs(() => pushLumaSyncError(result, { env: { BETTER_AUTH_URL: SITE }, fetch: f }));
    assert.equal(r.outcome, "skipped");
    assert.equal(f.calls.length, 0);
  });

  test("an invalid topic is logged and skipped", async () => {
    const f = fakeFetch();
    const { result: r, lines } = await captureLogs(() => pushLumaSyncError(result, { env: { SOCIAL_ALERT_NTFY_TOPIC: "bad topic!" }, fetch: f }));
    assert.equal(r.outcome, "skipped");
    assert.equal(f.calls.length, 0);
    assert.ok(lines.some((l) => /isn't a valid ntfy topic/.test(l)));
  });

  test("deploy previews never push", async () => {
    const f = fakeFetch();
    const { result: r } = await captureLogs(() => pushLumaSyncError(result, { env: { ...env, CONTEXT: "deploy-preview" }, fetch: f }));
    assert.equal(r.outcome, "skipped");
    assert.equal(f.calls.length, 0);
  });

  test("an HTTP error is logged, never thrown", async () => {
    const f = fakeFetch(() => new Response("nope", { status: 500 }));
    const { result: r, lines } = await captureLogs(() => pushLumaSyncError(result, { env, fetch: f }));
    assert.equal(r.outcome, "failed");
    assert.ok(lines.some((l) => /"level":"error"/.test(l) && /HTTP 500/.test(l)));
  });

  test("a network failure is logged without the topic, never thrown", async () => {
    const f = async () => { throw new TypeError("fetch failed for https://ntfy.sh/bocc-secret-topic"); };
    const { result: r, lines } = await captureLogs(() => pushLumaSyncError(result, { env, fetch: f }));
    assert.equal(r.outcome, "failed");
    assert.ok(lines.some((l) => /Error push failed/.test(l)));
    for (const l of lines) assert.doesNotMatch(l, /bocc-secret-topic/);
  });

  test("a timeout is logged, never thrown", async () => {
    const f = (_url, init) => new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
    });
    const { result: r, lines } = await captureLogs(() => pushLumaSyncError(result, { env, fetch: f, timeoutMs: 20 }));
    assert.equal(r.outcome, "failed");
    assert.ok(lines.some((l) => /timed out after 20 ms/.test(l)));
  });
});
