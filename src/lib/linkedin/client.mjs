// The LinkedIn client adapter (ADR 0012, issue #18 "LinkedIn client"). Every call the
// app makes to LinkedIn goes through here; the use-case (linkedin.mjs) gets one injected.
//
// Operations (ported from tools/linkedin-events, the CLI's client.py / events.py / auth.py):
//   exchangeCode({ code, redirectUri })              POST www.linkedin.com/oauth/v2/accessToken
//   getProfile(token)                                GET  api.linkedin.com/v2/userinfo
//   initializeImageUpload(token, ownerUrn)           POST /rest/images?action=initializeUpload
//   uploadImage(token, uploadUrl, bytes, type)       PUT  <the uploadUrl LinkedIn returned>
//   createEvent(token, payload)                      POST /rest/events
//   createPost(token, payload)                       POST /rest/posts
//   listOrganizerEvents(token, organizerUrn)         GET  /rest/events?q=eventsByOrganizer…
//
// Safety rules (issue #23):
//   - The bearer token goes only to https://linkedin.com or https://*.linkedin.com, no
//     userinfo in the URL. Anything else is refused before fetch is called.
//   - Redirects are never followed (redirect: "manual"; a 3xx is an error), so the
//     token can't be replayed to wherever a redirect points.
//   - No secret in any URL: the Netlify runtime's fetch tracing records full outgoing
//     URLs (docs/backend/OBSERVABILITY.md). The code and client secret go in the token
//     request's form body, the token only in the Authorization header.
//   - Each call is a "linkedin.<op>" span with the HTTP status only. Errors carry
//     LinkedIn's own message (bounded, redacted, the token scrubbed), never headers.
//   - LinkedIn event ids are 19 digits, past JS Number precision: JSON is parsed with
//     a reviver that keeps unsafe integers as their source text.
//   - POSTs are never retried. A network failure, or a create whose id can't be read,
//     is "uncertain": the thing may exist on LinkedIn.
//
// Tests inject `fetch`; tests through `astro dev` replace the whole client with
// setLinkedInClientForTests() (a globalThis slot, so it reaches Vite's module copy).

import { redact, span } from "../telemetry.mjs";
import { SCOPES } from "./rules.mjs";

export const API_BASE = "https://api.linkedin.com";
export const OAUTH_BASE = "https://www.linkedin.com/oauth/v2";
/** Sunsets 2027-09-15: move to a newer version before then (release runbook). */
export const LINKEDIN_VERSION = "202609";

const TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const MAX_BODY = 5 * 1024 * 1024;
const PAGE_SIZE = 50;
const MAX_PAGES = 10;
const SUB = /^[A-Za-z0-9_-]+$/;
const IMAGE_URN = /^urn:li:image:([A-Za-z0-9_-]+)$/;
const POST_URN = /^urn:li:(ugcPost|share):\d+$/;

const USER_MESSAGES = {
  expired: "LinkedIn says the connection is invalid or expired. Reconnect LinkedIn and try again.",
  page_role: "LinkedIn refused. Your account must be an ADMINISTRATOR or CONTENT_ADMINISTRATOR of the BOCC page, and the app needs its LinkedIn products.",
  validation: "LinkedIn rejected the request as invalid.",
  hidden_post: "LinkedIn rejected the post as a hidden member post (it treats those as sponsored content). The event post must be a public post on your main feed.",
  refused: "The app refused to send this request to LinkedIn.",
  uncertain: "LinkedIn didn't answer clearly. The item may or may not exist on LinkedIn: check there before retrying.",
  unknown: "LinkedIn failed. Try again later.",
};

/** A failed LinkedIn call, mapped to a domain error the page can explain. */
export class LinkedInError extends Error {
  /**
   * @param {"expired"|"page_role"|"validation"|"hidden_post"|"refused"|"uncertain"|"unknown"} kind
   * @param {string} message  for logs: no token, code or secret
   * @param {{ status?: number|null, detail?: string|null }} [extra]
   */
  constructor(kind, message, { status = null, detail = null } = {}) {
    super(message);
    this.name = "LinkedInError";
    this.kind = kind;
    this.status = status;
    this.detail = detail;
    this.userMessage = USER_MESSAGES[kind] ?? USER_MESSAGES.unknown;
  }
}

/**
 * The browser-facing authorize URL (the server never fetches it).
 * @param {{ clientId: string, redirectUri: string, state: string }} p
 */
export function authorizationUrl({ clientId, redirectUri, state }) {
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, state, scope: SCOPES.join(" ") });
  return `${OAUTH_BASE}/authorization?${q.toString().replace(/\+/g, "%20")}`;
}

/** https, no userinfo, host linkedin.com or a subdomain of it. */
export function isLinkedInUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  return u.protocol === "https:" && !u.username && !u.password && !u.port
    && (host === "linkedin.com" || host.endsWith(".linkedin.com"));
}

/** JSON.parse that keeps integers beyond 2^53 as their exact digits. */
export function parseJson(text) {
  return JSON.parse(text, (_k, v, ctx) => (typeof v === "number" && !Number.isSafeInteger(v) && Number.isInteger(v) && ctx?.source ? ctx.source : v));
}

const KIND_BY_STATUS = (status) =>
  status === 401 ? "expired" : status === 403 ? "page_role" : status === 400 || status === 422 ? "validation" : "unknown";

// LinkedIn refuses hidden member posts (feedDistribution NONE) as sponsored content
// (tools/linkedin-events/README.md, "Verified behaviour"). Only on the post call.
const HIDDEN_POST = /sponsored|feedDistribution/i;

/**
 * @param {{ clientId: string, clientSecret: string }} config
 * @param {{ fetch?: typeof fetch }} [deps]
 */
export function createLinkedInClient({ clientId, clientSecret }, { fetch: doFetch = globalThis.fetch } = {}) {
  /** LinkedIn's own words from an error body, bounded, without the token. */
  function detailOf(text, token) {
    let msg = "";
    try {
      const b = JSON.parse(text);
      msg = [b?.message ?? b?.error_description ?? b?.error, b?.serviceErrorCode && `(serviceErrorCode ${b.serviceErrorCode})`].filter(Boolean).join(" ");
    } catch {
      msg = text;
    }
    let out = String(msg).slice(0, 300);
    if (token) out = out.split(token).join("<redacted>");
    return redact(out);
  }

  /**
   * One request. Returns { status, headers, text } for a 2xx; throws LinkedInError otherwise.
   * @param {string} op  span name suffix
   * @param {{ method: string, url: string, token?: string, headers?: Record<string,string>, body?: any, timeoutMs?: number }} req
   */
  function call(op, { method, url, token, headers = {}, body, timeoutMs = TIMEOUT_MS }) {
    return span(`linkedin.${op}`, { "linkedin.op": op, "http.request.method": method }, async (h) => {
      if (!isLinkedInUrl(url)) throw new LinkedInError("refused", `linkedin ${op}: refused a non-LinkedIn URL`);
      const all = { ...headers };
      if (token) all.Authorization = `Bearer ${token}`;
      let res;
      try {
        res = await doFetch(url, { method, headers: all, body, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
        const why = timedOut ? `timed out after ${timeoutMs} ms` : `failed (${err?.name ?? "Error"})`;
        throw new LinkedInError(method === "GET" ? "unknown" : "uncertain", `linkedin ${op} ${why}`);
      }
      h.setAttributes({ "http.response.status_code": res.status });
      if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
        throw new LinkedInError("refused", `linkedin ${op}: refused to follow a redirect (HTTP ${res.status})`, { status: res.status });
      }
      const text = await readCapped(res);
      if (!res.ok) {
        const detail = detailOf(text, token);
        let kind = KIND_BY_STATUS(res.status);
        if (op === "create_post" && res.status >= 400 && res.status < 500 && kind !== "expired" && HIDDEN_POST.test(detail)) kind = "hidden_post";
        throw new LinkedInError(kind, `linkedin ${op} answered HTTP ${res.status}${detail ? `: ${detail}` : ""}`, { status: res.status, detail });
      }
      return { status: res.status, headers: res.headers, text };
    });
  }

  async function readCapped(res) {
    const text = await res.text();
    if (text.length > MAX_BODY) throw new LinkedInError("unknown", "linkedin: response too large");
    return text;
  }

  const bodyJson = (text, op) => {
    try {
      return text ? parseJson(text) : {};
    } catch {
      throw new LinkedInError("unknown", `linkedin ${op}: unreadable JSON reply`);
    }
  };

  const rest = (extra = {}) => ({
    "LinkedIn-Version": LINKEDIN_VERSION,
    "X-Restli-Protocol-Version": "2.0.0",
    Accept: "application/json",
    ...extra,
  });
  const restJson = (extra = {}) => rest({ "Content-Type": "application/json", ...extra });

  return {
    /** @param {{ code: string, redirectUri: string }} p */
    async exchangeCode({ code, redirectUri }) {
      const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, client_secret: clientSecret });
      const { text } = await call("exchange_code", {
        method: "POST",
        url: `${OAUTH_BASE}/accessToken`,
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: form.toString(),
      });
      const b = bodyJson(text, "exchange_code");
      const expiresIn = Number(b.expires_in);
      if (typeof b.access_token !== "string" || b.access_token === "" || !(expiresIn > 0)) {
        throw new LinkedInError("unknown", "linkedin exchange_code: reply had no usable access token");
      }
      return { accessToken: b.access_token, expiresIn, scope: typeof b.scope === "string" ? b.scope : "" };
    },

    /** @param {string} token @returns {Promise<{ memberUrn: string, name: string }>} */
    async getProfile(token) {
      const { text } = await call("get_profile", { method: "GET", url: `${API_BASE}/v2/userinfo`, token, headers: { Accept: "application/json" } });
      const b = bodyJson(text, "get_profile");
      if (typeof b.sub !== "string" || !SUB.test(b.sub)) throw new LinkedInError("unknown", "linkedin get_profile: no valid member id");
      const name = String(b.name ?? [b.given_name, b.family_name].filter(Boolean).join(" ")).trim().slice(0, 200) || "LinkedIn member";
      return { memberUrn: `urn:li:person:${b.sub}`, name };
    },

    /** @returns {Promise<{ uploadUrl: string, imageUrn: string, assetUrn: string }>} */
    async initializeImageUpload(token, ownerUrn) {
      const { text } = await call("initialize_image_upload", {
        method: "POST", url: `${API_BASE}/rest/images?action=initializeUpload`, token, headers: restJson(),
        body: JSON.stringify({ initializeUploadRequest: { owner: ownerUrn } }),
      });
      const v = bodyJson(text, "initialize_image_upload")?.value ?? {};
      const m = IMAGE_URN.exec(String(v.image ?? ""));
      if (!m || !isLinkedInUrl(v.uploadUrl)) throw new LinkedInError("unknown", "linkedin initialize_image_upload: unexpected reply");
      return { uploadUrl: v.uploadUrl, imageUrn: v.image, assetUrn: `urn:li:digitalmediaAsset:${m[1]}` };
    },

    /** @param {Uint8Array} bytes @param {"image/png"|"image/jpeg"} contentType */
    async uploadImage(token, uploadUrl, bytes, contentType) {
      await call("upload_image", { method: "PUT", url: uploadUrl, token, headers: { "Content-Type": contentType }, body: bytes, timeoutMs: UPLOAD_TIMEOUT_MS });
    },

    /** @returns {Promise<{ id: string, vanityName: string|null }>} */
    async createEvent(token, payload) {
      const { text, headers } = await call("create_event", {
        method: "POST", url: `${API_BASE}/rest/events`, token, headers: restJson({ "X-RestLi-Method": "create" }), body: JSON.stringify(payload),
      });
      let b = {};
      try {
        b = text ? parseJson(text) : {};
      } catch { /* the header may still carry the id */ }
      const id = String(b?.id ?? headers.get("x-restli-id") ?? "");
      if (!/^\d+$/.test(id)) throw new LinkedInError("uncertain", "linkedin create_event: no event id in the reply");
      const vanityName = typeof b?.vanityName === "string" && /^[A-Za-z0-9-]+$/.test(b.vanityName) ? b.vanityName : null;
      return { id, vanityName };
    },

    /** @returns {Promise<{ postUrn: string }>} */
    async createPost(token, payload) {
      const { headers } = await call("create_post", { method: "POST", url: `${API_BASE}/rest/posts`, token, headers: restJson(), body: JSON.stringify(payload) });
      const postUrn = headers.get("x-restli-id") ?? "";
      if (!POST_URN.test(postUrn)) throw new LinkedInError("uncertain", "linkedin create_post: no post id in the reply");
      return { postUrn };
    },

    /** Upcoming, not cancelled, events of the organizer (raw elements; ids as strings). */
    async listOrganizerEvents(token, organizerUrn) {
      const out = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        // The Rest.li tuple goes unencoded, as the CLI sends it.
        const url = `${API_BASE}/rest/events?q=eventsByOrganizer&organizer=${encodeURIComponent(organizerUrn)}`
          + `&start=${page * PAGE_SIZE}&count=${PAGE_SIZE}&excludeCancelled=true&sortOrder=START_TIME_ASC`
          + "&timeBasedFilter=(lifeCycleState:UPCOMING)";
        const { text } = await call("list_organizer_events", { method: "GET", url, token, headers: rest() });
        const elements = bodyJson(text, "list_organizer_events")?.elements;
        if (!Array.isArray(elements)) throw new LinkedInError("unknown", "linkedin list_organizer_events: unexpected reply");
        for (const e of elements) out.push(e && e.id != null ? { ...e, id: String(e.id) } : e);
        if (elements.length < PAGE_SIZE) return out;
      }
      throw new LinkedInError("unknown", `linkedin list_organizer_events: more than ${MAX_PAGES} pages`);
    },
  };
}

const TEST_CLIENT = Symbol.for("bocc.linkedin.testClient");

/**
 * Tests only: make linkedInClient() return `client` (undefined restores the real one).
 * A globalThis slot, so it reaches the module copy `astro dev` loads through Vite.
 */
export function setLinkedInClientForTests(client) {
  if (client === undefined) delete globalThis[TEST_CLIENT];
  else globalThis[TEST_CLIENT] = client;
}

/** The client the routes use: the real one, unless a test installed a fake. */
export function linkedInClient(config) {
  return globalThis[TEST_CLIENT] ?? createLinkedInClient(config);
}
