// POST /api/admin/media/{id}/complete: the browser has PUT all three files; confirm
// them in the bucket (HEAD: type and size as signed) and mark the photo ready.
// Admin only, Origin-checked, JSON.
//   200 { id, status: "ready" }
//   409 { id, status: "pending", problems[] }   something is missing or wrong; the row stays pending
//   404 · 401/403 · 405 · 503 when storage is off
import type { APIRoute } from "astro";
import { json, mediaRoute, methodNotAllowed } from "../../../../../lib/admin/media-http.mjs";

export const prerender = false;

export const POST: APIRoute = (ctx) =>
  mediaRoute(ctx, async ({ storage, user }) => {
    const { completeUpload } = await import("../../../../../lib/admin/media.mjs");
    const { pool } = await import("../../../../../lib/admin/db.mjs");
    const result = await completeUpload(user.id, storage, String(ctx.params.id), { db: pool });
    return json(result.status === "ready" ? 200 : 409, result);
  });

export const ALL: APIRoute = methodNotAllowed;
