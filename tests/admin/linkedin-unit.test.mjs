// Pure LinkedIn rules (ADR 0012, issue #23): no database, no network. Runs on its own:
//   node --test tests/admin/linkedin-unit.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readLinkedInEnv } from "../../src/lib/linkedin/env.mjs";
import { expiryAlertDue, expiryLevel, missingScopes, SCOPES } from "../../src/lib/linkedin/rules.mjs";
import { decryptToken, encryptToken, signState, verifyState } from "../../src/lib/linkedin/crypto.mjs";

const KEY_HEX = "a".repeat(64);
const good = {
  LINKEDIN_CLIENT_ID: "86abc123xyz",
  LINKEDIN_CLIENT_SECRET: "WPL_AP1.secretvalue.abc==",
  LINKEDIN_TOKEN_KEY: KEY_HEX,
};

describe("readLinkedInEnv", () => {
  it("is switched off, without throwing, when no LinkedIn variable is set", () => {
    const r = readLinkedInEnv({});
    assert.equal(r.enabled, false);
    assert.match(r.message, /LINKEDIN_CLIENT_ID/);
  });

  it("reads a complete configuration, dry run unless LINKEDIN_LIVE=1", () => {
    const r = readLinkedInEnv(good);
    assert.equal(r.enabled, true);
    assert.equal(r.config.clientId, good.LINKEDIN_CLIENT_ID);
    assert.equal(r.config.clientSecret, good.LINKEDIN_CLIENT_SECRET);
    assert.equal(r.config.tokenKey.length, 32);
    assert.equal(r.config.live, false);
    assert.equal(readLinkedInEnv({ ...good, LINKEDIN_LIVE: "1" }).config.live, true);
  });

  it("accepts the token key as 64 hex characters or base64 of 32 bytes", () => {
    const b64 = Buffer.alloc(32, 7).toString("base64");
    assert.deepEqual(readLinkedInEnv({ ...good, LINKEDIN_TOKEN_KEY: b64 }).config.tokenKey, Buffer.alloc(32, 7));
  });

  for (const [name, env, pattern] of [
    ["a missing secret", { ...good, LINKEDIN_CLIENT_SECRET: "" }, /LINKEDIN_CLIENT_SECRET is not set/],
    ["a missing client id", { ...good, LINKEDIN_CLIENT_ID: undefined }, /LINKEDIN_CLIENT_ID is not set/],
    ["a short token key", { ...good, LINKEDIN_TOKEN_KEY: "abcd" }, /LINKEDIN_TOKEN_KEY must be 32 bytes/],
    ["a bad LINKEDIN_LIVE", { ...good, LINKEDIN_LIVE: "true" }, /LINKEDIN_LIVE must be "1" or unset/],
    ["LINKEDIN_LIVE alone", { LINKEDIN_LIVE: "1" }, /LINKEDIN_CLIENT_ID is not set/],
  ]) {
    it(`fails fast on ${name}, naming the variable and never a value`, () => {
      assert.throws(() => readLinkedInEnv(env), (err) => {
        assert.match(err.message, /^\[linkedin env\] Misconfigured/);
        assert.match(err.message, pattern);
        for (const v of Object.values(good)) assert.ok(!err.message.includes(v), "a value leaked into the message");
        return true;
      });
    });
  }

  it("lists every problem at once", () => {
    assert.throws(() => readLinkedInEnv({ LINKEDIN_TOKEN_KEY: "x" }), (err) =>
      /LINKEDIN_CLIENT_ID/.test(err.message) && /LINKEDIN_CLIENT_SECRET/.test(err.message) && /LINKEDIN_TOKEN_KEY/.test(err.message));
  });
});

describe("expiryLevel", () => {
  const now = new Date("2026-11-19T15:00:00Z");
  const at = (days) => new Date(now.getTime() + days * 86_400_000);

  it("is ok with 7 days or more left, and counts whole days", () => {
    assert.deepEqual(expiryLevel(at(59.5), now), { level: "ok", daysLeft: 59 });
    assert.deepEqual(expiryLevel(at(7), now), { level: "ok", daysLeft: 7 });
  });
  it("is amber under 7 days", () => {
    assert.deepEqual(expiryLevel(at(6.99), now), { level: "amber", daysLeft: 6 });
    assert.deepEqual(expiryLevel(at(0.25), now), { level: "amber", daysLeft: 0 });
  });
  it("is red once expired", () => {
    assert.deepEqual(expiryLevel(now, now), { level: "red", daysLeft: 0 });
    assert.deepEqual(expiryLevel(at(-3), now), { level: "red", daysLeft: 0 });
  });
});

describe("expiryAlertDue (the Thursday ntfy threshold)", () => {
  const now = new Date("2026-11-19T14:00:00Z");
  const at = (days) => new Date(now.getTime() + days * 86_400_000);

  it("stays quiet with 10 days or more left", () => {
    assert.equal(expiryAlertDue(at(59), now), false);
    assert.equal(expiryAlertDue(at(10), now), false);
  });
  it("alerts under 10 days", () => {
    assert.equal(expiryAlertDue(at(9.99), now), true);
    assert.equal(expiryAlertDue(at(1), now), true);
  });
  it("alerts once expired", () => {
    assert.equal(expiryAlertDue(now, now), true);
    assert.equal(expiryAlertDue(at(-30), now), true);
  });
  it("takes the timestamptz as a string too", () => {
    assert.equal(expiryAlertDue("2026-11-25T14:00:00Z", now), true);
    assert.equal(expiryAlertDue("2026-12-25T14:00:00Z", now), false);
  });
});

describe("missingScopes", () => {
  it("requests the CLI's five scopes", () => {
    assert.deepEqual([...SCOPES], ["r_events", "rw_events", "openid", "profile", "w_member_social"]);
  });
  it("reads LinkedIn's comma- or space-separated grant", () => {
    assert.deepEqual(missingScopes("r_events,rw_events,openid,profile,w_member_social"), []);
    assert.deepEqual(missingScopes("openid profile"), ["r_events", "rw_events", "w_member_social"]);
    assert.deepEqual(missingScopes(undefined), [...SCOPES]);
  });
});

describe("token encryption (AES-256-GCM)", () => {
  const key = Buffer.alloc(32, 1);
  const token = "AQX-example-access-token-0123456789";

  it("round-trips, and the stored bytes never contain the token", () => {
    const box = encryptToken(token, { key, userId: "u1" });
    assert.ok(Buffer.isBuffer(box));
    assert.ok(!box.includes(Buffer.from(token)));
    assert.equal(decryptToken(box, { key, userId: "u1" }), token);
  });
  it("uses a fresh IV each time", () => {
    assert.notDeepEqual(encryptToken(token, { key, userId: "u1" }), encryptToken(token, { key, userId: "u1" }));
  });
  it("refuses the wrong key, another user's row, and tampering", () => {
    const box = encryptToken(token, { key, userId: "u1" });
    assert.throws(() => decryptToken(box, { key: Buffer.alloc(32, 2), userId: "u1" }));
    assert.throws(() => decryptToken(box, { key, userId: "u2" }));
    const bad = Buffer.from(box);
    bad[bad.length - 1] ^= 1;
    assert.throws(() => decryptToken(bad, { key, userId: "u1" }));
  });
});

describe("OAuth state cookie", () => {
  const key = Buffer.alloc(32, 3);
  const now = new Date("2026-11-19T15:00:00Z");
  const later = (s) => new Date(now.getTime() + s * 1000);

  it("signs a random state and verifies it for the same user, returning where to go back to", () => {
    const a = signState({ key, userId: "u1", returnTo: "2026-11-24", now });
    const b = signState({ key, userId: "u1", returnTo: "account", now });
    assert.match(a.state, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(a.state, b.state);
    assert.ok(!a.cookie.includes(key.toString("hex")));
    assert.deepEqual(verifyState(a.cookie, a.state, { key, userId: "u1", now: later(60) }), { ok: true, returnTo: "2026-11-24" });
    assert.deepEqual(verifyState(b.cookie, b.state, { key, userId: "u1", now }), { ok: true, returnTo: "account" });
  });

  it("refuses a missing or mismatched state, another user, an expired or forged cookie", () => {
    const { state, cookie } = signState({ key, userId: "u1", returnTo: "account", now });
    const other = signState({ key, userId: "u1", returnTo: "account", now });
    const ok = { key, userId: "u1", now };
    assert.equal(verifyState(cookie, null, ok).ok, false);
    assert.equal(verifyState(cookie, "", ok).ok, false);
    assert.equal(verifyState(null, state, ok).ok, false);
    assert.equal(verifyState(cookie, other.state, ok).ok, false);
    assert.equal(verifyState(other.cookie, state, ok).ok, false);
    assert.equal(verifyState(cookie, state, { ...ok, userId: "u2" }).ok, false);
    assert.equal(verifyState(cookie, state, { ...ok, key: Buffer.alloc(32, 4) }).ok, false);
    assert.equal(verifyState(cookie, state, { ...ok, now: later(601) }).ok, false);
    assert.equal(verifyState(cookie.slice(0, -2) + "AA", state, ok).ok, false);
    assert.equal(verifyState("garbage", state, ok).ok, false);
  });

  it("only accepts a date or the account page as the return target", () => {
    assert.throws(() => signState({ key, userId: "u1", returnTo: "https://evil.example/", now }));
    assert.throws(() => signState({ key, userId: "u1", returnTo: "2026-13-45x", now }));
  });
});
