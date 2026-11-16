// Astro config (ADR 0007). Static output: every page is prerendered at build time.
// Phase 2 adds @astrojs/netlify for the on-demand /admin and auth routes.
import { defineConfig } from "astro/config";
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
  integrations: [flatPages],
});
