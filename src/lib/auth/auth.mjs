// THE Better Auth instance (ADR 0008, amendment 7). Every caller builds auth from
// this one module: Astro routes and middleware, CommonJS Netlify functions
//   const { auth } = await import("../../../src/lib/auth/auth.mjs");
// and the create-admin CLI. In the Phase 0 spike a second instance with different
// session settings rewrote a session's expiry when it read it, so never call
// betterAuth() anywhere else.
//
// Importing this module validates the environment (src/lib/auth/env.mjs) and throws
// if anything is missing (ADR 0001). Import it LAZILY (`await import()`) from code that
// also runs at build time, such as src/middleware.ts, so the static build needs no
// secrets.
//
// It also owns the single `admin_app` pg Pool. Better Auth and the admin data layer
// (src/lib/admin/db.mjs) share it, so one function instance opens one small pool.

import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins/admin";
import { passkey } from "@better-auth/passkey";
import { PostgresDialect } from "kysely";
import pg from "pg";
import { readAdminEnv } from "./env.mjs";
import { toAdminPgConfig } from "./pg-config.mjs";

export const adminEnv = readAdminEnv();

/** The one admin_app pool. Use it through src/lib/admin/db.mjs. */
export const pool = new pg.Pool(toAdminPgConfig(adminEnv.dbUrl, { max: adminEnv.poolMax }));
// An idle client dropped by Neon (scale to zero) must not crash the process.
pool.on("error", (err) => console.error("[admin db] idle client error:", err.message));

const DAY = 60 * 60 * 24;

export const auth = betterAuth({
  appName: "BOCC admin",
  baseURL: adminEnv.baseURL,
  basePath: "/api/auth",
  secret: adminEnv.secret,
  trustedOrigins: [adminEnv.baseURL],
  telemetry: { enabled: false },

  // Tables live in the `auth` schema. search_path doesn't survive Neon's pooler, so
  // the schema is set here and every statement is qualified with it.
  database: {
    dialect: new PostgresDialect({ pool }),
    type: "postgres",
    schemaName: "auth",
  },

  // Password login only for accounts an admin created. disableSignUp also blocks the
  // server-side signUpEmail; accounts are made with the admin plugin's createUser
  // (src/lib/admin/users.mjs). No email flows in the MVP, so no reset-by-email.
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    minPasswordLength: 12,
  },

  // 30-day sliding sessions (long enough for the weekly Chrome tasks). getSession
  // writes the new expiry at most once a day. cookieCache stays OFF so a revoked
  // session stops working on the next request.
  session: {
    expiresIn: 30 * DAY,
    updateAge: 1 * DAY,
    cookieCache: { enabled: false },
  },

  // Counters in the auth."rateLimit" table: in-memory counters are useless on
  // serverless. Enabled everywhere (Better Auth's default is production only).
  rateLimit: {
    enabled: true,
    storage: "database",
    customRules: {
      "/sign-in/email": { window: 60, max: 5 },
      "/passkey/verify-authentication": { window: 60, max: 10 },
    },
  },

  advanced: {
    // Netlify sets this header itself; X-Forwarded-For can be supplied by the client.
    ipAddress: { ipAddressHeaders: ["x-nf-client-connection-ip"] },
  },

  plugins: [
    // Used ONLY for createUser and password resets (ADR 0008 decision 4). Its `role`
    // column is never read: roles live in public.user_roles. Nobody is given the
    // plugin's "admin" role, so its HTTP endpoints refuse everyone, and the
    // /api/auth/admin/* paths are also blocked in src/pages/api/auth/[...all].ts.
    admin(),
    // Passkeys are bound to the host: 716coffee.club, dev--bocc-backend.netlify.app
    // or localhost, taken from BETTER_AUTH_URL. Registration needs a signed-in session.
    passkey({
      rpID: adminEnv.rpID,
      rpName: "Buffalo Open Coffee Club admin",
      origin: adminEnv.baseURL,
    }),
  ],
});
