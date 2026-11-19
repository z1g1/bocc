// POST /api/admin/media/{id}/cover-complete: the browser has PUT a photo's 16:9 cover;
// confirm it in the bucket (HEAD: type and size as signed) and record it (ticket #21).
// Admin only, Origin-checked, JSON.
//   200 { id, status: "ready", coverKey }
//   409 { id, status: "pending", problems[] }   missing or wrong; the photo stays without a cover
//   404 · 401/403 · 405 · 503 when storage is off
import type { APIRoute } from "astro";
import { json, mediaRoute, methodNotAllowed } from "../../../../../lib/admin/media-http.mjs";

export const prerender = false;

export const POST: APIRoute = (ctx) =>
  mediaRoute(ctx, async ({ storage, user }) => {
    const { completeCover } = await import("../../../../../lib/admin/media.mjs");
    const { pool } = await import("../../../../../lib/admin/db.mjs");
    const result = await completeCover(user.id, storage, String(ctx.params.id), { db: pool });
    return json(result.status === "ready" ? 200 : 409, result);
  });

export const ALL: APIRoute = methodNotAllowed;
