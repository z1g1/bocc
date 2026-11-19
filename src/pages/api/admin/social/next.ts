// GET /api/admin/social/next: the same pick as /admin/social/next/, as JSON (ADR 0011
// decision 4). Admin and social.
//   200 { state: "ready", order: { date, ready, actionable, problems[], publishAt (ISO),
//         publishAtEastern, publishAtUtc, coverNote, lumaUrl, channels: [{ channel,
//         label, status, postUrl, verifiedAt, commentPostedAt, notes, caption,
//         firstComment, captionLength, captionLimit }] },
//         video: { fileName, downloadUrl, expiresAt, contentType, sizeBytes } | { unavailable } | null,
//         cover: { source: "event_image" | "override", eventImageSource, fileName, downloadUrl,
//                  expiresAt (null for the logo default, a link on this site), contentType } | { unavailable } | null }
//   200 { state: "nothing", reason: "no_post" | "not_ready" | "problems",
//         message, date, problems[], upcoming[] }
//         about the EARLIEST upcoming week that still has work (findNext): a later
//         week's post is never handed out while that one isn't actionable.
//   401 / 403 · 405 for other methods
import type { APIRoute } from "astro";
import { requireRole } from "../../../../lib/admin/roles.mjs";
import { socialApiGet, socialApiOther } from "../../../../lib/admin/social-api.mjs";

export const prerender = false;

export const GET: APIRoute = ({ locals, request }) => requireRole(locals, "admin", "social") ?? socialApiGet("next", request);
export const ALL: APIRoute = ({ locals }) => requireRole(locals, "admin", "social") ?? socialApiOther("GET");
