/**
 * Profile Photo Enforcement - Manual/On-Demand Function
 *
 * Epic 4: Profile Photo Enforcement System
 *
 * HTTP-accessible endpoint for manual testing. Shares the handler shell with the
 * scheduled function (see profile-photo-enforcement.js) but is hardened two ways:
 *   1. hard-wired to the test user, so it can never run unfiltered enforcement;
 *   2. as a normal HTTP function it never receives the cron signal, so the
 *      shared authorization gate only admits it with a valid `x-enforcement-token`
 *      (fails closed if the ENFORCEMENT_TRIGGER_TOKEN env var is unset).
 */

const { makeEnforcementHandler } = require('./profile-photo-enforcement');
const config = require('./utils/config');

// Manual endpoint: test user only (authorization handled by the shared gate).
exports.handler = makeEnforcementHandler({ filterEmail: config.enforcement.testUserEmail });
