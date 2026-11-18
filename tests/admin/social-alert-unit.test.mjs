// The Thursday social check (src/lib/social-alert/): the pure rules in alert.mjs, the
// ntfy call with an injected fetch, and runSocialCheck() with the database read
// replaced. No database here; the social_checker role and readWorkOrder() are in
// social-alert.test.mjs.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  alertSiteUrl, contextAllowed, easternToday, failureAlert, nextTuesday, readNtfyConfig, sendNtfy, socialAlert,
} from "../../src/lib/social-alert/alert.mjs";
import { runSocialCheck } from "../../src/lib/social-alert/run.mjs";
import { buildWorkOrder, CHANNEL_KEYS } from "../../src/lib/admin/social-rules.mjs";

const DATE = "2026-11-24";
const SITE = "https://716coffee.club";

/** A work order from the real buildWorkOrder(). */
function order({ exists = true, ready = true, statuses = {}, eventStatus = "scheduled", luma = "https://luma.com/x", video = true, baseCaption = "Coffee Tuesday" } = {}) {
  const channels = Object.fromEntries(CHANNEL_KEYS.map((c) => [c, {
    caption: null, firstComment: null, status: statuses[c] ?? "scheduled", postUrl: null,
    verifiedAt: null, commentPostedAt: null, notes: null,
  }]));
  return buildWorkOrder({
    date: DATE,
    event: { status: eventStatus, exists: true },
    post: exists ? { videoMediaId: video ? "v" : null, coverNote: null, baseCaption, extraHashtags: [], publishAt: new Date("2026-11-23T12:00:00Z"), ready, channels } : null,
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
    assert.equal(socialAlert({ order: order({ eventStatus: "cancelled", ready: false }), date: DATE, siteUrl: SITE }), null);
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

  test("a post not marked ready lists its problems and every pending channel", () => {
    const pending = Object.fromEntries(CHANNEL_KEYS.map((c) => [c, "pending"]));
    const a = socialAlert({ order: order({ ready: false, video: false, luma: null, statuses: pending }), date: DATE, siteUrl: SITE });
    assert.equal(a.title, "BOCC social: Tue Nov 24 post not ready");
    assert.match(a.message, /isn't marked ready/);
    assert.match(a.message, /- Upload the promo video\./);
    assert.match(a.message, /- Add the Luma listing/);
    assert.equal((a.message.match(/: pending/g) ?? []).length, 5);
  });

  test("a ready post that has since lost its Luma link is reported, even with every channel scheduled", () => {
    const a = socialAlert({ order: order({ luma: null }), date: DATE, siteUrl: SITE });
    assert.equal(a.title, "BOCC social: Tue Nov 24 post not ready");
    assert.match(a.message, /marked ready, but something changed since:\n- Add the Luma listing/);
    assert.doesNotMatch(a.message, /Not scheduled yet/);
  });

  test("the title is ASCII (it travels as an HTTP header)", () => {
    for (const o of [order({ exists: false }), order({ ready: false }), order({ statuses: { threads: "pending" } })]) {
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

  test("POSTs the message to <server>/<topic> with the ntfy headers", async () => {
    const f = fakeFetch();
    await sendNtfy(alert, cfg, { fetch: f });
    assert.equal(f.calls.length, 1);
    const { url, init } = f.calls[0];
    assert.equal(url, "https://ntfy.sh/bocc-secret-topic");
    assert.equal(init.method, "POST");
    assert.equal(init.body, alert.message);
    assert.equal(init.headers.Title, "BOCC social: x");
    assert.equal(init.headers.Priority, "high");
    assert.equal(init.headers.Tags, "warning");
    assert.equal(init.headers.Click, "https://716coffee.club/admin/social/next");
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.redirect, "error");
  });

  test("no Click header without a link", async () => {
    const f = fakeFetch();
    await sendNtfy({ ...alert, click: null }, cfg, { fetch: f });
    assert.equal("Click" in f.calls[0].init.headers, false);
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
    const { log, error } = console;
    console.log = (...a) => lines.push(a.join(" "));
    console.error = (...a) => lines.push(a.join(" "));
    try { return { result: await fn(), lines }; } finally { console.log = log; console.error = error; }
  }

  test("checks next Tuesday and sends nothing when all is well", async () => {
    const f = fakeFetch();
    const seen = [];
    const { result, lines } = await captureLogs(() => runSocialCheck({
      env, context: prod, now: THURSDAY, fetch: f, readOrder: async (d) => { seen.push(d); return order(); },
    }));
    assert.deepEqual(seen, ["2026-11-24"]);
    assert.equal(result.outcome, "ok");
    assert.equal(f.calls.length, 0);
    assert.match(lines.join("\n"), /2026-11-24: every channel is scheduled or live; no alert/);
  });

  test("sends the alert, with the production Click link, and never logs the topic", async () => {
    const f = fakeFetch();
    const { result, lines } = await captureLogs(() => runSocialCheck({
      env, context: prod, now: THURSDAY, fetch: f, readOrder: async () => order({ statuses: { linkedin_page: "pending" } }),
    }));
    assert.equal(result.outcome, "sent");
    assert.equal(f.calls[0].init.headers.Click, "https://716coffee.club/admin/social/next");
    assert.match(lines.join("\n"), /alert sent \(BOCC social: 1 of 5 channels/);
    assert.doesNotMatch(lines.join("\n"), /bocc-secret-topic/);
  });

  test("on the branch deploy the Click link is the staging host", async () => {
    const f = fakeFetch();
    await captureLogs(() => runSocialCheck({
      env, context: { deploy: { context: "branch-deploy" }, site: { url: SITE } }, now: THURSDAY, fetch: f, readOrder: async () => null,
    }));
    assert.equal(f.calls[0].init.headers.Click, "https://dev--bocc-backend.netlify.app/admin/social/next");
  });

  test("topic unset: logs and stops before reading anything", async () => {
    let read = false;
    const { result, lines } = await captureLogs(() => runSocialCheck({
      env: { URL: SITE }, context: prod, now: THURSDAY, fetch: fakeFetch(), readOrder: async () => { read = true; return null; },
    }));
    assert.equal(result.outcome, "skipped");
    assert.equal(read, false);
    assert.match(lines.join("\n"), /SOCIAL_ALERT_NTFY_TOPIC is not set/);
  });

  test("a deploy preview is skipped", async () => {
    const f = fakeFetch();
    const { result } = await captureLogs(() => runSocialCheck({
      env, context: { deploy: { context: "deploy-preview" } }, now: THURSDAY, fetch: f, readOrder: async () => null,
    }));
    assert.equal(result.outcome, "skipped");
    assert.equal(f.calls.length, 0);
  });

  test("a database failure sends the failure alert and redacts connection strings", async () => {
    const f = fakeFetch();
    const { result, lines } = await captureLogs(() => runSocialCheck({
      env, context: prod, now: THURSDAY, fetch: f,
      readOrder: async () => { throw new Error("connect failed postgresql://social_checker:pw@host/neondb"); },
    }));
    assert.equal(result.outcome, "failed");
    assert.match(f.calls[0].init.headers.Title, /the Thursday check failed/);
    assert.doesNotMatch(lines.join("\n"), /pw@host/);
  });

  test("an ntfy failure is logged, not thrown", async () => {
    const f = fakeFetch(() => new Response("", { status: 500 }));
    const { result, lines } = await captureLogs(() => runSocialCheck({
      env, context: prod, now: THURSDAY, fetch: f, readOrder: async () => null,
    }));
    assert.equal(result.outcome, "failed");
    assert.match(lines.join("\n"), /alert not sent .*HTTP 500/);
  });

  test("no database URL: the failure alert, naming the variable", async () => {
    const f = fakeFetch();
    const { result, lines } = await captureLogs(() => runSocialCheck({ env, context: prod, now: THURSDAY, fetch: f }));
    assert.equal(result.outcome, "failed");
    assert.match(lines.join("\n"), /SOCIAL_CHECK_DB_URL is not set/);
  });
});
