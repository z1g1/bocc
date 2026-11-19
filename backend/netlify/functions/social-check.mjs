// Thursday social check (ADR 0011 decision 5, amended 2026-11-18): a Netlify scheduled
// function that pushes an ntfy alert when the next Tuesday's social post is missing,
// not ready, or has a channel that isn't `scheduled` / `live` yet. Silent (log only)
// when everything is fine. It also alerts, separately, when a LinkedIn connection has
// under 10 days left or has expired (ADR 0012, #24). The logic is in src/lib/social-alert/ (alert.mjs is pure
// and unit-tested; run.mjs does the database read and the push).
//
// Schedule: Thursdays 14:00 UTC = 9:00 AM EST / 10:00 AM EDT, morning in Buffalo all
// year. Netlify cron is always UTC.
//
// Netlify only runs scheduled functions on the published production deploy. On the
// dev branch deploy (staging), trigger it by hand: Netlify -> the site -> Logs ->
// Functions, pick the dev branch deploy, open `social-check`, "Run now". Scheduled
// functions can't be invoked by URL. See docs/admin/PHASE5_RELEASE.md.

// Telemetry (docs/backend/OBSERVABILITY.md): this is a v2 function, so when Netlify
// tracing is on the run is a "social.check" span (src/lib/social-alert/run.mjs) under
// the invocation's trace. Its log lines are JSON with the trace id either way.

import { runSocialCheck } from "../../../src/lib/social-alert/run.mjs";
import { describeError, log } from "../../../src/lib/telemetry.mjs";

export default async (_req, context) => {
  try {
    await runSocialCheck({ env: process.env, context });
  } catch (err) {
    // runSocialCheck logs and alerts on every expected failure; this is a bug. Log it
    // without secrets, then fail the invocation as before.
    log("error", `[social-check] unexpected failure: ${describeError(err)}`);
    throw err;
  }
};

export const config = {
  schedule: "0 14 * * 4",
};
