// Browser-side Better Auth client for the login and account pages. Bundled by Astro
// into /_astro/*.js (first-party, so the admin CSP's script-src 'self' covers it).
// Talks only to /api/auth on the same origin.
import { createAuthClient } from "better-auth/client";
import { passkeyClient } from "@better-auth/passkey/client";

export const authClient = createAuthClient({ plugins: [passkeyClient()] });

/** Human-readable message from a Better Auth client error. */
export const errorMessage = (error) =>
  error?.status === 429
    ? "Too many attempts. Wait a minute and try again."
    : error?.message || "Something went wrong. Try again.";
