// The first photo upload for a date creates its events row (src/lib/admin/media.mjs
// startUpload), so POST /api/admin/media/uploads must purge /events/<date>/: a cached
// "Out of Coffee" 404 for that date would otherwise live on (ADR 0009 decision 4).
//
// Calls the route's POST handler directly, as a branch deploy would (locals.netlify),
// with the real purgeEventPages and the real @netlify/cache. Only Netlify's purge API
// is faked: globalThis.fetch answers api.netlify.com itself and records the body.
// Needs MinIO's STORAGE_* (scripts/test-db.sh), like the other upload tests.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { OWNER_URL, connect, unique, useAdminEnv } from "./helpers.mjs";

const skip = process.env.STORAGE_ENDPOINT ? false : "MinIO not running (STORAGE_ENDPOINT unset)";
const BASE = "http://localhost:4321";
useAdminEnv();
process.env.BETTER_AUTH_URL = BASE;
process.env.NETLIFY_PURGE_API_TOKEN = "nfp_test_token";
process.env.SITE_ID = "test-site-id";

const DATE = "2027-10-12"; // uploads accept dates up to a year ahead
let owner, pool, user, POST;
const purges = [];
const realFetch = globalThis.fetch;

describe("a media upload that creates the event purges its public page", { skip }, () => {
  before(async () => {
    owner = await connect(OWNER_URL);
    await owner.query("delete from event_media where event_date = $1", [DATE]);
    await owner.query("delete from events where event_date = $1", [DATE]);
    ({ pool } = await import("../../src/lib/auth/auth.mjs"));
    const { createUser } = await import("../../src/lib/admin/users.mjs");
    user = await createUser({ email: `${unique("mpurge")}@example.com`, name: "Media Purge", password: "correct horse battery staple" });
    ({ POST } = await import("../../src/pages/api/admin/media/uploads.ts"));
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith("https://api.netlify.com/")) {
        purges.push({ url: String(url), auth: init.headers.Authorization, body: JSON.parse(init.body) });
        return new Response(null, { status: 202 });
      }
      return realFetch(url, init);
    };
  });
  after(async () => {
    globalThis.fetch = realFetch;
    await owner?.query("delete from event_media where event_date = $1", [DATE]);
    await owner?.query("delete from events where event_date = $1", [DATE]);
    await owner?.end();
    await pool?.end();
  });

  const upload = () => POST({
    locals: {
      user: { id: user.id },
      roles: ["admin"],
      netlify: { context: { deploy: { context: "branch-deploy", branch: "dev", id: "d", published: false }, site: { url: "https://716coffee.club" } } },
    },
    request: new Request(`${BASE}/api/admin/media/uploads`, {
      method: "POST",
      headers: { origin: BASE, "content-type": "application/json" },
      body: JSON.stringify({ eventDate: DATE, kind: "social_photo", original: { contentType: "image/jpeg", size: 1000 }, display: { size: 500 }, thumb: { size: 100 } }),
    }),
  });

  test("first upload: event created, one scoped purge of the date and event-list", async () => {
    const res = await upload();
    assert.equal(res.status, 201);
    assert.equal((await res.json()).eventCreated, true);
    assert.equal(purges.length, 1);
    assert.equal(purges[0].url, "https://api.netlify.com/api/v1/purge");
    assert.deepEqual(purges[0].body, { cache_tags: [`event-${DATE}`, "event-list"], deploy_alias: "dev", site_id: "test-site-id" });
  });

  test("a later upload for the same date doesn't purge", async () => {
    const res = await upload();
    assert.equal(res.status, 201);
    assert.equal((await res.json()).eventCreated, false);
    assert.equal(purges.length, 1);
  });
});
