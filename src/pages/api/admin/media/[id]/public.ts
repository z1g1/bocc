// POST /api/admin/media/{id}/public: set "OK to use publicly" on a social photo
// (sign-in board photos never are; the CHECK on event_media agrees). Admin only,
// Origin-checked, audited.
//   form post  publiclyUsable=1|0  -> 303 to the photo's event page with ?media=public-on|public-off
//   JSON       { publiclyUsable: true|false }        -> 200 { id, publiclyUsable }
//   400 (not a social photo, bad value) · 404 · 401/403 · 405 · 503 when storage is off
import type { APIRoute } from "astro";
import { formOrJson, mediaRoute, methodNotAllowed, readFormOrJson } from "../../../../../lib/admin/media-http.mjs";

export const prerender = false;

const FORM_BOOL: Record<string, boolean> = { "1": true, "0": false, true: true, false: false };

export const POST: APIRoute = (ctx) =>
  mediaRoute(ctx, async ({ user, request }) => {
    const { form, data } = await readFormOrJson(request);
    const raw = data.publiclyUsable;
    const value = form ? FORM_BOOL[String(raw)] : raw;
    const { setPubliclyUsable } = await import("../../../../../lib/admin/media.mjs");
    const result = await setPubliclyUsable(user.id, String(ctx.params.id), value as boolean);
    return formOrJson(form, result.eventDate, result.publiclyUsable ? "public-on" : "public-off", {
      id: result.id, publiclyUsable: result.publiclyUsable,
    });
  });

export const ALL: APIRoute = methodNotAllowed;
