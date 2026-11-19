// POST /api/admin/media/event-image/clear: clear an event's Event Image (ADR 0012
// decision 3), so it goes back to the BOCC logo. Admin only, Origin-checked. Deletes
// the row (audited `event_image.clear`) and then its four objects
// (src/lib/admin/event-image.mjs clearEventImage).
//   form { eventDate }  -> 303 to /admin/events/<date>/?tab=info&media=event-image-cleared#event-image
//                          (event-image-cleared-partial when an object couldn't be removed,
//                          event-image-unchanged when there was nothing to clear)
//   400 bad date · 401/403 · 405 · 503 when storage is off
import type { APIRoute } from "astro";
import { formOrJson, mediaRoute, methodNotAllowed, readFormOrJson } from "../../../../../lib/admin/media-http.mjs";

export const prerender = false;

export const POST: APIRoute = (ctx) =>
  mediaRoute(ctx, async ({ storage, user, request }) => {
    const { form, data } = await readFormOrJson(request);
    const { clearEventImage } = await import("../../../../../lib/admin/event-image.mjs");
    const result = await clearEventImage(user.id, storage, String(data.eventDate ?? ""));
    const notice = !result.changed ? "event-image-unchanged"
      : result.leftovers.length ? "event-image-cleared-partial" : "event-image-cleared";
    // eventDate passed clearEventImage's date check, so it is a safe YYYY-MM-DD.
    return formOrJson(form, result.eventDate, notice, result, "event-image");
  });

export const ALL: APIRoute = methodNotAllowed;
