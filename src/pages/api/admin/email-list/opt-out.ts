// POST /api/admin/email-list/opt-out: set an attendee's ok_to_email to false. Admin
// only, Origin-checked, and the change and its audit row commit together
// (src/lib/admin/email-list.mjs optOut). A plain form POST: answers with a 303 back
// to the page it came from (an /admin path only) with ?notice=opted-out.
import type { APIRoute } from "astro";
import { requireRole } from "../../../../lib/admin/roles.mjs";
import { checkOrigin } from "../../../../lib/admin/csrf.mjs";
import { safeNext } from "../../../../lib/admin/next.mjs";

export const prerender = false;

export const POST: APIRoute = async ({ locals, request }) => {
  const denied = requireRole(locals, "admin") ?? checkOrigin(request);
  if (denied) return denied;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return text(400, "Bad Request");
  }
  const attendeeId = String(form.get("attendeeId") ?? "");
  const { optOut } = await import("../../../../lib/admin/email-list.mjs");
  try {
    await optOut(locals.user!.id, attendeeId);
  } catch (err: any) {
    if (err?.status === 404) return text(404, "Attendee not found");
    throw err;
  }

  const back = new URL(safeNext(String(form.get("return") ?? "/admin/email-list/")), "http://x");
  back.searchParams.set("notice", "opted-out");
  return new Response(null, { status: 303, headers: { location: back.pathname + back.search } });
};

const text = (status: number, body: string) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
