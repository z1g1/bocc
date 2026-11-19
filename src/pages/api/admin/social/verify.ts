// GET /api/admin/social/verify: the same pick as /admin/social/verify/, as JSON (ADR
// 0011 decision 4). Admin and social.
//   200 { state: "verify", order: (as GET /api/admin/social/next), video, allDone,
//         todo: [{ channel, task: "verify" | "never_scheduled" | "comment", message }] }
//   200 { state: "nothing", message, nextPublish: { date, publishAt } | null }
//   401 / 403 · 405 for other methods
import type { APIRoute } from "astro";
import { requireRole } from "../../../../lib/admin/roles.mjs";
import { socialApiGet, socialApiOther } from "../../../../lib/admin/social-api.mjs";

export const prerender = false;

export const GET: APIRoute = ({ locals, request }) => requireRole(locals, "admin", "social") ?? socialApiGet("verify", request);
export const ALL: APIRoute = ({ locals }) => requireRole(locals, "admin", "social") ?? socialApiOther("GET");
