// /sitemap.xml in the same shape jekyll-sitemap produced: event pages first, then the
// content pages. Not listed: 404, check-in, past or cancelled events.
//
// Rendered on request (ADR 0009): the upcoming scheduled events come from Neon as
// site_reader (src/lib/site/db.mjs), each with lastmod = its last change. Cached at the
// CDN with the tag `event-list`, which every event purge includes
// (src/lib/site/purge.mjs). If Neon can't be reached: 503, no-store, so crawlers retry
// rather than see a sitemap without its events.
import type { APIRoute } from "astro";
import { contentPages, site } from "../lib/data";
import { todayIso } from "../lib/events";
import { listUpcomingScheduled } from "../lib/site/db.mjs";
import { LIST_TAG, logSiteFailure, setPublicHeaders } from "../lib/site/http.mjs";
import { isoUtc } from "../lib/time";

export const prerender = false;

export const GET: APIRoute = async () => {
  const base = site().url;
  let events;
  try {
    events = await listUpcomingScheduled(todayIso());
  } catch (err) {
    logSiteFailure("sitemap.xml", err);
    const headers = setPublicHeaders(new Headers({ "Content-Type": "text/plain; charset=utf-8", "Retry-After": "60" }), "no-store");
    return new Response("Sitemap temporarily unavailable.\n", { status: 503, headers });
  }
  const urls: string[] = [];
  for (const e of events) {
    urls.push(`<url>\n<loc>${base}/events/${e.date}/</loc>\n<lastmod>${isoUtc(e.updatedAt)}</lastmod>\n</url>`);
  }
  // Content pages in Jekyll's order: sorted by source file name (index.md is the home
  // page), then the brand page, which lived under assets/.
  const key = (p: string) => (p === "/" ? "index" : p.replace(/\//g, ""));
  const pages = contentPages().map((p) => p.frontmatter.permalink as string);
  const ordered = [
    ...pages.filter((p) => !p.startsWith("/assets/")).concat("/").sort((a, b) => key(a).localeCompare(key(b))),
    ...pages.filter((p) => p.startsWith("/assets/")),
  ];
  for (const p of ordered) urls.push(`<url>\n<loc>${base}${p}</loc>\n</url>`);
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.sitemaps.org/schemas/sitemap/0.9 http://www.sitemaps.org/schemas/sitemap/0.9/sitemap.xsd" xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.join("\n") +
    "\n</urlset>\n";
  const headers = setPublicHeaders(new Headers({ "Content-Type": "application/xml" }), "cached", { tag: LIST_TAG });
  return new Response(xml, { headers });
};
