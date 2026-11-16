// Better Auth's endpoints (sign-in, sign-out, session, passkeys) at /api/auth/*.
// On demand only; the handler and the shared instance load on the first request.
import type { APIRoute } from "astro";
import { handleAuthRequest } from "../../../lib/auth/handler.mjs";

export const prerender = false;

export const ALL: APIRoute = ({ request }) => handleAuthRequest(request);
