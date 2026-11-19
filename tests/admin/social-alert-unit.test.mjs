// The Thursday social check (src/lib/social-alert/): the pure rules in alert.mjs, the
// ntfy call with an injected fetch, and runSocialCheck() with the database read
// replaced. No database here; the social_checker role and readWorkOrder() are in
// social-alert.test.mjs.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  alertSiteUrl, contextAllowed, easternToday, failureAlert, nextTuesday, NTFY_MESSAGE_MAX, NTFY_TITLE_MAX, ntfyBody, linkedinExpiryAlerts, readNtfyConfig, sendNtfy, socialAlert,
} from "../../src/lib/social-alert/alert.mjs";
import { runSocialCheck } from "../../src/lib/social-alert/run.mjs";
import { buildWorkOrder, CHANNEL_KEYS } from "../../src/lib/admin/social-rules.mjs";

const DATE = "2026-11-24";
const SITE = "https://716coffee.club";

/** A work order from the real buildWorkOrder(). */
function order({ date = DATE, exists = true, status = "ready", statuses = {}, eventStatus = "scheduled", luma = "https://luma.com/x", video = true, baseCaption = "Coffee Tuesday" } = {}) {
  const channels = Object.fromEntries(CHANNEL_KEYS.map((c) => [c, {
    caption: null, firstComment: null, status: statuses[c] ?? "scheduled", postUrl: null,
    verifiedAt: null, commentPostedAt: null, notes: null,
  }]));
  return buildWorkOrder({
    date,
    event: { status: eventStatus, exists: true },
    post: exists ? { videoMediaId: video ? "v" : null, coverNote: null, baseCaption, extraHashtags: [], publishAt: new Date("2026-11-23T12:00:00Z"), status, channels } : null,
    lumaUrl: luma,
    video: video ? { id: "v", kind: "promo_video", status: "ready" } : null,
  });
}

describe("nextTuesday / easternToday", () => {
  test("from a Thursday is five days on", () => assert.equal(nextTuesday("2026-11-19"), "2026-11-24"));
  test("from a Tuesday is the following week", () => assert.equal(nextTuesday("2026-11-24"), "2026-12-01"));
  test("from a Monday is the next day", () => assert.equal(nextTuesday("2026-11-23"), "2026-11-24"));
  test("crosses a year", () => assert.equal(nextTuesday("2026-12-31"), "2027-01-05"));
  test("rejects a bad date", () => assert.throws(() => nextTuesday("2026-02-30"), /YYYY-MM-DD/));
  test("14:00 UTC on a Thursday is Thursday in Eastern, winter and summer", () => {
    assert.equal(easternToday(new Date("2026-11-19T14:00:00Z")), "2026-11-19");
    assert.equal(easternToday(new Date("2027-06-17T14:00:00Z")), "2027-06-17");
    // just after midnight UTC is still the evening before in Eastern
    assert.equal(easternToday(new Date("2026-11-20T03:00:00Z")), "2026-11-19");
  });
});

describe("socialAlert", () => {
  test("everything scheduled or live: no alert", () => {
    assert.equal(socialAlert({ order: order({ statuses: { tiktok: "live" } }), date: DATE, siteUrl: SITE }), null);
  });

  test("a cancelled event: no alert, whatever its post says", () => {
    assert.equal(socialAlert({ order: order({ eventStatus: "cancelled", status: "todo" }), date: DATE, siteUrl: SITE }), null);
  });

  test("channels not yet scheduled are listed with their status", () => {
    const a = socialAlert({ order: order({ statuses: { facebook: "pending", tiktok: "failed" } }), date: DATE, siteUrl: SITE });
    assert.equal(a.title, "BOCC social: 2 of 5 channels not scheduled for Tue Nov 24");
    assert.match(a.message, /Event: Tuesday, November 24, 2026\./);
    assert.match(a.message, /Not scheduled yet:\n- Facebook: pending\n- TikTok: failed$/);
    assert.doesNotMatch(a.message, /Instagram/);
    assert.equal(a.priority, "high");
    assert.deepEqual(a.tags, ["warning"]);
    assert.equal(a.click, "https://716coffee.club/admin/social/next");
  });

  test("no post at all", () => {
    const a = socialAlert({ order: order({ exists: false }), date: DATE, siteUrl: SITE });
    assert.equal(a.title, "BOCC social: no post for Tue Nov 24");
    assert.match(a.message, /no social post yet.*\/admin\/events\/2026-11-24\//);
    for (const label of ["Facebook", "Instagram", "Threads", "TikTok", "LinkedIn page"]) assert.match(a.message, new RegExp(`- ${label}: no post`));
  });

  test("no events row is treated as a scheduled event with no post", () => {
    const a = socialAlert({ order: null, date: DATE, siteUrl: SITE });
    assert.equal(a.title, "BOCC social: no post for Tue Nov 24");
  });

  test("holiday break (Dec 22 to Jan 4): no events row, no alert", () => {
    for (const d of ["2026-12-22", "2026-12-29", "2028-01-04"]) assert.equal(socialAlert({ order: null, date: d, siteUrl: SITE }), null, d);
  });

  test("the weeks either side of the break still alert without a row", () => {
    assert.equal(socialAlert({ order: null, date: "2026-12-15", siteUrl: SITE }).title, "BOCC social: no post for Tue Dec 15");
    assert.equal(socialAlert({ order: null, date: "2027-01-05", siteUrl: SITE }).title, "BOCC social: no post for Tue Jan 5");
  });

  test("a scheduled row on a holiday date is the override: checked like any week", () => {
    const d = "2026-12-22";
    assert.equal(socialAlert({ order: order({ date: d, exists: false }), date: d, siteUrl: SITE }).title, "BOCC social: no post for Tue Dec 22");
    assert.equal(socialAlert({ order: order({ date: d, statuses: { tiktok: "pending" } }), date: d, siteUrl: SITE }).title,
      "BOCC social: 1 of 5 channels not scheduled for Tue Dec 22");
    assert.equal(socialAlert({ order: order({ date: d }), date: d, siteUrl: SITE }), null, "all scheduled");
    assert.equal(socialAlert({ order: order({ date: d, eventStatus: "cancelled" }), date: d, siteUrl: SITE }), null, "cancelled");
  });

  test("a post To do lists its problems and every pending channel", () => {
    const pending = Object.fromEntries(CHANNEL_KEYS.map((c) => [c, "pending"]));
    const a = socialAlert({ order: order({ status: "todo", video: false, luma: null, statuses: pending }), date: DATE, siteUrl: SITE });
    assert.equal(a.title, "BOCC social: Tue Nov 24 post not ready");
    assert.match(a.message, /isn't set to Ready for Posting \(it is To do\)/);
    assert.match(a.message, /- Upload the promo video\./);
    assert.match(a.message, /- Add the Luma listing/);
    assert.equal((a.message.match(/: pending/g) ?? []).length, 5);
  });

  test("a ready post that has since lost its Luma link is reported, even with every channel scheduled", () => {
    const a = socialAlert({ order: order({ luma: null }), date: DATE, siteUrl: SITE });
    assert.equal(a.title, "BOCC social: Tue Nov 24 post not ready");
    assert.match(a.message, /is Ready for Posting, but something changed since:\n- Add the Luma listing/);
    assert.doesNotMatch(a.message, /Not scheduled yet/);
  });

  test("Ready for Posting and Posted count as ready (ticket #39): no alert once every channel is scheduled or live", () => {
    assert.equal(socialAlert({ order: order({ status: "posted", statuses: { tiktok: "live" } }), date: DATE, siteUrl: SITE }), null);
    const a = socialAlert({ order: order({ status: "posted", statuses: { threads: "pending" } }), date: DATE, siteUrl: SITE });
    assert.equal(a.title, "BOCC social: 1 of 5 channels not scheduled for Tue Nov 24");
  });

  test("Error alerts like an offered post (as before #39): channels not scheduled, naming the failed one", () => {
    const a = socialAlert({ order: order({ status: "error", statuses: { tiktok: "failed" } }), date: DATE, siteUrl: SITE });
    assert.equal(a.title, "BOCC social: 1 of 5 channels not scheduled for Tue Nov 24");
    assert.match(a.message, /The post's status is Error: TikTok failed\. Fix it on \/admin\/events\/2026-11-24\/\./);
    assert.match(a.message, /Not scheduled yet:\n- TikTok: failed$/);
  });

  test("Error with problems is still not ready", () => {
    const a = socialAlert({ order: order({ status: "error", luma: null, statuses: { tiktok: "failed" } }), date: DATE, siteUrl: SITE });
    assert.equal(a.title, "BOCC social: Tue Nov 24 post not ready");
    assert.match(a.message, /- Add the Luma listing/);
  });

  test("the title is ASCII (it travels as an HTTP header)", () => {
    for (const o of [order({ exists: false }), order({ status: "todo" }), order({ status: "error", statuses: { tiktok: "failed" } }), order({ statuses: { threads: "pending" } })]) {
      assert.match(socialAlert({ order: o, date: DATE, siteUrl: SITE }).title, /^[\x20-\x7e]+$/);
    }
  });

  test("no usable site URL: no Click link", () => {
    assert.equal(socialAlert({ order: null, date: DATE, siteUrl: null }).click, null);
    assert.equal(socialAlert({ order: null, date: DATE, siteUrl: "http://716coffee.club" }).click, null);
  });

  test("failureAlert", () => {
    const a = failureAlert({ date: DATE, siteUrl: SITE });
    assert.equal(a.title, "BOCC social: the Thursday check failed (Tue Nov 24)");
    assert.equal(a.click, "https://716coffee.club/admin/social/next");
  });
});

describe("linkedinExpiryAlerts", () => {
  const now = new Date("2026-11-19T14:00:00Z");
  const at = (days) => new Date(now.getTime() + days * 86_400_000);

  test("no connection: no alert", () => {
    assert.deepEqual(linkedinExpiryAlerts({ connections: [], now, siteUrl: SITE }), []);
  });
  test("10 days or more left: no alert", () => {
    assert.deepEqual(linkedinExpiryAlerts({ connections: [{ name: "Zack Glick", expiresAt: at(10) }], now, siteUrl: SITE }), []);
  });
  test("under 10 days: names whose connection it is and sends them to /admin/account/", () => {
    const [a, ...rest] = linkedinExpiryAlerts({ connections: [{ name: "Zack Glick", expiresAt: at(3.2) }], now, siteUrl: SITE });
    assert.equal(rest.length, 0);
    assert.equal(a.title, "BOCC LinkedIn: Zack Glick's connection expires in 3 days");
    assert.match(a.message, /Zack Glick's LinkedIn connection expires on Sunday, November 22, 2026 \(in 3 days\)\./);
    assert.match(a.message, /Reconnect at \/admin\/account\/ before Tuesday's LinkedIn event has to be created\./);
    assert.equal(a.click, "https://716coffee.club/admin/account/");
    assert.equal(a.priority, "high");
    assert.deepEqual(a.tags, ["warning"]);
  });
  test("under a day left: \"in less than a day\"", () => {
    const [a] = linkedinExpiryAlerts({ connections: [{ name: "Zack Glick", expiresAt: at(0.5) }], now, siteUrl: SITE });
    assert.equal(a.title, "BOCC LinkedIn: Zack Glick's connection expires in less than a day");
  });
  test("one day left: singular", () => {
    const [a] = linkedinExpiryAlerts({ connections: [{ name: "Zack Glick", expiresAt: at(1.2) }], now, siteUrl: SITE });
    assert.equal(a.title, "BOCC LinkedIn: Zack Glick's connection expires in 1 day");
  });
  test("expired: says so", () => {
    const [a] = linkedinExpiryAlerts({ connections: [{ name: "Zack Glick", expiresAt: "2026-11-01T12:00:00Z" }], now, siteUrl: SITE });
    assert.equal(a.title, "BOCC LinkedIn: Zack Glick's connection has expired");
    assert.match(a.message, /expired on Sunday, November 1, 2026\./);
    assert.match(a.message, /Reconnect at \/admin\/account\//);
  });
  test("one alert per connection that is due, in the order given", () => {
    const alerts = linkedinExpiryAlerts({ connections: [
      { name: "Ann", expiresAt: at(2) }, { name: "Bob", expiresAt: at(40) }, { name: "Cy", expiresAt: at(-1) },
    ], now, siteUrl: SITE });
    assert.deepEqual(alerts.map((a) => a.title), [
      "BOCC LinkedIn: Ann's connection expires in 2 days", "BOCC LinkedIn: Cy's connection has expired",
    ]);
  });
  test("a missing name still reads; no site URL: no Click link", () => {
    const [a] = linkedinExpiryAlerts({ connections: [{ name: null, expiresAt: at(2) }], now, siteUrl: null });
    assert.equal(a.title, "BOCC LinkedIn: an Admin's connection expires in 2 days");
    assert.equal(a.click, null);
  });
});

describe("alertSiteUrl / contextAllowed", () => {
  const env = { URL: "https://716coffee.club", BETTER_AUTH_URL: "https://dev--bocc-backend.netlify.app" };
  test("production uses Netlify's site URL", () => {
    assert.equal(alertSiteUrl({ deployContext: "production", siteUrl: "https://716coffee.club/", env }), SITE);
    assert.equal(alertSiteUrl({ deployContext: "production", siteUrl: null, env }), SITE);
  });
  test("the branch deploy uses its own admin origin, not the production URL", () => {
    assert.equal(alertSiteUrl({ deployContext: "branch-deploy", siteUrl: "https://716coffee.club", env }), "https://dev--bocc-backend.netlify.app");
  });
  test("local dev may use http://localhost", () => {
    assert.equal(alertSiteUrl({ deployContext: "dev", siteUrl: null, env: { BETTER_AUTH_URL: "http://localhost:4321" } }), "http://localhost:4321");
  });
  test("nothing usable: null", () => {
    assert.equal(alertSiteUrl({ deployContext: "production", siteUrl: "not a url", env: {} }), null);
  });
  test("only deploy previews are refused", () => {
    assert.equal(contextAllowed("deploy-preview"), false);
    for (const c of ["production", "branch-deploy", "dev", null, undefined]) assert.equal(contextAllowed(c), true);
  });
});

describe("readNtfyConfig", () => {
  test("unset topic: null", () => {
    assert.equal(readNtfyConfig({}), null);
    assert.equal(readNtfyConfig({ SOCIAL_ALERT_NTFY_TOPIC: "  " }), null);
  });
  test("defaults to https://ntfy.sh", () => {
    assert.deepEqual(readNtfyConfig({ SOCIAL_ALERT_NTFY_TOPIC: "bocc-abc_123" }), { topic: "bocc-abc_123", server: "https://ntfy.sh" });
  });
  test("a custom server, trailing slash dropped", () => {
    assert.deepEqual(readNtfyConfig({ SOCIAL_ALERT_NTFY_TOPIC: "t", SOCIAL_ALERT_NTFY_SERVER: "https://ntfy.example.org/" }), { topic: "t", server: "https://ntfy.example.org" });
  });
  test("a bad topic or server is a problem that never quotes the value", () => {
    const bad = readNtfyConfig({ SOCIAL_ALERT_NTFY_TOPIC: "secret/../x" });
    assert.ok(bad.problem);
    assert.doesNotMatch(bad.problem, /secret/);
    assert.ok(readNtfyConfig({ SOCIAL_ALERT_NTFY_TOPIC: "t", SOCIAL_ALERT_NTFY_SERVER: "http://ntfy.sh" }).problem);
    assert.ok(readNtfyConfig({ SOCIAL_ALERT_NTFY_TOPIC: "t", SOCIAL_ALERT_NTFY_SERVER: "https://ntfy.sh/?x=1" }).problem);
  });
});

/** A fetch double that records its calls. */
function fakeFetch(respond = () => new Response("{}", { status: 200 })) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init }); return respond(url, init); };
  f.calls = calls;
  return f;
}

describe("sendNtfy", () => {
  const cfg = { topic: "bocc-secret-topic", server: "https://ntfy.sh" };
  const alert = { title: "BOCC social: x", message: "Line one\n- Facebook: pending", priority: "high", tags: ["warning"], click: "https://716coffee.club/admin/social/next" };

  test("POSTs JSON to the server root; the topic is only in the body", async () => {
    const f = fakeFetch();
    await sendNtfy(alert, cfg, { fetch: f });
    assert.equal(f.calls.length, 1);
    const { url, init } = f.calls[0];
    assert.equal(url, "https://ntfy.sh/");
    assert.equal(new URL(url).pathname, "/");
    assert.equal(new URL(url).search, "");
    assert.doesNotMatch(url, /bocc-secret-topic/);
    assert.equal(init.method, "POST");
    assert.deepEqual(init.headers, { "Content-Type": "application/json" });
    assert.doesNotMatch(JSON.stringify(init.headers), /bocc-secret-topic/);
    assert.deepEqual(JSON.parse(init.body), {
      topic: "bocc-secret-topic",
      title: "BOCC social: x",
      message: alert.message,
      priority: 4,
      tags: ["warning"],
      click: "https://716coffee.club/admin/social/next",
    });
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.redirect, "error");
  });

  test("a custom server with a path: POSTs to <server>/", async () => {
    const f = fakeFetch();
    await sendNtfy(alert, { topic: "bocc-secret-topic", server: "https://ntfy.example.org/push" }, { fetch: f });
    assert.equal(f.calls[0].url, "https://ntfy.example.org/push/");
  });

  test("no click field without a link", async () => {
    const f = fakeFetch();
    await sendNtfy({ ...alert, click: null }, cfg, { fetch: f });
    assert.equal("click" in JSON.parse(f.calls[0].init.body), false);
  });

  test("the title is one bounded line; the message is bounded", () => {
    const body = ntfyBody({ ...alert, title: `a\r\nb\u0000${"x".repeat(500)}`, message: "y".repeat(5000) }, "t");
    assert.ok(body.title.startsWith("a b "));
    assert.doesNotMatch(body.title, /[\x00-\x1f]/);
    assert.equal(body.title.length, NTFY_TITLE_MAX);
    assert.equal(body.message.length, NTFY_MESSAGE_MAX);
    assert.equal(ntfyBody({ ...alert, priority: "unknown" }, "t").priority, 3);
  });

  test("an HTTP error throws, without the topic", async () => {
    const f = fakeFetch(() => new Response("nope", { status: 429 }));
    await assert.rejects(sendNtfy(alert, cfg, { fetch: f }), (err) => {
      assert.match(err.message, /HTTP 429/);
      assert.doesNotMatch(err.message, /bocc-secret-topic/);
      return true;
    });
  });

  test("a network error throws, without the URL", async () => {
    const f = async () => { throw new TypeError("fetch failed for https://ntfy.sh/bocc-secret-topic"); };
    await assert.rejects(sendNtfy(alert, cfg, { fetch: f }), (err) => {
      assert.doesNotMatch(err.message, /bocc-secret-topic/);
      return true;
    });
  });

  test("times out", async () => {
    const f = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
    await assert.rejects(sendNtfy(alert, cfg, { fetch: f, timeoutMs: 20 }), /timed out after 20 ms/);
  });
});

describe("runSocialCheck (database read replaced)", () => {
  const THURSDAY = new Date("2026-11-19T14:00:00Z");
  const env = { SOCIAL_ALERT_NTFY_TOPIC: "bocc-secret-topic", URL: SITE, BETTER_AUTH_URL: "https://dev--bocc-backend.netlify.app" };
  const prod = { deploy: { context: "production" }, site: { url: SITE } };

  /** Capture console output for the duration of fn. */
  async function captureLogs(fn) {
    const lines = [];
    const { log, info, error } = console;
    console.log = console.info = console.error = (...a) => lines.push(a.join(" "));
    try { return { result: await fn(), lines }; } finally { Object.assign(console, { log, info, error }); }
  }
  /** runSocialCheck with no LinkedIn connections unless a test says otherwise. */
  const run = (opts) => runSocialCheck({ readConnections: async () => [], ...opts });

  test("checks next Tuesday and sends nothing when all is well", async () => {
    const f = fakeFetch();
    const seen = [];
    const { result, lines } = await captureLogs(() => run({
      env, context: prod, now: THURSDAY, fetch: f, readOrder: async (d) => { seen.push(d); return order(); },
    }));
    assert.deepEqual(seen, ["2026-11-24"]);
    assert.equal(result.outcome, "ok");
    assert.equal(f.calls.length, 0);
    assert.match(lines.join("\n"), /2026-11-24: every channel is scheduled or live; no alert/);
  });

  test("sends the alert, with the production Click link, and never logs the topic", async () => {
    const f = fakeFetch();
    const { result, lines } = await captureLogs(() => run({
      env, context: prod, now: THURSDAY, fetch: f, readOrder: async () => order({ statuses: { linkedin_page: "pending" } }),
    }));
    assert.equal(result.outcome, "sent");
    assert.equal(JSON.parse(f.calls[0].init.body).click, "https://716coffee.club/admin/social/next");
    assert.equal(f.calls[0].url, "https://ntfy.sh/");
    assert.match(lines.join("\n"), /alert sent \(BOCC social: 1 of 5 channels/);
    assert.doesNotMatch(lines.join("\n"), /bocc-secret-topic/);
  });

  test("on the branch deploy the Click link is the staging host", async () => {
    const f = fakeFetch();
    await captureLogs(() => run({
      env, context: { deploy: { context: "branch-deploy" }, site: { url: SITE } }, now: THURSDAY, fetch: f, readOrder: async () => null,
    }));
    assert.equal(JSON.parse(f.calls[0].init.body).click, "https://dev--bocc-backend.netlify.app/admin/social/next");
  });

  test("a holiday week: reads the row, finds none, sends nothing and logs why", async () => {
    for (const [thursday, tuesday] of [["2026-12-17T14:00:00Z", "2026-12-22"], ["2026-12-24T14:00:00Z", "2026-12-29"]]) {
      const f = fakeFetch();
      const seen = [];
      const { result, lines } = await captureLogs(() => run({
        env, context: prod, now: new Date(thursday), fetch: f, readOrder: async (d) => { seen.push(d); return null; },
      }));
      assert.deepEqual(seen, [tuesday]);
      assert.deepEqual(result, { outcome: "ok", date: tuesday, linkedin: { outcome: "ok", alerts: [] } });
      assert.equal(f.calls.length, 0);
      assert.match(lines.join("\n"), new RegExp(`${tuesday}: skipped as a holiday week \\(no meeting December 22 to January 4\\); no alert`));
      assert.match(lines.join("\n"), /"level":"info"/);
    }
  });

  test("a holiday week with a saved row (the override) alerts as usual", async () => {
    const f = fakeFetch();
    const { result } = await captureLogs(() => run({
      env, context: prod, now: new Date("2026-12-17T14:00:00Z"), fetch: f,
      readOrder: async (d) => order({ date: d, exists: false }),
    }));
    assert.equal(result.outcome, "sent");
    assert.equal(JSON.parse(f.calls[0].init.body).title, "BOCC social: no post for Tue Dec 22");
  });

  test("the first week after the break alerts without a row", async () => {
    const f = fakeFetch();
    const { result } = await captureLogs(() => run({
      env, context: prod, now: new Date("2026-12-31T14:00:00Z"), fetch: f, readOrder: async () => null,
    }));
    assert.equal(result.outcome, "sent");
    assert.equal(result.date, "2027-01-05");
  });

  test("topic unset: logs and stops before reading anything", async () => {
    let read = false;
    const { result, lines } = await captureLogs(() => run({
      env: { URL: SITE }, context: prod, now: THURSDAY, fetch: fakeFetch(), readOrder: async () => { read = true; return null; },
    }));
    assert.equal(result.outcome, "skipped");
    assert.equal(read, false);
    assert.match(lines.join("\n"), /SOCIAL_ALERT_NTFY_TOPIC is not set/);
  });

  test("a deploy preview is skipped", async () => {
    const f = fakeFetch();
    const { result } = await captureLogs(() => run({
      env, context: { deploy: { context: "deploy-preview" } }, now: THURSDAY, fetch: f, readOrder: async () => null,
    }));
    assert.equal(result.outcome, "skipped");
    assert.equal(f.calls.length, 0);
  });

  test("a database failure sends the failure alert and redacts connection strings", async () => {
    const f = fakeFetch();
    const { result, lines } = await captureLogs(() => run({
      env, context: prod, now: THURSDAY, fetch: f,
      readOrder: async () => { throw new Error("connect failed postgresql://social_checker:pw@host/neondb"); },
    }));
    assert.equal(result.outcome, "failed");
    assert.match(JSON.parse(f.calls[0].init.body).title, /the Thursday check failed/);
    assert.doesNotMatch(lines.join("\n"), /pw@host/);
  });

  test("an ntfy failure is logged, not thrown", async () => {
    const f = fakeFetch(() => new Response("", { status: 500 }));
    const { result, lines } = await captureLogs(() => run({
      env, context: prod, now: THURSDAY, fetch: f, readOrder: async () => null,
    }));
    assert.equal(result.outcome, "failed");
    assert.match(lines.join("\n"), /alert not sent .*HTTP 500/);
  });

  test("no database URL: the failure alert, naming the variable", async () => {
    const f = fakeFetch();
    const { result, lines } = await captureLogs(() => run({ env, context: prod, now: THURSDAY, fetch: f }));
    assert.equal(result.outcome, "failed");
    assert.match(lines.join("\n"), /SOCIAL_CHECK_DB_URL is not set/);
  });
});

describe("runSocialCheck: the LinkedIn connection expiry (#24)", () => {
  const THURSDAY = new Date("2026-11-19T14:00:00Z");
  const env = { SOCIAL_ALERT_NTFY_TOPIC: "bocc-secret-topic", URL: SITE };
  const prod = { deploy: { context: "production" }, site: { url: SITE } };
  const inDays = (d) => new Date(THURSDAY.getTime() + d * 86_400_000);
  const zack = (days) => ({ name: "Zack Glick", expiresAt: inDays(days) });

  async function captureLogs(fn) {
    const lines = [];
    const { log, info, error } = console;
    console.log = console.info = console.error = (...a) => lines.push(a.join(" "));
    try { return { result: await fn(), lines }; } finally { Object.assign(console, { log, info, error }); }
  }
  const run = (opts) => runSocialCheck({ env, context: prod, now: THURSDAY, readOrder: async () => order(), ...opts });

  test("no connection: quiet", async () => {
    const f = fakeFetch();
    const { result, lines } = await captureLogs(() => run({ fetch: f, readConnections: async () => [] }));
    assert.equal(result.outcome, "ok");
    assert.deepEqual(result.linkedin, { outcome: "ok", alerts: [] });
    assert.equal(f.calls.length, 0);
    assert.match(lines.join("\n"), /linkedin: no connection; no alert/);
  });

  test("10 days or more left: quiet", async () => {
    const f = fakeFetch();
    const { result, lines } = await captureLogs(() => run({ fetch: f, readConnections: async () => [zack(10)] }));
    assert.equal(result.outcome, "ok");
    assert.equal(f.calls.length, 0);
    assert.match(lines.join("\n"), /linkedin: 1 connection, none expiring within 10 days; no alert/);
  });

  test("under 10 days: alerts even when the social post is fine, and logs no name or topic", async () => {
    const f = fakeFetch();
    const { result, lines } = await captureLogs(() => run({ fetch: f, readConnections: async () => [zack(4)] }));
    assert.equal(result.outcome, "sent");
    assert.equal(result.linkedin.outcome, "sent");
    assert.equal(f.calls.length, 1);
    const body = JSON.parse(f.calls[0].init.body);
    assert.equal(body.title, "BOCC LinkedIn: Zack Glick's connection expires in 4 days");
    assert.equal(body.click, "https://716coffee.club/admin/account/");
    const logs = lines.join("\n");
    assert.match(logs, /linkedin: 1 expiry alert sent/);
    assert.doesNotMatch(logs, /bocc-secret-topic|Zack/);
  });

  test("expired, alongside a social alert: two pushes, social first", async () => {
    const f = fakeFetch();
    const { result } = await captureLogs(() => run({
      fetch: f, readOrder: async () => null, readConnections: async () => [zack(-2)],
    }));
    assert.equal(result.outcome, "sent");
    assert.deepEqual(f.calls.map((c) => JSON.parse(c.init.body).title),
      ["BOCC social: no post for Tue Nov 24", "BOCC LinkedIn: Zack Glick's connection has expired"]);
  });

  test("the LinkedIn read failing still runs the social check, then sends its own failure alert", async () => {
    const f = fakeFetch();
    const { result, lines } = await captureLogs(() => run({
      fetch: f, readConnections: async () => { throw new Error("permission denied for table linkedin_connections postgresql://social_checker:pw@host/db"); },
    }));
    assert.equal(result.outcome, "failed");
    assert.equal(result.linkedin.outcome, "failed");
    assert.equal(f.calls.length, 1);
    assert.match(JSON.parse(f.calls[0].init.body).title, /BOCC LinkedIn: the Thursday check couldn't read the connection/);
    assert.doesNotMatch(lines.join("\n"), /pw@host/);
  });

  test("the social read failing doesn't stop the LinkedIn check", async () => {
    const f = fakeFetch();
    const { result } = await captureLogs(() => run({
      fetch: f, readOrder: async () => { throw new Error("boom"); }, readConnections: async () => [zack(1)],
    }));
    assert.equal(result.outcome, "failed");
    assert.equal(result.linkedin.outcome, "sent");
    assert.deepEqual(f.calls.map((c) => JSON.parse(c.init.body).title.split(":")[0]), ["BOCC social", "BOCC LinkedIn"]);
  });

  test("an ntfy failure on the LinkedIn alert is logged, not thrown", async () => {
    const f = fakeFetch(() => new Response("", { status: 500 }));
    const { result, lines } = await captureLogs(() => run({ fetch: f, readConnections: async () => [zack(2)] }));
    assert.equal(result.outcome, "failed");
    assert.equal(result.linkedin.outcome, "failed");
    assert.match(lines.join("\n"), /linkedin: expiry alert not sent: ntfy publish answered HTTP 500/);
  });

  test("no database URL: one failure alert for the whole run, not two", async () => {
    const f = fakeFetch();
    const { result } = await captureLogs(() => runSocialCheck({ env, context: prod, now: THURSDAY, fetch: f }));
    assert.equal(result.outcome, "failed");
    assert.equal(result.linkedin.outcome, "failed");
    assert.equal(f.calls.length, 1);
    assert.match(JSON.parse(f.calls[0].init.body).title, /BOCC social: the Thursday check failed/);
  });
});
