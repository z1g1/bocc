// What the social role's pages (/admin/social/next/, /admin/social/verify/) and their
// JSON API (/api/admin/social/*) share (ADR 0011 decisions 3, 4; plan Phase 5 part B):
// loading the pick with the video's download link, the JSON shape, and turning a form
// post into setPostResult() input. Admin and social only; callers check the role
// (and checkOrigin on POST). Nothing here reads attendees, check-ins, reports or the
// audit log: the work order is all these pages ever show (ADR 0008).
//
//   loadPick("next" | "verify", { now })   findNext / findVerify (social-plan.mjs) plus
//       `video` for a picked Social plan: { fileName, downloadUrl, expiresAt, contentType,
//       sizeBytes } or null, or { unavailable: message } when storage is off; and
//       `thumbnail` (tickets #22, #57): { source, eventImageSource, fileName, downloadUrl,
//       expiresAt, contentType } for the video's Thumbnail (the Event Image or the
//       admin's override; the logo default is a link on `origin`, never signed), or
//       { unavailable } when it is in the bucket and storage is off.
//   toJson(pick)                           the same, safe to send (no storage keys)
//   resultInput(values)                    a form's fields -> setPostResult input
//   handleChannelPost(request, userId, page), noticeText(params)   the pages' forms (PRG)

import { pool } from "./db.mjs";
import { getStorage } from "./storage.mjs";
import { ValidationError } from "./events.mjs";
import { CHANNELS, findNext, findVerify, isChannel, setPostResult } from "./social-plan.mjs";

/** How long the video download link works (the Chrome task downloads it right away). */
export const VIDEO_LINK_SECONDS = 3600;

export const VIDEO_OFF_MESSAGE = "Media storage is not set up on this site, so the video can't be downloaded here.";

/** "bocc-2026-11-24-promo.mp4" */
export const videoFileName = (date, video) =>
  `bocc-${date}-promo.${video?.contentType === "video/quicktime" ? "mov" : "mp4"}`;

export const THUMBNAIL_OFF_MESSAGE = "Media storage is not set up on this site, so the Thumbnail can't be downloaded here.";

/** "bocc-2026-11-24-thumbnail.jpg" */
export const thumbnailFileName = (date, contentType) => `bocc-${date}-thumbnail.${contentType === "image/png" ? "png" : "jpg"}`;

/**
 * The Thumbnail's download link (tickets #22, #57): order.thumbnail (resolveThumbnail) signed like
 * the video, or the checked-in logo on the site's own origin (no signing).
 * { source, eventImageSource, fileName, downloadUrl, expiresAt, contentType } |
 * { unavailable } | null.
 */
function thumbnailLink(order, st, origin) {
  const c = order.thumbnail;
  if (!c) return null;
  const fileName = thumbnailFileName(order.date, c.file.contentType);
  const base = { source: c.source, eventImageSource: c.eventImageSource, fileName };
  if ("path" in c.file) return { ...base, downloadUrl: `${origin}${c.file.path}`, expiresAt: null, contentType: c.file.contentType };
  if (!st) return { unavailable: THUMBNAIL_OFF_MESSAGE };
  const link = st.presignGet({ key: c.file.key, downloadName: fileName, expiresIn: VIDEO_LINK_SECONDS });
  return { ...base, downloadUrl: link.url, expiresAt: link.expiresAt, contentType: c.file.contentType };
}

/**
 * @param {"next" | "verify"} which
 * @param {{ now?: Date, db?: any, storage?: any, origin?: string }} [opts]  storage: tests pass a fake; null = off.
 *   origin: the site's origin for the logo's link ("" = a same-origin path)
 */
export async function loadPick(which, { now = new Date(), db = pool, storage, origin = "" } = {}) {
  const pick = which === "next" ? await findNext(db, { now }) : await findVerify(db, { now });
  if (!pick.order) return { ...pick, video: null, thumbnail: null };
  const st = storage === undefined ? getStorage().storage : storage;
  const thumbnail = thumbnailLink(pick.order, st, origin);
  const v = pick.order.video;
  if (!v || v.status !== "ready") return { ...pick, video: null, thumbnail };
  if (!st) return { ...pick, video: { unavailable: VIDEO_OFF_MESSAGE }, thumbnail };
  const fileName = videoFileName(pick.order.date, v);
  const link = st.presignGet({ key: v.originalKey, downloadName: fileName, expiresIn: VIDEO_LINK_SECONDS });
  return {
    ...pick,
    video: { fileName, downloadUrl: link.url, expiresAt: link.expiresAt, contentType: v.contentType, sizeBytes: v.sizeBytes },
    thumbnail,
  };
}

const CHANNEL_FIELDS = ["channel", "label", "status", "postUrl", "verifiedAt", "commentPostedAt", "notes",
  "caption", "firstComment", "captionLength", "captionLimit"];

/** The pick as JSON: the work order without storage keys or admin-only details. */
export function toJson(pick) {
  const { order, video, thumbnail, ...rest } = pick;
  if (!order) return rest;
  return {
    ...rest,
    order: {
      date: order.date,
      status: order.status,
      statusLabel: order.statusLabel,
      // The Chrome task contract's name, kept: "offered to the Chrome tasks" (true for
      // Ready for Posting and Error), not the post status Ready for Posting.
      ready: order.ready,
      actionable: order.actionable,
      problems: order.problems,
      publishAt: order.publishAtDisplay.iso,
      publishAtEastern: order.publishAtDisplay.et,
      publishAtUtc: order.publishAtDisplay.utc,
      thumbnailTimecode: order.thumbnailTimecode,
      lumaUrl: order.lumaUrl,
      channels: order.channels.map((c) => Object.fromEntries(CHANNEL_FIELDS.map((k) => [k, c[k] ?? null]))),
    },
    video,
    thumbnail: thumbnail ?? null,
  };
}

/**
 * A channel form's fields -> setPostResult() input. Only the fields the form sent
 * are passed on: an absent field keeps what is stored.
 * @param {Record<string, string>} values
 */
export function resultInput(values) {
  const out = {};
  for (const k of ["status", "postUrl", "notes", "verified", "commentPosted"]) {
    if (typeof values[k] === "string") out[k] = values[k];
  }
  return out;
}

const plain = (status, text) =>
  new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

/**
 * A page's channel form POST (the caller has checked the role and the Origin). Fields:
 * date, channel, and resultInput()'s. Success: a 303 back to `page` with
 * ?notice=saved|unchanged&channel=<key>#channel-<key> (post/redirect/get). A refused
 * save: { status, errors, posted } for the page to re-render.
 * @param {Request} request
 * @param {string} userId
 * @param {string} page  e.g. "/admin/social/next/"
 * @returns {Promise<{ response: Response } | { status: number, errors: Record<string, string>, posted: { channel: string, values: Record<string, string> } }>}
 */
export async function handleChannelPost(request, userId, page) {
  let data;
  try {
    data = await request.formData();
  } catch {
    return { response: plain(400, "Bad Request") };
  }
  const values = {};
  for (const [k, v] of data) if (typeof v === "string") values[k] = v;
  const { channel = "", date = "" } = values;
  if (!isChannel(channel)) return { response: plain(400, "Bad Request: unknown channel") };
  try {
    const r = await setPostResult(userId, date, channel, resultInput(values));
    const notice = r.changed ? (values.commentPosted !== undefined && values.status === undefined ? "comment" : "saved") : "unchanged";
    return {
      response: new Response(null, {
        status: 303,
        headers: { location: `${page}?notice=${notice}&channel=${channel}#channel-${channel}`, "cache-control": "no-store" },
      }),
    };
  } catch (err) {
    if (!(err instanceof ValidationError)) throw err;
    return { status: err.status, errors: err.errors, posted: { channel, values } };
  }
}

/** The notice for ?notice=…&channel=… after a redirect, or null. */
export function noticeText(params) {
  const ch = params.get("channel");
  const label = isChannel(ch) ? CHANNELS[ch] : null;
  switch (params.get("notice")) {
    case "saved": return label ? `${label} saved.` : "Saved.";
    case "comment": return label ? `${label}: first comment saved.` : "First comment saved.";
    case "unchanged": return "Nothing changed.";
    default: return null;
  }
}
