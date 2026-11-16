// Astro config (ADR 0007). Static output: every page is prerendered at build time,
// except the few routes that opt out with `export const prerender = false` (the admin
// app, ADR 0008: /admin/*, /api/auth/*, /login/, /logout). @astrojs/netlify serves
// those from one SSR function next to backend/netlify/functions. Never name one of
// our own functions `ssr`.
import { defineConfig } from "astro/config";
import netlify from "@astrojs/netlify";
import { rename, rmdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Pages that must be served at a URL without a trailing slash. Astro writes
// checkin/bocc/index.html, and Netlify would answer /checkin/bocc with a 301 to
// /checkin/bocc/. The printed QR codes point at /checkin/bocc?token=…, so the
// file moves to checkin/bocc.html, which Netlify serves at /checkin/bocc directly
// (the layout production has always had).
const FLAT_PAGES = ["checkin/bocc"];

const flatPages = {
  name: "bocc-flat-pages",
  hooks: {
    "astro:build:done": async ({ dir }) => {
      const out = fileURLToPath(dir);
      for (const page of FLAT_PAGES) {
        await rename(`${out}${page}/index.html`, `${out}${page}.html`);
        await rmdir(`${out}${page}`);
      }
    },
  },
};

export default defineConfig({
  site: "https://716coffee.club",
  output: "static",
  trailingSlash: "ignore",
  build: { format: "directory" },
  // Defaults matter here: cacheOnDemandPages stays off (it would cache /admin/* at the
  // CDN for a year) and middleware runs in the SSR function, not at the edge.
  adapter: netlify(),
  integrations: [flatPages],
});
