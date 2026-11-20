// Pure helpers for the admin photo upload (ADR 0010), shared by the browser script
// /js/admin-media.js (an ES module, loaded with <script type="module">, which the
// admin CSP's script-src 'self' allows) and by the node tests, which import this
// file directly. No DOM, no network: only rules and arithmetic.
//
// The size cap and limits must match src/lib/admin/media.mjs LIMITS (a test checks).

export const ACCEPTED_TYPES = Object.freeze(["image/jpeg", "image/png"]);
export const DISPLAY_EDGE = 1600;
export const THUMB_EDGE = 400;
export const DISPLAY_QUALITY = 0.85;
export const THUMB_QUALITY = 0.8;
export const MAX_ORIGINAL_BYTES = 25 * 1024 * 1024;
export const MAX_DISPLAY_BYTES = 5 * 1024 * 1024;
export const MAX_THUMB_BYTES = 1024 * 1024;

// The weekly promo video (kind promo_video): one file, uploaded as is.
export const VIDEO_TYPES = Object.freeze(["video/mp4", "video/quicktime"]);
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

// The Event Image (kind event_image, ADR 0012 decision 3): one per event, made as a
// 1:1 square, used as is on Luma (the original). Its 16:9 Event Image (for the
// listings entered by hand and LinkedIn) is the image at full height, centred on the
// "Just the Beans" background, never cropped (ticket #40). Keep in step with
// src/lib/admin/media.mjs EVENT_IMAGE (a test checks).
export const EVENT_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const EVENT_IMAGE_MIN_WIDTH = 480;
export const EVENT_IMAGE_MIN_HEIGHT = 270;
export const IMAGE_16X9_WIDTH = 1920;
export const IMAGE_16X9_HEIGHT = 1080;
/** The 1920x1080 background of every 16:9 Event Image, served from the site itself. */
export const IMAGE_16X9_BACKGROUND = "/assets/images/brand/just-the-beans-16x9.jpg";
export const IMAGE_16X9_QUALITY = 0.88;
export const MAX_16X9_BYTES = 5 * 1024 * 1024;

export const UNREADABLE_MESSAGE =
  "This photo can't be read in this browser. Upload from your iPhone, or export the photo as JPEG.";

// A few browsers report JPEG under an old alias.
const ALIASES = { "image/jpg": "image/jpeg", "image/pjpeg": "image/jpeg" };

/** The canonical MIME type for a file's reported type ("" when the browser gave none). */
export function normalizeType(type) {
  const t = String(type ?? "").split(";")[0].trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(ALIASES, t) ? ALIASES[t] : t;
}

/**
 * Can this picked file be uploaded? Decided by its MIME type, never its name.
 * @param {{ type?: string, size?: number, name?: string }} file
 * @returns {{ ok: true, contentType: string } | { ok: false, message: string }}
 */
export function checkFile(file) {
  const name = file && file.name ? `${file.name}: ` : "";
  const type = normalizeType(file && file.type);
  if (!ACCEPTED_TYPES.includes(type)) {
    // HEIC/HEIF (an iPhone photo picked outside Safari) and anything else unknown.
    if (type === "" || /hei[cf]/.test(type)) return { ok: false, message: name + UNREADABLE_MESSAGE };
    return { ok: false, message: `${name}only JPEG or PNG photos can be uploaded.` };
  }
  const size = file.size;
  if (!Number.isSafeInteger(size) || size <= 0) return { ok: false, message: `${name}the file is empty.` };
  if (size > MAX_ORIGINAL_BYTES) {
    return { ok: false, message: `${name}the photo is ${formatBytes(size)}; the limit is ${formatBytes(MAX_ORIGINAL_BYTES)}.` };
  }
  return { ok: true, contentType: type };
}

/**
 * Can this picked file be uploaded as the promo video? MP4 or QuickTime (.mov, what an
 * iPhone records), decided by its MIME type.
 * @param {{ type?: string, size?: number, name?: string }} file
 * @returns {{ ok: true, contentType: string } | { ok: false, message: string }}
 */
export function checkVideoFile(file) {
  const name = file && file.name ? `${file.name}: ` : "";
  const type = normalizeType(file && file.type);
  if (!VIDEO_TYPES.includes(type)) return { ok: false, message: `${name}only MP4 or MOV videos can be uploaded.` };
  const size = file.size;
  if (!Number.isSafeInteger(size) || size <= 0) return { ok: false, message: `${name}the file is empty.` };
  if (size > MAX_VIDEO_BYTES) {
    return { ok: false, message: `${name}the video is ${formatBytes(size)}; the limit is ${formatBytes(MAX_VIDEO_BYTES)}.` };
  }
  return { ok: true, contentType: type };
}

/** The JSON body for POST /api/admin/media/uploads, for the promo video. */
export function videoUploadRequestBody({ eventDate, original }) {
  return { eventDate, kind: "promo_video", original: { contentType: original.contentType, size: original.size } };
}

/**
 * Scale (width, height) so the long edge is at most maxEdge. Never upscales; keeps the
 * aspect ratio; whole pixels, at least 1.
 * @returns {{ width: number, height: number }}
 */
export function fitWithin(width, height, maxEdge) {
  if (!(width > 0 && height > 0 && maxEdge > 0)) throw new Error("fitWithin: dimensions must be positive");
  const long = Math.max(width, height);
  if (long <= maxEdge) return { width: Math.round(width), height: Math.round(height) };
  const scale = maxEdge / long;
  return {
    width: width >= height ? maxEdge : Math.max(1, Math.round(width * scale)),
    height: height > width ? maxEdge : Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Where a (width x height) image goes on the 16:9 background: scaled to the full
 * height (or, for an image wider than 16:9, to the full width) and centred, never
 * cropped; whole pixels, an odd leftover pixel to the right or bottom. Draw the
 * background over the whole canvas, then ctx.drawImage(src, dx, dy, dw, dh).
 * @returns {{ canvas: { width: number, height: number }, dx: number, dy: number, dw: number, dh: number }}
 */
export function compose16x9(width, height) {
  if (!(width > 0 && height > 0)) throw new Error("compose16x9: dimensions must be positive");
  const W = IMAGE_16X9_WIDTH;
  const H = IMAGE_16X9_HEIGHT;
  const tooWide = width * H > height * W;
  const dw = tooWide ? W : Math.min(W, Math.max(1, Math.round((width * H) / height)));
  const dh = tooWide ? Math.min(H, Math.max(1, Math.round((height * W) / width))) : H;
  return { canvas: { width: W, height: H }, dx: Math.floor((W - dw) / 2), dy: Math.floor((H - dh) / 2), dw, dh };
}

/** True when (width x height) is square to within a pixel. */
export const isSquare = (width, height) => Math.abs(width - height) <= 1;

/**
 * Can this decoded image be the Event Image? PNG or JPEG, at most 8 MiB, at least
 * 480x270. Not square is allowed, with a warning: the Event Image should be 1:1.
 * @param {{ type?: string, size?: number, name?: string, width: number, height: number }} file
 * @returns {{ ok: true, contentType: string, warning: string|null } | { ok: false, message: string }}
 */
export function checkEventImage(file) {
  const name = file && file.name ? `${file.name}: ` : "";
  const type = normalizeType(file && file.type);
  if (!ACCEPTED_TYPES.includes(type)) return { ok: false, message: `${name}the Event Image must be a PNG or JPEG.` };
  const size = file.size;
  if (!Number.isSafeInteger(size) || size <= 0) return { ok: false, message: `${name}the file is empty.` };
  if (size > EVENT_IMAGE_MAX_BYTES) {
    return { ok: false, message: `${name}the image is ${formatBytes(size)}; the limit is ${formatBytes(EVENT_IMAGE_MAX_BYTES)}.` };
  }
  const { width, height } = file;
  if (!(width >= EVENT_IMAGE_MIN_WIDTH && height >= EVENT_IMAGE_MIN_HEIGHT)) {
    return { ok: false, message: `${name}the image is ${width}×${height}; it must be at least ${EVENT_IMAGE_MIN_WIDTH}×${EVENT_IMAGE_MIN_HEIGHT}.` };
  }
  const warning = isSquare(width, height) ? null
    : `The image is ${width}×${height}, not square. Make the Event Image a 1:1 square: Luma shows it as is, and the 16:9 Event Image puts it at full height on the beans background. Check the preview.`;
  return { ok: true, contentType: type, warning };
}

/** The JSON body for POST /api/admin/media/uploads, for the Event Image. `cover` is the 16:9 Event Image
 * (the API's variant name, like its object key …/cover.jpg). */
export function eventImageRequestBody({ eventDate, original, display, thumb, cover }) {
  return {
    eventDate,
    kind: "event_image",
    original: { contentType: original.contentType, size: original.size, width: original.width, height: original.height },
    display: { contentType: "image/jpeg", size: display.size },
    thumb: { contentType: "image/jpeg", size: thumb.size },
    cover: { contentType: "image/jpeg", size: cover.size },
  };
}

/** The JSON body for POST /api/admin/media/uploads. */
export function uploadRequestBody({ eventDate, kind, publiclyUsable, original, display, thumb }) {
  return {
    eventDate,
    kind,
    publiclyUsable: kind === "social_photo" && publiclyUsable === true,
    original: { contentType: original.contentType, size: original.size },
    display: { contentType: "image/jpeg", size: display.size },
    thumb: { contentType: "image/jpeg", size: thumb.size },
  };
}

/** "3.2 MB", "410 KB", "900 bytes". */
export function formatBytes(n) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} bytes`;
}
