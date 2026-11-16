// Compiles src/styles/main.scss to public/assets/css/main.css (compressed).
// The URL /assets/css/main.css is fixed: every page and the frozen check-in page
// link to it. The output is generated, not committed.
import { compile } from "sass";
import { mkdirSync, writeFileSync } from "node:fs";

const out = "public/assets/css/main.css";
const { css } = compile("src/styles/main.scss", {
  style: "compressed",
  loadPaths: ["src/styles"],
  // The partials use @import, which Dart Sass deprecates. Migrating to @use is a
  // separate change; the port keeps the stylesheets as they were.
  silenceDeprecations: ["import"],
});
mkdirSync("public/assets/css", { recursive: true });
writeFileSync(out, css + "\n");
console.log(`wrote ${out} (${css.length} bytes)`);
