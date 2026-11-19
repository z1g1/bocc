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
// A second, independent check (ADR 0012, issue #24) reads each LinkedIn connection's
// expiry and its user's name (SELECT (user_id, expires_at) on linkedin_connections and
// (id, name) on auth."user"; migration 20261126120000_social_checker_linkedin.sql,
// never the token) and pushes a "reconnect at /admin/account/" alert for each one with
// under 10 days left or expired. Each check runs and alerts on its own: a failure in one
// never stops the other. The run's outcome is the worse of the two ("failed" > "sent" >
// "ok"); `linkedin` in the result carries the LinkedIn check's own outcome.
//
// Environment (read per run, never logged):
//   SOCIAL_ALERT_NTFY_TOPIC   the private ntfy topic: the only secret. Unset = log and stop
//   SOCIAL_ALERT_NTFY_SERVER  optional, default https://ntfy.sh
//   SOCIAL_CHECK_DB_URL       pooled Neon URL for social_checker
//   DB_CA_CERT                optional PEM CA override (src/lib/auth/pg-config.mjs)
//   URL, BETTER_AUTH_URL      for the Click link (alert.mjs alertSiteUrl)
//
// Logs one line per check, prefixed "[social-check]", as JSON (src/lib/telemetry.mjs
// log()). Nothing logged contains the topic, a connection string, a name or token data. Traced as one
// "social.check" span (outcome, date) with the reads as "db.query" spans and the ntfy
// push as "ntfy.send" when Netlify tracing is on. The push is ntfy JSON publishing to the
// server root (alert.mjs sendNtfy), so the runtime's fetch span records `<server>/` and
// never the topic.

import pg from "pg";
import { toAdminPgConfig } from "../auth/pg-config.mjs";
import { buildWorkOrder, CHANNEL_KEYS } from "../admin/social-rules.mjs";
import {
  alertSiteUrl, contextAllowed, easternToday, failureAlert, isHolidayWeek, linkedinExpiryAlerts, linkedinFailureAlert, nextTuesday,
  readNtfyConfig, sendNtfy, socialAlert,
} from "./alert.mjs";
import { EXPIRY_ALERT_DAYS } from "../linkedin/rules.mjs";
import { HOLIDAY_BREAK_LABEL } from "../holiday-weeks.mjs";
import { instrumentPg, log as logLine, redact, span } from "../telemetry.mjs";

const log = (msg) => logLine("info", `[social-check] ${msg}`);
const logError = (msg) => logLine("error", `[social-check] ${msg}`);
/** The ntfy push, traced. Attributes: never the topic or the server URL. */
const push = (alert, ntfy, doFetch) => span("ntfy.send", () => sendNtfy(alert, ntfy, { fetch: doFetch }));

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

/**
 * Every LinkedIn connection's expiry and its user's name, soonest first. Never the token,
 * the member URN or anything else in the row (social_checker can't read them).
 * @param {{ query: Function }} db  connected as social_checker
 * @returns {Promise<Array<{ name: string|null, expiresAt: Date }>>}
 */
export async function readLinkedInConnections(db) {
  const { rows } = await db.query(
    `select u.name, c.expires_at as "expiresAt"
       from public.linkedin_connections c left join "auth"."user" u on u.id = c.user_id
      order by c.expires_at, c.user_id`);
  return rows;
}

/** A connected client as social_checker. */
async function connect(env) {
  const url = env.SOCIAL_CHECK_DB_URL;
  if (!url) throw new Error("SOCIAL_CHECK_DB_URL is not set (pooled social_checker connection string)");
  const client = instrumentPg(new pg.Client(toAdminPgConfig(url, {
    // Neon may be scaled to zero; the whole run must stay well inside the scheduled
    // function's 30 s limit.
    connectionTimeoutMillis: 8000,
    query_timeout: 6000,
    application_name: "bocc-social-check",
  }, env)), "social");
  client.on("error", (err) => logError(`client error: ${redact(err.message)}`));
  await client.connect();
  return client;
}

/**
 * One run of the check.
 * @param {{ env?: Record<string, string|undefined>, context?: any, now?: Date,
 *           fetch?: typeof fetch, readOrder?: (date: string) => Promise<any>,
 *           readConnections?: () => Promise<Array<{ name: string|null, expiresAt: Date|string }>> }} [opts]
 *   readOrder / readConnections replace the database reads (tests); fetch replaces the ntfy call
 * @returns {Promise<{ outcome: "skipped"|"ok"|"sent"|"failed", date?: string, alert?: object,
 *           linkedin?: { outcome: "ok"|"sent"|"failed", alerts: object[] } }>}
 */
export function runSocialCheck(opts = {}) {
  return span("social.check", async (h) => {
    const result = await check(opts);
    h.setAttributes({ "social.outcome": result.outcome, "social.date": result.date, "social.linkedin_outcome": result.linkedin?.outcome });
    if (result.outcome === "failed") h.setError("social check failed");
    return result;
  });
}

const RANK = Object.freeze({ ok: 0, sent: 1, failed: 2 });

/** runSocialCheck's body: the gates, then the two checks on one lazily opened connection. */
async function check({
  env = process.env, context = undefined, now = new Date(), fetch: doFetch = globalThis.fetch, readOrder, readConnections,
} = {}) {
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

  // One connection for both reads, opened on first use. A failed connect is remembered,
  // so the LinkedIn check doesn't retry it or send a second failure alert for it.
  let client = null;
  let connectError = null;
  const db = async () => {
    if (connectError) throw connectError;
    if (!client) {
      try { client = await connect(env); } catch (err) { connectError = err; throw err; }
    }
    return client;
  };
  try {
    const social = await socialCheck({
      date, siteUrl, ntfy, doFetch, read: readOrder ? () => readOrder(date) : async () => readWorkOrder(await db(), date),
    });
    const linkedin = await linkedinCheck({
      now, siteUrl, ntfy, doFetch, alreadyAlerted: social.failedOn,
      read: readConnections ?? (async () => readLinkedInConnections(await db())),
    });
    const outcome = RANK[linkedin.outcome] > RANK[social.outcome] ? linkedin.outcome : social.outcome;
    const result = { outcome, date };
    if (social.alert) result.alert = social.alert;
    result.linkedin = { outcome: linkedin.outcome, alerts: linkedin.alerts };
    return result;
  } finally {
    await client?.end().catch(() => {});
  }
}

/**
 * The next Tuesday's social post.
 * @returns {Promise<{ outcome: "ok"|"sent"|"failed", alert?: object, failedOn?: unknown }>}
 *   failedOn: the read error behind a failure alert
 */
async function socialCheck({ date, siteUrl, ntfy, doFetch, read }) {
  let order;
  try {
    order = await read();
  } catch (err) {
    logError(`${date}: could not read the work order: ${redact(err?.message ?? err)}`);
    const alert = failureAlert({ date, siteUrl });
    try { await push(alert, ntfy, doFetch); log(`${date}: failure alert sent`); } catch (e) { logError(`${date}: ${e.message}`); }
    return { outcome: "failed", alert, failedOn: err };
  }

  const alert = socialAlert({ order, date, siteUrl });
  if (!alert) {
    // Still read the row first: a saved row on a holiday date is the override and is
    // checked like any other week.
    const why = !order && isHolidayWeek(date) ? `skipped as a holiday week (no meeting ${HOLIDAY_BREAK_LABEL})`
      : order && order.eventStatus !== "scheduled" ? `event is ${order.eventStatus}`
      : "every channel is scheduled or live";
    log(`${date}: ${why}; no alert`);
    return { outcome: "ok" };
  }
  try {
    await push(alert, ntfy, doFetch);
  } catch (err) {
    logError(`${date}: alert not sent (${alert.title}): ${err.message}`);
    return { outcome: "failed", alert };
  }
  log(`${date}: alert sent (${alert.title})`);
  return { outcome: "sent", alert };
}

/**
 * The LinkedIn connections' expiry. Logs counts only: the alert names the user, the
 * log never does.
 * @returns {Promise<{ outcome: "ok"|"sent"|"failed", alerts: object[] }>}
 */
async function linkedinCheck({ now, siteUrl, ntfy, doFetch, read, alreadyAlerted }) {
  let connections;
  try {
    connections = await read();
  } catch (err) {
    if (err === alreadyAlerted) {
      logError("linkedin: not checked (no database connection; the failure alert is already sent)");
      return { outcome: "failed", alerts: [] };
    }
    logError(`linkedin: could not read the connections: ${redact(err?.message ?? err)}`);
    const alert = linkedinFailureAlert({ siteUrl });
    try { await push(alert, ntfy, doFetch); log("linkedin: failure alert sent"); } catch (e) { logError(`linkedin: ${e.message}`); }
    return { outcome: "failed", alerts: [alert] };
  }
  if (connections.length === 0) {
    log("linkedin: no connection; no alert");
    return { outcome: "ok", alerts: [] };
  }
  const alerts = linkedinExpiryAlerts({ connections, now, siteUrl });
  if (alerts.length === 0) {
    const n = connections.length;
    log(`linkedin: ${n} connection${n === 1 ? "" : "s"}, none expiring within ${EXPIRY_ALERT_DAYS} days; no alert`);
    return { outcome: "ok", alerts };
  }
  let sent = 0;
  for (const alert of alerts) {
    try { await push(alert, ntfy, doFetch); sent++; } catch (err) { logError(`linkedin: expiry alert not sent: ${err.message}`); }
  }
  if (sent) log(`linkedin: ${sent} expiry alert${sent === 1 ? "" : "s"} sent`);
  return { outcome: sent === alerts.length ? "sent" : "failed", alerts };
}
