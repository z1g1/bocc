/**
 * Profile Photo Enforcement - Scheduled Function
 * Weekly automated enforcement of profile photo policy
 *
 * Epic 4: Profile Photo Enforcement System
 * Epic 5: Refactored to use client-side filtering (Feb 2026)
 * STORY-17: Netlify Scheduled Function
 *
 * Runs every Monday at 9:00 AM EST via Netlify Scheduled Functions
 * Configured in netlify.toml
 */

const crypto = require('crypto');
const { getAllMembers } = require('./utils/circle');
const { findWarningByEmail, getActiveWarnings } = require('./utils/airtable-warnings');
const {
  determineEnforcementAction,
  processEnforcementAction
} = require('./utils/enforcement-logic');
const config = require('./utils/config');

/**
 * Enforce the photo policy for a single member: decide the action, then execute
 * it. This is the shared per-member step used by both passes of the run (the
 * no-photo pass and the photo-added pass).
 *
 * @param {object} member - Circle member
 * @param {object|null} existingWarning - the member's current warning record
 * @param {boolean} dryRun
 * @returns {Promise<{action: object, result: object}>}
 */
const enforceMember = async (member, existingWarning, dryRun) => {
  const action = determineEnforcementAction(member, existingWarning);

  console.log(`  Action: ${action.action} (Level ${action.warningLevel})`);
  console.log(`  Reason: ${action.reason}`);

  const result = await processEnforcementAction(member, existingWarning, action, dryRun);

  return { action, result };
};

/**
 * Fold a single member's enforcement outcome into the run summary.
 *
 * @param {object} summary - the run summary (mutated)
 * @param {object} member - Circle member
 * @param {object} action - the decided action
 * @param {object} result - the execution result from processEnforcementAction
 */
const recordOutcome = (summary, member, action, result) => {
  if (result.success) {
    summary.processed++;
    summary.actions[action.action]++;

    // Track final warnings and deactivations separately
    if (action.warningLevel === 4 && action.shouldNotifyAdmin) {
      summary.finalWarnings++;
    }
    if (action.action === 'DEACTIVATE') {
      summary.deactivations++;
    }

    console.log(`  ✓ Success: ${result.executedActions.join(', ')}`);

    if (result.errors.length > 0) {
      console.log(`  ⚠ Non-blocking errors: ${result.errors.join(', ')}`);
    }
  } else {
    summary.errors++;
    summary.errorDetails.push({
      member: member.email,
      action: action.action,
      errors: result.errors
    });

    console.log(`  ✗ Failed: ${result.errors.join(', ')}`);
  }
};

/**
 * Main enforcement orchestrator
 * Processes all members without profile photos
 *
 * @param {boolean} dryRun - If true, log actions without executing them
 * @param {string|null} filterEmail - If set, only process this email address
 * @returns {Promise<object>} Summary report
 */
const runEnforcement = async (dryRun = false, filterEmail = null) => {
  const startTime = Date.now();

  console.log('====================================');
  console.log('Profile Photo Enforcement - Starting');
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'PRODUCTION'}`);
  console.log(`Filter: ${filterEmail || 'none (all members)'}`);
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log('====================================');

  const summary = {
    totalMembers: 0,
    processed: 0,
    skipped: 0,
    errors: 0,
    actions: {
      CREATE_WARNING: 0,
      INCREMENT_WARNING: 0,
      DEACTIVATE: 0,
      PHOTO_ADDED: 0,
      SKIP: 0
    },
    finalWarnings: 0,
    deactivations: 0,
    duration: 0,
    errorDetails: []
  };

  try {
    // Step 1: Fetch all community members
    // Uses client-side filtering as Circle.so Admin API v2 does not support
    // querying audience segments. See docs/CIRCLE_SEGMENTS_RESEARCH.md
    console.log('\nFetching all members...');
    const allMembers = await getAllMembers();

    // Filter for members without profile photos
    const membersWithoutPhotos = allMembers.filter(member => {
      const hasPhoto = member.avatar_url && member.avatar_url !== '';
      return !hasPhoto;
    });

    console.log(`Found ${membersWithoutPhotos.length} members without profile photos`);

    // Filter to specific email if provided (used by manual endpoint)
    let filteredMembers = membersWithoutPhotos;
    if (filterEmail) {
      filteredMembers = membersWithoutPhotos.filter(
        m => m.email && m.email.toLowerCase() === filterEmail.toLowerCase()
      );
      console.log(`Filtered to email "${filterEmail}": ${filteredMembers.length} match(es) from ${membersWithoutPhotos.length} total`);
    }

    summary.totalMembers = filteredMembers.length;

    console.log(`Found ${filteredMembers.length} members to process\n`);

    // Step 2: Process each member without a photo (no-photo pass)
    for (const member of filteredMembers) {
      try {
        console.log(`\nProcessing: ${member.name} (${member.email})`);

        const existingWarning = await findWarningByEmail(member.email);
        const { action, result } = await enforceMember(member, existingWarning, dryRun);
        recordOutcome(summary, member, action, result);

      } catch (memberError) {
        summary.errors++;
        summary.errorDetails.push({
          member: member.email,
          error: memberError.message
        });

        console.error(`  ✗ Error processing ${member.email}:`, memberError.message);
      }
    }

    // Step 3: Detect members who added photos since last enforcement run
    // Cross-reference active Airtable warnings against the no-photo member list
    console.log('\nStep 3: Checking for members who added photos...');
    const activeWarnings = await getActiveWarnings();

    // Build a Set of no-photo member emails for fast lookup
    const noPhotoEmails = new Set(
      membersWithoutPhotos.map(m => m.email.toLowerCase())
    );

    for (const warning of activeWarnings) {
      const warningEmail = warning.fields['Email'];
      if (!warningEmail) continue;

      const normalizedEmail = warningEmail.toLowerCase();

      // Respect filterEmail parameter
      if (filterEmail && normalizedEmail !== filterEmail.toLowerCase()) {
        continue;
      }

      // If this warning's email is NOT in the no-photo set, they added a photo
      if (!noPhotoEmails.has(normalizedEmail)) {
        try {
          // Find the member object from the full allMembers list
          const member = allMembers.find(
            m => m.email && m.email.toLowerCase() === normalizedEmail
          );

          if (!member) {
            console.log(`  Skipping ${warningEmail}: not found in community members (may have left)`);
            continue;
          }

          console.log(`\nPhoto added detected: ${member.name} (${member.email})`);

          // Set has_profile_picture so determineEnforcementAction returns PHOTO_ADDED
          member.has_profile_picture = true;

          const { action, result } = await enforceMember(member, warning, dryRun);
          recordOutcome(summary, member, action, result);

        } catch (photoAddedError) {
          summary.errors++;
          summary.errorDetails.push({
            member: warningEmail,
            error: photoAddedError.message
          });
          console.error(`  ✗ Error processing photo-added for ${warningEmail}:`, photoAddedError.message);
        }
      }
    }

  } catch (error) {
    console.error('\n✗ Fatal error during enforcement run:', error.message);
    summary.errorDetails.push({
      fatal: true,
      error: error.message
    });
  }

  summary.duration = Date.now() - startTime;
  summary.skipped = summary.totalMembers - summary.processed - summary.errors;

  // Print summary report
  console.log('\n====================================');
  console.log('Enforcement Run Complete');
  console.log('====================================');
  console.log(`Total members: ${summary.totalMembers}`);
  console.log(`Processed: ${summary.processed}`);
  console.log(`Skipped: ${summary.skipped}`);
  console.log(`Errors: ${summary.errors}`);
  console.log('\nActions:');
  console.log(`  - New warnings created: ${summary.actions.CREATE_WARNING}`);
  console.log(`  - Warnings incremented: ${summary.actions.INCREMENT_WARNING}`);
  console.log(`  - Final warnings (4th): ${summary.finalWarnings}`);
  console.log(`  - Deactivations: ${summary.actions.DEACTIVATE}`);
  console.log(`  - Photos added (removed from tracking): ${summary.actions.PHOTO_ADDED}`);
  console.log(`  - Skipped (already handled): ${summary.actions.SKIP}`);
  console.log(`\nDuration: ${summary.duration}ms`);
  console.log('====================================\n');

  if (summary.errorDetails.length > 0) {
    console.log('Error Details:');
    summary.errorDetails.forEach((err, index) => {
      console.log(`  ${index + 1}. ${err.member || 'Fatal'}: ${err.error || err.errors?.join(', ')}`);
    });
    console.log();
  }

  return summary;
};

/**
 * Constant-time comparison of a request-supplied token against the configured
 * secret. Returns false on any missing value or length mismatch.
 */
const tokenMatches = (provided, expected) => {
  if (!expected || !provided) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

/**
 * Build a Netlify function handler around runEnforcement.
 *
 * Both entry points share this shell; they differ only in configuration:
 * the scheduled (cron) handler runs unfiltered and ungated; the manual handler
 * is hard-wired to the test user AND requires a shared-secret token, so it can
 * never run unfiltered enforcement and can't be triggered anonymously.
 *
 * No CORS header is emitted: these endpoints are server/cron-invoked, not
 * called from a browser. Client error responses are generic; details are
 * logged server-side only.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.filterEmail] - restrict the run to one email
 * @param {boolean} [opts.requireToken] - require a valid x-enforcement-token header
 * @returns {Function} Netlify handler
 */
const makeEnforcementHandler = ({ filterEmail = null, requireToken = false } = {}) => async (event) => {
  const headers = { 'Content-Type': 'application/json' };

  // Fail closed: reject if a token is required but missing/invalid (this also
  // rejects when ENFORCEMENT_TRIGGER_TOKEN is unset, since expected is null).
  if (requireToken) {
    const provided = (event.headers || {})['x-enforcement-token'];
    if (!tokenMatches(provided, config.enforcement.triggerToken)) {
      console.warn('Enforcement trigger rejected: missing or invalid x-enforcement-token');
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ success: false, error: 'Unauthorized' })
      };
    }
  }

  try {
    console.log('Enforcement function triggered', { filterEmail: filterEmail || 'none (all members)' });

    const queryParams = event.queryStringParameters || {};
    const dryRun = queryParams.dryRun === 'true' || queryParams.dryRun === '1';

    const summary = await runEnforcement(dryRun, filterEmail);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: 'Profile photo enforcement completed',
        mode: dryRun ? 'DRY RUN' : 'PRODUCTION',
        filterEmail: filterEmail || null,
        summary
      }, null, 2)
    };

  } catch (error) {
    // Log full detail server-side; return a generic message to the client.
    console.error('Enforcement function error:', error.message);
    console.error('Error stack:', error.stack);

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error: 'An error occurred while processing the request'
      }, null, 2)
    };
  }
};

// Scheduled (cron) handler — unfiltered. Schedule defined in netlify.toml.
exports.handler = makeEnforcementHandler();

// Exports for the manual endpoint and for testing
exports.makeEnforcementHandler = makeEnforcementHandler;
exports.runEnforcement = runEnforcement;
exports.enforceMember = enforceMember;
exports.recordOutcome = recordOutcome;
