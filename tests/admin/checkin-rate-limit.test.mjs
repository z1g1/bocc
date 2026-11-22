// Per-IP check-in rate limit (issue #67, ADR 0013) against the throwaway database
// (npm run test:db): migration 20261204120000_checkin_rate_limit.sql, checkin_writer's
// grants on its table, and the real store statement and handler as checkin_writer.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import { ADMIN_URL, CHECKIN_URL, OWNER_URL, assertAllowed, assertRefused, connect, inRollback, unique } from "./helpers.mjs";

const key = (s) => createHash("sha256").update(s).digest("hex");

let owner, writer, admin, store;

before(async () => {
  owner = await connect(OWNER_URL);
  writer = await connect(CHECKIN_URL);
  admin = await connect(ADMIN_URL);
  // The real adapter, as checkin_writer over verify-full TLS (utils/db-ssl.js).
  process.env.CHECKIN_DB_URL = CHECKIN_URL;
  process.env.DB_CA_CERT = fs.readFileSync(process.env.DB_CA_CERT_FILE, "utf8");
  const require = createRequire(import.meta.url);
  store = require("../../backend/netlify/functions/utils/pg-store.js");
});
after(async () => {
  await store?._getPool().end();
  await Promise.all([owner?.end(), writer?.end(), admin?.end()]);
});

describe("checkin_rate_limit_hits grants", () => {
  test("checkin_writer can SELECT and INSERT, and nothing else", () =>
    inRollback(writer, async () => {
      const k = key(unique("ip"));
      await assertAllowed(writer, "insert into checkin_rate_limit_hits (client_key, window_start) values ($1, now())", [k]);
      await assertAllowed(writer, "select count(*) from checkin_rate_limit_hits");
      await assertRefused(writer, "update checkin_rate_limit_hits set window_start = now()");
      await assertRefused(writer, "delete from checkin_rate_limit_hits");
      await assertRefused(writer, "truncate checkin_rate_limit_hits");
    }));

  test("other app roles get nothing", () =>
    inRollback(admin, async () => {
      await assertRefused(admin, "select 1 from checkin_rate_limit_hits");
      await assertRefused(admin, "insert into checkin_rate_limit_hits (client_key, window_start) values ($1, now())", [key("x")]);
    }));

  test("only a SHA-256 hex digest is accepted as the client key, never a raw IP", () =>
    inRollback(owner, async () => {
      await assertRefused(owner, "insert into checkin_rate_limit_hits (client_key, window_start) values ('203.0.113.7', now())",
        [], /violates check constraint/);
    }));
});

describe("recordAttemptUnderLimit, as checkin_writer", () => {
  test("records under the limit, at the limit, and refuses over it without writing", async () => {
    const clientKey = key(unique("ip"));
    const windowStart = new Date("2026-11-24T13:00:00Z");
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await store.recordAttemptUnderLimit({ clientKey, windowStart, limit: 3 }));
    assert.deepEqual(results, [true, true, true, false]);

    const { rows: [{ n }] } = await owner.query(
      "select count(*)::int as n from checkin_rate_limit_hits where client_key = $1", [clientKey]);
    assert.equal(n, 3);
  });

  test("a new window starts from zero, and other IPs are counted apart", async () => {
    const clientKey = key(unique("ip"));
    const other = key(unique("ip"));
    const w1 = new Date("2026-11-24T13:00:00Z");
    const w2 = new Date("2026-11-24T14:00:00Z");
    assert.equal(await store.recordAttemptUnderLimit({ clientKey, windowStart: w1, limit: 1 }), true);
    assert.equal(await store.recordAttemptUnderLimit({ clientKey, windowStart: w1, limit: 1 }), false);
    assert.equal(await store.recordAttemptUnderLimit({ clientKey: other, windowStart: w1, limit: 1 }), true);
    assert.equal(await store.recordAttemptUnderLimit({ clientKey, windowStart: w2, limit: 1 }), true);
  });
});

describe("the check-in handler end to end", () => {
  test("over the limit a POST gets 429 and writes no attendee or check-in", async () => {
    // checkin.js reads its limit from config at import; 200 per hour by default.
    const require = createRequire(import.meta.url);
    const { handler } = require("../../backend/netlify/functions/checkin.js");
    const ip = `198.18.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
    const k = key(ip);

    // Fill this IP's current window to the limit as the owner (the current window's
    // start is the clock hour, matching the default 3600 s window).
    await owner.query(
      `insert into checkin_rate_limit_hits (client_key, window_start)
       select $1, to_timestamp(floor(extract(epoch from now()) / 3600) * 3600)
       from generate_series(1, 200)`, [k]);

    const email = `${unique("limited")}@example.com`;
    const res = await handler({
      httpMethod: "POST",
      headers: { "x-nf-client-connection-ip": ip },
      body: JSON.stringify({ email, name: "Limited Person", eventId: "bocc", token: "t", debug: "1" }),
    });
    assert.equal(res.statusCode, 429, res.body);
    // The message names the minutes left in the clock hour, matching Retry-After.
    const minutes = Number(JSON.parse(res.body).message.match(/about (\d+) minutes?\./)[1]);
    assert.equal(minutes, Math.ceil(Number(res.headers["Retry-After"]) / 60));

    const { rows } = await owner.query("select 1 from attendees where email = $1", [email]);
    assert.equal(rows.length, 0);

    // Another IP is unaffected.
    const ok = await handler({
      httpMethod: "POST",
      headers: { "x-nf-client-connection-ip": "198.51.100.77" },
      body: JSON.stringify({ email, name: "Limited Person", eventId: "bocc", token: "t", debug: "1" }),
    });
    assert.equal(ok.statusCode, 200, ok.body);
  });
});
