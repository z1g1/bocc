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
// The weekly event (#25):
//   linkedInEventPreview(db, userId, date)                -> { mode, action, refusals, ledger, connection, image, spec, payloads }
//   createLinkedInEvent(userId, date, { confirm })        -> { ok: true, mode: "dry_run", requests, image, duplicateCheck }
//                                                            | { ok: false, refusals, preview }
//   The dry run sends nothing and writes no ledger row.
// The live sequence and recovery (#26):
//   createLinkedInEvent, live (LINKEDIN_LIVE=1)          -> { ok: true, mode: "live", status: "posted", ledger, preview }
//                                                            | { ok: false, mode: "live", status, failure, refusals: [], preview }
//     commits the ledger row `pending` (audited) BEFORE anything is sent, then uploads
//     the cover, creates the event, moves the row to `created` (audited), creates the
//     member post and moves the row to `posted` (audited) with the event's
//     `linkedin_event` listing filled in the same transaction (event_link.set). A
//     failure leaves the last committed state; `failure` says which step and why.
//   publishRetry(userId, date, { confirm })             -> the same shapes; a `created` row only: posts, never re-creates
//   allowRetry(userId, date)                            -> { ok: true } | { ok: false, refusals }
//     retires a `pending` row (admin_app has no DELETE on linkedin_events), audited.
// Audit actions (target linkedin_events, the row id; details.eventDate):
//   linkedin_event.pending, .created, .posted ({ retry }), .retire
// Every function takes the injected `client` and `config` options, so tests swap in
// tests/admin/fake-linkedin.mjs.
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
import { pool, withAudit, writeAudit } from "../admin/db.mjs";
import { describeError, log } from "../telemetry.mjs";
import { decryptToken, encryptToken, signState, STATE_TTL_SECONDS, verifyState } from "./crypto.mjs";
import { API_BASE, LinkedInError, authorizationUrl, linkedInClient } from "./client.mjs";
import { readLinkedInEnv } from "./env.mjs";
import {
  ORGANIZER_URN, REFUSALS, allowedActions, buildEventPayload, buildEventSpec, buildImageUploadPayload,
  buildPostPayload, checkCoverImage, createRefusals, eventUrl, expiryLevel, findDuplicates, missingScopes, postUrl,
} from "./rules.mjs";
import { normaliseLinkUrl } from "../admin/event-links-rules.mjs";
import { getEvent } from "../admin/events.mjs";
import { getEventImage, loadCoverBytes } from "../admin/event-image.mjs";

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

const RETURN_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A valid return target from a request ("account" or a date), else null. */
export function parseReturnTo(raw) {
  const v = String(raw ?? "");
  if (v === "account") return v;
  if (!RETURN_DATE.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : null;
}

/** Where the routes send the browser back to, with ?linkedin=<notice>#linkedin. */
export function returnLocation(returnTo, notice) {
  const base = returnTo === "account" ? "/admin/account/?" : `/admin/events/${returnTo}/?tab=social&`;
  return `${base}linkedin=${encodeURIComponent(notice)}#linkedin`;
}

/** Set-Cookie for the state cookie (value "" with maxAge 0 clears it). */
export function stateCookieHeader(value, maxAge, baseURL = adminEnv.baseURL) {
  const secure = baseURL.startsWith("https:") ? "; Secure" : "";
  // Lax, not Strict: the callback is a top-level GET navigation from linkedin.com.
  return `${STATE_COOKIE}=${value}; Path=/api/admin/linkedin/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

/** The state cookie's value from a Cookie request header, or null. */
export function readStateCookie(cookieHeader) {
  for (const part of String(cookieHeader ?? "").split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === STATE_COOKIE) return part.slice(i + 1) || null;
  }
  return null;
}

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

// ── The weekly LinkedIn event (#25: preview and dry run; #26: the live sequence) ──

/** Stand-ins, in the preview and the dry run, for values only LinkedIn's replies give. */
export const PLACEHOLDERS = Object.freeze({
  member: "urn:li:person:<your LinkedIn member id>",
  asset: "urn:li:digitalmediaAsset:<from the image upload>",
  eventId: "<event id from the create>",
  uploadUrl: "<the uploadUrl LinkedIn returns>",
  postUrn: "<post id from the post>",
});

/** The date's active (not retired) ledger row, or null. */
async function activeLedgerRow(db, date) {
  const { rows } = await db.query(
    `select id, status, name, commentary, location, image_source as "imageSource", image_ref as "imageRef",
            linkedin_event_id as "linkedinEventId", event_url as "eventUrl", post_urn as "postUrn", post_url as "postUrl",
            created_by as "createdBy", attempted_at as "attemptedAt", posted_at as "postedAt",
            cancelled_on_linkedin_at as "cancelledOnLinkedInAt"
       from public.linkedin_events where event_date = $1 and status <> 'retired'`, [date]);
  return rows[0] ?? null;
}

/** The three bodies the app sends, with placeholders for what LinkedIn's replies fill in. */
function payloadsFor(spec, memberUrn) {
  return {
    imageUpload: buildImageUploadPayload(memberUrn),
    event: buildEventPayload(spec, PLACEHOLDERS.asset),
    post: buildPostPayload(memberUrn, PLACEHOLDERS.eventId, spec.commentary),
  };
}

const describeBytes = (bytes, contentType) => {
  const c = checkCoverImage(bytes);
  return `${bytes.length} bytes of ${contentType}${c.width ? ` (${c.width}×${c.height})` : ""}`;
};

/**
 * Stands in for the client's write operations on a dry run: records each request it
 * would have sent (never the token) and answers with placeholders. Nothing leaves the app.
 */
function recordingClient() {
  const requests = [];
  return {
    requests,
    async initializeImageUpload(_token, ownerUrn) {
      requests.push({ op: "initializeImageUpload", method: "POST", url: `${API_BASE}/rest/images?action=initializeUpload`, body: buildImageUploadPayload(ownerUrn) });
      return { uploadUrl: PLACEHOLDERS.uploadUrl, imageUrn: null, assetUrn: PLACEHOLDERS.asset };
    },
    async uploadImage(_token, uploadUrl, bytes, contentType) {
      requests.push({ op: "uploadImage", method: "PUT", url: uploadUrl, body: describeBytes(bytes, contentType) });
    },
    async createEvent(_token, payload) {
      requests.push({ op: "createEvent", method: "POST", url: `${API_BASE}/rest/events`, body: payload });
      return { id: PLACEHOLDERS.eventId, vanityName: null };
    },
    async createPost(_token, payload) {
      requests.push({ op: "createPost", method: "POST", url: `${API_BASE}/rest/posts`, body: payload });
      return { postUrn: PLACEHOLDERS.postUrn };
    },
  };
}

/**
 * The write calls in order: upload the cover, create the event, publish the post. The
 * dry run runs it against recordingClient(). #26 runs the same steps against the real
 * client with the ledger transitions between them (pending committed first, then
 * created after createEvent, posted after createPost).
 */
async function sendSequence(writer, token, { spec, memberUrn, cover }) {
  const upload = await writer.initializeImageUpload(token, memberUrn);
  await writer.uploadImage(token, upload.uploadUrl, cover.bytes, cover.contentType);
  const created = await writer.createEvent(token, buildEventPayload(spec, upload.assetUrn));
  const posted = await writer.createPost(token, buildPostPayload(memberUrn, created.id, spec.commentary));
  return { upload, created, posted };
}

/**
 * Everything the LinkedIn section shows for one date: the mode, the action on offer and
 * why create can't run, the ledger row, the connection, the cover, and the payloads.
 * @param {{ query: Function }} db
 * @param {string} userId  the signed-in Admin
 * @param {string} date
 * @param {{ config?: any, now?: Date }} [opts]
 */
export async function linkedInEventPreview(db, userId, date, { config, now = new Date() } = {}) {
  const cfg = requireConfig(config);
  const [event, ledger, connection, image] = await Promise.all([
    getEvent(db, date), activeLedgerRow(db, date), connectionStatus(db, userId, { now }), getEventImage(db, date),
  ]);
  const ctx = { date, now, event: { status: event.status, location: event.location }, ledger, connection, live: cfg.live };
  const { action, mode, refusals } = allowedActions(ctx);
  const built = buildEventSpec({ date, location: event.location });
  const spec = built.ok ? built.spec : null;
  return {
    date, mode, action, refusals, ctx, ledger, connection, image, spec,
    payloads: spec ? payloadsFor(spec, connection?.memberUrn ?? PLACEHOLDERS.member) : null,
  };
}

/**
 * The Create live event button. Refused unless the request carries confirm=live (the
 * dialog) and the allowed-actions matrix allows create. When connected, the read-only
 * organizer listing refuses a duplicate (same name, old or new style, or the same
 * Eastern day). The cover's bytes are read and checked. Then:
 *   dry run (no LINKEDIN_LIVE): the requests that would be sent; nothing is sent to
 *     LinkedIn and no ledger row or audit row is written
 *   live: the ledger-guarded sequence (liveSequence)
 * @param {string} userId
 * @param {string} date
 * @param {{ confirm?: unknown }} request
 * @param {{ config?: any, client?: any, now?: Date, storage?: any, readAsset?: (path: string) => Promise<Buffer> }} [opts]
 */
export async function createLinkedInEvent(userId, date, { confirm }, { config, client, now = new Date(), storage = null, readAsset } = {}) {
  const cfg = requireConfig(config);
  const preview = await linkedInEventPreview(pool, userId, date, { config: cfg, now });
  const refuse = (refusals, extra = {}) => ({ ok: false, mode: preview.mode, refusals, preview, ...extra });

  const refusals = createRefusals(preview.ctx, { confirm });
  if (refusals.length) return refuse(refusals);
  const { spec, connection } = preview;

  const li = client ?? linkedInClient(cfg);
  let token = null;
  let duplicateCheck = "skipped";
  if (connection && connection.level !== "red") {
    try {
      token = await accessToken(pool, userId, { config: cfg, now });
      const duplicates = findDuplicates(await li.listOrganizerEvents(token, ORGANIZER_URN), spec);
      if (duplicates.length) {
        return refuse([{ code: "duplicate", message: REFUSALS.duplicate }], {
          duplicates: duplicates.map((d) => ({ id: d.id == null ? null : String(d.id), name: d.name?.localized?.en_US ?? null, startsAt: d.startsAt ?? null })),
        });
      }
      duplicateCheck = "passed";
    } catch (err) {
      if (!(err instanceof LinkedInError)) throw err;
      log("error", `linkedin duplicate check failed: ${describeError(err)}`, { kind: err.kind });
      return refuse([{ code: "linkedin", message: err.userMessage }]);
    }
  }

  let cover;
  try {
    cover = await loadCoverBytes(preview.image, { storage, readAsset });
  } catch (err) {
    log("error", `linkedin cover unreadable: ${describeError(err)}`, { date });
    return refuse([{ code: "image", message: `${REFUSALS.image} It couldn't be read: try again, or set the Event Image again.` }]);
  }
  const image = checkCoverImage(cover.bytes);
  if (!image.ok) return refuse([{ code: "image", message: `${REFUSALS.image} ${image.errors.join(" ")}` }], { image });

  if (cfg.live) {
    return liveSequence({ userId, date, token, li, spec, memberUrn: connection.memberUrn, cover, image, eventImage: preview.image, cfg, now, duplicateCheck });
  }

  const recorder = recordingClient();
  await sendSequence(recorder, token, { spec, memberUrn: connection?.memberUrn ?? PLACEHOLDERS.member, cover });
  return { ok: true, mode: "dry_run", duplicateCheck, image, requests: recorder.requests, preview };
}


// ── The live sequence and its recovery (#26) ───────────────────────────────────

/** The ledger row's audit entry. */
const ledgerAudit = (action, date, details = {}) => (row) => ({
  action, targetTable: "linkedin_events", targetId: row.id, details: { eventDate: date, ...details },
});

/** Kinds of LinkedIn error after which nothing exists on LinkedIn: it said no. */
const DEFINITE_NO = new Set(["expired", "page_role", "validation", "hidden_post", "refused"]);

/**
 * What the page says about a failed step.
 * @param {"image_init"|"image_upload"|"create"|"post"} step
 * @param {unknown} err
 * @returns {{ step: string, kind: string, message: string, nothingCreated: boolean }}
 */
function failureOf(step, err) {
  const known = err instanceof LinkedInError;
  const kind = known ? err.kind : "unknown";
  log("error", `linkedin ${step} failed: ${describeError(err)}`, { step, kind });
  let message = known ? err.userMessage : new LinkedInError("unknown", "").userMessage;
  if (kind === "validation" && err.detail) message = `${message} LinkedIn said: ${err.detail}`;
  const nothingCreated = step === "image_init" || step === "image_upload" || (step === "create" && DEFINITE_NO.has(kind));
  return { step, kind, message, nothingCreated };
}

/** Move a `created` row to `posted` and fill the event's linkedin_event listing, one transaction. */
async function markPosted(userId, date, row, postUrn, { now, retry }) {
  const listingUrl = normaliseLinkUrl("linkedin_event", row.eventUrl);
  await withAudit(userId, async (c) => {
    const { rowCount } = await c.query(
      `update public.linkedin_events set status = 'posted', post_urn = $2, post_url = $3, posted_at = $4
        where id = $1 and status = 'created'`, [row.id, postUrn, postUrl(postUrn), now]);
    if (rowCount !== 1) throw new Error("linkedin ledger: the row is no longer `created`");
    const { rows } = await c.query(
      `select url, external_id from public.event_links where event_date = $1::date and platform = 'linkedin_event' for update`, [date]);
    const before = rows[0] ?? null;
    if (before?.url !== listingUrl) {
      await c.query(
        `insert into public.event_links (event_date, platform, url, external_id) values ($1::date, 'linkedin_event', $2, null)
         on conflict (event_date, platform) do update set url = excluded.url, external_id = null`, [date, listingUrl]);
      await writeAudit(c, userId, {
        action: "event_link.set", targetTable: "event_links", targetId: date,
        details: { platform: "linkedin_event", created: false, before, after: { url: listingUrl, external_id: null }, from: "linkedin_event.posted" },
      });
    }
    return row;
  }, ledgerAudit("linkedin_event.posted", date, { postUrn, retry }));
}

/** A failed live step's result: the row as now committed, and why. */
async function failed(userId, date, cfg, now, step, err, extra = {}) {
  const preview = await linkedInEventPreview(pool, userId, date, { config: cfg, now });
  return { ok: false, mode: "live", status: preview.ledger?.status ?? null, failure: failureOf(step, err), refusals: [], preview, ...extra };
}

/** Posted: the result the page shows. */
async function succeeded(userId, date, cfg, now, extra = {}) {
  const preview = await linkedInEventPreview(pool, userId, date, { config: cfg, now });
  return { ok: true, mode: "live", status: "posted", ledger: preview.ledger, preview, ...extra };
}

/**
 * The live create: pending (committed first), upload, create, created, post, posted.
 * Never retried automatically: a failure stops at the last committed state.
 */
async function liveSequence({ userId, date, token, li, spec, memberUrn, cover, image, eventImage, cfg, now, duplicateCheck }) {
  const c = eventImage.cover;
  let row;
  try {
    row = await withAudit(userId, async (client) => {
      const { rows } = await client.query(
        `insert into public.linkedin_events
           (event_date, status, name, commentary, location, image_source, image_ref, image_media_id, created_by, attempted_at)
         values ($1, 'pending', $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (event_date) where status <> 'retired' do nothing
         returning id`,
        [date, spec.name, spec.commentary, spec.location, eventImage.source, "path" in c ? c.path : c.key, eventImage.mediaId, userId, now]);
      if (!rows[0]) throw NOOP;
      return { id: rows[0].id };
    }, ledgerAudit("linkedin_event.pending", date, { name: spec.name, location: spec.location, imageSource: eventImage.source }));
  } catch (err) {
    if (err !== NOOP) throw err;
    // A second tab or a double click got there first.
    const again = await linkedInEventPreview(pool, userId, date, { config: cfg, now });
    return { ok: false, mode: "live", refusals: [{ code: "ledger", message: REFUSALS.ledger }], preview: again };
  }

  const extra = { image, duplicateCheck };
  let step = "image_init";
  let created, url;
  try {
    const upload = await li.initializeImageUpload(token, memberUrn);
    step = "image_upload";
    await li.uploadImage(token, upload.uploadUrl, cover.bytes, cover.contentType);
    step = "create";
    created = await li.createEvent(token, buildEventPayload(spec, upload.assetUrn));
    url = eventUrl(created.id, created.vanityName);
    await withAudit(userId, async (client) => {
      const { rowCount } = await client.query(
        `update public.linkedin_events
            set status = 'created', linkedin_event_id = $2, event_url = $3, event_created_at = $4, image_asset_urn = $5
          where id = $1 and status = 'pending'`, [row.id, created.id, url, now, upload.assetUrn]);
      if (rowCount !== 1) throw new Error("linkedin ledger: the row is no longer `pending`");
      return row;
    }, ledgerAudit("linkedin_event.created", date, { linkedinEventId: created.id, eventUrl: url }));
  } catch (err) {
    // Whatever LinkedIn did, the row is still `pending`: the page says to check LinkedIn.
    return failed(userId, date, cfg, now, step, err, extra);
  }

  const createdRow = { id: row.id, linkedinEventId: created.id, eventUrl: url, commentary: spec.commentary };
  return postAndMark({ userId, date, token, li, memberUrn, row: createdRow, cfg, now, retry: false, extra });
}

/** Create the member post for a `created` row, then mark it posted. */
async function postAndMark({ userId, date, token, li, memberUrn, row, cfg, now, retry, extra = {} }) {
  let posted;
  try {
    posted = await li.createPost(token, buildPostPayload(memberUrn, row.linkedinEventId, row.commentary));
  } catch (err) {
    return failed(userId, date, cfg, now, "post", err, extra);
  }
  try {
    await markPosted(userId, date, row, posted.postUrn, { now, retry });
  } catch (err) {
    // The post is out but the ledger still says `created`: say so, rather than invite a second post.
    log("error", `linkedin ledger: posted but not recorded: ${describeError(err)}`, { date });
    const why = new LinkedInError("uncertain", "linkedin: the post was sent but the ledger update failed");
    return failed(userId, date, cfg, now, "post", why, { ...extra, postUrl: postUrl(posted.postUrn) });
  }
  return succeeded(userId, date, cfg, now, extra);
}

/**
 * Publish event: retry only the member post of a `created` row (LinkedIn hides an
 * unposted event and can't delete it, so the event is never created twice).
 * Dry run: the post request that would be sent; nothing is sent or written.
 * @param {string} userId
 * @param {string} date
 * @param {{ confirm?: unknown }} request  confirm=live, as on the create
 * @param {{ config?: any, client?: any, now?: Date }} [opts]
 */
export async function publishRetry(userId, date, { confirm }, { config, client, now = new Date() } = {}) {
  const cfg = requireConfig(config);
  const preview = await linkedInEventPreview(pool, userId, date, { config: cfg, now });
  const refuse = (codes) => ({ ok: false, mode: preview.mode, refusals: codes.map((code) => ({ code, message: REFUSALS[code] })), preview });
  const { ledger, connection } = preview;
  const codes = [];
  if (confirm !== "live") codes.push("confirm");
  if (ledger?.status !== "created") codes.push("not_created");
  if (cfg.live && !connection) codes.push("no_connection");
  else if (cfg.live && connection.level === "red") codes.push("expired");
  if (codes.length) return refuse(codes);

  const memberUrn = connection?.memberUrn ?? PLACEHOLDERS.member;
  if (!cfg.live) {
    const recorder = recordingClient();
    await recorder.createPost(null, buildPostPayload(memberUrn, ledger.linkedinEventId, ledger.commentary));
    return { ok: true, mode: "dry_run", requests: recorder.requests, preview };
  }
  const token = await accessToken(pool, userId, { config: cfg, now });
  const li = client ?? linkedInClient(cfg);
  return postAndMark({ userId, date, token, li, memberUrn, row: ledger, cfg, now, retry: true });
}

/**
 * "I checked: nothing was created, allow retry": retire the date's `pending` row
 * (audited), which frees the date for a new create. Only a pending row.
 * @param {string} userId
 * @param {string} date
 * @param {{ now?: Date }} [opts]
 * @returns {Promise<{ ok: true } | { ok: false, refusals: { code: string, message: string }[] }>}
 */
export async function allowRetry(userId, date, { now = new Date() } = {}) {
  try {
    await withAudit(userId, async (c) => {
      const { rows } = await c.query(
        `update public.linkedin_events set status = 'retired', retired_at = $2, retired_by = $3
          where event_date = $1 and status = 'pending' returning id`, [date, now, userId]);
      if (!rows[0]) throw NOOP;
      return rows[0];
    }, ledgerAudit("linkedin_event.retire", date));
    return { ok: true };
  } catch (err) {
    if (err !== NOOP) throw err;
    return { ok: false, refusals: [{ code: "not_pending", message: REFUSALS.not_pending }] };
  }
}
