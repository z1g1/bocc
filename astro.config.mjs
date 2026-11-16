// Astro config (ADR 0007). Static output: every page is prerendered at build time.
// Phase 2 adds @astrojs/netlify for the on-demand /admin and auth routes.
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://716coffee.club",
  output: "static",
  trailingSlash: "ignore",
  build: { format: "directory" },
});
