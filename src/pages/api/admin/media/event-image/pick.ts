// POST /api/admin/media/event-image/pick: make a recent Photo from Event this event's
// Event Image, by reference (ticket #21, ADR 0012 decision 3). Admin only,
// Origin-checked. The event points at the photo (no copy), audited
// `event_image.pick`; an uploaded Event Image is deleted (src/lib/admin/event-image.mjs
// pickEventImage). The picker's script makes the photo's 16:9 Event Image first when it has
// none (/api/admin/media/{id}/cover).
//   form { eventDate, mediaId } -> 303 to /admin/events/<date>/?tab=info&media=event-image-picked#event-image
//                                  (event-image-picked-partial when a replaced upload's object
//                                  couldn't be removed, event-image-unchanged-pick when it was already picked)
//   JSON { eventDate, mediaId } -> 200 { changed, eventDate, mediaId, needs16x9, replaced, leftovers }
//   400 a bad date or a photo the picker doesn't offer · 401/403 · 405 · 503 when storage is off
import type { APIRoute } from "astro";
import { formOrJson, mediaRoute, methodNotAllowed, readFormOrJson } from "../../../../../lib/admin/media-http.mjs";

export const prerender = false;

export const POST: APIRoute = (ctx) =>
  mediaRoute(ctx, async ({ storage, user, request }) => {
    const { form, data } = await readFormOrJson(request);
    const { pickEventImage } = await import("../../../../../lib/admin/event-image.mjs");
    const result = await pickEventImage(user.id, storage, String(data.eventDate ?? ""), String(data.mediaId ?? ""));
    const notice = !result.changed ? "event-image-unchanged-pick"
      : result.leftovers.length ? "event-image-picked-partial" : "event-image-picked";
    // eventDate passed pickEventImage's date check, so it is a safe YYYY-MM-DD.
    return formOrJson(form, result.eventDate, notice, result, "event-image");
  });

export const ALL: APIRoute = methodNotAllowed;
