// The public event pages and sitemap with no database (ADR 0009 decision 4): with
// SITE_DB_URL unset, and then pointing at a closed port (Neon down), every DB-backed
// response is a 503 with a friendly page, no-store everywhere and no error text.
// A malformed date never needs the database, so it is still a 404.
// Its own file, so its own process: SITE_DB_URL is removed before anything reads it.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { useAdminEnv } from "./helpers.mjs";

delete process.env.SITE_DB_URL;

const port = await new Promise((resolve, reject) => {
  const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  s.on("error", reject);
});
// A port nothing listens on, for "Neon is down".
const closedPort = await new Promise((resolve, reject) => {
  const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  s.on("error", reject);
});
const BASE = `http://localhost:${port}`;
useAdminEnv();
process.env.BETTER_AUTH_URL = BASE;
process.env.ASTRO_TELEMETRY_DISABLED = "1";

const get = (path) => fetch(`${BASE}${path}`, { redirect: "manual" });

async function assertUnavailable(path) {
  const res = await get(path);
  assert.equal(res.status, 503, path);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("netlify-cdn-cache-control"), "no-store");
  assert.equal(res.headers.get("netlify-cache-tag"), null);
  assert.equal(res.headers.get("retry-after"), "60");
  const body = await res.text();
  assert.doesNotMatch(body, /SITE_DB_URL|ECONNREFUSED|postgres|Error:|stack/i, "no error details leak");
  return body;
}

describe("public event pages without a database", { timeout: 300_000 }, () => {
  let server;
  const root = fileURLToPath(new URL("../../", import.meta.url));
  before(async () => {
    const { dev } = await import("astro");
    server = await dev({ root, logLevel: "error", server: { port, host: "localhost" } });
  });
  after(async () => { await server?.stop(); });

  test("SITE_DB_URL unset: 503 with a friendly page; the sitemap 503s too", async () => {
    const html = await assertUnavailable("/events/2031-06-10/");
    assert.match(html, /This page is still brewing\./);
    assert.match(html, /<meta name="robots" content="noindex">/);
    assert.match(await assertUnavailable("/sitemap.xml"), /temporarily unavailable/);
  });

  test("a malformed date is still a 404 without the database", async () => {
    const res = await get("/events/2031-13-01/");
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  test("/events/ needs no database", async () => {
    const res = await get("/events/");
    assert.equal(res.status, 302);
  });

  test("database down: 503, no-store", async () => {
    // The pool is made on first successful env read, so this takes effect now.
    process.env.SITE_DB_URL = `postgresql://site_reader:x@localhost:${closedPort}/neondb`;
    try {
      await assertUnavailable("/events/2031-06-10/");
      await assertUnavailable("/sitemap.xml");
    } finally {
      delete process.env.SITE_DB_URL;
    }
  });
});
