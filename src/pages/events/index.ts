// /events/ with no date: a 302 to the home page, which has the schedule and the Luma
// calendar. Not a 404: people trim a shared /events/YYYY-MM-DD/ link back to /events/
// and should land somewhere useful. Not a 301, so an events index can be added later
// without browsers having cached the redirect. Rendered on request (a static page
// can't redirect); it never touches the database, and the CDN keeps it for a day.
import type { APIRoute } from "astro";
import { setPublicHeaders } from "../../lib/site/http.mjs";

export const prerender = false;

export const GET: APIRoute = () => {
  const headers = setPublicHeaders(new Headers({ Location: "/" }), "cached");
  return new Response(null, { status: 302, headers });
};
