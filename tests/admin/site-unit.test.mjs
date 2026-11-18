// Unit tests for the public-site seams (ADR 0009 decision 4), no server:
//   - purgeEventPages: scoped to one deploy (branch alias, or the production domain),
//     refuses outside production without an alias, never throws, one call for all tags,
//     one retry on a 429, skipped off Netlify
//   - readSiteEnv: fail-fast, names variables never values
//   - the cache headers
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { purgeEventPages, purgeScope } from "../../src/lib/site/purge.mjs";
import { readSiteEnv } from "../../src/lib/site/db.mjs";
import { secondsToEasternMidnight, setPublicHeaders } from "../../src/lib/site/http.mjs";

const branch = (b = "dev") => ({ netlify: { context: { deploy: { context: "branch-deploy", branch: b, id: "d1", published: false }, site: { url: "https://716coffee.club", name: "bocc-backend" } } } });
const production = (url = "https://716coffee.club") => ({ netlify: { context: { deploy: { context: "production", branch: "main", id: "d2", published: true }, site: { url, name: "bocc-backend" } } } });

function fakePurge(...outcomes) {
  const calls = [];
  const fn = async (opts) => {
    calls.push(structuredClone(opts));
    const o = outcomes.shift();
    if (o instanceof Error) throw o;
  };
  return { fn, calls };
}
const noSleep = { sleeps: [], fn(ms) { this.sleeps.push(ms); return Promise.resolve(); } };

describe("purgeEventPages", () => {
  test("branch deploy: one call, every date's tag plus event-list, scoped by deployAlias", async () => {
    const p = fakePurge();
    const r = await purgeEventPages(["2031-06-10", "2031-06-17", "2031-06-10", "nope"], { locals: branch("dev"), purge: p.fn });
    assert.deepEqual(r, { ok: true });
    assert.deepEqual(p.calls, [{ tags: ["event-2031-06-10", "event-2031-06-17", "event-list"], deployAlias: "dev" }]);
  });

  test("production: scoped to the production domain, never unscoped", async () => {
    const p = fakePurge();
    assert.deepEqual(await purgeEventPages(["2031-06-10"], { locals: production(), purge: p.fn }), { ok: true });
    assert.deepEqual(p.calls, [{ tags: ["event-2031-06-10", "event-list"], domain: "716coffee.club" }]);
  });

  test("every call carries deployAlias or domain", async () => {
    for (const locals of [branch("dev"), branch("feature-x"), production()]) {
      const p = fakePurge();
      await purgeEventPages(["2031-06-10"], { locals, purge: p.fn });
      assert.equal(p.calls.length, 1);
      assert.ok(p.calls[0].deployAlias || p.calls[0].domain, JSON.stringify(p.calls[0]));
    }
  });

  test("refuses, logs and doesn't call purge when no alias can be found outside production", async (t) => {
    const err = t.mock.method(console, "error", () => {});
    const cases = [
      { netlify: { context: { deploy: { context: "branch-deploy" }, site: {} } } },
      { netlify: { context: { deploy: { context: "branch-deploy", branch: "feat/../x" }, site: {} } } },
      { netlify: { context: { deploy: { context: "deploy-preview", branch: "x" }, site: {} } } },
      { netlify: { context: { deploy: { context: "something-new" }, site: {} } } },
      production(""),
      production("not a url"),
    ];
    for (const locals of cases) {
      const p = fakePurge();
      const r = await purgeEventPages(["2031-06-10"], { locals, purge: p.fn });
      assert.deepEqual(r, { ok: false, skipped: "no deploy alias" }, JSON.stringify(locals));
      assert.equal(p.calls.length, 0);
    }
    assert.equal(err.mock.callCount(), cases.length);
    assert.match(err.mock.calls[0].arguments[0], /purge refused/);
  });

  test("off Netlify (astro dev, scripts): skipped, ok", async () => {
    for (const locals of [undefined, {}, { netlify: {} }, { netlify: { context: { deploy: { context: "dev" } } } }]) {
      const p = fakePurge();
      assert.deepEqual(await purgeEventPages(["2031-06-10"], { locals, purge: p.fn }), { ok: true, skipped: "not on Netlify" });
      assert.equal(p.calls.length, 0);
    }
  });

  test("no valid dates: nothing to do", async () => {
    const p = fakePurge();
    for (const dates of [[], ["x"], undefined, null, "2031-06-10"]) {
      assert.deepEqual(await purgeEventPages(dates, { locals: branch(), purge: p.fn }), { ok: true, skipped: "no dates" });
    }
    assert.equal(p.calls.length, 0);
  });

  test("never throws: a failing purge is logged with secrets redacted", async (t) => {
    const err = t.mock.method(console, "error", () => {});
    const p = fakePurge(new Error("boom Bearer nfp_secretToken123 at postgresql://u:pw@host/db"));
    const r = await purgeEventPages(["2031-06-10"], { locals: branch(), purge: p.fn, sleep: noSleep.fn.bind(noSleep) });
    assert.deepEqual(r, { ok: false });
    const line = err.mock.calls.map((c) => c.arguments.join(" ")).join("\n");
    assert.match(line, /purge failed/);
    assert.doesNotMatch(line, /nfp_secretToken123|u:pw|postgresql:/);
    assert.equal(p.calls.length, 1, "only a 429 is retried");
  });

  test("a 429 is retried once after 5 s; a second 429 is logged, not thrown", async (t) => {
    t.mock.method(console, "error", () => {});
    const sleep = { sleeps: [], fn(ms) { this.sleeps.push(ms); return Promise.resolve(); } };
    const rateLimited = () => new Error("Cache purge API call returned an unexpected status code: 429");
    let p = fakePurge(rateLimited());
    assert.deepEqual(await purgeEventPages(["2031-06-10"], { locals: branch(), purge: p.fn, sleep: sleep.fn.bind(sleep) }), { ok: true });
    assert.equal(p.calls.length, 2);
    assert.deepEqual(sleep.sleeps, [5000]);
    p = fakePurge(rateLimited(), rateLimited());
    assert.deepEqual(await purgeEventPages(["2031-06-10"], { locals: branch(), purge: p.fn, sleep: sleep.fn.bind(sleep) }), { ok: false });
    assert.equal(p.calls.length, 2);
  });

  test("a purge that throws synchronously, or a bad locals object, still never throws", async (t) => {
    t.mock.method(console, "error", () => {});
    const throwing = () => { throw new TypeError("sync"); };
    assert.deepEqual(await purgeEventPages(["2031-06-10"], { locals: branch(), purge: throwing }), { ok: false });
    const hostile = { get netlify() { throw new Error("getter"); } };
    assert.equal((await purgeEventPages(["2031-06-10"], { locals: hostile })).ok, false);
  });

  test("the real @netlify/cache without a token or site: fails closed, no network, no throw", async (t) => {
    const err = t.mock.method(console, "error", () => {});
    const saved = { token: process.env.NETLIFY_PURGE_API_TOKEN, site: process.env.SITE_ID, local: process.env.NETLIFY_LOCAL };
    delete process.env.NETLIFY_PURGE_API_TOKEN; delete process.env.SITE_ID; delete process.env.NETLIFY_LOCAL;
    try {
      assert.deepEqual(await purgeEventPages(["2031-06-10"], { locals: branch() }), { ok: false });
      assert.match(err.mock.calls.at(-1).arguments[0], /purge failed/);
    } finally {
      for (const [k, v] of [["NETLIFY_PURGE_API_TOKEN", saved.token], ["SITE_ID", saved.site], ["NETLIFY_LOCAL", saved.local]]) if (v !== undefined) process.env[k] = v;
    }
  });

  test("purgeScope reads deploy.branch on a branch deploy and site.url in production", () => {
    assert.deepEqual(purgeScope(branch("dev")), { scope: { deployAlias: "dev" } });
    assert.deepEqual(purgeScope(production("https://716coffee.club/")), { scope: { domain: "716coffee.club" } });
  });
});

describe("readSiteEnv", () => {
  test("needs SITE_DB_URL, a postgres URL; names the variable, never the value", () => {
    assert.throws(() => readSiteEnv({}), /SITE_DB_URL is not set/);
    assert.throws(() => readSiteEnv({ SITE_DB_URL: "https://secret-host/x" }), (e) => /postgres:\/\/ URL/.test(e.message) && !e.message.includes("secret-host"));
    assert.throws(() => readSiteEnv({ SITE_DB_URL: "nope" }), /not a valid URL/);
    assert.deepEqual(readSiteEnv({ SITE_DB_URL: "postgresql://u:p@h/db" }), { dbUrl: "postgresql://u:p@h/db", poolMax: 2 });
    assert.equal(readSiteEnv({ SITE_DB_URL: "postgres://u:p@h/db", SITE_DB_POOL_MAX: "1" }).poolMax, 1);
    assert.throws(() => readSiteEnv({ SITE_DB_URL: "postgres://u:p@h/db", SITE_DB_POOL_MAX: "0" }), /SITE_DB_POOL_MAX/);
    assert.throws(() => readSiteEnv({ SITE_DB_POOL_MAX: "x" }), (e) => /SITE_DB_URL/.test(e.message) && /SITE_DB_POOL_MAX/.test(e.message), "every problem at once");
  });
});

describe("cache headers", () => {
  test("CDN max-age runs to the next Eastern midnight, between 60 s and a day", () => {
    assert.equal(secondsToEasternMidnight(new Date("2031-06-10T04:00:00Z")), 86400); // 00:00 EDT
    assert.equal(secondsToEasternMidnight(new Date("2031-06-10T16:00:00Z")), 12 * 3600); // 12:00 EDT
    assert.equal(secondsToEasternMidnight(new Date("2031-01-14T04:59:30Z")), 60); // 23:59:30 EST, floored to 60
  });

  test("cached / unknown-date / no-store", () => {
    const now = new Date("2031-06-10T16:00:00Z");
    const h = Object.fromEntries(setPublicHeaders(new Headers(), "cached", { tag: "event-2031-06-10", now }));
    assert.deepEqual(h, {
      "cache-control": "public, max-age=0, must-revalidate",
      "netlify-cdn-cache-control": "public, durable, max-age=43200, stale-while-revalidate=3600",
      "netlify-cache-tag": "event-2031-06-10",
      "x-content-type-options": "nosniff",
      "x-frame-options": "SAMEORIGIN",
    });
    assert.equal(setPublicHeaders(new Headers(), "unknown-date", { tag: "event-x" }).get("netlify-cdn-cache-control"), "public, durable, max-age=300");
    const n = setPublicHeaders(new Headers({ "Netlify-Cache-Tag": "x" }), "no-store");
    assert.equal(n.get("cache-control"), "no-store");
    assert.equal(n.get("netlify-cdn-cache-control"), "no-store");
    assert.equal(n.get("netlify-cache-tag"), null);
  });
});
