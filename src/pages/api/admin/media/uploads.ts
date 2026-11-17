// POST /api/admin/media/uploads: start one photo upload (ADR 0010). Admin only,
// Origin-checked, JSON in and out. The browser has already made the display copy and
// thumbnail; it declares the three files' types and sizes and gets back three
// presigned PUTs for them (src/lib/admin/media.mjs startUpload).
//
//   request  { eventDate: "2026-11-24", kind: "signin_board" | "social_photo",
//              publiclyUsable: false, original: { contentType: "image/jpeg", size },
//              display: { size }, thumb: { size } }
//   201      { id, eventDate, eventCreated, expiresInSeconds,
//              uploads: { original|display|thumb: { method: "PUT", url, headers } } }
//   400 { error, errors[] } · 401/403 · 405 · 503 { error } when storage is off
import type { APIRoute } from "astro";
import { json, mediaRoute, methodNotAllowed, readJson } from "../../../../lib/admin/media-http.mjs";

export const prerender = false;

export const POST: APIRoute = (ctx) =>
  mediaRoute(ctx, async ({ storage, user, request }) => {
    const body = await readJson(request);
    const { startUpload } = await import("../../../../lib/admin/media.mjs");
    return json(201, await startUpload(user.id, storage, body));
  });

export const ALL: APIRoute = methodNotAllowed;
