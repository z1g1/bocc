// The ntfy push when a Luma sync is set to Error (spec #70, ticket #74; ADR 0014). It goes
// to the same private topic as the Thursday social check (SOCIAL_ALERT_NTFY_TOPIC, optional
// SOCIAL_ALERT_NTFY_SERVER) and reuses its ntfy code (src/lib/social-alert/alert.mjs):
// JSON publishing to the server root, so the topic never appears in a URL or a log.
//
//   lumaSyncErrorAlert({ date, note, people, siteUrl })
//       the alert: the title names the Event date, the body carries the note, the Click
//       link opens that Event's Admin event page (/admin/events/<date>/)
//   pushLumaSyncError({ date, note, people }, { env?, fetch? })
//       sends it; resolves { outcome: "sent" | "skipped" | "failed" } and NEVER throws.
//
// Called by luma-sync-pages.mjs handleLumaSyncPost after markError() has committed, so a
// push that fails or times out (5 s) is only logged: the Error is already saved. Done,
// Nothing to add and missed runs never push. Deploy previews never push (they share the
// branch deploy's values), like the social check. Nothing logged holds the topic or the
// note (the note may name people).

import {
  alertSiteUrl, contextAllowed, longDate, readNtfyConfig, sendNtfy, shortDate,
} from "../social-alert/alert.mjs";
import { log as logLine, span } from "../telemetry.mjs";

const log = (level, msg) => logLine(level, `[luma-sync] ${msg}`);

/**
 * @param {{ date: string, note: string, people?: number|null, siteUrl?: string|null }} s
 * @returns {{ title: string, message: string, priority: "high", tags: string[], click: string|null }}
 */
export function lumaSyncErrorAlert({ date, note, people = null, siteUrl = null }) {
  const lines = [String(note ?? "").trim(), "", `Event: ${longDate(date)}.`];
  if (Number.isInteger(people)) {
    lines.push(`${people} ${people === 1 ? "person is" : "people are"} still to add to Luma.`);
  }
  lines.push(`Follow up on /admin/events/${date}/.`);
  let origin = null;
  try { origin = siteUrl ? new URL(siteUrl).origin : null; } catch { origin = null; }
  return {
    title: `BOCC Luma sync: Error for ${shortDate(date)}`,
    message: lines.join("\n"),
    priority: "high",
    tags: ["warning"],
    click: origin ? `${origin}/admin/events/${date}/` : null,
  };
}

/**
 * Push the Error alert. Never throws.
 * @param {{ date: string, note: string, people?: number|null }} result  markError()'s return
 * @param {{ env?: Record<string, string|undefined>, fetch?: typeof fetch, timeoutMs?: number }} [opts]
 * @returns {Promise<{ outcome: "sent"|"skipped"|"failed", alert?: object }>}
 */
export async function pushLumaSyncError(result, { env = process.env, fetch: doFetch = globalThis.fetch, timeoutMs } = {}) {
  const date = result?.date;
  try {
    const deployContext = env.CONTEXT ?? null;
    if (!contextAllowed(deployContext)) {
      log("info", `${date}: Error push skipped: deploy context ${deployContext}`);
      return { outcome: "skipped" };
    }
    const ntfy = readNtfyConfig(env);
    if (ntfy === null) {
      log("info", `${date}: Error push skipped: SOCIAL_ALERT_NTFY_TOPIC is not set`);
      return { outcome: "skipped" };
    }
    if ("problem" in ntfy) {
      log("error", `${date}: Error push skipped: ${ntfy.problem}`);
      return { outcome: "skipped" };
    }
    // The admin origin of this deploy (BETTER_AUTH_URL first, then Netlify's URL).
    const siteUrl = alertSiteUrl({ deployContext: null, siteUrl: null, env });
    const alert = lumaSyncErrorAlert({ date, note: result.note, people: result.people, siteUrl });
    await span("ntfy.send", () => sendNtfy(alert, ntfy, { fetch: doFetch, ...(timeoutMs ? { timeoutMs } : {}) }));
    log("info", `${date}: Error push sent`);
    return { outcome: "sent", alert };
  } catch (err) {
    // sendNtfy's messages never contain the topic.
    log("error", `${date}: Error push failed: ${err?.message ?? err}`);
    return { outcome: "failed" };
  }
}
