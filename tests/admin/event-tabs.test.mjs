// The tabs of /admin/events/YYYY-MM-DD/ (ADR 0012 decision 1, issue #19) over HTTP
// through a real `astro dev` server, against the throwaway database (npm run test:db):
// - which tab renders (?tab=, the date default, unknown values) and which sections it has,
//   with Readiness above the tabs on every tab
// - every form redirecting back to its tab (post/redirect/get), validation errors on the
//   form's tab, and the media delete route landing on the photo's or video's tab
// - the two renames (Online Event Listings, Photos from Event)
// - the role fences and the Origin checks, per tab
// The default-tab rule itself is unit tested in event-tabs-unit.test.mjs.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { OWNER_URL, connect, unique, useAdminEnv } from "./helpers.mjs";

const port = await new Promise((resolve, reject) => {
  const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  s.on("error", reject);
});
const BASE = `http://localhost:${port}`;
useAdminEnv();
process.env.BETTER_AUTH_URL = BASE;
process.env.ASTRO_TELEMETRY_DISABLED = "1";

const { pool } = await import("../../src/lib/auth/auth.mjs");
const { handleAuthRequest } = await import("../../src/lib/auth/handler.mjs");
const { withAudit } = await import("../../src/lib/admin/db.mjs");
const { createUser, grantRole } = await import("../../src/lib/admin/users.mjs");

const PASSWORD = "correct horse battery staple";
const STORAGE = Boolean(process.env.STORAGE_ENDPOINT);
let owner;

// Dates no other test file uses (past ones from 1980, future ones from 2040), from a
// random start, so a re-run against a database left up (test-db.sh up) gets fresh ones.
const day = (y, i) => new Date(Date.UTC(y, 0, 1 + i)).toISOString().slice(0, 10);
let n = randomInt(0, 7000);
const pastDate = () => day(1980, n++);
let m = randomInt(0, 7000);
const futureDate = () => day(2040, m++);

const SECTIONS = {
  info: ["h-details", "h-links"],
  social: ["h-social"],
  post: ["h-report", "h-media-signin", "h-media-social"],
};
const ALL_SECTIONS = Object.values(SECTIONS).flat();

/** Which section headings the page has, and which tab is marked current. */
function shape(html) {
  const sections = ALL_SECTIONS.filter((id) => html.includes(`id="${id}"`));
  const current = [...html.matchAll(/<a\b[^>]*href="\?tab=(\w+)"[^>]*aria-current="page"/g)].map((x) => x[1]);
  return { sections, current };
}
const expectTab = (html, tab, msg) => {
  const s = shape(html);
  assert.deepEqual(s.current, [tab], `${msg}: the current tab`);
  // EventMedia renders a single "Photos" section when storage is off.
  const want = SECTIONS[tab].filter((id) => STORAGE || !id.startsWith("h-media"));
  assert.deepEqual(s.sections, want, `${msg}: the sections`);
};

let ipCounter = 0;
const nextIp = () => `198.21.${Math.floor(++ipCounter / 250)}.${ipCounter % 250 + 1}`;
async function signedIn(roles) {
  const user = await createUser({ email: `${unique("tabu")}@example.com`, name: "Tabs User", password: PASSWORD });
  for (const r of roles) await withAudit(null, (c) => grantRole(c, user.id, r), { action: "test.grant" });
  const res = await handleAuthRequest(new Request(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, "x-nf-client-connection-ip": nextIp() },
    body: JSON.stringify({ email: user.email, password: PASSWORD }),
  }));
  assert.equal(res.status, 200);
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).filter((c) => !c.endsWith("=")).join("; ");
  return { user, cookie };
}

/** A ready media row inserted as the owner (no bucket objects). */
async function insertMedia(d, kind) {
  const id = randomUUID();
  const video = kind === "promo_video";
  const base = `events/${d}/${id}`;
  await owner.query(`insert into events (event_date) values ($1) on conflict do nothing`, [d]);
  await owner.query(
    `insert into event_media (id, event_date, kind, original_key, display_key, thumb_key, content_type, size_bytes, status, publicly_usable)
     values ($1, $2, $3, $4, $5, $6, $7, 4800000, 'ready', $8)`,
    [id, d, kind, `${base}/original.${video ? "mp4" : "jpg"}`, video ? null : `${base}/display.jpg`, video ? null : `${base}/thumb.jpg`,
      video ? "video/mp4" : "image/jpeg", kind === "social_photo"]);
  return id;
}

before(async () => { owner = await connect(OWNER_URL); });
after(async () => { await owner?.end(); await pool.end(); });

describe("event page tabs over HTTP", { timeout: 300_000 }, () => {
  let server, admin, social, noRole;
  const root = fileURLToPath(new URL("../../", import.meta.url));

  before(async () => {
    const { dev } = await import("astro");
    server = await dev({ root, logLevel: "error", server: { port, host: "localhost" } });
    admin = await signedIn(["admin"]);
    social = await signedIn(["social"]);
    noRole = await signedIn([]);
  });
  after(async () => { await server?.stop(); });

  const req = (path, { cookie, method = "GET", form, origin = BASE } = {}) => {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    let body;
    if (method === "POST") {
      if (origin) headers.origin = origin;
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(form ?? {}).toString();
    }
    return fetch(`${BASE}${path}`, { method, headers, body, redirect: "manual" });
  };
  const page = async (path) => {
    const res = await req(path, { cookie: admin.cookie });
    assert.equal(res.status, 200, path);
    return res.text();
  };

  test("?tab picks the tab; each tab has its sections, and Readiness sits above the tabs on every one", async () => {
    const d = futureDate();
    for (const tab of ["info", "social", "post"]) {
      const html = await page(`/admin/events/${d}/?tab=${tab}`);
      expectTab(html, tab, tab);
      assert.ok(html.includes('id="h-ready"'), `${tab}: readiness`);
      assert.ok(html.indexOf('id="h-ready"') < html.indexOf('aria-label="Event page tabs"'), `${tab}: readiness above the tabs`);
      for (const [key, label] of [["info", "Event Info"], ["social", "Social Posts"], ["post", "Post Event"]]) {
        assert.match(html, new RegExp(`<a\\b[^>]*href="\\?tab=${key}"[^>]*>${label}</a>`), `${tab}: a plain link to ${label}`);
      }
    }
  });

  test("the title and the tabs are pinned to the top on scroll; Readiness is not (#36)", async () => {
    const d = futureDate();
    for (const tab of ["info", "social", "post"]) {
      const html = await page(`/admin/events/${d}/?tab=${tab}`);
      assert.match(html, /<h1\b[^>]*class="[^"]*\bpinned\b[^"]*"[^>]*>/, `${tab}: the title is pinned`);
      assert.match(html, /<nav\b[^>]*aria-label="Event page tabs"[^>]*class="[^"]*\bpinned\b|<nav\b[^>]*class="[^"]*\bpinned\b[^"]*"[^>]*aria-label="Event page tabs"/, `${tab}: the tabs are pinned`);
      assert.doesNotMatch(html, /<section\b[^>]*class="[^"]*\bpinned\b[^"]*"[^>]*aria-labelledby="h-ready"|<section\b[^>]*aria-labelledby="h-ready"[^>]*class="[^"]*\bpinned\b/, `${tab}: Readiness scrolls`);
    }
    // The page's own CSS: sticky with a solid background, and anchor jumps clear the bar.
    const css = (await page(`/admin/events/${d}/?tab=social`)).replace(/\s+/g, "");
    assert.match(css, /\.pinned(\[[^\]]*\])*\{[^}]*position:sticky/, "the pinned elements are sticky");
    assert.match(css, /\.pinned(\[[^\]]*\])*\{[^}]*background:var\(--bg\)/, "with the page background, not see-through");
    assert.match(css, /html\{[^}]*scroll-padding-top:/, "anchor jumps land below the pinned bar");
  });

  test("no tab, or an unknown one: Event Info for a future date, Post Event for a past one", async () => {
    const future = futureDate();
    const past = pastDate();
    for (const q of ["", "?tab=", "?tab=photos", "?tab=__proto__", "?notice=saved"]) {
      expectTab(await page(`/admin/events/${future}/${q}`), "info", `future ${q}`);
      expectTab(await page(`/admin/events/${past}/${q}`), "post", `past ${q}`);
    }
    // A past event has no readiness block, on any tab.
    for (const tab of ["info", "social", "post"]) assert.ok(!(await page(`/admin/events/${past}/?tab=${tab}`)).includes('id="h-ready"'));
  });

  test("the renames: Online Event Listings and Photos from Event, and the old labels are gone", async () => {
    const d = pastDate();
    const info = await page(`/admin/events/${d}/?tab=info`);
    assert.match(info, /<h2 id="h-links"[^>]*>Online Event Listings<\/h2>/);
    assert.ok(!/>Listings</.test(info));
    if (STORAGE) {
      const post = await page(`/admin/events/${d}/?tab=post`);
      assert.match(post, /<h2 id="h-media-social"[^>]*>Photos from Event<\/h2>/);
      assert.ok(!/[Ss]ocial photos?/.test(post), "no 'social photo' label left");
      assert.ok(post.includes('data-kind="social_photo"'), "the media kind is unchanged");
    }
    // The social post's "no Luma link" reason names the renamed section.
    await req(`/admin/events/${d}/`, { cookie: admin.cookie, method: "POST", form: { action: "social_post", baseCaption: "Renames" } });
    const social = await page(`/admin/events/${d}/?tab=social`);
    assert.ok(social.includes("Add the Luma listing (under Online Event Listings)"), "the social post's missing-Luma reason");
  });

  test("every form redirects back to its own tab", async () => {
    const future = futureDate();
    const past = pastDate();
    const video = await insertMedia(future, "promo_video");
    const cases = [
      [future, { action: "save", status: "scheduled", location: "lobby" }, "info", "saved"],
      [future, { action: "link", platform: "luma", url: "https://luma.com/tabs-test" }, "info", "link"],
      [future, { action: "unlink", platform: "luma" }, "info", "unlink"],
      [future, { action: "save", status: "cancelled", location: "lobby", cancelReason: "weather" }, "info", "saved"],
      [future, { action: "save", status: "scheduled", location: "lobby" }, "info", "saved"],
      [future, { action: "social_post", baseCaption: "Tabs caption" }, "social", "social_post", "#social"],
      [future, { action: "social_video", videoMediaId: video }, "social", "social_video", "#social"],
      [future, { action: "social_channel", channel: "threads", caption: "Threads tabs", firstComment: "" }, "social", "social_channel", "#social"],
      [past, { action: "report", givesAsksCount: "12", blingGiven: "no", notes: "", blingDetails: "" }, "post", "report"],
    ];
    for (const [d, form, tab, notice, anchor = ""] of cases) {
      // Posted from a different tab's URL: the form's own tab still wins.
      const res = await req(`/admin/events/${d}/?tab=${tab === "info" ? "post" : "info"}`, { cookie: admin.cookie, method: "POST", form });
      assert.equal(res.status, 303, form.action);
      assert.equal(res.headers.get("location"), `/admin/events/${d}/?tab=${tab}&notice=${notice}${anchor}`, form.action);
    }
    // Nothing changed: still back to the tab.
    const same = await req(`/admin/events/${future}/`, { cookie: admin.cookie, method: "POST", form: { action: "save", status: "scheduled", location: "lobby" } });
    assert.equal(same.headers.get("location"), `/admin/events/${future}/?tab=info&notice=unchanged`);
    expectTab(await page(`/admin/events/${future}/?tab=info&notice=saved`), "info", "after the redirect");
  });

  test("a refused save re-renders (400) on the form's tab, with its messages", async () => {
    const future = futureDate();
    const past = pastDate();
    const cases = [
      [future, { action: "save", location: "basement" }, "info"],
      [future, { action: "link", platform: "luma", url: "https://evil.example/x" }, "info"],
      [future, { action: "save", status: "cancelled", cancelReason: "" }, "info"],
      [future, { action: "social_post", baseCaption: "x", ready: "on" }, "social"],
      [future, { action: "social_video", videoMediaId: "nope" }, "social"],
      [past, { action: "report", givesAsksCount: "-1", blingGiven: "" }, "post"],
    ];
    for (const [d, form, tab] of cases) {
      const res = await req(`/admin/events/${d}/?tab=${tab === "info" ? "social" : "info"}`, { cookie: admin.cookie, method: "POST", form });
      assert.equal(res.status, 400, form.action);
      const html = await res.text();
      expectTab(html, tab, form.action);
      assert.match(html, /class="error" role="alert"/, `${form.action}: the message is shown`);
    }
  });

  test("the media delete route lands on the tab of what was deleted", { skip: !STORAGE && "storage not configured" }, async () => {
    const past = pastDate();
    const photo = await insertMedia(past, "social_photo");
    const del = await req(`/api/admin/media/${photo}/delete`, { cookie: admin.cookie, method: "POST" });
    assert.equal(del.status, 303);
    assert.equal(del.headers.get("location"), `/admin/events/${past}/?tab=post&media=deleted#event-media`);

    const future = futureDate();
    const video = await insertMedia(future, "promo_video");
    const vdel = await req(`/api/admin/media/${video}/delete`, { cookie: admin.cookie, method: "POST" });
    assert.equal(vdel.status, 303);
    assert.equal(vdel.headers.get("location"), `/admin/events/${future}/?tab=social&media=video-deleted#social`);
  });

  test("the role fences are unchanged: social and no role get 403 on every tab, GET and POST", async () => {
    const d = futureDate();
    for (const who of [social, noRole]) {
      for (const q of ["", "?tab=info", "?tab=social", "?tab=post"]) {
        assert.equal((await req(`/admin/events/${d}/${q}`, { cookie: who.cookie })).status, 403, q);
        const posted = await req(`/admin/events/${d}/${q}`, { cookie: who.cookie, method: "POST", form: { action: "social_post", baseCaption: "x" } });
        assert.equal(posted.status, 403, `POST ${q}`);
      }
    }
    const out = await req(`/admin/events/${d}/?tab=social`);
    assert.equal(out.status, 302);
    assert.match(out.headers.get("location"), /^\/login\/\?next=/);
    assert.equal((await owner.query(`select 1 from events where event_date = $1`, [d])).rowCount, 0, "nothing written");
  });

  test("Origin: a POST with no or a foreign Origin is 403 on every tab", async () => {
    const d = futureDate();
    for (const q of ["?tab=info", "?tab=social", "?tab=post"]) {
      for (const origin of [null, "https://evil.example"]) {
        const res = await req(`/admin/events/${d}/${q}`, { cookie: admin.cookie, method: "POST", origin, form: { action: "save", location: "lobby" } });
        assert.equal(res.status, 403, `${q} ${origin}`);
      }
    }
    assert.equal((await owner.query(`select 1 from events where event_date = $1`, [d])).rowCount, 0, "nothing written");
  });
});
