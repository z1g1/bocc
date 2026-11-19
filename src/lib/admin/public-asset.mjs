// A checked-in file under public/assets/ (the BOCC logo defaults), read on the server.
// No database, no Astro APIs.
//
// In dev and tests the file is read from public/ on disk. The Netlify SSR function
// bundle doesn't carry public/ (and the bundled module's import.meta.url isn't under
// src/ any more), so when the file isn't on disk it is fetched from the site's own
// origin (BETTER_AUTH_URL: the per-context origin, https://716coffee.club in
// production), where the CDN serves it as a static asset. Public file, public URL: no
// secret in the request. Redirects are refused.

import { readFile } from "node:fs/promises";

const DEFAULT_ROOT = new URL("../../../public/", import.meta.url);
const SAFE_PATH = /^\/assets\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:png|jpe?g)$/;

/**
 * @param {string} path  e.g. "/assets/images/brand/bocc-logo-wide-16x9.png"
 * @param {{ root?: URL, baseURL?: string, fetch?: typeof fetch }} [opts]
 * @returns {Promise<Buffer>}
 */
export async function readPublicAsset(path, { root = DEFAULT_ROOT, baseURL = process.env.BETTER_AUTH_URL, fetch: doFetch = globalThis.fetch } = {}) {
  if (!SAFE_PATH.test(path) || path.includes("..")) throw new Error(`public asset: refused path ${path}`);
  try {
    return await readFile(new URL(`.${path}`, root));
  } catch (err) {
    if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") throw err;
  }
  if (!baseURL) throw new Error(`public asset: ${path} isn't on disk and BETTER_AUTH_URL is not set`);
  const url = new URL(path, baseURL);
  const res = await doFetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`public asset: GET ${url.pathname} answered HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
