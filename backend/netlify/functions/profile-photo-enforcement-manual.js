/**
 * Profile Photo Enforcement - Manual/On-Demand Function
 *
 * Epic 4: Profile Photo Enforcement System
 *
 * HTTP-accessible endpoint for manual testing. Shares the handler shell with the
 * scheduled function (see profile-photo-enforcement.js) but is hard-wired to the
 * test user as a safety affordance — it can never run unfiltered enforcement.
 */

const { makeEnforcementHandler } = require('./profile-photo-enforcement');
const config = require('./utils/config');

// Manual endpoint only processes the test user to prevent accidental mass-processing.
exports.handler = makeEnforcementHandler({ filterEmail: config.enforcement.testUserEmail });
