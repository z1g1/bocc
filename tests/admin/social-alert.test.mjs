// The Thursday social check against the throwaway database (npm run test:db):
//   1. migration 20261123120000_social_checker.sql: social_checker may SELECT events,
//      event_links, social_plans, social_media_posts and four columns of event_media,
//      and nothing else; it can't write anything
//   2. readWorkOrder() as social_checker, on rows seeded by the owner, and
//      runSocialCheck() end to end with SOCIAL_CHECK_DB_URL and a fake ntfy
//   3. the LinkedIn expiry check (#24, migration 20261126120000_social_checker_linkedin.sql):
//      social_checker reads only user_id, expires_at and display_name of
//      linkedin_authentications and nothing in auth, never the token or member URN; the alert
//      names the LinkedIn authentication by its LinkedIn display name, under 10 days or expired
// The pure rules are in social-alert-unit.test.mjs.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { OWNER_URL, assertAllowed, assertRefused, connect } from "./helpers.mjs";
import { readLinkedInAuthentications, readWorkOrder, runSocialCheck } from "../../src/lib/social-alert/run.mjs";
import { socialAlert } from "../../src/lib/social-alert/alert.mjs";

const CHECK_URL = process.env.TEST_SOCIAL_CHECK_URL;
if (!CHECK_URL) throw new Error("TEST_SOCIAL_CHECK_URL is not set: run these tests with npm run test:db");

const CHANNELS = ["facebook", "instagram", "threads", "tiktok", "linkedin_page"];
let owner, checker;

// Tuesdays in 2085, one per test, so nothing collides with the other suites.
let n = 0;
const tuesday = () => new Date(Date.UTC(2085, 0, 2 + 7 * n++)).toISOString().slice(0, 10); // 2085-01-02 is a Tuesday

/** Seed an event, optionally its Luma link, a ready video and a post with channel statuses. */
async function seed(date, { status = "scheduled", luma = true, post = true, postStatus = "ready", statuses = {} } = {}) {
  await owner.query(`insert into events (event_date, status, cancel_reason) values ($1, $2, $3)`,
    [date, status, status === "cancelled" ? "weather" : null]);
  if (luma) await owner.query(`insert into event_links (event_date, platform, url) values ($1, 'luma', 'https://luma.com/bocc-test')`, [date]);
  if (!post) return;
  const vid = randomUUID();
  await owner.query(
    `insert into event_media (id, event_date, kind, original_key, content_type, size_bytes, status)
     values ($1, $2, 'promo_video', $3, 'video/mp4', 4800000, 'ready')`, [vid, date, `events/${date}/${vid}/original.mp4`]);
  await owner.query(
    `insert into social_plans (event_date, video_media_id, base_caption, publish_at, status)
     values ($1, $2, 'Coffee on Tuesday', ($1::date - 1) + time '12:00' at time zone 'UTC', $3)`, [date, vid, postStatus]);
  for (const c of CHANNELS) {
    await owner.query(`insert into social_media_posts (event_date, channel, status) values ($1, $2, $3)`, [date, c, statuses[c] ?? "scheduled"]);
  }
}

before(async () => {
  owner = await connect(OWNER_URL);
  checker = await connect(CHECK_URL);
});
after(async () => {
  await checker?.end();
  await owner?.end();
});

describe("social_checker permissions", () => {
  before(async () => { await checker.query("begin"); });
  after(async () => { await checker.query("rollback").catch(() => {}); });

  test("may read the work-order tables", async () => {
    await assertAllowed(checker, "select event_date, status from events limit 1");
    await assertAllowed(checker, "select event_date, platform, url from event_links limit 1");
    await assertAllowed(checker, "select * from social_plans limit 1");
    await assertAllowed(checker, "select * from social_media_posts limit 1");
    await assertAllowed(checker, "select id, event_date, kind, status from event_media limit 1");
  });

  test("may not read the rest of event_media", async () => {
    await assertRefused(checker, "select * from event_media limit 1");
    await assertRefused(checker, "select original_key from event_media limit 1");
    await assertRefused(checker, "select uploaded_by from event_media limit 1");
  });

  test("may read only the expiry, user link and display name of linkedin_authentications (#24)", async () => {
    await assertAllowed(checker, "select user_id, expires_at, display_name from linkedin_authentications limit 1");
    await assertRefused(checker, "select token_ciphertext from linkedin_authentications limit 1");
    await assertRefused(checker, "select * from linkedin_authentications limit 1");
    for (const col of ["member_urn", "scope", "connected_at"]) {
      await assertRefused(checker, `select ${col} from linkedin_authentications limit 1`);
    }
  });

  test("has nothing in the auth schema: no USAGE, no column of auth.\"user\"", async () => {
    const { rows: [r] } = await checker.query("select has_schema_privilege(current_user, 'auth', 'USAGE') as usage");
    assert.equal(r.usage, false);
    for (const col of ["id", "name", "email"]) {
      await assertRefused(checker, `select ${col} from auth."user" limit 1`);
    }
    const { rows: grants } = await owner.query(
      `select table_name || ':' || privilege_type as g from information_schema.role_table_grants
        where grantee = 'social_checker' and table_schema = 'auth'
       union all
       select table_name || ':' || column_name from information_schema.column_privileges
        where grantee = 'social_checker' and table_schema = 'auth'`);
    assert.deepEqual(grants, []);
  });

  test("may not write linkedin_authentications", async () => {
    await assertRefused(checker, "update linkedin_authentications set expires_at = now()");
    await assertRefused(checker, "delete from linkedin_authentications");
  });

  for (const table of ["event_reports", "attendees", "checkins", "audit_log", "user_roles", "streaks", "held_occurrences", 'auth."user"', "auth.session"]) {
    test(`may not read ${table}`, async () => {
      await assertRefused(checker, `select * from ${table} limit 1`);
    });
  }

  test("may not write anything", async () => {
    await assertRefused(checker, "insert into events (event_date) values ('2031-01-07')");
    await assertRefused(checker, "update social_plans set status = 'todo'");
    await assertRefused(checker, "update social_media_posts set status = 'scheduled'");
    await assertRefused(checker, "delete from event_links");
    await assertRefused(checker, "update event_media set status = 'ready'");
  });

  test("is not a superuser and can't create objects in public", async () => {
    const { rows: [r] } = await checker.query("select rolsuper, rolcreaterole, rolcreatedb from pg_roles where rolname = current_user");
    assert.deepEqual(r, { rolsuper: false, rolcreaterole: false, rolcreatedb: false });
    await assertRefused(checker, "create table public.social_checker_probe (x int)");
  });
});

describe("readWorkOrder as social_checker", () => {
  test("no events row: null", async () => {
    assert.equal(await readWorkOrder(checker, tuesday()), null);
  });

  test("an event with no Social plan", async () => {
    const d = tuesday();
    await seed(d, { post: false });
    const o = await readWorkOrder(checker, d);
    assert.equal(o.exists, false);
    assert.equal(o.eventStatus, "scheduled");
    assert.equal(socialAlert({ order: o, date: d }).title.includes("no Social plan"), true);
  });

  test("a ready Social plan with every social media post scheduled: actionable, no alert", async () => {
    const d = tuesday();
    await seed(d, { statuses: { tiktok: "live" } });
    const o = await readWorkOrder(checker, d);
    assert.equal(o.exists, true);
    assert.equal(o.actionable, true, JSON.stringify(o.problems));
    assert.equal(o.video.status, "ready");
    assert.equal(o.lumaUrl, "https://luma.com/bocc-test");
    assert.equal(socialAlert({ order: o, date: d }), null);
  });

  test("pending and failed social media posts are reported with their Post status", async () => {
    const d = tuesday();
    await seed(d, { statuses: { facebook: "pending", threads: "failed" } });
    const a = socialAlert({ order: await readWorkOrder(checker, d), date: d });
    assert.match(a.message, /- Facebook: Pending\n- Threads: Failed/);
  });

  test("a ready post that lost its Luma listing is not ready", async () => {
    const d = tuesday();
    await seed(d, { luma: false });
    const o = await readWorkOrder(checker, d);
    assert.deepEqual(o.problems.map((p) => p.key), ["luma"]);
    assert.match(socialAlert({ order: o, date: d }).title, /Social plan not ready/);
  });

  test("the Plan status (ticket #39): Posted counts as ready; Error alerts as social media posts not scheduled; To do isn't ready", async () => {
    const [p, e, t] = [tuesday(), tuesday(), tuesday()];
    await seed(p, { postStatus: "posted", statuses: { tiktok: "live" } });
    await seed(e, { postStatus: "error", statuses: { threads: "failed" } });
    await seed(t, { postStatus: "todo" });
    const posted = await readWorkOrder(checker, p);
    assert.equal(posted.status, "posted");
    assert.equal(socialAlert({ order: posted, date: p }), null);
    const error = socialAlert({ order: await readWorkOrder(checker, e), date: e });
    assert.match(error.title, /1 of 5 social media posts not scheduled/);
    assert.match(error.message, /Plan status is Error: the Threads social media post failed[\s\S]*- Threads: Failed/);
    assert.match(socialAlert({ order: await readWorkOrder(checker, t), date: t }).message, /The Social plan isn't set to Ready for Posting \(it is To do\)/);
  });

  test("a cancelled event: no alert", async () => {
    const d = tuesday();
    await seed(d, { status: "cancelled", postStatus: "todo", statuses: { facebook: "pending" } });
    const o = await readWorkOrder(checker, d);
    assert.equal(o.eventStatus, "cancelled");
    assert.equal(socialAlert({ order: o, date: d }), null);
  });
});

describe("runSocialCheck end to end", () => {
  test("reads next Tuesday through SOCIAL_CHECK_DB_URL and pushes the alert", async () => {
    const d = tuesday();
    await seed(d, { statuses: { instagram: "pending" } });
    const thursday = new Date(Date.parse(`${d}T14:00:00Z`) - 5 * 86400_000);
    const calls = [];
    const fetch = async (url, init) => { calls.push({ url, init }); return new Response("{}"); };
    const lines = [];
    const { log, info, error } = console;
    console.log = console.info = console.error = (...a) => lines.push(a.join(" "));
    let result;
    try {
      result = await runSocialCheck({
        env: { SOCIAL_CHECK_DB_URL: CHECK_URL, SOCIAL_ALERT_NTFY_TOPIC: "bocc-test-topic", URL: "https://716coffee.club" },
        context: { deploy: { context: "production" }, site: { url: "https://716coffee.club" } },
        now: thursday,
        fetch,
      });
    } finally { Object.assign(console, { log, info, error }); }
    assert.equal(result.outcome, "sent", lines.join("\n"));
    assert.equal(result.date, d);
    // Other suites may leave LinkedIn authentications behind: count the social pushes only.
    const social = calls.filter((c) => JSON.parse(c.init.body).title.startsWith("BOCC social"));
    assert.equal(social.length, 1);
    assert.equal(social[0].url, "https://ntfy.sh/", "the server root: the topic is never in the URL");
    const body = JSON.parse(social[0].init.body);
    assert.equal(body.topic, "bocc-test-topic");
    assert.match(body.message, /- Instagram: Pending/);
    assert.doesNotMatch(lines.join("\n"), /bocc-test-topic|social_checker:/);
  });
});

describe("the LinkedIn authentication expiry as social_checker (#24)", () => {
  const seeded = [];
  /**
   * A user (seeded as the owner) with a LinkedIn authentication expiring `days` from `now`. `name` is
   * the LinkedIn authentication's LinkedIn display name, what the alert must use; `authName` is the
   * Better Auth name, which social_checker can't read.
   */
  async function authentication(days, now = new Date()) {
    const id = `t24-${randomUUID()}`;
    const name = `LinkedIn ${id.slice(4, 12)}`;
    const authName = `AuthName ${id.slice(4, 12)}`;
    await owner.query(`insert into auth."user" (id, name, email, "emailVerified") values ($1, $2, $3, true)`, [id, authName, `${id}@example.com`]);
    await owner.query(
      `insert into linkedin_authentications (user_id, token_ciphertext, expires_at, member_urn, display_name)
       values ($1, $2, $3, 'urn:li:person:t24secret', $4)`,
      [id, Buffer.from("SECRET-TOKEN-BYTES-".repeat(3)), new Date(now.getTime() + days * 86_400_000), name]);
    seeded.push(id);
    return { id, name, authName };
  }
  after(async () => { await owner.query(`delete from auth."user" where id = any($1)`, [seeded]); });

  /** runSocialCheck against the database at `now` (a social alert may come too: tests look at theirs). */
  async function run(now) {
    const calls = [];
    const fetch = async (url, init) => { calls.push(JSON.parse(init.body)); return new Response("{}"); };
    const lines = [];
    const { log, info, error } = console;
    console.log = console.info = console.error = (...a) => lines.push(a.join(" "));
    let result;
    try {
      result = await runSocialCheck({
        env: { SOCIAL_CHECK_DB_URL: CHECK_URL, SOCIAL_ALERT_NTFY_TOPIC: "bocc-test-topic", URL: "https://716coffee.club" },
        context: { deploy: { context: "production" }, site: { url: "https://716coffee.club" } },
        now,
        fetch,
      });
    } finally { Object.assign(console, { log, info, error }); }
    return { result, calls, logs: lines.join("\n") };
  }

  test("readLinkedInAuthentications returns the display name and expiry only", async () => {
    const { id, name } = await authentication(5);
    const rows = await readLinkedInAuthentications(checker);
    const mine = rows.filter((r) => r.name === name);
    assert.equal(mine.length, 1, id);
    assert.deepEqual(Object.keys(mine[0]).sort(), ["expiresAt", "name"]);
    assert.ok(mine[0].expiresAt instanceof Date);
  });

  test("under 10 days: the alert fires, names the LinkedIn display name, links /admin/account/, and carries no token data", async () => {
    const d = new Date();
    const { name, authName } = await authentication(3, d);
    const { result, calls, logs } = await run(d);
    const mine = calls.filter((b) => b.title.includes(name));
    assert.equal(mine.length, 1, logs);
    assert.equal(mine[0].title, `BOCC LinkedIn: ${name}'s LinkedIn authentication expires in 3 days`);
    assert.match(mine[0].message, /Re-authenticate at \/admin\/account\//);
    assert.equal(mine[0].click, "https://716coffee.club/admin/account/");
    assert.equal(result.linkedin.outcome, "sent");
    assert.doesNotMatch(JSON.stringify(calls) + logs, /SECRET-TOKEN|t24secret/);
    assert.doesNotMatch(JSON.stringify(calls) + logs, new RegExp(authName));
    assert.doesNotMatch(logs, new RegExp(`${name}|bocc-test-topic`));
  });

  test("expired: the alert fires", async () => {
    const d = new Date();
    const { name } = await authentication(-1, d);
    const { calls } = await run(d);
    assert.deepEqual(calls.filter((b) => b.title.includes(name)).map((b) => b.title), [`BOCC LinkedIn: ${name}'s LinkedIn authentication has expired`]);
  });

  test("10 days or more left: no alert for it", async () => {
    const d = new Date();
    const { name } = await authentication(30, d);
    const { result, calls, logs } = await run(d);
    assert.equal(calls.filter((b) => b.title.includes(name)).length, 0);
    assert.notEqual(result.linkedin.outcome, "failed", logs);
  });
});
