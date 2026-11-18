// Loaders for the YAML data and Markdown page files.
// The files are bundled as text through import.meta.glob, not read from disk, so the
// same loaders work at build time and in the on-demand SSR function (the public
// /events/YYYY-MM-DD/ pages and the sitemap, ADR 0009), whose bundle has no src/.
// A change to any of these files still needs a rebuild (a deploy).
import { parse } from "yaml";

const yamlFiles = import.meta.glob("../data/*.yml", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const pageFiles = import.meta.glob("../content/pages/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const cache = new Map<string, unknown>();

/** src/data/<name>.yml, parsed once. */
export function data<T = any>(name: string): T {
  if (!cache.has(name)) {
    const raw = yamlFiles[`../data/${name}.yml`];
    if (raw === undefined) throw new Error(`src/data/${name}.yml not found`);
    cache.set(name, parse(raw));
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
  return Object.keys(pageFiles)
    .sort()
    .map((key) => {
      const file = key.slice(key.lastIndexOf("/") + 1);
      const raw = pageFiles[key];
      const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
      return m
        ? { file, frontmatter: parse(m[1]) ?? {}, body: m[2] }
        : { file, frontmatter: {}, body: raw };
    });
}
