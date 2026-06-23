/**
 * Profile Photo Enforcement - Manual/On-Demand Function
 *
 * Epic 4: Profile Photo Enforcement System
 *
 * HTTP-accessible endpoint for manual testing. Shares the handler shell with the
 * scheduled function (see profile-photo-enforcement.js) but is hardened two ways:
 *   1. hard-wired to the test user, so it can never run unfiltered enforcement;
 *   2. requires a valid `x-enforcement-token` header (fails closed if the
 *      ENFORCEMENT_TRIGGER_TOKEN env var is unset), so it can't be triggered
 *      anonymously.
 */

const { makeEnforcementHandler } = require('./profile-photo-enforcement');
const config = require('./utils/config');

// Manual endpoint: test user only + shared-secret required.
exports.handler = makeEnforcementHandler({
  filterEmail: config.enforcement.testUserEmail,
  requireToken: true
});
