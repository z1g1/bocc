// POST /api/admin/media/{id}/cover: start the 16:9 Event Image of a Photo from Event
// picked as an Event Image (ticket #21), or remake one made under the old centre-crop
// rule (a Photo from Event or an uploaded Event Image, ticket #40). The browser made the
// JPEG (the display copy at full height on the beans background) and declares its size.
// Admin only, Origin-checked, JSON.
// The route keeps the old name "cover" (as does the object key, …/cover.jpg).
//   { size } -> 201 { id, eventDate, key, expiresInSeconds, upload: { method, url, headers } }
//   400 not a ready Photo from Event or Event Image, its 16:9 Event Image is current, or a bad size
//   404 · 401/403 · 405 · 503 when storage is off
// Then PUT the file to upload.url and POST /api/admin/media/{id}/cover-complete.
import type { APIRoute } from "astro";
import { json, mediaRoute, methodNotAllowed, readJson } from "../../../../../lib/admin/media-http.mjs";

export const prerender = false;

export const POST: APIRoute = (ctx) =>
  mediaRoute(ctx, async ({ storage, user, request }) => {
    const body = await readJson(request);
    const { startImage16x9 } = await import("../../../../../lib/admin/media.mjs");
    return json(201, await startImage16x9(user.id, storage, String(ctx.params.id), body));
  });

export const ALL: APIRoute = methodNotAllowed;
