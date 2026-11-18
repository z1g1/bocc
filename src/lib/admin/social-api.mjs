// The JSON routes under /api/admin/social/ (ADR 0011 decision 4): next.ts, verify.ts
// and channel.ts are thin wrappers around these. The routes check the role (admin or
// social) and, on POST, checkOrigin; everything here answers JSON with no-store.

import { adminFailure } from "./log.mjs";
import { readJson } from "./media-http.mjs";

const NO_STORE = { "cache-control": "no-store" };
const json = (status, body) => Response.json(body, { status, headers: NO_STORE });

/** @param {"next" | "verify"} which */
export async function socialApiGet(which) {
  try {
    const sp = await import("./social-pages.mjs");
    return json(200, sp.toJson(await sp.loadPick(which)));
  } catch (err) {
    return adminFailure(`api/admin/social/${which}`, err);
  }
}

/** POST /api/admin/social/channel */
export async function socialApiChannel(userId, request) {
  let body;
  try {
    body = await readJson(request);
  } catch (err) {
    return json(400, { error: "invalid", errors: { body: /** @type {any} */ (err).message } });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json(400, { error: "invalid", errors: { body: "Send a JSON object." } });
  try {
    const so = await import("./social.mjs");
    const { date, channel, ...input } = body;
    const r = await so.setChannelResult(userId, typeof date === "string" ? date : "", typeof channel === "string" ? channel : "", input);
    const order = await so.getWorkOrder((await import("./db.mjs")).pool, date);
    const { toJson } = await import("./social-pages.mjs");
    const c = toJson({ order, video: null }).order.channels.find((x) => x.channel === channel);
    return json(200, { changed: r.changed, channel: c });
  } catch (err) {
    const e = /** @type {any} */ (err);
    if (e?.errors && [400, 404, 409].includes(e.status)) {
      return json(e.status, { error: e.status === 404 ? "not found" : e.status === 409 ? "conflict" : "invalid", errors: e.errors });
    }
    return adminFailure("api/admin/social/channel", err);
  }
}

/** Any other method: 405 with Allow. */
export const socialApiOther = (allow) =>
  Response.json({ error: "method not allowed" }, { status: 405, headers: { ...NO_STORE, allow } });
