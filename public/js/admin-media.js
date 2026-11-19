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
// Several files upload one after another. The event page has one form per kind (sign-in
// board, Photos from Event), each with a hidden `kind` field and its own aria-live status
// line. One upload at a time across the forms: a finished upload reloads the page.
//
// The Event Image form (kind event_image, on the Event Info tab, ADR 0012 decision 3)
// takes one file. On pick it is decoded and checked (PNG/JPEG, at least 480x270, at
// most 8 MiB), a warning shows when it isn't square, and the 16:9 version is drawn
// into the preview; the upload adds that as a fourth copy, the cover: 1920x1080, the
// decoded original at full height centred on the "Just the Beans" background
// (COVER_BACKGROUND, from the site itself), never cropped (ticket #40).
//
// The Event Image picker (form[data-event-image-pick], ticket #21) is a plain form
// post. When the chosen Photo from Event has no 16:9 cover copy yet (data-needs-cover),
// the cover is made first: the photo's display copy is fetched from the bucket
// (presigned GET in data-display-url; the bucket's CORS allows GET), composed on the
// beans background, and PUT through /api/admin/media/{id}/cover and /cover-complete;
// then the form is submitted. form[data-make-cover] does the same for a photo already
// picked without one, then reloads; with data-auto it runs as soon as the page opens
// (a 16:9 version made under the old centre-crop rule, being remade).
// form[data-remake-covers] (the /admin/media/covers page) remakes every such version,
// one after another.

import {
  COVER_BACKGROUND, COVER_QUALITY, DISPLAY_EDGE, DISPLAY_QUALITY, THUMB_EDGE, THUMB_QUALITY, UNREADABLE_MESSAGE,
  checkEventImage, checkFile, composeCover, eventImageRequestBody, fitWithin, formatBytes,
  uploadRequestBody,
} from "./admin-media-lib.js";

class UserError extends Error {}

const forms = Array.from(document.querySelectorAll("form[data-media-upload]"));
let busy = false;
for (const form of forms) setUpUpload(form);
if (forms.length) {
  for (const el of document.querySelectorAll("[data-media-nojs]")) el.hidden = true;
  window.addEventListener("beforeunload", (e) => {
    if (busy) { e.preventDefault(); e.returnValue = ""; }
  });
}
for (const form of document.querySelectorAll("form[data-event-image-pick]")) setUpPick(form);
for (const form of document.querySelectorAll("form[data-make-cover]")) setUpMakeCover(form);
for (const form of document.querySelectorAll("form[data-remake-covers]")) setUpRemakeCovers(form);
for (const form of document.querySelectorAll("form[data-confirm]")) {
  form.addEventListener("submit", (e) => {
    if (!window.confirm(form.getAttribute("data-confirm"))) e.preventDefault();
  });
}

function setUpUpload(form) {
  const input = form.querySelector('input[type="file"]');
  const kind = form.querySelector('input[name="kind"]').value;
  const status = document.getElementById(form.getAttribute("data-status"));
  const eventDate = form.getAttribute("data-event-date");

  const say = (text) => { status.textContent = text.charAt(0).toUpperCase() + text.slice(1); };
  const warning = form.hasAttribute("data-warning") ? document.getElementById(form.getAttribute("data-warning")) : null;
  const preview = form.hasAttribute("data-preview") ? document.getElementById(form.getAttribute("data-preview")) : null;
  let previewUrl = null;
  const clearPreview = () => {
    if (!preview) return;
    preview.hidden = true;
    preview.removeAttribute("src");
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
  };
  if (kind === "event_image" && warning) {
    // Check on pick, so the not-square warning and the 16:9 preview show before the upload.
    input.addEventListener("change", async () => {
      warning.textContent = "";
      clearPreview();
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        const r = await checkPicked(file);
        warning.textContent = r.ok ? r.warning || "" : r.message;
        if (r.ok && preview) {
          const blob = await composedCover(file);
          if (input.files && input.files[0] === file) {
            previewUrl = URL.createObjectURL(blob);
            preview.src = previewUrl;
            preview.hidden = false;
          }
        }
      } catch (err) {
        warning.textContent = err instanceof UserError ? err.message : UNREADABLE_MESSAGE;
      }
    });
  }
  const setBusy = (on) => {
    busy = on;
    for (const f of forms) f.querySelector('button[type="submit"]').disabled = on;
  };
  form.hidden = false;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy) { say("Wait for the other upload to finish."); return; }
    const files = Array.from(input.files || []);
    if (files.length === 0) { say("Choose at least one photo."); return; }
    setBusy(true);
    const opts = { eventDate, kind }; // the server sets publicly_usable from the kind
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
    setBusy(false);
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

function setUpPick(form) {
  const status = document.getElementById(form.getAttribute("data-status"));
  const button = form.querySelector('button[type="submit"]');
  const say = (text) => { status.textContent = text.charAt(0).toUpperCase() + text.slice(1); };
  form.addEventListener("submit", async (e) => {
    const chosen = form.querySelector('input[name="mediaId"]:checked');
    if (!chosen || !chosen.hasAttribute("data-needs-cover")) return; // a plain post
    e.preventDefault();
    if (busy) { say("Wait for the upload to finish."); return; }
    busy = true;
    button.disabled = true;
    try {
      await makePhotoCover(chosen.value, chosen.getAttribute("data-display-url"), say);
      say("Using this photo…");
      busy = false;
      form.submit(); // doesn't fire "submit" again
    } catch (err) {
      busy = false;
      button.disabled = false;
      say(err instanceof UserError ? err.message : "something went wrong making the 16:9 version. Try again.");
    }
  });
}

function setUpMakeCover(form) {
  const status = document.getElementById(form.getAttribute("data-status"));
  const button = form.querySelector('button[type="submit"]');
  const say = (text) => { status.textContent = text.charAt(0).toUpperCase() + text.slice(1); };
  form.hidden = false;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy) { say("Wait for the upload to finish."); return; }
    busy = true;
    button.disabled = true;
    try {
      await makePhotoCover(form.getAttribute("data-media-id"), form.getAttribute("data-display-url"), say);
      busy = false;
      say("16:9 version made. Refreshing…");
      window.location.reload();
    } catch (err) {
      busy = false;
      button.disabled = false;
      say(err instanceof UserError ? err.message : "something went wrong making the 16:9 version. Try again.");
    }
  });
  // A 16:9 version made under the old rule is remade as soon as the page opens.
  if (form.hasAttribute("data-auto")) form.requestSubmit();
}

/**
 * The /admin/media/covers page: remake every 16:9 version still made under the old
 * centre-crop rule, one at a time (li[data-cover-id][data-display-url] in the form's
 * list), then reload. One failure doesn't stop the rest.
 */
function setUpRemakeCovers(form) {
  const status = document.getElementById(form.getAttribute("data-status"));
  const button = form.querySelector('button[type="submit"]');
  const say = (text) => { status.textContent = text.charAt(0).toUpperCase() + text.slice(1); };
  for (const el of document.querySelectorAll("[data-media-nojs]")) el.hidden = true;
  form.hidden = false;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const items = Array.from(document.querySelectorAll("li[data-cover-id]"));
    if (items.length === 0) { say("Nothing to remake."); return; }
    busy = true;
    button.disabled = true;
    const failed = [];
    for (let i = 0; i < items.length; i++) {
      const li = items[i];
      const prefix = `${i + 1} of ${items.length}: `;
      try {
        await makePhotoCover(li.getAttribute("data-cover-id"), li.getAttribute("data-display-url"), (t) => say(prefix + t));
        li.setAttribute("data-done", "");
      } catch (err) {
        failed.push(`${li.getAttribute("data-label")}: ${err instanceof UserError ? err.message : "something went wrong"}`);
      }
    }
    busy = false;
    if (failed.length === 0) {
      say(`Remade ${items.length}. Refreshing…`);
      window.location.reload();
      return;
    }
    button.disabled = false;
    say(`Remade ${items.length - failed.length} of ${items.length}. Not remade: ${failed.join(" · ")} Reload and try again for those.`);
  });
}

/** A photo's (or an uploaded Event Image's) 16:9 version: compose its display copy, PUT it, confirm it. */
async function makePhotoCover(mediaId, displayUrl, step) {
  step("making the 16:9 version…");
  let res;
  try {
    res = await fetch(displayUrl, { credentials: "omit" });
  } catch {
    throw new UserError("the photo couldn't be downloaded to make its 16:9 version. Check your connection and try again.");
  }
  if (!res.ok) throw new UserError(`the photo couldn't be downloaded (${res.status}). Reload the page and try again.`);
  const src = await decode(await res.blob());
  let canvas;
  try {
    canvas = await drawCover(src);
  } finally {
    src.close();
  }
  let cover;
  try {
    cover = await toJpeg(canvas, COVER_QUALITY);
  } finally {
    canvas.width = 0; canvas.height = 0;
  }

  step("uploading the 16:9 version…");
  const start = await postJson(`/api/admin/media/${mediaId}/cover`, { size: cover.size });
  if (start.status !== 201) throw new UserError(await serverMessage(start, "the 16:9 version couldn't start"));
  const plan = await start.json();
  let put;
  try {
    put = await fetch(plan.upload.url, { method: "PUT", headers: plan.upload.headers, body: cover, credentials: "omit" });
  } catch {
    throw new UserError("the 16:9 version upload failed (network). Try again.");
  }
  if (!put.ok) throw new UserError(`the 16:9 version upload was refused (${put.status}). Try again.`);
  const done = await postJson(`/api/admin/media/${mediaId}/cover-complete`, {});
  if (done.status !== 200) throw new UserError(await serverMessage(done, "the 16:9 version couldn't be confirmed"));
}

/** Decode the picked Event Image just to measure it, and check it. */
async function checkPicked(file) {
  const quick = checkEventImage({ name: file.name, type: file.type, size: file.size, width: Infinity, height: Infinity });
  if (!quick.ok) return quick; // type or size: no need to decode
  const src = await decode(file);
  try {
    return checkEventImage({ name: file.name, type: file.type, size: file.size, width: src.width, height: src.height });
  } finally {
    src.close();
  }
}

async function uploadOne(file, opts, step) {
  const eventImage = opts.kind === "event_image";
  const check = checkFile(file);
  if (!check.ok) throw new UserError(check.message);
  if (eventImage) {
    // Type and size before the (slow) decode.
    const quick = checkEventImage({ type: file.type, size: file.size, width: Infinity, height: Infinity });
    if (!quick.ok) throw new UserError(quick.message);
  }

  step(eventImage ? "preparing the image…" : "preparing the photo…");
  const { display, thumb, cover, width, height } = await makeCopies(file, { cover: eventImage });

  let requestBody;
  if (eventImage) {
    const ok = checkEventImage({ type: file.type, size: file.size, width, height });
    if (!ok.ok) throw new UserError(ok.message);
    requestBody = eventImageRequestBody({
      eventDate: opts.eventDate, original: { contentType: ok.contentType, size: file.size, width, height }, display, thumb, cover,
    });
  } else {
    requestBody = uploadRequestBody({ ...opts, original: { contentType: check.contentType, size: file.size }, display, thumb });
  }

  step("starting the upload…");
  const start = await postJson("/api/admin/media/uploads", requestBody);
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
    ...(cover ? [["cover", cover, "16:9 cover"]] : []),
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

async function makeCopies(file, { cover: withCover = false } = {}) {
  const src = await decode(file);
  const { width, height } = src;
  let displayCanvas;
  let thumbCanvas;
  let coverCanvas;
  try {
    const d = fitWithin(src.width, src.height, DISPLAY_EDGE);
    displayCanvas = drawScaled(src.image, d);
    // The 16:9 version is drawn from the decoded original, not the display copy.
    if (withCover) coverCanvas = await drawCover(src);
  } finally {
    src.close();
  }
  try {
    const t = fitWithin(displayCanvas.width, displayCanvas.height, THUMB_EDGE);
    thumbCanvas = drawScaled(displayCanvas, t);
    const display = await toJpeg(displayCanvas, DISPLAY_QUALITY);
    const thumb = await toJpeg(thumbCanvas, THUMB_QUALITY);
    const cover = coverCanvas ? await toJpeg(coverCanvas, COVER_QUALITY) : null;
    return { display, thumb, cover, width, height };
  } finally {
    // iOS keeps canvas memory until the canvas is shrunk.
    for (const c of [displayCanvas, thumbCanvas, coverCanvas]) if (c) { c.width = 0; c.height = 0; }
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

/** The 16:9 version of a picked file, as a JPEG blob (for the preview). */
async function composedCover(file) {
  const src = await decode(file);
  let canvas;
  try {
    canvas = await drawCover(src);
  } finally {
    src.close();
  }
  try {
    return await toJpeg(canvas, COVER_QUALITY);
  } finally {
    canvas.width = 0; canvas.height = 0;
  }
}

let background = null;
/** The beans background, decoded once per page. */
function loadBackground() {
  if (!background) {
    background = (async () => {
      const img = new Image();
      img.decoding = "async";
      img.src = COVER_BACKGROUND;
      await (img.decode ? img.decode() : new Promise((ok, no) => { img.onload = ok; img.onerror = no; }));
      return img;
    })().catch(() => {
      background = null;
      throw new UserError("the 16:9 background couldn't be loaded. Check your connection and try again.");
    });
  }
  return background;
}

/** The 16:9 version of a decoded image: the beans background, the image at full height, centred. */
async function drawCover(src) {
  const bg = await loadBackground();
  const c = composeCover(src.width, src.height);
  const canvas = document.createElement("canvas");
  canvas.width = c.canvas.width;
  canvas.height = c.canvas.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new UserError("this browser couldn't make the 16:9 version. Try another browser.");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bg, 0, 0, canvas.width, canvas.height);
  ctx.drawImage(src.image, c.dx, c.dy, c.dw, c.dh);
  return canvas;
}

/** Draw `source` scaled to width x height on a new canvas. */
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
