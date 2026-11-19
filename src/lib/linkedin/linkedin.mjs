// The LinkedIn use-case (ADR 0012, issue #18 "LinkedIn use-case"): one module with a
// small interface that owns every LinkedIn database write. Routes stay thin: they
// parse the request, call one function here and turn the result into a response.
//
// Interface (this ticket, #23: the per-user connection):
//   startConnect(userId, { returnTo })                    -> { location, cookie }
//   finishConnect(userId, { code, state, error, cookie }) -> { ok, returnTo, notice } | { ok: false, status: 400 }
//   disconnect(userId)                                    -> { changed }
//   connectionStatus(db, userId)                          -> null | { name, memberUrn, expiresAt, level, daysLeft }
//   accessToken(db, userId)                               -> the decrypted token (for the create flow)
// Later tickets add here: preview, create, publishRetry, allowRetry and
// markCancelledOnLinkedIn (#25, #26), all taking the same injected `client` and
// `config` options so tests swap in tests/admin/fake-linkedin.mjs.
//
// Every function takes optional { config, client, baseURL, now } for tests; by default
// config comes from the env (src/lib/linkedin/env.mjs, fail fast), the client from
// client.mjs and baseURL from BETTER_AUTH_URL (the per-context origin, never Netlify's
// URL / DEPLOY_PRIME_URL).
//
// Tables (migration 20261124120000_linkedin_connections.sql; admin_app has
// SELECT/INSERT/UPDATE/DELETE): linkedin_connections, one row per user, the token
// AES-256-GCM encrypted (crypto.mjs). Audit actions: linkedin_connection.connect
// (details { reconnect, expires_at }) and linkedin_connection.disconnect. Never a
// token, code or state in an audit row, log line or span attribute.

import { adminEnv } from "../auth/auth.mjs";
import { withAudit } from "../admin/db.mjs";
import { describeError, log } from "../telemetry.mjs";
import { decryptToken, encryptToken, signState, STATE_TTL_SECONDS, verifyState } from "./crypto.mjs";
import { LinkedInError, authorizationUrl, linkedInClient } from "./client.mjs";
import { readLinkedInEnv } from "./env.mjs";
import { expiryLevel, missingScopes } from "./rules.mjs";

/** The state cookie, scoped to the LinkedIn routes. */
export const STATE_COOKIE = "bocc_linkedin_state";
export const CALLBACK_PATH = "/api/admin/linkedin/callback";

let cachedEnv;
/** The LinkedIn env, read once. Throws (fail fast) when misconfigured. */
export function linkedInEnv() {
  cachedEnv ??= readLinkedInEnv();
  return cachedEnv;
}

/** The config, or a LinkedInError when LinkedIn isn't configured on this deploy. */
function requireConfig(config) {
  if (config) return config;
  const env = linkedInEnv();
  if (!env.enabled) throw new LinkedInError("refused", env.message);
  return env.config;
}

const NOOP = Symbol("noop");
const redirectUri = (baseURL) => `${baseURL}${CALLBACK_PATH}`;

/**
 * Begin the OAuth flow: a fresh state in a signed cookie, and LinkedIn's authorize URL.
 * @param {string} userId
 * @param {{ returnTo: string, config?: any, baseURL?: string, now?: Date }} opts  returnTo: "account" or a date
 * @returns {{ location: string, cookie: { name: string, value: string, maxAge: number } }}
 */
export function startConnect(userId, { returnTo, config, baseURL = adminEnv.baseURL, now = new Date() }) {
  const cfg = requireConfig(config);
  const { state, cookie } = signState({ key: cfg.tokenKey, userId, returnTo, now });
  return {
    location: authorizationUrl({ clientId: cfg.clientId, redirectUri: redirectUri(baseURL), state }),
    cookie: { name: STATE_COOKIE, value: cookie, maxAge: STATE_TTL_SECONDS },
  };
}

/**
 * The OAuth callback: check state, exchange the code, read the profile, store the
 * encrypted token (insert, or replace on reconnect), audited.
 * @param {string} userId  the signed-in Admin
 * @param {{ code?: string|null, state?: string|null, error?: string|null, cookie?: string|null }} input
 * @param {{ config?: any, client?: any, baseURL?: string, now?: Date }} [opts]
 * @returns {Promise<{ ok: true, returnTo: string, notice: "connected" }
 *   | { ok: false, returnTo: string, notice: "cancelled"|"failed"|"scopes" }
 *   | { ok: false, status: 400 }>}
 */
export async function finishConnect(userId, { code, state, error, cookie }, { config, client, baseURL = adminEnv.baseURL, now = new Date() } = {}) {
  const cfg = requireConfig(config);
  const checked = verifyState(cookie, state, { key: cfg.tokenKey, userId, now });
  if (!checked.ok) {
    log("warn", "linkedin connect: state refused", { reason: checked.reason });
    return { ok: false, status: 400 };
  }
  const { returnTo } = checked;
  if (error) return { ok: false, returnTo, notice: "cancelled" };
  if (!code) return { ok: false, returnTo, notice: "failed" };

  const li = client ?? linkedInClient(cfg);
  let token, profile;
  try {
    token = await li.exchangeCode({ code, redirectUri: redirectUri(baseURL) });
    if (missingScopes(token.scope).length) return { ok: false, returnTo, notice: "scopes" };
    profile = await li.getProfile(token.accessToken);
  } catch (err) {
    if (!(err instanceof LinkedInError)) throw err;
    log("error", `linkedin connect failed: ${describeError(err)}`, { kind: err.kind });
    return { ok: false, returnTo, notice: "failed" };
  }

  const expiresAt = new Date(now.getTime() + token.expiresIn * 1000);
  const box = encryptToken(token.accessToken, { key: cfg.tokenKey, userId });
  await withAudit(userId, async (c) => {
    const { rows } = await c.query(
      `insert into public.linkedin_connections (user_id, token_ciphertext, expires_at, member_urn, display_name, scope, connected_at)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (user_id) do update
          set token_ciphertext = excluded.token_ciphertext, expires_at = excluded.expires_at,
              member_urn = excluded.member_urn, display_name = excluded.display_name,
              scope = excluded.scope, connected_at = excluded.connected_at
       returning (xmax <> 0) as reconnect`,
      [userId, box, expiresAt, profile.memberUrn, profile.name, String(token.scope).slice(0, 500), now],
    );
    return rows[0].reconnect;
  }, (reconnect) => ({
    action: "linkedin_connection.connect",
    targetTable: "linkedin_connections",
    targetId: userId,
    details: { reconnect, expires_at: expiresAt.toISOString() },
  }));
  return { ok: true, returnTo, notice: "connected" };
}

/**
 * Delete the user's connection (audited). LinkedIn's own grant is revoked by the member
 * on PERMITTED_SERVICES_URL (rules.mjs); the app has no revoke endpoint.
 * @param {string} userId
 * @returns {Promise<{ changed: boolean }>}
 */
export async function disconnect(userId) {
  try {
    await withAudit(userId, async (c) => {
      const { rowCount } = await c.query(`delete from public.linkedin_connections where user_id = $1`, [userId]);
      if (rowCount === 0) throw NOOP;
    }, { action: "linkedin_connection.disconnect", targetTable: "linkedin_connections", targetId: userId });
    return { changed: true };
  } catch (err) {
    if (err === NOOP) return { changed: false };
    throw err;
  }
}

/**
 * The user's connection as the page shows it, or null when not connected.
 * @param {{ query: Function }} db
 * @param {string} userId
 * @param {{ now?: Date }} [opts]
 */
export async function connectionStatus(db, userId, { now = new Date() } = {}) {
  const { rows } = await db.query(
    `select display_name, member_urn, expires_at from public.linkedin_connections where user_id = $1`, [userId]);
  if (!rows[0]) return null;
  const { display_name: name, member_urn: memberUrn, expires_at: expiresAt } = rows[0];
  return { name, memberUrn, expiresAt, ...expiryLevel(expiresAt, now) };
}

/**
 * The user's decrypted access token, for calls to LinkedIn. Never log or return it to
 * the browser.
 * @param {{ query: Function }} db
 * @param {string} userId
 * @param {{ config?: any, now?: Date }} [opts]
 * @throws {LinkedInError} kind "expired" when not connected or expired
 */
export async function accessToken(db, userId, { config, now = new Date() } = {}) {
  const cfg = requireConfig(config);
  const { rows } = await db.query(
    `select token_ciphertext, expires_at from public.linkedin_connections where user_id = $1`, [userId]);
  if (!rows[0]) throw new LinkedInError("expired", "linkedin: not connected");
  if (expiryLevel(rows[0].expires_at, now).level === "red") throw new LinkedInError("expired", "linkedin: connection expired");
  return decryptToken(rows[0].token_ciphertext, { key: cfg.tokenKey, userId });
}

