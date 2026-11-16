// /feed.xml: the Atom feed jekyll-feed published. The site has no posts, so it is
// the feed header only. Kept so the URL doesn't change.
import type { APIRoute } from "astro";
import { site } from "../lib/data";
import { isoUtc } from "../lib/time";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const GET: APIRoute = () => {
  const s = site();
  const xml =
    `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${s.lang}">` +
    `<link href="${s.url}/feed.xml" rel="self" type="application/atom+xml" />` +
    `<link href="${s.url}/" rel="alternate" type="text/html" hreflang="${s.lang}" />` +
    `<updated>${isoUtc()}</updated><id>${s.url}/feed.xml</id>` +
    `<title type="html">${esc(s.title)}</title><subtitle>${esc(s.description)}</subtitle>` +
    `<author><name>${esc(s.author)}</name></author></feed>`;
  return new Response(xml, { headers: { "Content-Type": "application/atom+xml" } });
};
