// Thursday social check (ADR 0011 decision 5, amended 2026-11-18): a Netlify scheduled
// function that pushes an ntfy alert when the next Tuesday's social post is missing,
// not ready, or has a channel that isn't `scheduled` / `live` yet. Silent (log only)
// when everything is fine. The logic is in src/lib/social-alert/ (alert.mjs is pure
// and unit-tested; run.mjs does the database read and the push).
//
// Schedule: Thursdays 14:00 UTC = 9:00 AM EST / 10:00 AM EDT, morning in Buffalo all
// year. Netlify cron is always UTC.
//
// Netlify only runs scheduled functions on the published production deploy. On the
// dev branch deploy (staging), trigger it by hand: Netlify -> the site -> Logs ->
// Functions, pick the dev branch deploy, open `social-check`, "Run now". Scheduled
// functions can't be invoked by URL. See docs/admin/PHASE5_RELEASE.md.

import { runSocialCheck } from "../../../src/lib/social-alert/run.mjs";

export default async (_req, context) => {
  await runSocialCheck({ env: process.env, context });
};

export const config = {
  schedule: "0 14 * * 4",
};
