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

const { getAllMembers } = require('./utils/circle');
const { findWarningByEmail, getActiveWarnings } = require('./utils/airtable-warnings');
const {
  determineEnforcementAction,
  processEnforcementAction
} = require('./utils/enforcement-logic');

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

    // Step 2: Process each member without a photo (existing warning loop)
    for (const member of filteredMembers) {
      try {
        console.log(`\nProcessing: ${member.name} (${member.email})`);

        // Step 2a: Check for existing warning record in Airtable
        const existingWarning = await findWarningByEmail(member.email);

        // Step 2b: Determine what action to take
        const action = determineEnforcementAction(member, existingWarning);

        console.log(`  Action: ${action.action} (Level ${action.warningLevel})`);
        console.log(`  Reason: ${action.reason}`);

        // Step 2c: Execute the enforcement action
        const result = await processEnforcementAction(
          member,
          existingWarning,
          action,
          dryRun
        );

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

          const action = determineEnforcementAction(member, warning);

          console.log(`  Action: ${action.action} (Level ${action.warningLevel})`);
          console.log(`  Reason: ${action.reason}`);

          const result = await processEnforcementAction(
            member,
            warning,
            action,
            dryRun
          );

          if (result.success) {
            summary.processed++;
            summary.actions[action.action]++;
            console.log(`  ✓ Success: ${result.executedActions.join(', ')}`);
          } else {
            summary.errors++;
            summary.errorDetails.push({
              member: member.email,
              action: action.action,
              errors: result.errors
            });
            console.log(`  ✗ Failed: ${result.errors.join(', ')}`);
          }

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
 * Netlify Scheduled Function Handler
 * Triggered by cron schedule defined in netlify.toml
 *
 * @param {object} event - Netlify event object
 * @returns {Promise<object>} Response with status and summary
 */
exports.handler = async (event) => {
  try {
    console.log('Scheduled function triggered:', event);

    // Check if this is a manual invocation with dryRun parameter
    const queryParams = event.queryStringParameters || {};
    const dryRun = queryParams.dryRun === 'true' || queryParams.dryRun === '1';

    // Run enforcement
    const summary = await runEnforcement(dryRun);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        success: true,
        message: 'Profile photo enforcement completed',
        summary: summary
      })
    };

  } catch (error) {
    console.error('Scheduled function error:', error);

    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        success: false,
        error: error.message
      })
    };
  }
};

// Export runEnforcement for testing
exports.runEnforcement = runEnforcement;
