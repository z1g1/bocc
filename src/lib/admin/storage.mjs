// Media storage seam (ADR 0010): presigned URLs for one private S3-compatible bucket
// (Neon Object Storage in staging and production, MinIO in scripts/test-db.sh).
// Dependency-free: AWS Signature Version 4 with node:crypto. No AWS SDK. Two forms:
//   query-string ("presigned URL")  for URLs handed to a browser (PUT, GET) or to the
//                                   operator script (presignBucket)
//   Authorization header            for requests the server sends itself (HEAD, DELETE)
//
// The browser never gets a storage credential. The server checks the user's role,
// builds the object key itself (mediaKey, never from a user's filename) and hands
// out a short-lived URL for exactly one object and one method:
//   PUT  presignPut  — signs Content-Type (and Content-Length when given), so the
//                      browser can't upload a different type (or size) with that URL
//   GET  presignGet  — 10 minutes by default; the gallery re-signs on each render
// headObject / deleteObject are server-side calls, header-signed (signRequest): HEAD
// confirms an upload landed before a row goes pending → ready, and DELETE goes with
// removing an event_media row. Their URL is just <origin>/<bucket>/<key>, with no
// X-Amz-* query: the Netlify runtime's fetch tracing records full outgoing URLs, and
// the signature, access key id and date stay in headers it skips (authorization, x-*).
// The browser-facing URLs are never fetched by the server, so they never reach a span.
//
// Storage is OPTIONAL. readStorageEnv() never throws: with no STORAGE_* variables (or a
// broken set) it returns { enabled: false, message }, and the admin keeps working with
// media switched off. The message names variables, never their values.
//
// Variables (Netlify: Production and Branch deploys each get their own; see
// docs/backend/NEON_PERMISSIONS.md "Storage"):
//   STORAGE_ENDPOINT           the branch's S3 endpoint, an origin with no path, e.g.
//                              https://br-<branch-id>.storage.c-1.us-east-2.aws.neon.tech
//                              (https required; plain http only for localhost)
//   STORAGE_BUCKET             bucket name (S3 rules: 3–63 of a-z 0-9 . -)
//   STORAGE_REGION             SigV4 region, default us-east-2 (Neon's region for this project)
//   STORAGE_ACCESS_KEY_ID      Neon credential token id (nak_…)
//   STORAGE_SECRET_ACCESS_KEY  Neon credential secret (nsk_…) — SECRET
//   STORAGE_FORCE_PATH_STYLE   optional, default true. Neon supports path-style only
//                              (https://neon.com/docs/storage/s3-compatibility); "false"
//                              switches to virtual-hosted (bucket.host) for other providers.

import { createHash, createHmac } from "node:crypto";
import { isLocalHost } from "../auth/env.mjs";
import { span } from "../telemetry.mjs";

export const DEFAULT_REGION = "us-east-2";
export const DEFAULT_PUT_EXPIRES = 300; // 5 min: long enough for a phone on bad signal
export const DEFAULT_GET_EXPIRES = 600; // 10 min
export const MAX_EXPIRES = 604800; // SigV4 maximum (7 days)

const REQUIRED = ["STORAGE_ENDPOINT", "STORAGE_BUCKET", "STORAGE_ACCESS_KEY_ID", "STORAGE_SECRET_ACCESS_KEY"];
const BUCKET_RE = /^(?=.{3,63}$)[a-z0-9][a-z0-9.-]*[a-z0-9]$/;
const CONTENT_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const KEY_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

/**
 * @typedef {object} StorageConfig
 * @property {string} endpoint        origin, e.g. https://br-x.storage.c-1.us-east-2.aws.neon.tech
 * @property {string} bucket
 * @property {string} region
 * @property {string} accessKeyId
 * @property {string} secretAccessKey
 * @property {boolean} forcePathStyle
 */

/**
 * Read and validate the storage variables. Never throws.
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ enabled: true, config: StorageConfig } | { enabled: false, message: string }}
 */
export function readStorageEnv(env = process.env) {
  const set = (k) => env[k] !== undefined && env[k] !== "";
  if (!REQUIRED.some(set)) {
    return { enabled: false, message: `Media storage is not configured (set ${REQUIRED.join(", ")}).` };
  }
  const problems = REQUIRED.filter((k) => !set(k)).map((k) => `${k} is not set`);

  let endpoint;
  if (set("STORAGE_ENDPOINT")) {
    try {
      const u = new URL(env.STORAGE_ENDPOINT);
      if (u.pathname !== "/" || u.search || u.hash || u.username || u.password) {
        problems.push("STORAGE_ENDPOINT must be an origin with no path, query or credentials");
      } else if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocalHost(u.hostname))) {
        problems.push("STORAGE_ENDPOINT must use https (plain http only for localhost)");
      } else {
        endpoint = u.origin;
      }
    } catch {
      problems.push("STORAGE_ENDPOINT is not a valid URL");
    }
  }
  if (set("STORAGE_BUCKET") && !BUCKET_RE.test(env.STORAGE_BUCKET)) {
    problems.push("STORAGE_BUCKET is not a valid bucket name");
  }
  const region = set("STORAGE_REGION") ? env.STORAGE_REGION : DEFAULT_REGION;
  if (!/^[a-z0-9-]+$/.test(region)) problems.push("STORAGE_REGION is not a valid region name");

  let forcePathStyle = true;
  if (set("STORAGE_FORCE_PATH_STYLE")) {
    const v = env.STORAGE_FORCE_PATH_STYLE.toLowerCase();
    if (v === "true" || v === "1") forcePathStyle = true;
    else if (v === "false" || v === "0") forcePathStyle = false;
    else problems.push("STORAGE_FORCE_PATH_STYLE must be true or false");
  }
  if (!forcePathStyle && set("STORAGE_BUCKET") && env.STORAGE_BUCKET.includes(".")) {
    problems.push("STORAGE_BUCKET with dots needs path-style (TLS names don't cover bucket.with.dots.host)");
  }

  if (problems.length) {
    return { enabled: false, message: `Media storage is misconfigured:\n  - ${problems.join("\n  - ")}` };
  }
  return {
    enabled: true,
    config: {
      endpoint,
      bucket: env.STORAGE_BUCKET,
      region,
      accessKeyId: env.STORAGE_ACCESS_KEY_ID,
      secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY,
      forcePathStyle,
    },
  };
}

/**
 * The origin browsers talk to for media (for CSP img-src / media-src / connect-src), or null when
 * storage is disabled. Accepts a config, or reads the env.
 * @param {StorageConfig | Record<string, string|undefined>} [configOrEnv]
 */
export function storageOrigin(configOrEnv = process.env) {
  let config = /** @type {StorageConfig} */ (configOrEnv);
  if (!("forcePathStyle" in configOrEnv)) {
    const r = readStorageEnv(/** @type {Record<string, string|undefined>} */ (configOrEnv));
    if (!r.enabled) return null;
    config = r.config;
  }
  if (config.forcePathStyle) return config.endpoint;
  const u = new URL(config.endpoint);
  u.hostname = `${config.bucket}.${u.hostname}`;
  return u.origin;
}

// ─── Keys ────────────────────────────────────────────────────────────────────

export const MEDIA_VARIANTS = /** @type {const} */ (["original", "display", "thumb"]);
// heic/heif: only the untouched originals of the one-time sign-in board photo import
// (ADR 0010 decision 4, migration 20261119120000). Browser uploads still refuse HEIC,
// and display copies and thumbnails are always JPEG.
const EXT_BY_TYPE = {
  "image/jpeg": "jpg", "image/png": "png", "image/heic": "heic", "image/heif": "heif",
  "video/mp4": "mp4", "video/quicktime": "mov",
};
const ORIGINAL_ONLY_EXTS = ["heic", "heif"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** File extension for an allowed media content type, or null. */
export function extForContentType(contentType) {
  return Object.hasOwn(EXT_BY_TYPE, contentType) ? EXT_BY_TYPE[contentType] : null;
}

/** True for a real calendar date written YYYY-MM-DD. */
export function isIsoDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Object key for one stored file. Built only from server-controlled parts: the
 * user's filename never reaches the key.
 *   events/2026-11-24/<uuid>/original.jpg
 * @param {string} eventDate  YYYY-MM-DD
 * @param {string} id         event_media.id (lowercase uuid)
 * @param {"original"|"display"|"thumb"} variant
 * @param {"jpg"|"png"|"heic"|"heif"|"mp4"|"mov"} ext  heic/heif for the original only
 */
export function mediaKey(eventDate, id, variant, ext) {
  if (!isIsoDate(eventDate)) throw new Error("mediaKey: eventDate must be YYYY-MM-DD");
  if (typeof id !== "string" || !UUID_RE.test(id)) throw new Error("mediaKey: id must be a lowercase uuid");
  if (!MEDIA_VARIANTS.includes(variant)) throw new Error("mediaKey: unknown variant");
  if (!Object.values(EXT_BY_TYPE).includes(ext)) throw new Error("mediaKey: unknown extension");
  if (ORIGINAL_ONLY_EXTS.includes(ext) && variant !== "original") throw new Error("mediaKey: heic/heif is for originals only");
  return `events/${eventDate}/${id}/${variant}.${ext}`;
}

// ─── SigV4 ───────────────────────────────────────────────────────────────────

const sha256Hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");
/** SHA-256 of an empty body (HEAD, DELETE). */
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const hmac = (key, s) => createHmac("sha256", key).update(s, "utf8").digest();

/** RFC 3986 encoding as SigV4 wants it: only A-Z a-z 0-9 - . _ ~ stay literal. */
const uriEncode = (s, keepSlash = false) =>
  Array.from(new TextEncoder().encode(s), (b) => {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9\-._~]/.test(c) || (keepSlash && c === "/")) return c;
    return `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }).join("");

const amzDate = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

function assertKey(key) {
  if (typeof key !== "string" || key.length > 512 || !KEY_RE.test(key) || key.split("/").some((p) => p === "." || p === "..")) {
    throw new Error("storage: invalid object key");
  }
}

function assertExpires(expiresIn) {
  if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > MAX_EXPIRES) {
    throw new Error(`storage: expiresIn must be an integer from 1 to ${MAX_EXPIRES}`);
  }
}

/**
 * @param {StorageConfig} config
 * @param {{ now?: () => Date, fetch?: typeof fetch }} [deps]  inject the clock in tests
 */
export function createStorage(config, { now = () => new Date(), fetch: fetchImpl = globalThis.fetch } = {}) {
  const origin = storageOrigin(config);
  const host = new URL(origin).host; // includes a non-default port (MinIO)

  /**
   * @param {string} method
   * @param {string|null} key  null = the bucket itself (operator calls such as ?cors)
   * @param {{ expiresIn: number, headers?: Record<string, string>, query?: Record<string, string> }} opts
   *   headers are signed; query adds signed sub-resource parameters
   */
  function presign(method, key, opts) {
    // A "storage.presign" span (src/lib/telemetry.mjs): the method only, never the
    // key, the URL or the credential.
    return span("storage.presign", { "storage.method": method }, () => sign(method, key, opts));
  }

  /**
   * The parts of a SigV4 request both forms share.
   * @param {string} method
   * @param {string|null} key
   * @param {Record<string, string>} headers  signed, in addition to host
   */
  function prepare(method, key, headers) {
    if (key !== null) assertKey(key);
    const t = now();
    const datetime = amzDate(t);
    const date = datetime.slice(0, 8);
    const scope = `${date}/${config.region}/s3/aws4_request`;
    const signed = { host, ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])) };
    for (const v of Object.values(signed)) if (/[\r\n]/.test(v)) throw new Error("storage: invalid header value");
    const names = Object.keys(signed).sort();
    const bucketPath = config.forcePathStyle ? `/${config.bucket}` : "";
    const path = key === null ? bucketPath || "/" : `${bucketPath}/${uriEncode(key, true)}`;
    return { t, datetime, date, scope, signed, names, signedHeaders: names.join(";"), path };
  }

  /** Hex signature over a canonical request. */
  function signature({ datetime, date, scope, signed, names, signedHeaders, path }, method, query, payloadHash) {
    const canonicalRequest = [
      method,
      path,
      query,
      names.map((n) => `${n}:${signed[n]}\n`).join(""),
      signedHeaders,
      payloadHash,
    ].join("\n");
    const stringToSign = ["AWS4-HMAC-SHA256", datetime, scope, sha256Hex(canonicalRequest)].join("\n");
    const kDate = hmac(`AWS4${config.secretAccessKey}`, date);
    const kSigning = hmac(hmac(hmac(kDate, config.region), "s3"), "aws4_request");
    return createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  }

  /** presign's body. */
  function sign(method, key, { expiresIn, headers = {}, query: extra = {} }) {
    assertExpires(expiresIn);
    const p = prepare(method, key, headers);
    const params = {
      ...extra,
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": `${config.accessKeyId}/${p.scope}`,
      "X-Amz-Date": p.datetime,
      "X-Amz-Expires": String(expiresIn),
      "X-Amz-SignedHeaders": p.signedHeaders,
    };
    const query = Object.entries(params)
      .map(([k, v]) => [uriEncode(k), uriEncode(v)])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    const sig = signature(p, method, query, "UNSIGNED-PAYLOAD");
    return {
      method,
      url: `${origin}${p.path}?${query}&X-Amz-Signature=${sig}`,
      expiresAt: new Date(p.t.getTime() + expiresIn * 1000),
    };
  }

  /**
   * A header-signed request for the server to send itself: the URL carries no query
   * (no credential, date or signature), only <origin>/<bucket>/<key>. The body is
   * empty (its hash is signed as x-amz-content-sha256).
   * @param {{ method: string, key: string, headers?: Record<string, string> }} opts
   *   headers are signed and returned with the auth headers
   * @returns {{ method: string, url: string, headers: Record<string, string> }}
   *   headers: Authorization, x-amz-date, x-amz-content-sha256 and any given; never
   *   Host (fetch sets it from the URL, the same value that was signed)
   */
  function signRequest({ method, key, headers = {} }) {
    return span("storage.sign", { "storage.method": method }, () => {
      if (key === null || key === undefined) throw new Error("storage: invalid object key");
      const p0 = prepare(method, key, headers); // validates, fixes the clock once
      const amz = { "x-amz-content-sha256": EMPTY_SHA256, "x-amz-date": p0.datetime };
      const p = { ...p0, signed: { ...p0.signed, ...amz } };
      p.names = Object.keys(p.signed).sort();
      p.signedHeaders = p.names.join(";");
      const sig = signature(p, method, "", EMPTY_SHA256);
      const out = Object.fromEntries(p.names.filter((n) => n !== "host").map((n) => [n, p.signed[n]]));
      out.authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${p.scope}, SignedHeaders=${p.signedHeaders}, Signature=${sig}`;
      return { method, url: `${origin}${p.path}`, headers: out };
    });
  }

  /** Send a header-signed request with an empty body. */
  function send(method, key) {
    const r = signRequest({ method, key });
    return fetchImpl(r.url, { method, headers: r.headers });
  }

  return {
    origin,
    signRequest,

    /**
     * A URL the browser PUTs one file to. Send exactly `headers` with it.
     * @param {{ key: string, contentType: string, contentLength?: number, expiresIn?: number }} opts
     * @returns {{ method: "PUT", url: string, headers: Record<string, string>, expiresAt: Date }}
     */
    presignPut({ key, contentType, contentLength, expiresIn = DEFAULT_PUT_EXPIRES }) {
      if (typeof contentType !== "string" || !CONTENT_TYPE_RE.test(contentType)) {
        throw new Error("storage: contentType must be a bare type/subtype (no parameters)");
      }
      const headers = { "content-type": contentType };
      if (contentLength !== undefined) {
        if (!Number.isSafeInteger(contentLength) || contentLength < 0) throw new Error("storage: invalid contentLength");
        headers["content-length"] = String(contentLength);
      }
      const p = presign("PUT", key, { expiresIn, headers });
      // The browser sets Content-Length itself (a forbidden header in fetch), so only
      // Content-Type is returned for the caller to send.
      return { method: "PUT", url: p.url, headers: { "Content-Type": contentType }, expiresAt: p.expiresAt };
    },

    /**
     * A short-lived URL to show or download one object.
     * With `downloadName`, the response carries `Content-Disposition: attachment` (a
     * signed `response-content-disposition`), since browsers ignore `<a download>` on
     * another origin such as the bucket. The name is reduced to safe characters.
     * @param {{ key: string, expiresIn?: number, downloadName?: string }} opts
     * @returns {{ url: string, expiresAt: Date }}
     */
    presignGet({ key, expiresIn = DEFAULT_GET_EXPIRES, downloadName }) {
      const query = {};
      if (downloadName) {
        const safe = String(downloadName).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100) || "download";
        query["response-content-disposition"] = `attachment; filename="${safe}"`;
      }
      const p = presign("GET", key, { expiresIn, query });
      return { url: p.url, expiresAt: p.expiresAt };
    },

    /**
     * Server side: does the object exist? Use before marking an upload `ready`.
     * @param {{ key: string }} opts
     * @returns {Promise<null | { contentType: string|null, contentLength: number, etag: string|null }>}
     */
    async headObject({ key }) {
      const res = await send("HEAD", key);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`storage: HEAD failed with ${res.status}`);
      return {
        contentType: res.headers.get("content-type"),
        contentLength: Number(res.headers.get("content-length")),
        etag: res.headers.get("etag"),
      };
    },

    /**
     * Server side: delete one object. Deleting a missing object is not an error.
     * @param {{ key: string }} opts
     */
    async deleteObject({ key }) {
      const res = await send("DELETE", key);
      await res.body?.cancel();
      if (!res.ok && res.status !== 404) throw new Error(`storage: DELETE failed with ${res.status}`);
    },

    /**
     * Operator use only (scripts/storage-cors.mjs): a signed request on the bucket
     * itself, e.g. { method: "PUT", query: { cors: "" } }. Never handed to a browser.
     * @param {{ method: string, query?: Record<string, string>, headers?: Record<string, string>, expiresIn?: number }} opts
     */
    presignBucket({ method, query = {}, headers = {}, expiresIn = 60 }) {
      return presign(method, null, { expiresIn, headers, query }).url;
    },
  };
}

/** @typedef {ReturnType<typeof createStorage>} Storage */

let cached;
/**
 * The storage client for this process, from process.env (read once).
 * @returns {{ storage: Storage, message: null } | { storage: null, message: string }}
 */
export function getStorage() {
  if (!cached) {
    const r = readStorageEnv();
    cached = r.enabled ? { storage: createStorage(r.config), message: null } : { storage: null, message: r.message };
  }
  return cached;
}
