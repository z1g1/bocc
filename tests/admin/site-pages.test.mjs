// Public /events/YYYY-MM-DD/ pages rendered from Neon on request (ADR 0009 decision 4),
// through a real `astro dev` server connected as site_reader (TEST_SITE_URL from
// scripts/test-db.sh), with "today" pinned by BOCC_TODAY:
//   scheduled (embed, RSVP to Luma, sameAs only in JSON-LD), scheduled without a Luma
//   link (calendar fallback), cancelled, past (held, and scheduled but past), unknown
//   and malformed dates (404), /events/ (302), the sitemap, and every cache header.
// All rows are in 2031 so other test files' events don't change "the next event".
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { OWNER_URL, connect, useAdminEnv } from "./helpers.mjs";

if (!process.env.TEST_SITE_URL) throw new Error("TEST_SITE_URL is not set: run these tests with npm run test:db");

const port = await new Promise((resolve, reject) => {
  const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  s.on("error", reject);
});
const BASE = `http://localhost:${port}`;
useAdminEnv();
process.env.BETTER_AUTH_URL = BASE;
process.env.ASTRO_TELEMETRY_DISABLED = "1";
process.env.SITE_DB_URL = process.env.TEST_SITE_URL;
process.env.BOCC_TODAY = "2031-06-04"; // a Wednesday

const D = {
  heldPast: "2031-05-27",
  scheduledPast: "2031-06-03",
  upcoming: "2031-06-10",
  noLuma: "2031-06-17",
  cancelled: "2031-06-24",
  unknown: "2031-07-01",
};
const LUMA = { url: "https://luma.com/test2031", id: "evt-Test2031abcDEF" };
const OTHERS = {
  eventbrite: "https://www.eventbrite.com/e/buffalo-open-coffee-club-2031",
  facebook_event: "https://www.facebook.com/events/2031061000",
  linkedin_event: "https://www.linkedin.com/events/2031061000",
};

let owner, server;

async function seed() {
  const dates = Object.values(D);
  await owner.query("delete from event_links where event_date = any($1::date[])", [dates]);
  await owner.query("delete from events where event_date = any($1::date[])", [dates]);
  await owner.query(
    `insert into events (event_date, status, location, cancel_reason) values
       ($1, 'held', 'lobby', null), ($2, 'scheduled', 'lobby', null), ($3, 'scheduled', 'food_hall', null),
       ($4, 'scheduled', null, null), ($5, 'cancelled', 'lobby', 'weather')`,
    [D.heldPast, D.scheduledPast, D.upcoming, D.noLuma, D.cancelled]);
  await owner.query(
    `insert into event_links (event_date, platform, url, external_id) values
       ($1, 'luma', $2, $3), ($1, 'eventbrite', $4, null), ($1, 'facebook_event', $5, null), ($1, 'linkedin_event', $6, null),
       ($7, 'eventbrite', $4, null),
       ($8, 'luma', $2, $3), ($8, 'linkedin_event', $6, null),
       ($9, 'luma', $2, $3)`,
    [D.upcoming, LUMA.url, LUMA.id, OTHERS.eventbrite, OTHERS.facebook_event, OTHERS.linkedin_event,
      D.noLuma, D.cancelled, D.heldPast]);
}

const get = (path) => fetch(`${BASE}${path}`, { redirect: "manual" });
const ldBlocks = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
const eventLd = (html) => ldBlocks(html).find((o) => o["@type"] === "Event");
const withoutLd = (html) => html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, "");

function assertCached(res, date) {
  assert.equal(res.headers.get("netlify-cache-tag"), `event-${date}`);
  assert.match(res.headers.get("netlify-cdn-cache-control"), /^public, durable, max-age=(\d+), stale-while-revalidate=3600$/);
  const maxAge = Number(res.headers.get("netlify-cdn-cache-control").match(/max-age=(\d+)/)[1]);
  assert.ok(maxAge >= 60 && maxAge <= 86400, `CDN max-age within a day: ${maxAge}`);
  assert.equal(res.headers.get("cache-control"), "public, max-age=0, must-revalidate");
  assert.equal(res.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
}

before(async () => {
  owner = await connect(OWNER_URL);
  await seed();
});
after(async () => {
  const dates = Object.values(D);
  await owner?.query("delete from event_links where event_date = any($1::date[])", [dates]);
  await owner?.query("delete from events where event_date = any($1::date[])", [dates]);
  await owner?.end();
});

describe("public event pages from the database", { timeout: 300_000 }, () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  before(async () => {
    const { dev } = await import("astro");
    server = await dev({ root, logLevel: "error", server: { port, host: "localhost" } });
  });
  after(async () => { await server?.stop(); });

  test("scheduled: the Luma embed and RSVP, the other listings only as JSON-LD sameAs", async () => {
    const res = await get(`/events/${D.upcoming}/`);
    assert.equal(res.status, 200);
    assertCached(res, D.upcoming);
    const html = await res.text();
    assert.match(html, new RegExp(`<iframe[^>]+src="https://luma.com/embed/event/${LUMA.id}/simple"`));
    assert.match(html, new RegExp(`class="btn btn--primary btn--lg" href="${LUMA.url}"`), "RSVP button goes to Luma");
    assert.match(html, /Save your spot for Tuesday, June 10, 2031\./);
    assert.match(html, /<dt[^>]*>Food hall<\/dt>/, "location comes from the event");
    assert.doesNotMatch(html, /name="robots"/);
    const ld = eventLd(html);
    assert.equal(ld.eventStatus, "https://schema.org/EventScheduled");
    assert.deepEqual(ld.sameAs, [OTHERS.eventbrite, OTHERS.facebook_event, OTHERS.linkedin_event]);
    assert.equal(ld.offers.url, LUMA.url);
    assert.equal(ld.startDate, "2031-06-10T07:30:00-04:00");
    for (const url of Object.values(OTHERS)) assert.ok(!withoutLd(html).includes(url), `no visible link to ${url}`);
  });

  test("scheduled without a Luma link: no embed, the Luma calendar instead", async () => {
    const res = await get(`/events/${D.noLuma}`); // no trailing slash works too
    assert.equal(res.status, 200);
    assertCached(res, D.noLuma);
    const html = await res.text();
    assert.doesNotMatch(html, /<iframe/);
    assert.match(html, /<a href="https:\/\/luma.com\/716coffeeclub"[^>]*>See upcoming dates on Luma<\/a>/);
    assert.match(html, /class="btn btn--primary btn--lg" href="https:\/\/luma.com\/716coffeeclub"/);
    assert.match(html, /<dt[^>]*>Lobby<\/dt>/);
    assert.deepEqual(eventLd(html).sameAs, [OTHERS.eventbrite]);
  });

  test("cancelled: a clear notice, no RSVP, the next event, EventCancelled", async () => {
    const res = await get(`/events/${D.cancelled}/`);
    assert.equal(res.status, 200);
    assertCached(res, D.cancelled);
    const html = await res.text();
    assert.match(html, /This Tuesday is cancelled/);
    assert.doesNotMatch(html, /<iframe/);
    assert.doesNotMatch(html, /id="rsvp"|Save your spot|RSVP free</);
    assert.ok(!html.includes(`href="${LUMA.url}"`), "no RSVP link");
    assert.match(html, new RegExp(`href="/events/${D.upcoming}/"[^>]*>Next: Tuesday, June 10, 2031`));
    assert.doesNotMatch(html, /name="robots"/, "an upcoming cancellation stays indexable");
    const ld = eventLd(html);
    assert.equal(ld.eventStatus, "https://schema.org/EventCancelled");
    assert.deepEqual(ld.sameAs, [OTHERS.linkedin_event]);
  });

  for (const [label, date] of [["held", D.heldPast], ["scheduled but past", D.scheduledPast]]) {
    test(`past (${label}): "has passed", the next event, noindex, no embed`, async () => {
      const res = await get(`/events/${date}/`);
      assert.equal(res.status, 200);
      assertCached(res, date);
      const html = await res.text();
      assert.match(html, /This one has passed/);
      assert.doesNotMatch(html, /<iframe/);
      assert.doesNotMatch(html, /id="rsvp"|Save your spot|RSVP free</);
      assert.match(html, new RegExp(`href="/events/${D.upcoming}/"[^>]*>Next: Tuesday, June 10, 2031`));
      assert.match(html, /<meta name="robots" content="noindex">/);
      assert.equal(eventLd(html), undefined, "no Event JSON-LD for a past date");
    });
  }

  test("a date with no event: the Out of Coffee 404, cached 5 minutes under its tag", async () => {
    const res = await get(`/events/${D.unknown}/`);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("netlify-cdn-cache-control"), "public, durable, max-age=300");
    assert.equal(res.headers.get("netlify-cache-tag"), `event-${D.unknown}`);
    assert.equal(res.headers.get("cache-control"), "public, max-age=0, must-revalidate");
    const html = await res.text();
    assert.match(html, /This page is out of coffee\./);
    assert.equal(eventLd(html), undefined);
  });

  for (const bad of ["2031-02-30", "2031-6-10", "not-a-date", "2031-06-10x"]) {
    test(`a malformed date (${bad}): 404, never cached`, async () => {
      const res = await get(`/events/${bad}/`);
      assert.equal(res.status, 404);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(res.headers.get("netlify-cdn-cache-control"), "no-store");
      assert.equal(res.headers.get("netlify-cache-tag"), null);
      assert.match(await res.text(), /This page is out of coffee\./);
    });
  }

  test("/events/ redirects to the home page", async () => {
    for (const path of ["/events/", "/events"]) {
      const res = await get(path);
      assert.equal(res.status, 302, path);
      assert.equal(res.headers.get("location"), "/");
    }
  });

  test("the sitemap lists upcoming scheduled events from the database, tagged event-list", async () => {
    const res = await get("/sitemap.xml");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/xml");
    assert.equal(res.headers.get("netlify-cache-tag"), "event-list");
    assert.match(res.headers.get("netlify-cdn-cache-control"), /^public, durable, max-age=\d+, stale-while-revalidate=3600$/);
    const xml = await res.text();
    assert.match(xml, new RegExp(`<loc>https://716coffee.club/events/${D.upcoming}/</loc>\\n<lastmod>\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\+00:00</lastmod>`));
    assert.ok(xml.includes(`/events/${D.noLuma}/`));
    for (const d of [D.cancelled, D.heldPast, D.scheduledPast, D.unknown]) assert.ok(!xml.includes(`/events/${d}/`), d);
    assert.ok(xml.indexOf(D.upcoming) < xml.indexOf(D.noLuma), "soonest first");
    assert.match(xml, /<url>\n<loc>https:\/\/716coffee.club\/<\/loc>\n<\/url>/, "content pages still listed");
    assert.match(xml, /<loc>https:\/\/716coffee.club\/code-of-conduct\/<\/loc>/);
    assert.ok(xml.endsWith("</url>\n</urlset>\n"));
  });
});
