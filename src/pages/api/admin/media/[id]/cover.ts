// POST /api/admin/media/{id}/cover: start the 16:9 cover copy of a Photo from Event
// picked as an Event Image (ticket #21). The browser made the JPEG (a centre crop of
// the display copy) and declares its size. Admin only, Origin-checked, JSON.
//   { size } -> 201 { id, eventDate, key, expiresInSeconds, upload: { method, url, headers } }
//   400 not a ready Photo from Event, it already has a cover, or a bad size
//   404 · 401/403 · 405 · 503 when storage is off
// Then PUT the file to upload.url and POST /api/admin/media/{id}/cover-complete.
import type { APIRoute } from "astro";
import { json, mediaRoute, methodNotAllowed, readJson } from "../../../../../lib/admin/media-http.mjs";

export const prerender = false;

export const POST: APIRoute = (ctx) =>
  mediaRoute(ctx, async ({ storage, user, request }) => {
    const body = await readJson(request);
    const { startCover } = await import("../../../../../lib/admin/media.mjs");
    return json(201, await startCover(user.id, storage, String(ctx.params.id), body));
  });

export const ALL: APIRoute = methodNotAllowed;
