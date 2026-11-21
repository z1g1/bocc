// POST /api/admin/media/uploads: start one photo or promo video upload (ADR 0010). Admin only,
// Origin-checked, JSON in and out. The browser has already made the display copy and
// thumbnail; it declares the three files' types and sizes and gets back three
// presigned PUTs for them (src/lib/admin/media.mjs startUpload). The server sets
// publicly_usable from the kind (event_photo true, signin_board false); a
// `publiclyUsable` field in the request is ignored. The old kind "social_photo" (a tab
// opened before #54 deployed) is taken as event_photo.
//
//   request  { eventDate: "2026-11-24", kind: "signin_board" | "event_photo",
//              original: { contentType: "image/jpeg", size },
//              display: { size }, thumb: { size } }
//            or, for the promo video (Phase 5; one file, no copies):
//            { eventDate, kind: "promo_video", original: { contentType: "video/mp4" | "video/quicktime", size } }
//            -> uploads has `original` only
//   201      { id, eventDate, eventCreated, expiresInSeconds,
//              uploads: { original|display|thumb: { method: "PUT", url, headers } } }
//   400 { error, errors[] } · 401/403 · 405 · 503 { error } when storage is off
import type { APIRoute } from "astro";
import { json, mediaRoute, methodNotAllowed, readJson } from "../../../../lib/admin/media-http.mjs";
import { purgeIfEventCreated } from "../../../../lib/site/purge.mjs";

export const prerender = false;

export const POST: APIRoute = (ctx) =>
  mediaRoute(ctx, async ({ storage, user, request }) => {
    const body = await readJson(request);
    const { startUpload } = await import("../../../../lib/admin/media.mjs");
    const result = await startUpload(user.id, storage, body);
    // The first upload for a date creates its events row: clear a cached public 404
    // for /events/<date>/ (ADR 0009). Awaited, bounded at ~3 s, never throws.
    await purgeIfEventCreated(result, { locals: ctx.locals });
    return json(201, result);
  });

export const ALL: APIRoute = methodNotAllowed;
