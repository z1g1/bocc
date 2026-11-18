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
// `event-<date>` for each date plus `event-list` (the sitemap). Netlify allows each tag
// two purges per 5 s; a 429 is retried once after 5 s.
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

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ALIAS = /^[a-z0-9][a-z0-9-]{0,62}$/i;
const RETRY_MS = 5000;

const redact = (text) =>
  String(text)
    .replace(/postgres(ql)?:\/\/\S+/gi, "<redacted-url>")
    .replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
    .replace(/nfp_[A-Za-z0-9_-]+/g, "<redacted-token>");

const describe = (err) => {
  const e = /** @type {any} */ (err);
  return e && typeof e === "object" ? `${e.name ?? "Error"}: ${e.message ?? ""}` : String(err);
};

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
 * @param {{ locals?: any, purge?: (opts: object) => Promise<void>, sleep?: (ms: number) => Promise<void> }} [opts]
 *   purge/sleep: injected by tests; default purgeCache from @netlify/cache and setTimeout
 * @returns {Promise<{ ok: boolean, skipped?: string }>}
 */
export async function purgeEventPages(dates, opts = {}) {
  try {
    const valid = [...new Set((Array.isArray(dates) ? dates : []).filter((d) => typeof d === "string" && DATE.test(d)))];
    if (valid.length === 0) return { ok: true, skipped: "no dates" };

    const where = purgeScope(opts.locals);
    if ("local" in where) return { ok: true, skipped: "not on Netlify" };
    if ("refused" in where) {
      console.error(`[site] purge refused (${where.refused}); not purging unscoped. Pages refresh when their cache expires.`);
      return { ok: false, skipped: "no deploy alias" };
    }

    const tags = [...valid.map(eventTag), LIST_TAG];
    const purge = opts.purge ?? (await import("@netlify/cache")).purgeCache;
    const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const args = { tags, ...where.scope };
    try {
      await purge(args);
    } catch (err) {
      if (!/\b429\b/.test(describe(err))) throw err;
      await sleep(RETRY_MS);
      await purge(args);
    }
    return { ok: true };
  } catch (err) {
    console.error(`[site] purge failed: ${redact(describe(err))}`);
    return { ok: false };
  }
}
