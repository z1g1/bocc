// The Thursday social check (ADR 0011 decision 5, amended 2026-11-18): pure rules and
// the ntfy push. No database code and no environment reads here: ./run.mjs does the
// I/O and passes everything in, so all of this is unit-tested
// (tests/admin/social-alert-unit.test.mjs).
//
//   nextTuesday(today)                 the Tuesday strictly after `today` (Eastern date)
//   socialAlert({ order, siteUrl })    the work order (social-plan-rules.mjs buildWorkOrder,
//                                      or null when there is no events row) -> an alert,
//                                      or null when everything is fine, the event is
//                                      cancelled, or `date` is a holiday-week Tuesday
//                                      with no events row (isHolidayWeek)
//   linkedinExpiryAlerts({ authentications, now, siteUrl })
//                                      one "re-authenticate with LinkedIn" alert per LinkedIn authentication with
//                                      under 10 days left or expired (linkedin/rules.mjs
//                                      expiryAlertDue); [] when none is due or none exists
//   alertSiteUrl({ deployContext, siteUrl, env })   the origin the Click link opens
//   readNtfyConfig(env)                { topic, server } | { problem } | null (unset)
//   sendNtfy(alert, config, { fetch }) POST JSON to the server root; 5 s timeout; errors
//                                      never contain the topic
//
// An alert is { title, message, priority, tags, click }. The push uses ntfy's JSON
// publishing (https://docs.ntfy.sh/publish/#publish-as-json): the request goes to the
// server root, `<server>/`, and the topic travels only in the body. The URL never holds
// the secret, so the Netlify runtime's fetch tracing (which records full outgoing URLs)
// can't leak it.

import {
  CHANNELS, CHANNEL_KEYS, DONE_POST_STATUSES, OFFERED_PLAN_STATUSES, PLAN_STATUS_LABELS, postStatusLabel,
} from "../admin/social-plan-rules.mjs";
import { isHolidayWeek } from "../holiday-weeks.mjs";
import { expiryAlertDue, expiryLevel } from "../linkedin/rules.mjs";

export { isHolidayWeek };

const TZ = "America/New_York";

/**
 * Plan statuses the check treats as ready (ticket #39): offered to the Chrome tasks
 * (Ready for Posting, Error) or Posted. Error is here because the old `ready` flag stayed
 * on after a social media post failed: such a plan alerts as "N of 5 social media posts
 * not scheduled", naming the failed Channel, not as "Social plan not ready". Post
 * statuses that need no nudge are social-plan-rules.mjs DONE_POST_STATUSES (scheduled, live).
 */
export const READY_PLAN_STATUSES = Object.freeze([...OFFERED_PLAN_STATUSES, "posted"]);

export const NTFY_DEFAULT_SERVER = "https://ntfy.sh";
export const NTFY_TIMEOUT_MS = 5000;
/** ntfy's own topic rule: letters, digits, _ and -, at most 64. */
const TOPIC_RE = /^[A-Za-z0-9_-]{1,64}$/;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const ymdFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });

/** Today's date in Eastern time, YYYY-MM-DD. */
export const easternToday = (now = new Date()) => ymdFmt.format(now);

/**
 * The Tuesday strictly after `today` (YYYY-MM-DD): from a Thursday, five days on. Holiday
 * weeks are NOT skipped here: the check looks at that Tuesday and socialAlert() stays
 * quiet when it is in the break and has no row.
 */
export function nextTuesday(today) {
  if (typeof today !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error("nextTuesday: date must be YYYY-MM-DD");
  const d = new Date(`${today}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== today) throw new Error("nextTuesday: date must be YYYY-MM-DD");
  d.setUTCDate(d.getUTCDate() + (((2 - d.getUTCDay() + 7) % 7) || 7));
  return d.toISOString().slice(0, 10);
}

/** "Tue Nov 24" (ASCII, for the title). */
export const shortDate = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
  timeZone: "UTC", weekday: "short", month: "short", day: "numeric",
}).replace(",", "");
/** "Tuesday, November 24, 2026". */
export const longDate = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
  timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric",
});

/** Origin of a site URL, or null unless it is https (http only for loopback). */
function originOf(value) {
  if (typeof value !== "string" || value === "") return null;
  try {
    const u = new URL(value);
    if (u.protocol === "https:" || (u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname))) return u.origin;
  } catch { /* fall through */ }
  return null;
}

/**
 * The origin the alert's Click link opens, never a hard-coded host:
 *   production   Netlify's site URL (context.site.url, else the runtime `URL`):
 *                https://716coffee.club
 *   otherwise    BETTER_AUTH_URL, the admin origin of that context (the dev branch
 *                deploy's own host; Netlify's `URL` is the production domain there),
 *                else the site URL
 * @param {{ deployContext?: string|null, siteUrl?: string|null, env?: Record<string, string|undefined> }} s
 * @returns {string|null}  null = send the alert without a Click link
 */
export function alertSiteUrl({ deployContext, siteUrl, env = {} }) {
  const candidates = deployContext === "production"
    ? [siteUrl, env.URL, env.BETTER_AUTH_URL]
    : [env.BETTER_AUTH_URL, siteUrl, env.URL];
  for (const c of candidates) {
    const o = originOf(c);
    if (o) return o;
  }
  return null;
}

/**
 * Deploy previews never alert (they share the branch-deploy values). Production and
 * the dev branch deploy do; an unknown context (Netlify metadata can be missing at
 * runtime) is treated as allowed, so production never goes quiet by accident.
 */
export const contextAllowed = (deployContext) => deployContext !== "deploy-preview";

/**
 * @param {{ order: null | { date: string, exists: boolean, eventStatus: string, status: string, statusLabel: string,
 *             problems: Array<{ message: string }>, channels: Array<{ channel: string, label?: string, status: string|null }> },
 *           date: string, siteUrl?: string|null }} s
 *   order null = no events row for `date`: a scheduled event with no Social plan, except in the
 *   holiday break (Dec 22 to Jan 4), where a Tuesday without a row isn't a meeting. A row
 *   on a holiday date (the override) is checked like any other week.
 * @returns {null | { title: string, message: string, priority: "high", tags: string[], click: string|null }}
 */
export function socialAlert({ order, date, siteUrl = null }) {
  if (order && order.eventStatus !== "scheduled") return null; // cancelled (or already reported)
  if (!order && isHolidayWeek(date)) return null; // holiday break, no meeting
  const exists = Boolean(order?.exists);
  const problems = exists ? order.problems ?? [] : [];
  const ready = exists && READY_PLAN_STATUSES.includes(order.status);
  const notReady = !ready || problems.length > 0;
  const channels = exists
    ? order.channels.filter((c) => !DONE_POST_STATUSES.includes(c.status))
    : CHANNEL_KEYS.map((channel) => ({ channel, label: CHANNELS[channel], status: null }));
  if (!notReady && channels.length === 0) return null;

  const when = shortDate(date);
  let title;
  if (!exists) title = `BOCC social: no Social plan for ${when}`;
  else if (notReady) title = `BOCC social: ${when} Social plan not ready`;
  else title = `BOCC social: ${channels.length} of ${CHANNEL_KEYS.length} social media posts not scheduled for ${when}`;

  const lines = [`Event: ${longDate(date)}.`];
  if (!exists) {
    lines.push(`There is no Social plan yet. Upload the promo video and caption on /admin/events/${date}/ and set its Plan status to ${PLAN_STATUS_LABELS.ready}.`);
  } else if (order.status === "error") {
    const failed = order.channels.filter((c) => c.status === "failed").map((c) => c.label ?? CHANNELS[c.channel] ?? c.channel);
    const what = failed.length ? `the ${failed.join(", ")} social media post failed` : "a social media post failed";
    lines.push(`The Social plan's Plan status is ${PLAN_STATUS_LABELS.error}: ${what}. Fix it on /admin/events/${date}/.`);
  } else if (!ready) {
    lines.push(`The Social plan isn't set to ${PLAN_STATUS_LABELS.ready} (it is ${order.statusLabel}), so the Wednesday task skipped it. Finish it on /admin/events/${date}/.`);
  } else if (problems.length) {
    lines.push(`The Social plan is ${order.statusLabel}, but something changed since:`);
  }
  for (const p of problems) lines.push(`- ${p.message}`);
  if (channels.length) {
    lines.push("", "Social media posts not scheduled yet:");
    for (const c of channels) {
      lines.push(`- ${c.label ?? CHANNELS[c.channel] ?? c.channel}: ${postStatusLabel(c.status, "no social media post")}`);
    }
  }
  const origin = originOf(siteUrl);
  return {
    title,
    message: lines.join("\n"),
    priority: "high",
    tags: ["warning"],
    click: origin ? `${origin}/admin/social/next` : null,
  };
}

/** The alert for a check that couldn't read the work order. */
export function failureAlert({ date, siteUrl = null }) {
  const origin = originOf(siteUrl);
  return {
    title: `BOCC social: the Thursday check failed${date ? ` (${shortDate(date)})` : ""}`,
    message: "The check couldn't read the work order (see Netlify -> Logs -> Functions -> social-check). Check /admin/social/next by hand.",
    priority: "high",
    tags: ["warning"],
    click: origin ? `${origin}/admin/social/next` : null,
  };
}

/** The alert for a check that couldn't read the LinkedIn authentications. */
export function linkedinFailureAlert({ siteUrl = null } = {}) {
  const origin = originOf(siteUrl);
  return {
    title: "BOCC LinkedIn: the Thursday check couldn't read the LinkedIn authentications",
    message: "The check couldn't read the LinkedIn authentications' expiry (see Netlify -> Logs -> Functions -> social-check). Check /admin/account/ by hand.",
    priority: "high",
    tags: ["warning"],
    click: origin ? `${origin}/admin/account/` : null,
  };
}

/** "Sunday, November 22, 2026" for an instant, in Eastern time. */
const easternLongDate = (at) => new Date(at).toLocaleDateString("en-US", {
  timeZone: TZ, weekday: "long", month: "long", day: "numeric", year: "numeric",
});

/**
 * The LinkedIn authentication alerts (ADR 0012): one per LinkedIn authentication that is due
 * (expiryAlertDue: under 10 days left, or expired), so it is renewed before Tuesday's
 * event has to be created. Only the name and the expiry come in, never token data.
 * @param {{ authentications: Array<{ name?: string|null, expiresAt: Date|string }>, now?: Date, siteUrl?: string|null }} s
 * @returns {Array<{ title: string, message: string, priority: "high", tags: string[], click: string|null }>}
 */
export function linkedinExpiryAlerts({ authentications, now = new Date(), siteUrl = null }) {
  const origin = originOf(siteUrl);
  return authentications.filter((c) => expiryAlertDue(c.expiresAt, now)).map((c) => {
    const who = `${String(c.name ?? "").trim() || "an Admin"}'s`;
    const { level, daysLeft } = expiryLevel(c.expiresAt, now);
    const on = easternLongDate(c.expiresAt);
    const left = daysLeft === 0 ? "less than a day" : daysLeft === 1 ? "1 day" : `${daysLeft} days`;
    const expired = level === "red";
    return {
      title: expired ? `BOCC LinkedIn: ${who} LinkedIn authentication has expired` : `BOCC LinkedIn: ${who} LinkedIn authentication expires in ${left}`,
      message: [
        expired ? `${who} LinkedIn authentication expired on ${on}.` : `${who} LinkedIn authentication expires on ${on} (in ${left}).`,
        "Re-authenticate at /admin/account/ before Tuesday's LinkedIn event has to be created.",
      ].join("\n"),
      priority: "high",
      tags: ["warning"],
      click: origin ? `${origin}/admin/account/` : null,
    };
  });
}

/**
 * @param {Record<string, string|undefined>} env
 * @returns {null | { topic: string, server: string } | { problem: string }}
 *   null when SOCIAL_ALERT_NTFY_TOPIC is unset; problems name the variable, never its value
 */
export function readNtfyConfig(env = {}) {
  const topic = (env.SOCIAL_ALERT_NTFY_TOPIC ?? "").trim();
  if (topic === "") return null;
  if (!TOPIC_RE.test(topic)) return { problem: "SOCIAL_ALERT_NTFY_TOPIC isn't a valid ntfy topic (letters, digits, _ and -, at most 64)" };
  const rawServer = (env.SOCIAL_ALERT_NTFY_SERVER ?? "").trim() || NTFY_DEFAULT_SERVER;
  let server;
  try {
    const u = new URL(rawServer);
    if (u.protocol !== "https:" || u.search || u.hash || u.username || u.password) throw new Error("bad");
    server = `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return { problem: "SOCIAL_ALERT_NTFY_SERVER must be an https URL with no query (default https://ntfy.sh)" };
  }
  return { topic, server };
}

/** ntfy's JSON `priority` is an integer 1-5; alerts name it like the header does. */
const PRIORITY = Object.freeze({ min: 1, low: 2, default: 3, high: 4, max: 5, urgent: 5 });
/** Bounds well inside ntfy's limits (4,096-byte message; the title is a short line). */
export const NTFY_TITLE_MAX = 200;
export const NTFY_MESSAGE_MAX = 3000;
/** One line, no control characters, bounded. JSON escaping does the rest. */
const oneLine = (s, max) => String(s).replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, max);

/**
 * The JSON body for one alert (exported for tests).
 * @param {{ title: string, message: string, priority: string, tags: string[], click: string|null }} alert
 * @param {string} topic
 */
export function ntfyBody(alert, topic) {
  const body = {
    topic,
    title: oneLine(alert.title, NTFY_TITLE_MAX),
    message: String(alert.message).slice(0, NTFY_MESSAGE_MAX),
    priority: PRIORITY[alert.priority] ?? PRIORITY.default,
    tags: alert.tags.map(String),
  };
  if (alert.click) body.click = alert.click;
  return body;
}

/**
 * Publish one alert. Throws an Error whose message never contains the topic.
 * @param {{ title: string, message: string, priority: string, tags: string[], click: string|null }} alert
 * @param {{ topic: string, server: string }} config
 * @param {{ fetch?: typeof fetch, timeoutMs?: number }} [opts]
 */
export async function sendNtfy(alert, { topic, server }, { fetch: doFetch = globalThis.fetch, timeoutMs = NTFY_TIMEOUT_MS } = {}) {
  let res;
  try {
    // The server root, never <server>/<topic>: the topic is only in the JSON body.
    res = await doFetch(`${server}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ntfyBody(alert, topic)),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
  } catch (err) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    throw new Error(timedOut ? `ntfy publish timed out after ${timeoutMs} ms` : `ntfy publish failed (${err?.name ?? "Error"})`);
  }
  if (!res.ok) throw new Error(`ntfy publish answered HTTP ${res.status}`);
}
