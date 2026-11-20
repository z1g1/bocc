// POST /api/admin/media/{id}/delete: delete one photo's (or promo video's) row
// (audited) and then its objects. Admin only, Origin-checked.
//   form post (gallery button)  -> 303 to /admin/events/<the photo's date>/?tab=post with
//                                  &media=deleted, or ?media=deleted-partial when an
//                                  object couldn't be removed (logged with its key)
//                                  (a promo video: ?tab=social&media=video-deleted[-partial]#social; it
//                                  is also cleared from the Social plan and un-readies it)
//   JSON (upload script giving up on a failed upload) -> 200 { id, eventDate, kind, leftovers[] }
//   a photo picked as an Event Image (ticket #21) is refused, nothing deleted:
//     form -> 303 to /admin/events/<the photo's date>/?tab=post&media=in-use&used-by=<date,…>#event-media
//     JSON -> 409 { error, errors[], eventDates[] }
//   404 · 401/403 · 405 · 503 when storage is off (the row is kept, so nothing is orphaned)
import type { APIRoute } from "astro";
import { formOrJson, mediaRoute, methodNotAllowed, readFormOrJson } from "../../../../../lib/admin/media-http.mjs";

export const prerender = false;

export const POST: APIRoute = (ctx) =>
  mediaRoute(ctx, async ({ storage, user, request }) => {
    const { form } = await readFormOrJson(request);
    const { deleteMedia, InUseError } = await import("../../../../../lib/admin/media.mjs");
    let result;
    try {
      result = await deleteMedia(user.id, storage, String(ctx.params.id));
    } catch (err) {
      // Dates from the database, so the redirect is safe (formOrJson checks the date).
      if (form && err instanceof InUseError) {
        return formOrJson(form, err.photoDate, "in-use", {}, "event-media", { "used-by": err.eventDates.join(",") });
      }
      throw err;
    }
    if (result.kind === "event_image") {
      // An unfinished Event Image upload (the section's "Unfinished uploads").
      return formOrJson(form, result.eventDate, result.leftovers.length ? "deleted-partial" : "deleted", result, "event-image");
    }
    if (result.kind === "promo_video") {
      return formOrJson(form, result.eventDate, result.leftovers.length ? "video-deleted-partial" : "video-deleted", result, "social");
    }
    return formOrJson(form, result.eventDate, result.leftovers.length ? "deleted-partial" : "deleted", result);
  });

export const ALL: APIRoute = methodNotAllowed;
