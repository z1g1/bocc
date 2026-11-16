// POST /logout: end the Better Auth session and go back to the login page.
// A form POST only (Astro's checkOrigin refuses cross-site form posts); GET does nothing.
import type { APIRoute } from "astro";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const headers = new Headers({ location: "/login/" });
  try {
    const { auth } = await import("../lib/auth/auth.mjs");
    const result = await auth.api.signOut({ headers: request.headers, returnHeaders: true });
    for (const c of result.headers?.getSetCookie?.() ?? []) headers.append("set-cookie", c);
  } catch {
    // No session (already signed out): nothing to revoke.
  }
  return new Response(null, { status: 303, headers });
};

export const GET: APIRoute = () => new Response(null, { status: 303, headers: { location: "/admin/" } });
