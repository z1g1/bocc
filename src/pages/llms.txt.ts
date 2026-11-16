// /llms.txt: a plain-text summary for language models. The text lives in
// src/content/llms.txt; {{ site.… }} placeholders are filled from src/data/site.yml.
import type { APIRoute } from "astro";
import { readFileSync } from "node:fs";
import { site } from "../lib/data";

export const GET: APIRoute = () => {
  const s = site();
  const lookup = (path: string) => path.split(".").reduce((o: any, k) => o?.[k], { site: s });
  const text = readFileSync("src/content/llms.txt", "utf8").replace(/\{\{\s*(site\.[\w.]+)\s*\}\}/g, (m, path) => {
    const v = lookup(path);
    if (v === undefined) throw new Error(`llms.txt: unknown placeholder ${m}`);
    return String(v);
  });
  return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
