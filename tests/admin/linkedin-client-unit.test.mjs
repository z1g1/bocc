// The LinkedIn client adapter (src/lib/linkedin/client.mjs, issue #23) against a fake
// fetch: which host and URL each operation calls, that the bearer token only goes to
// LinkedIn over https, that redirects are never followed, that secrets stay out of
// URLs, span attributes and error messages, and the 19-digit ids. No network, no DB.
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { authorizationUrl, createLinkedInClient, LinkedInError } from "../../src/lib/linkedin/client.mjs";
import { setTracerForTests } from "../../src/lib/telemetry.mjs";

const TOKEN = "AQV-secret-access-token-xyz";
const SECRET = "WPL_AP1.client-secret";
const CODE = "AQT-one-time-auth-code";

/** A fake fetch: replies from a queue (Response or Error), records every call. */
function fakeFetch(...replies) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init, headers: new Headers(init.headers) });
    const next = replies.shift();
    if (!next) throw new Error("fakeFetch: no reply queued");
    if (next instanceof Error) throw next;
    return next;
  };
  fn.calls = calls;
  return fn;
}
const json = (status, body, headers = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A minimal SugaredTracer that keeps every span's attributes, events and exceptions. */
function recordingTracer() {
  const spans = [];
  return {
    spans,
    withActiveSpan(name, opts, fn) {
      const s = {
        name, attributes: { ...opts.attributes }, events: [], exceptions: [], status: null,
        setAttributes(a) { Object.assign(this.attributes, a); },
        addEvent(n, a) { this.events.push({ n, a }); },
        recordException(e) { this.exceptions.push(e); },
        setStatus(st) { this.status = st; },
        end() {},
        spanContext: () => ({ traceId: "a".repeat(32), spanId: "b".repeat(16) }),
      };
      spans.push(s);
      return Promise.resolve(fn(s)).catch((err) => { opts.onException?.(err, s); throw err; });
    },
  };
}

const client = (fetch) => createLinkedInClient({ clientId: "cid", clientSecret: SECRET }, { fetch });

afterEach(() => setTracerForTests(undefined));

describe("authorizationUrl", () => {
  it("sends the browser to LinkedIn's authorize page with the five scopes, %20-separated", () => {
    const u = new URL(authorizationUrl({ clientId: "cid", redirectUri: "https://716coffee.club/api/admin/linkedin/callback", state: "st8" }));
    assert.equal(u.origin + u.pathname, "https://www.linkedin.com/oauth/v2/authorization");
    assert.equal(u.searchParams.get("response_type"), "code");
    assert.equal(u.searchParams.get("client_id"), "cid");
    assert.equal(u.searchParams.get("redirect_uri"), "https://716coffee.club/api/admin/linkedin/callback");
    assert.equal(u.searchParams.get("state"), "st8");
    assert.equal(u.searchParams.get("scope"), "r_events rw_events openid profile w_member_social");
    assert.match(u.search, /scope=r_events%20rw_events/);
  });
});

describe("exchangeCode", () => {
  it("POSTs the code and secret in the form body, never the URL, and returns the token", async () => {
    const fetch = fakeFetch(json(200, { access_token: TOKEN, expires_in: 5183999, scope: "openid,profile" }));
    const r = await client(fetch).exchangeCode({ code: CODE, redirectUri: "https://x.example/cb" });
    assert.deepEqual(r, { accessToken: TOKEN, expiresIn: 5183999, scope: "openid,profile" });
    const [call] = fetch.calls;
    assert.equal(call.url, "https://www.linkedin.com/oauth/v2/accessToken");
    assert.equal(call.init.method, "POST");
    assert.equal(call.headers.get("content-type"), "application/x-www-form-urlencoded");
    assert.equal(call.headers.get("authorization"), null);
    const body = new URLSearchParams(call.init.body);
    assert.equal(body.get("grant_type"), "authorization_code");
    assert.equal(body.get("code"), CODE);
    assert.equal(body.get("client_secret"), SECRET);
    assert.equal(body.get("redirect_uri"), "https://x.example/cb");
    assert.notEqual(call.init.redirect, "follow");
  });

  it("keeps the code, secret and token out of span attributes and errors", async () => {
    const tracer = recordingTracer();
    setTracerForTests(tracer);
    await client(fakeFetch(json(200, { access_token: TOKEN, expires_in: 60 }))).exchangeCode({ code: CODE, redirectUri: "https://x/cb" });
    await assert.rejects(
      client(fakeFetch(json(400, { error: "invalid_grant", error_description: "bad code" }))).exchangeCode({ code: CODE, redirectUri: "https://x/cb" }),
      (err) => err instanceof LinkedInError && !err.message.includes(CODE) && !err.message.includes(SECRET),
    );
    assert.ok(tracer.spans.length >= 2);
    const everything = JSON.stringify(tracer.spans.map(({ name, attributes, events, exceptions, status }) => ({ name, attributes, events, exceptions, status })));
    for (const secret of [CODE, SECRET, TOKEN]) assert.ok(!everything.includes(secret), `${secret} reached a span`);
    assert.ok(tracer.spans.every((s) => s.name === "linkedin.exchange_code"));
  });

  it("refuses a reply without a usable token", async () => {
    await assert.rejects(client(fakeFetch(json(200, { expires_in: 60 }))).exchangeCode({ code: CODE, redirectUri: "https://x/cb" }), LinkedInError);
  });
});

describe("getProfile", () => {
  it("reads the member URN and display name from userinfo with the bearer token", async () => {
    const fetch = fakeFetch(json(200, { sub: "abc_DEF-1", name: "Zack Glick", given_name: "Zack" }));
    assert.deepEqual(await client(fetch).getProfile(TOKEN), { memberUrn: "urn:li:person:abc_DEF-1", name: "Zack Glick" });
    assert.equal(fetch.calls[0].url, "https://api.linkedin.com/v2/userinfo");
    assert.equal(fetch.calls[0].headers.get("authorization"), `Bearer ${TOKEN}`);
  });
  it("refuses a malformed subject", async () => {
    await assert.rejects(client(fakeFetch(json(200, { sub: "../x", name: "X" }))).getProfile(TOKEN), LinkedInError);
  });
});

describe("bearer token only to LinkedIn, never through a redirect", () => {
  for (const bad of [
    "https://evil.example/upload",
    "https://linkedin.com.evil.example/upload",
    "https://evillinkedin.com/upload",
    "http://www.linkedin.com/dms-uploads/x",
    "https://user:pw@www.linkedin.com/dms-uploads/x",
  ]) {
    it(`refuses ${bad} without calling fetch`, async () => {
      const fetch = fakeFetch();
      await assert.rejects(client(fetch).uploadImage(TOKEN, bad, Buffer.from("png"), "image/png"),
        (err) => err instanceof LinkedInError && err.kind === "refused" && !err.message.includes(TOKEN));
      assert.equal(fetch.calls.length, 0);
    });
  }

  it("PUTs the bytes to a LinkedIn upload URL", async () => {
    const fetch = fakeFetch(new Response(null, { status: 201 }));
    await client(fetch).uploadImage(TOKEN, "https://www.linkedin.com/dms-uploads/x?sig=1", Buffer.from("png"), "image/png");
    assert.equal(fetch.calls[0].init.method, "PUT");
    assert.equal(fetch.calls[0].headers.get("content-type"), "image/png");
    assert.equal(fetch.calls[0].headers.get("authorization"), `Bearer ${TOKEN}`);
  });

  it("asks fetch not to follow redirects and refuses a 3xx", async () => {
    const fetch = fakeFetch(new Response(null, { status: 302, headers: { location: "https://evil.example/" } }));
    await assert.rejects(client(fetch).getProfile(TOKEN), (err) => err instanceof LinkedInError && err.kind === "refused");
    assert.equal(fetch.calls.length, 1);
    assert.equal(fetch.calls[0].init.redirect, "manual");
  });
});

describe("events, images and posts", () => {
  it("initializes an image upload owned by the member", async () => {
    const fetch = fakeFetch(json(200, { value: { uploadUrl: "https://www.linkedin.com/dms-uploads/x", image: "urn:li:image:D55" } }));
    assert.deepEqual(await client(fetch).initializeImageUpload(TOKEN, "urn:li:person:abc"), {
      uploadUrl: "https://www.linkedin.com/dms-uploads/x", imageUrn: "urn:li:image:D55", assetUrn: "urn:li:digitalmediaAsset:D55",
    });
    const [call] = fetch.calls;
    assert.equal(call.url, "https://api.linkedin.com/rest/images?action=initializeUpload");
    assert.equal(call.headers.get("linkedin-version"), "202609");
    assert.equal(call.headers.get("x-restli-protocol-version"), "2.0.0");
    assert.deepEqual(JSON.parse(call.init.body), { initializeUploadRequest: { owner: "urn:li:person:abc" } });
  });

  it("creates an event and keeps its 19-digit id exact", async () => {
    const fetch = fakeFetch(json(201, '{"id":7249812613549670401,"vanityName":"bocc-7249812613549670401"}'));
    const r = await client(fetch).createEvent(TOKEN, { name: "x" });
    assert.deepEqual(r, { id: "7249812613549670401", vanityName: "bocc-7249812613549670401" });
    assert.equal(fetch.calls[0].url, "https://api.linkedin.com/rest/events");
    assert.equal(fetch.calls[0].headers.get("x-restli-method"), "create");
  });

  it("takes the event id from x-restli-id when the body has none", async () => {
    const r = await client(fakeFetch(new Response("", { status: 201, headers: { "x-restli-id": "7249812613549670403" } }))).createEvent(TOKEN, {});
    assert.equal(r.id, "7249812613549670403");
  });

  it("treats a create with no readable id as uncertain (it may exist)", async () => {
    await assert.rejects(client(fakeFetch(json(201, {}))).createEvent(TOKEN, {}), (err) => err.kind === "uncertain");
  });

  it("treats a network failure mid-POST as uncertain", async () => {
    await assert.rejects(client(fakeFetch(new TypeError("fetch failed"))).createEvent(TOKEN, {}), (err) => err.kind === "uncertain");
  });

  it("creates the member post and returns its URN from x-restli-id", async () => {
    const fetch = fakeFetch(new Response("", { status: 201, headers: { "x-restli-id": "urn:li:ugcPost:7511865991627468800" } }));
    assert.deepEqual(await client(fetch).createPost(TOKEN, { author: "urn:li:person:abc" }), { postUrn: "urn:li:ugcPost:7511865991627468800" });
    assert.equal(fetch.calls[0].url, "https://api.linkedin.com/rest/posts");
  });

  it("lists the organizer's upcoming events across pages, ids as exact strings", async () => {
    const page1 = `{"elements":[${Array.from({ length: 50 }, (_, i) => `{"id":72498126135496704${String(i).padStart(2, "0")},"name":{"localized":{"en_US":"E${i}"}},"startsAt":1791286200000}`).join(",")}]}`;
    const fetch = fakeFetch(json(200, page1), json(200, '{"elements":[{"id":7249812613549670499,"startsAt":1}]}'));
    const events = await client(fetch).listOrganizerEvents(TOKEN, "urn:li:organization:89993057");
    assert.equal(events.length, 51);
    assert.equal(events[0].id, "7249812613549670400");
    assert.equal(events[50].id, "7249812613549670499");
    assert.equal(events[0].startsAt, 1791286200000);
    assert.equal(fetch.calls[0].url,
      "https://api.linkedin.com/rest/events?q=eventsByOrganizer&organizer=urn%3Ali%3Aorganization%3A89993057&start=0&count=50&excludeCancelled=true&sortOrder=START_TIME_ASC&timeBasedFilter=(lifeCycleState:UPCOMING)");
    assert.match(fetch.calls[1].url, /&start=50&/);
    assert.equal(fetch.calls[0].init.method, "GET");
  });
});

describe("errors are mapped to domain errors", () => {
  for (const [status, kind] of [[401, "expired"], [403, "page_role"], [400, "validation"], [422, "validation"], [500, "unknown"]]) {
    it(`HTTP ${status} -> ${kind}, with LinkedIn's message but never the token`, async () => {
      const fetch = fakeFetch(json(status, { message: `nope ${TOKEN}`, serviceErrorCode: 100 }));
      await assert.rejects(client(fetch).createPost(TOKEN, {}), (err) => {
        assert.ok(err instanceof LinkedInError);
        assert.equal(err.kind, kind);
        assert.equal(err.status, status);
        assert.ok(!err.message.includes(TOKEN) && !String(err.detail).includes(TOKEN));
        assert.ok(err.userMessage.length > 0);
        return true;
      });
    });
  }
});
