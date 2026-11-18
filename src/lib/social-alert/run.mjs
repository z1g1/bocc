// The Thursday social check's I/O (ADR 0011 decision 5, amended 2026-11-18), called by
// the Netlify scheduled function backend/netlify/functions/social-check.mjs. The rules
// and the ntfy call are in ./alert.mjs.
//
// Reads the next Tuesday's work order as `social_checker` (SELECT on events,
// event_links, social_posts, social_post_channels and four columns of event_media;
// migration 20261123120000_social_checker.sql), never as admin_app. One short-lived
// connection per run, parameterized SQL only. The work order is built with the same
// buildWorkOrder() the admin pages use (src/lib/admin/social-rules.mjs).
//
// Environment (read per run, never logged):
//   SOCIAL_ALERT_NTFY_TOPIC   the private ntfy topic: the only secret. Unset = log and stop
//   SOCIAL_ALERT_NTFY_SERVER  optional, default https://ntfy.sh
//   SOCIAL_CHECK_DB_URL       pooled Neon URL for social_checker
//   DB_CA_CERT                optional PEM CA override (src/lib/auth/pg-config.mjs)
//   URL, BETTER_AUTH_URL      for the Click link (alert.mjs alertSiteUrl)
//
// Logs one line per run, prefixed "[social-check]". Nothing logged contains the topic
// or a connection string.

import pg from "pg";
import { toAdminPgConfig } from "../auth/pg-config.mjs";
import { buildWorkOrder, CHANNEL_KEYS } from "../admin/social-rules.mjs";
import {
  alertSiteUrl, contextAllowed, easternToday, failureAlert, nextTuesday, readNtfyConfig, sendNtfy, socialAlert,
} from "./alert.mjs";

const redact = (text) => String(text).replace(/postgres(ql)?:\/\/\S+/gi, "<redacted-url>");
const log = (msg) => console.log(`[social-check] ${msg}`);
const logError = (msg) => console.error(`[social-check] ${msg}`);

/**
 * The work order for `date` as buildWorkOrder() returns it, or null when there is no
 * events row.
 * @param {{ query: Function }} db  a pg client or pool connected as social_checker
 * @param {string} date  YYYY-MM-DD
 */
export async function readWorkOrder(db, date) {
  const [{ rows: [event] }, { rows: [luma] }, { rows: [post] }, { rows: channels }] = await Promise.all([
    db.query(`select status from public.events where event_date = $1::date`, [date]),
    db.query(`select url from public.event_links where event_date = $1::date and platform = 'luma'`, [date]),
    db.query(
      `select video_media_id as "videoMediaId", cover_note as "coverNote", base_caption as "baseCaption",
              extra_hashtags as "extraHashtags", publish_at as "publishAt", ready, updated_at as "updatedAt"
         from public.social_posts where event_date = $1::date`, [date]),
    db.query(
      `select channel, caption, first_comment as "firstComment", status, post_url as "postUrl",
              verified_at as "verifiedAt", comment_posted_at as "commentPostedAt", notes
         from public.social_post_channels where event_date = $1::date`, [date]),
  ]);
  if (!event) return null;
  let video = null;
  if (post?.videoMediaId) {
    const { rows: [v] } = await db.query(
      `select id, kind, status from public.event_media where id = $1 and event_date = $2::date`, [post.videoMediaId, date]);
    video = v ?? null;
  }
  const byChannel = Object.fromEntries(CHANNEL_KEYS.map((c) => [c, null]));
  for (const { channel, ...rest } of channels) byChannel[channel] = rest;
  return buildWorkOrder({
    date,
    event: { status: event.status, exists: true },
    post: post ? { ...post, channels: byChannel } : null,
    lumaUrl: luma?.url ?? null,
    video,
  });
}

/** A connected client as social_checker. */
async function connect(env) {
  const url = env.SOCIAL_CHECK_DB_URL;
  if (!url) throw new Error("SOCIAL_CHECK_DB_URL is not set (pooled social_checker connection string)");
  const client = new pg.Client(toAdminPgConfig(url, {
    // Neon may be scaled to zero; the whole run must stay well inside the scheduled
    // function's 30 s limit.
    connectionTimeoutMillis: 8000,
    query_timeout: 6000,
    application_name: "bocc-social-check",
  }, env));
  client.on("error", (err) => logError(`client error: ${redact(err.message)}`));
  await client.connect();
  return client;
}

/**
 * One run of the check.
 * @param {{ env?: Record<string, string|undefined>, context?: any, now?: Date,
 *           fetch?: typeof fetch, readOrder?: (date: string) => Promise<any> }} [opts]
 *   readOrder replaces the database read (tests); fetch replaces the ntfy call
 * @returns {Promise<{ outcome: "skipped"|"ok"|"sent"|"failed", date?: string, alert?: object }>}
 */
export async function runSocialCheck({ env = process.env, context = undefined, now = new Date(), fetch: doFetch = globalThis.fetch, readOrder } = {}) {
  const deployContext = context?.deploy?.context ?? null;
  if (!contextAllowed(deployContext)) {
    log(`skipped: deploy context ${deployContext}`);
    return { outcome: "skipped" };
  }
  const ntfy = readNtfyConfig(env);
  if (ntfy === null) {
    log("skipped: SOCIAL_ALERT_NTFY_TOPIC is not set");
    return { outcome: "skipped" };
  }
  if ("problem" in ntfy) {
    logError(`skipped: ${ntfy.problem}`);
    return { outcome: "skipped" };
  }
  const siteUrl = alertSiteUrl({ deployContext, siteUrl: context?.site?.url ?? null, env });
  const date = nextTuesday(easternToday(now));

  let order;
  try {
    if (readOrder) order = await readOrder(date);
    else {
      const client = await connect(env);
      try { order = await readWorkOrder(client, date); } finally { await client.end().catch(() => {}); }
    }
  } catch (err) {
    logError(`${date}: could not read the work order: ${redact(err?.message ?? err)}`);
    const alert = failureAlert({ date, siteUrl });
    try { await sendNtfy(alert, ntfy, { fetch: doFetch }); log(`${date}: failure alert sent`); } catch (e) { logError(`${date}: ${e.message}`); }
    return { outcome: "failed", date, alert };
  }

  const alert = socialAlert({ order, date, siteUrl });
  if (!alert) {
    log(`${date}: ${order && order.eventStatus !== "scheduled" ? `event is ${order.eventStatus}` : "every channel is scheduled or live"}; no alert`);
    return { outcome: "ok", date };
  }
  try {
    await sendNtfy(alert, ntfy, { fetch: doFetch });
  } catch (err) {
    logError(`${date}: alert not sent (${alert.title}): ${err.message}`);
    return { outcome: "failed", date, alert };
  }
  log(`${date}: alert sent (${alert.title})`);
  return { outcome: "sent", date, alert };
}
