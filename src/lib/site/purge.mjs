// Clearing the public event pages from Netlify's CDN cache after an admin save
// (ADR 0009 decision 4). STUB: the Phase 4 public-pages work fills this in; the
// admin side already calls it with this signature.
//
//   purgeEventPages(dates, { locals })
//     dates   YYYY-MM-DD strings whose /events/<date>/ page (and any list pages that
//             show them, e.g. the sitemap) must be re-rendered
//     locals  Astro.locals of the admin request, for the deploy alias
//             (locals.netlify.context.deploy) — every purge is scoped to one deploy
//     -> Promise<{ ok: boolean, skipped?: string }>. Never throws: a failed purge must
//        not fail the admin save (the save is already committed); it is logged and
//        the page refreshes when its cache max-age runs out.

/** @param {string[]} dates @param {{ locals?: any }} [opts] */
export async function purgeEventPages(dates, opts = {}) {
  void dates;
  void opts;
  return { ok: true, skipped: "purge not implemented yet" };
}
