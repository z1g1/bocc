// POST /api/admin/social/channel: record one channel's result (setChannelResult,
// src/lib/admin/social.mjs; the rules are in its header). Admin and social,
// Origin-checked, JSON in and out.
//   request  { date: "2026-11-24", channel: "facebook" | "instagram" | "threads" | "tiktok" | "linkedin_page",
//              status?: "pending" | "scheduled" | "live" | "failed", postUrl?: string, notes?: string,
//              verified?: boolean, commentPosted?: boolean }
//            an absent field keeps what is stored; "" or null clears postUrl / notes;
//            any other non-string status / postUrl / notes (123, {}, []) is a 400 on that
//            field. The post URL is stored as parsed (lower-case scheme and host).
//   200 { changed, channel: { channel, label, status, postUrl, verifiedAt, commentPostedAt, notes, … } }
//   400 / 404 / 409 { error, errors: { field: message } } · 401 / 403 · 405
import type { APIRoute } from "astro";
import { requireRole } from "../../../../lib/admin/roles.mjs";
import { checkOrigin } from "../../../../lib/admin/csrf.mjs";
import { socialApiChannel, socialApiOther } from "../../../../lib/admin/social-api.mjs";

export const prerender = false;

export const POST: APIRoute = ({ locals, request }) =>
  requireRole(locals, "admin", "social") ?? checkOrigin(request) ?? socialApiChannel(locals.user!.id, request);
export const ALL: APIRoute = ({ locals }) => requireRole(locals, "admin", "social") ?? socialApiOther("POST");
