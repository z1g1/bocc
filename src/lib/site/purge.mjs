// Clearing the public event pages from Netlify's CDN cache after an admin save
// (ADR 0009 decision 4).
//
//   purgeEventPages(dates, { locals })
//     dates   YYYY-MM-DD strings whose /events/<date>/ page (and any list pages that
//             show them, e.g. the sitemap) must be re-rendered
//     locals  Astro.locals of the admin request, for the deploy alias
//             (locals.netlify.context.deploy) — every purge is scoped to one deploy
//     -> Promise<{ ok: boolean, skipped?: string }>. Never throws: a failed purge must
//        not fail the admin save (the save is already committed); it is logged and
//        the page refreshes when its cache max-age runs out (src/lib/site/http.mjs).
//
// One call to purgeCache() from @netlify/cache per save, with every tag in it:
// `event-<date>` for each date plus `event-list` (the sitemap, and the past/cancelled
// pages' "Next" link). Netlify allows each tag two purges per 5 s.
//
// Bounded: the admin save awaits this (an un-awaited promise can be cut off when the
// function returns), and purgeCache() is a bare fetch with no timeout. So the call is
// raced against a 3 s timer, and there is no retry: a 429 or a timeout is logged and
// returns { ok: false }. The worst case is about 3 s added to a save; the page then
// refreshes when its CDN max-age runs out (the next Eastern midnight at the latest).
//
// Scope. A purge with neither deployAlias nor domain covers EVERY deploy of the site,
// so a staging save would clear production. locals.netlify.context.deploy is what the
// SSR function gets per request (Netlify's CONTEXT/BRANCH env vars are null at
// runtime): { context, branch, id, published }.
//   context "production"     -> { domain: hostname of context.site.url } — Netlify:
//                               "targets the currently published production deploy on
//                               the specified domain" (716coffee.club)
//   context "branch-deploy"  -> { deployAlias: deploy.branch } — the branch subdomain,
//                               e.g. "dev" for dev--bocc-backend.netlify.app
//   anything else (deploy previews, unknown, missing branch/domain) -> refused, logged
//   no Netlify context, or context "dev" (astro dev)  -> skipped, ok
//
// Token. The adapter's SSR function (.netlify/v1/functions/ssr/ssr.mjs) is a modern
// default-export function, so Netlify puts NETLIFY_PURGE_API_TOKEN in its environment
// and purgeCache() reads it; nothing is passed here.

import { LIST_TAG, eventTag } from "./http.mjs";
import { describeError, log, span } from "../telemetry.mjs";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ALIAS = /^[a-z0-9][a-z0-9-]{0,62}$/i;
export const PURGE_TIMEOUT_MS = 3000;

/**
 * Which deploy to purge, from the request's Netlify context.
 * @param {any} locals
 * @returns {{ local: true } | { scope: { deployAlias: string } | { domain: string } } | { refused: string }}
 */
export function purgeScope(locals) {
  const ctx = locals?.netlify?.context;
  const deploy = ctx?.deploy;
  if (!ctx || !deploy || !deploy.context || deploy.context === "dev") return { local: true };
  if (deploy.context === "production") {
    let domain;
    try {
      domain = ctx.site?.url ? new URL(ctx.site.url).hostname : undefined;
    } catch {
      domain = undefined;
    }
    return domain ? { scope: { domain } } : { refused: "production deploy without a site URL" };
  }
  if (deploy.context === "branch-deploy") {
    const alias = deploy.branch;
    return typeof alias === "string" && ALIAS.test(alias)
      ? { scope: { deployAlias: alias } }
      : { refused: "branch deploy without a usable branch name" };
  }
  return { refused: `no deploy alias for context "${deploy.context}"` };
}

/**
 * @param {string[]} dates
 * @param {{ locals?: any, purge?: (opts: object) => Promise<void>, timeoutMs?: number }} [opts]
 *   purge/timeoutMs: injected by tests; default purgeCache from @netlify/cache, 3000 ms
 * @returns {Promise<{ ok: boolean, skipped?: string }>}
 */
export function purgeEventPages(dates, opts = {}) {
  // Traced as "cdn.purge" (src/lib/telemetry.mjs): tag count and the outcome, never
  // the token. A failed purge is swallowed, so the span is marked ERROR by hand.
  return span("cdn.purge", async (h) => {
    const r = await purge(dates, opts);
    h.setAttributes({ "purge.ok": r.ok, "purge.skipped": r.skipped });
    if (!r.ok) h.setError(r.skipped ?? "purge failed");
    return r;
  });
}

/** purgeEventPages' body. @returns {Promise<{ ok: boolean, skipped?: string }>} */
async function purge(dates, opts) {
  try {
    const valid = [...new Set((Array.isArray(dates) ? dates : []).filter((d) => typeof d === "string" && DATE.test(d)))];
    if (valid.length === 0) return { ok: true, skipped: "no dates" };

    const where = purgeScope(opts.locals);
    if ("local" in where) return { ok: true, skipped: "not on Netlify" };
    if ("refused" in where) {
      log("error", `[site] purge refused (${where.refused}); not purging unscoped. Pages refresh when their cache expires.`);
      return { ok: false, skipped: "no deploy alias" };
    }

    const tags = [...valid.map(eventTag), LIST_TAG];
    const purgeCache = opts.purge ?? (await import("@netlify/cache")).purgeCache;
    const timeoutMs = opts.timeoutMs ?? PURGE_TIMEOUT_MS;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
    });
    try {
      await Promise.race([Promise.resolve().then(() => purgeCache({ tags, ...where.scope })), timeout]);
    } finally {
      clearTimeout(timer);
    }
    return { ok: true };
  } catch (err) {
    log("error", `[site] purge failed: ${describeError(err)}`);
    return { ok: false };
  }
}

/**
 * Purge a date's page when an admin action created its `events` row as a side effect
 * (the first photo upload for a date), so a cached 404 for that date clears.
 * @param {{ eventCreated?: boolean, eventDate?: string } | null | undefined} result
 * @param {{ locals?: any, purge?: (opts: object) => Promise<void>, timeoutMs?: number }} [opts]
 * @returns {Promise<{ ok: boolean, skipped?: string }>} never throws
 */
export async function purgeIfEventCreated(result, opts = {}) {
  if (!result?.eventCreated || typeof result.eventDate !== "string") return { ok: true, skipped: "no event created" };
  return purgeEventPages([result.eventDate], opts);
}
