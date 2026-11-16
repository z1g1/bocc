/// <reference types="astro/client" />

// Set by src/middleware.ts on /admin/* and /api/admin/* only (undefined elsewhere).
declare namespace App {
  interface Locals {
    user?: { id: string; email: string; name: string };
    session?: { id: string; expiresAt: Date };
    /** From public.user_roles, never the admin plugin's user.role. */
    roles?: Array<"admin" | "social">;
  }
}
