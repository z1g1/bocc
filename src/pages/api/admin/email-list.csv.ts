// POST /api/admin/email-list.csv: download the email list (ok_to_email, no test rows).
// Admin only. Each export writes an audit_log row (who, when, row count) in the same
// transaction that reads the rows. POST rather than GET so a cross-site link can't
// trigger an export, and the Origin is checked like every other admin mutation.
import type { APIRoute } from "astro";
import { requireRole } from "../../../lib/admin/roles.mjs";
import { checkOrigin } from "../../../lib/admin/csrf.mjs";

export const prerender = false;

export const POST: APIRoute = async ({ locals, request }) => {
  const denied = requireRole(locals, "admin") ?? checkOrigin(request);
  if (denied) return denied;
  const { exportEmailList } = await import("../../../lib/admin/email-list.mjs");
  const { csv } = await exportEmailList(locals.user!.id);
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  return new Response(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="bocc-email-list-${day}.csv"`,
      "cache-control": "no-store",
    },
  });
};
