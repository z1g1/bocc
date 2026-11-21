// Promo video upload for the event page's "Social plan" section (ADR 0010, ADR 0011).
// Loaded by src/components/admin/SocialPlan.astro as
// <script type="module" src="/js/admin-video.js">: the admin CSP is script-src 'self',
// so no inline code or handlers. Plain JS, no framework.
//
// One file, uploaded as is (no copies): POST /api/admin/media/uploads with kind
// promo_video, PUT the file to its presigned URL (XMLHttpRequest, for upload progress),
// POST /api/admin/media/{id}/complete, then submit the page's hidden "use this video"
// form, which attaches it to the Social plan (post/redirect/get, like the other forms).
// The delete buttons' confirm prompts are wired by /js/admin-media.js, which the same
// page loads whenever storage is on.

import { checkVideoFile, formatBytes, videoUploadRequestBody } from "./admin-media-lib.js";

class UserError extends Error {}

const form = document.querySelector("form[data-video-upload]");
if (form) setUp(form);

function setUp(form) {
  const input = form.querySelector('input[type="file"]');
  const button = form.querySelector('button[type="submit"]');
  const status = document.getElementById(form.getAttribute("data-status"));
  const attach = document.querySelector("form[data-video-attach]");
  const eventDate = form.getAttribute("data-event-date");
  const say = (text) => { status.textContent = text.charAt(0).toUpperCase() + text.slice(1); };
  let busy = false;

  for (const el of document.querySelectorAll("[data-video-nojs]")) el.hidden = true;
  form.hidden = false;
  window.addEventListener("beforeunload", (e) => {
    if (busy) { e.preventDefault(); e.returnValue = ""; }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy) return;
    const file = (input.files || [])[0];
    if (!file) { say("Choose the video."); return; }
    busy = true;
    button.disabled = true;
    try {
      const id = await upload(file, eventDate, say);
      say("Uploaded. Attaching it to the post…");
      busy = false;
      attach.querySelector('input[name="videoMediaId"]').value = id;
      attach.submit();
    } catch (err) {
      busy = false;
      button.disabled = false;
      input.value = "";
      say(err instanceof UserError ? err.message : "something went wrong. Check your connection and try again.");
    }
  });
}

async function upload(file, eventDate, say) {
  const check = checkVideoFile(file);
  if (!check.ok) throw new UserError(check.message);

  say("starting the upload…");
  const start = await postJson("/api/admin/media/uploads",
    videoUploadRequestBody({ eventDate, original: { contentType: check.contentType, size: file.size } }));
  if (start.status !== 201) throw new UserError(await serverMessage(start, "the upload couldn't start"));
  const plan = await start.json();
  // Clean up only when the video certainly did NOT complete (see admin-media.js).
  const abandon = () => { postJson(`/api/admin/media/${plan.id}/delete`, {}).catch(() => {}); };

  const u = plan.uploads.original;
  const total = formatBytes(file.size);
  let res;
  try {
    res = await put(u, file, (sent) => say(`uploading the video… ${Math.floor((sent / file.size) * 100)}% of ${total}`));
  } catch {
    abandon();
    throw new UserError("the video upload failed (network). Try again.");
  }
  if (res < 200 || res >= 300) {
    abandon();
    throw new UserError(`the video upload was refused (${res}). Try again.`);
  }

  say("checking…");
  let done;
  try {
    done = await postJson(`/api/admin/media/${plan.id}/complete`, {});
  } catch {
    throw new UserError("the connection dropped while finishing. Reload the page to see whether the video arrived.");
  }
  if (done.status === 200) return plan.id;
  if (done.status === 409) {
    const body = await done.json().catch(() => ({}));
    abandon();
    throw new UserError(`the upload didn't complete${body.problems ? ` (${body.problems.join("; ")})` : ""}. Try again.`);
  }
  throw new UserError(`the upload couldn't be confirmed (${done.status}). Reload the page to see whether the video arrived.`);
}

/** PUT with progress; resolves with the HTTP status, rejects on a network error. */
function put({ method, url, headers }, body, progress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    for (const [k, v] of Object.entries(headers || {})) {
      // The browser sets Content-Length itself (and refuses to be told).
      if (k.toLowerCase() !== "content-length") xhr.setRequestHeader(k, v);
    }
    xhr.upload.addEventListener("progress", (e) => { if (e.lengthComputable) progress(e.loaded); });
    xhr.addEventListener("load", () => resolve(xhr.status));
    xhr.addEventListener("error", () => reject(new Error("network")));
    xhr.addEventListener("abort", () => reject(new Error("aborted")));
    xhr.send(body);
  });
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
