// /sitemap.xml in the same shape jekyll-sitemap produced: event pages (with
// lastmod = build time) first, then the content pages. Not listed: 404, check-in.
import type { APIRoute } from "astro";
import { contentPages, site } from "../lib/data";
import { upcomingEvents } from "../lib/events";
import { isoUtc } from "../lib/time";

export const GET: APIRoute = () => {
  const base = site().url;
  const lastmod = isoUtc();
  const urls: string[] = [];
  for (const e of upcomingEvents()) {
    urls.push(`<url>\n<loc>${base}/events/${e.date}/</loc>\n<lastmod>${lastmod}</lastmod>\n</url>`);
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
  return new Response(xml, { headers: { "Content-Type": "application/xml" } });
};
