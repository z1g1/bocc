// Build-time loaders for the YAML data and Markdown page files.
// Everything here runs during `astro build`, never in the browser.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const root = process.cwd();
const cache = new Map<string, unknown>();

/** Read src/data/<name>.yml once per build. */
export function data<T = any>(name: string): T {
  if (!cache.has(name)) {
    cache.set(name, parse(readFileSync(join(root, "src/data", `${name}.yml`), "utf8")));
  }
  return cache.get(name) as T;
}

export const site = () => data("site");

export interface ContentPage {
  file: string;
  frontmatter: Record<string, any>;
  body: string;
}

/** Markdown pages in src/content/pages: YAML front matter between --- lines, then Markdown. */
export function contentPages(): ContentPage[] {
  const dir = join(root, "src/content/pages");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((file) => {
      const raw = readFileSync(join(dir, file), "utf8");
      const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
      return m
        ? { file, frontmatter: parse(m[1]) ?? {}, body: m[2] }
        : { file, frontmatter: {}, body: raw };
    });
}
