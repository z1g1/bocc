// Admin photo upload and gallery actions for the event page (ADR 0010). Loaded by
// src/components/admin/EventMedia.astro as <script type="module" src="/js/admin-media.js">:
// the admin CSP is script-src 'self', so no inline code or handlers. Plain JS, no
// framework, written for mobile Safari and Chrome:
//   - decode with createImageBitmap (EXIF orientation applied), falling back to an
//     <img> where createImageBitmap is missing or refuses its options
//   - a regular <canvas> (no OffscreenCanvas), drawn at the TARGET size, never at the
//     photo's full size, to stay under iOS canvas memory limits; the thumbnail is drawn
//     from the 1600px copy, not from the original
//   - canvas.toBlob wrapped in a Promise; canvas export drops EXIF/GPS
//   - fetch PUT straight to the bucket with the presigned URL and its Content-Type
// Several files upload one after another. Progress and errors go to one aria-live region.

import {
  DISPLAY_EDGE, DISPLAY_QUALITY, THUMB_EDGE, THUMB_QUALITY, UNREADABLE_MESSAGE,
  checkFile, fitWithin, formatBytes, uploadRequestBody,
} from "./admin-media-lib.js";

class UserError extends Error {}

const root = document.querySelector("[data-media-upload]");
if (root) setUpUpload(root);
for (const form of document.querySelectorAll("form[data-confirm]")) {
  form.addEventListener("submit", (e) => {
    if (!window.confirm(form.getAttribute("data-confirm"))) e.preventDefault();
  });
}

function setUpUpload(form) {
  const input = form.querySelector('input[type="file"]');
  const kind = form.querySelector('select[name="kind"]');
  const pub = form.querySelector('input[name="publiclyUsable"]');
  const button = form.querySelector('button[type="submit"]');
  const status = document.getElementById(form.getAttribute("data-status"));
  const eventDate = form.getAttribute("data-event-date");
  let busy = false;

  const say = (text) => { status.textContent = text.charAt(0).toUpperCase() + text.slice(1); };
  const syncPublic = () => {
    const social = kind.value === "social_photo";
    pub.disabled = !social;
    if (!social) pub.checked = false;
  };
  kind.addEventListener("change", syncPublic);
  syncPublic();
  form.hidden = false;
  const noJs = document.querySelector("[data-media-nojs]");
  if (noJs) noJs.hidden = true;

  window.addEventListener("beforeunload", (e) => {
    if (busy) { e.preventDefault(); e.returnValue = ""; }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy) return;
    const files = Array.from(input.files || []);
    if (files.length === 0) { say("Choose at least one photo."); return; }
    busy = true;
    button.disabled = true;
    const opts = { eventDate, kind: kind.value, publiclyUsable: pub.checked };
    const failed = [];
    let done = 0;
    for (let i = 0; i < files.length; i++) {
      const prefix = files.length > 1 ? `Photo ${i + 1} of ${files.length}: ` : "";
      try {
        await uploadOne(files[i], opts, (step) => say(prefix + step));
        done++;
      } catch (err) {
        const msg = err instanceof UserError ? err.message : "something went wrong. Check your connection and try again.";
        failed.push(`${files[i].name || `photo ${i + 1}`}: ${msg}`);
        say(prefix + msg);
      }
    }
    busy = false;
    button.disabled = false;
    if (failed.length === 0) {
      say(`Uploaded ${done} photo${done === 1 ? "" : "s"}. Refreshing…`);
      window.location.reload();
      return;
    }
    input.value = "";
    say(`Uploaded ${done} of ${files.length}. Not uploaded: ${failed.join(" · ")}` +
      (done ? " Reload the page to see the ones that did upload." : ""));
  });
}

async function uploadOne(file, opts, step) {
  const check = checkFile(file);
  if (!check.ok) throw new UserError(check.message);

  step("preparing the photo…");
  const { display, thumb } = await makeCopies(file);

  step("starting the upload…");
  const start = await postJson("/api/admin/media/uploads", uploadRequestBody({
    ...opts, original: { contentType: check.contentType, size: file.size }, display, thumb,
  }));
  if (start.status !== 201) throw new UserError(await serverMessage(start, "the upload couldn't start"));
  const plan = await start.json();

  // Clean up (delete the pending row and anything that landed) only when the photo
  // certainly did NOT complete: a PUT failed, or /complete answered 409 (pending). If
  // /complete may have succeeded on the server but its answer was lost, leave the row:
  // it is either ready already, or shows up under "unfinished uploads" a day later.
  const abandon = () => { postJson(`/api/admin/media/${plan.id}/delete`, {}).catch(() => {}); };
  const parts = [
    ["thumb", thumb, "thumbnail"],
    ["display", display, "display copy"],
    ["original", file, `original (${formatBytes(file.size)})`],
  ];
  for (const [variant, blob, label] of parts) {
    step(`uploading the ${label}…`);
    const u = plan.uploads[variant];
    let res;
    try {
      res = await fetch(u.url, { method: "PUT", headers: u.headers, body: blob, credentials: "omit" });
    } catch {
      abandon();
      throw new UserError(`the ${label} upload failed (network). Try again.`);
    }
    if (!res.ok) {
      abandon();
      throw new UserError(`the ${label} upload was refused (${res.status}). Try again.`);
    }
  }

  step("checking…");
  let done;
  try {
    done = await postJson(`/api/admin/media/${plan.id}/complete`, {});
  } catch {
    throw new UserError("the connection dropped while finishing. Reload the page to see whether the photo arrived.");
  }
  if (done.status === 200) return;
  if (done.status === 409) {
    const body = await done.json().catch(() => ({}));
    abandon();
    throw new UserError(`the upload didn't complete${body.problems ? ` (${body.problems.join("; ")})` : ""}. Try again.`);
  }
  throw new UserError(`the upload couldn't be confirmed (${done.status}). Reload the page to see whether the photo arrived.`);
}

function postJson(url, body) {
  return fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
}

async function serverMessage(res, fallback) {
  try {
    const body = await res.json();
    if (body.errors) return `${fallback}: ${body.errors.join("; ")}`;
    if (body.error) return body.error;
  } catch { /* not JSON */ }
  if (res.status === 401) return "you've been signed out. Sign in again and retry.";
  return `${fallback} (${res.status}).`;
}

// ── Resizing ────────────────────────────────────────────────────────────────

async function makeCopies(file) {
  const src = await decode(file);
  let displayCanvas;
  let thumbCanvas;
  try {
    const d = fitWithin(src.width, src.height, DISPLAY_EDGE);
    displayCanvas = drawScaled(src.image, d);
  } finally {
    src.close();
  }
  try {
    const t = fitWithin(displayCanvas.width, displayCanvas.height, THUMB_EDGE);
    thumbCanvas = drawScaled(displayCanvas, t);
    const display = await toJpeg(displayCanvas, DISPLAY_QUALITY);
    const thumb = await toJpeg(thumbCanvas, THUMB_QUALITY);
    return { display, thumb };
  } finally {
    // iOS keeps canvas memory until the canvas is shrunk.
    for (const c of [displayCanvas, thumbCanvas]) if (c) { c.width = 0; c.height = 0; }
  }
}

/** Decode with EXIF orientation applied. Returns { image, width, height, close }. */
async function decode(file) {
  if (typeof window.createImageBitmap === "function") {
    for (const options of [{ imageOrientation: "from-image" }, undefined]) {
      try {
        const bitmap = options ? await createImageBitmap(file, options) : await createImageBitmap(file);
        return { image: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close && bitmap.close() };
      } catch { /* try the next way */ }
    }
  }
  // <img> also applies EXIF orientation (CSS image-orientation: from-image is the default).
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await (img.decode ? img.decode() : new Promise((ok, no) => { img.onload = ok; img.onerror = no; }));
    if (!img.naturalWidth || !img.naturalHeight) throw new Error("no size");
    return { image: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    throw new UserError(UNREADABLE_MESSAGE);
  }
}

function drawScaled(source, { width, height }) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new UserError("this browser couldn't resize the photo. Try a smaller photo or another browser.");
  ctx.fillStyle = "#fff"; // a PNG's transparent areas become white, not black, in the JPEG
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, width, height);
  return canvas;
}

function toJpeg(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob && blob.size > 0) resolve(blob);
      else reject(new UserError("this browser couldn't resize the photo. Try a smaller photo or another browser."));
    }, "image/jpeg", quality);
  });
}
