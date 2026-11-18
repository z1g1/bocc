// The Thursday social check (ADR 0011 decision 5, amended 2026-11-18): pure rules and
// the ntfy push. No database code and no environment reads here: ./run.mjs does the
// I/O and passes everything in, so all of this is unit-tested
// (tests/admin/social-alert-unit.test.mjs).
//
//   nextTuesday(today)                 the Tuesday strictly after `today` (Eastern date)
//   socialAlert({ order, siteUrl })    the work order (social-rules.mjs buildWorkOrder,
//                                      or null when there is no events row) -> an alert,
//                                      or null when everything is fine or the event is
//                                      cancelled
//   alertSiteUrl({ deployContext, siteUrl, env })   the origin the Click link opens
//   readNtfyConfig(env)                { topic, server } | { problem } | null (unset)
//   sendNtfy(alert, config, { fetch }) POST to <server>/<topic>; 5 s timeout; errors
//                                      never contain the topic
//
// An alert is { title, message, priority, tags, click }. The title is plain ASCII
// (ntfy takes it as an HTTP header); the message is UTF-8 text.

import { CHANNELS, CHANNEL_KEYS } from "../admin/social-rules.mjs";

const TZ = "America/New_York";

/** Channel statuses that need no nudge on Thursday. */
export const DONE_STATUSES = Object.freeze(["scheduled", "live"]);

export const NTFY_DEFAULT_SERVER = "https://ntfy.sh";
export const NTFY_TIMEOUT_MS = 5000;
/** ntfy's own topic rule: letters, digits, _ and -, at most 64. */
const TOPIC_RE = /^[A-Za-z0-9_-]{1,64}$/;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const ymdFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });

/** Today's date in Eastern time, YYYY-MM-DD. */
export const easternToday = (now = new Date()) => ymdFmt.format(now);

/** The Tuesday strictly after `today` (YYYY-MM-DD): from a Thursday, five days on. */
export function nextTuesday(today) {
  if (typeof today !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error("nextTuesday: date must be YYYY-MM-DD");
  const d = new Date(`${today}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== today) throw new Error("nextTuesday: date must be YYYY-MM-DD");
  d.setUTCDate(d.getUTCDate() + (((2 - d.getUTCDay() + 7) % 7) || 7));
  return d.toISOString().slice(0, 10);
}

/** "Tue Nov 24" (ASCII, for the title). */
const shortDate = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
  timeZone: "UTC", weekday: "short", month: "short", day: "numeric",
}).replace(",", "");
/** "Tuesday, November 24, 2026". */
const longDate = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
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
 * @param {{ order: null | { date: string, exists: boolean, eventStatus: string, ready: boolean,
 *             problems: Array<{ message: string }>, channels: Array<{ channel: string, label?: string, status: string|null }> },
 *           date: string, siteUrl?: string|null }} s
 *   order null = no events row for `date` (treated like a scheduled event with no post)
 * @returns {null | { title: string, message: string, priority: "high", tags: string[], click: string|null }}
 */
export function socialAlert({ order, date, siteUrl = null }) {
  if (order && order.eventStatus !== "scheduled") return null; // cancelled (or already held)
  const exists = Boolean(order?.exists);
  const problems = exists ? order.problems ?? [] : [];
  const notReady = !exists || !order.ready || problems.length > 0;
  const channels = exists
    ? order.channels.filter((c) => !DONE_STATUSES.includes(c.status))
    : CHANNEL_KEYS.map((channel) => ({ channel, label: CHANNELS[channel], status: null }));
  if (!notReady && channels.length === 0) return null;

  const when = shortDate(date);
  let title;
  if (!exists) title = `BOCC social: no post for ${when}`;
  else if (notReady) title = `BOCC social: ${when} post not ready`;
  else title = `BOCC social: ${channels.length} of ${CHANNEL_KEYS.length} channels not scheduled for ${when}`;

  const lines = [`Event: ${longDate(date)}.`];
  if (!exists) {
    lines.push(`There is no social post yet. Upload the promo video and caption on /admin/events/${date}/ and mark it ready.`);
  } else if (!order.ready) {
    lines.push(`The post isn't marked ready, so the Wednesday task skipped it. Finish it on /admin/events/${date}/.`);
  } else if (problems.length) {
    lines.push("The post is marked ready, but something changed since:");
  }
  for (const p of problems) lines.push(`- ${p.message}`);
  if (channels.length) {
    lines.push("", "Not scheduled yet:");
    for (const c of channels) lines.push(`- ${c.label ?? CHANNELS[c.channel] ?? c.channel}: ${c.status ?? "no post"}`);
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

/** Header values must be latin1; titles are ASCII already, this only guards. */
const headerSafe = (s) => String(s).replace(/[^\x20-\x7e]/g, "?");

/**
 * Publish one alert. Throws an Error whose message never contains the topic.
 * @param {{ title: string, message: string, priority: string, tags: string[], click: string|null }} alert
 * @param {{ topic: string, server: string }} config
 * @param {{ fetch?: typeof fetch, timeoutMs?: number }} [opts]
 */
export async function sendNtfy(alert, { topic, server }, { fetch: doFetch = globalThis.fetch, timeoutMs = NTFY_TIMEOUT_MS } = {}) {
  const headers = {
    "Content-Type": "text/plain; charset=utf-8",
    Title: headerSafe(alert.title),
    Priority: alert.priority,
    Tags: alert.tags.join(","),
  };
  if (alert.click) headers.Click = alert.click;
  let res;
  try {
    res = await doFetch(`${server}/${topic}`, {
      method: "POST",
      headers,
      body: alert.message,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
  } catch (err) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    throw new Error(timedOut ? `ntfy publish timed out after ${timeoutMs} ms` : `ntfy publish failed (${err?.name ?? "Error"})`);
  }
  if (!res.ok) throw new Error(`ntfy publish answered HTTP ${res.status}`);
}
