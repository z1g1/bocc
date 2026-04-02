/**
 * Profile Photo Enforcement Logic
 * Core decision and execution engine for photo enforcement system
 *
 * Epic 4: Profile Photo Enforcement System
 * STORY-13: Progressive Warning Logic and Status Transitions
 */

const {
  createWarningRecord,
  incrementWarningCount,
  updateWarningStatus,
  deleteWarningRecord
} = require('./airtable-warnings');

const { sendDirectMessage } = require('./circle-member-api');
const {
  getWarningMessage,
  thankYouMessage,
  adminAlert
} = require('./message-templates');
const { deactivateMember: deactivateCircleMember } = require('./circle');

// Admin member ID for notifications
const ADMIN_MEMBER_ID = '2d8e9215'; // circle@zackglick.com

/**
 * Send warning DM to member
 * @param {object} member - Circle member object
 * @param {number} warningLevel - Warning level (1-5)
 * @returns {Promise<void>}
 */
const sendWarningDM = async (member, warningLevel) => {
  try {
    console.log(`Sending warning ${warningLevel} DM to ${member.email}`);

    // Generate message based on warning level
    const messageBody = getWarningMessage(member.name, warningLevel);

    // Send DM via Member API
    const result = await sendDirectMessage(member.id, messageBody);

    if (!result.success) {
      throw new Error(result.error);
    }

    console.log(`Successfully sent warning ${warningLevel} DM to ${member.email}`);
  } catch (error) {
    console.error(`Failed to send warning DM to ${member.email}:`, error.message);
    throw error;
  }
};

/**
 * Send thank you DM to member who added photo
 * @param {object} member - Circle member object
 * @returns {Promise<void>}
 */
const sendThankYouDM = async (member) => {
  try {
    console.log(`Sending thank you DM to ${member.email}`);

    const messageBody = thankYouMessage(member.name);
    const result = await sendDirectMessage(member.id, messageBody);

    if (!result.success) {
      throw new Error(result.error);
    }

    console.log(`Successfully sent thank you DM to ${member.email}`);
  } catch (error) {
    console.error(`Failed to send thank you DM to ${member.email}:`, error.message);
    throw error;
  }
};

/**
 * Deactivate member account
 * Wrapper around Circle Admin API deactivation
 *
 * @param {string} memberId - Circle member ID
 * @returns {Promise<void>}
 */
const deactivateMember = async (memberId) => {
  try {
    console.log(`Deactivating Circle member: ${memberId}`);
    await deactivateCircleMember(memberId);
    console.log(`Successfully deactivated Circle member: ${memberId}`);
  } catch (error) {
    console.error(`Failed to deactivate Circle member ${memberId}:`, error.message);
    throw error;
  }
};

/**
 * Notify admin of enforcement action
 * @param {string} subject - Alert subject
 * @param {string} message - Alert message
 * @param {object} member - Circle member object (optional)
 * @param {number} warningCount - Warning count (optional)
 * @returns {Promise<void>}
 */
const notifyAdmin = async (subject, message, member = null, warningCount = 0) => {
  try {
    console.log(`Sending admin notification: ${subject}`);

    // Determine action type from subject
    let action = 'INFO';
    if (subject.includes('Final Warning')) {
      action = 'FINAL_WARNING';
    } else if (subject.includes('Deactivated')) {
      action = 'DEACTIVATION';
    } else if (subject.includes('Anomaly')) {
      action = 'ERROR';
    }

    // Generate admin alert message
    const messageBody = adminAlert(
      action,
      member ? member.name : 'Unknown',
      member ? member.email : 'unknown@example.com',
      warningCount,
      member ? member.id : 'unknown',
      message
    );

    // Send DM to admin
    const result = await sendDirectMessage(ADMIN_MEMBER_ID, messageBody);

    if (!result.success) {
      throw new Error(result.error);
    }

    console.log(`Successfully sent admin notification: ${subject}`);
  } catch (error) {
    console.error(`Failed to send admin notification:`, error.message);
    throw error;
  }
};

/**
 * Determine what enforcement action to take for a member
 * Pure function - no side effects, easy to test
 *
 * @param {object} member - Circle member object {id, email, name, has_profile_picture}
 * @param {object|null} existingWarning - Airtable warning record or null if not found
 * @returns {object} Action object {action, warningLevel, shouldNotifyAdmin, reason}
 */
const determineEnforcementAction = (member, existingWarning) => {
  // Case 1: Member has profile photo now (added since last check)
  if (member.has_profile_picture === true) {
    if (existingWarning && existingWarning.fields['Status'] !== 'Photo Added') {
      return {
        action: 'PHOTO_ADDED',
        warningLevel: 0,
        shouldNotifyAdmin: false,
        reason: 'Member added profile photo since last enforcement run'
      };
    }
    return {
      action: 'SKIP',
      warningLevel: 0,
      shouldNotifyAdmin: false,
      reason: 'Member has profile photo, no action needed'
    };
  }

  // Case 2: No existing warning record - create first warning
  if (!existingWarning) {
    return {
      action: 'CREATE_WARNING',
      warningLevel: 1,
      shouldNotifyAdmin: false,
      reason: 'First time member identified without profile photo'
    };
  }

  // Case 3: Existing warning record - check status and count
  const currentStatus = existingWarning.fields['Status'];
  const currentCount = existingWarning.fields['Number of warnings'];

  // Case 3a: Already deactivated - skip
  if (currentStatus === 'Deactivated') {
    return {
      action: 'SKIP',
      warningLevel: currentCount,
      shouldNotifyAdmin: false,
      reason: 'Member already deactivated, no further action'
    };
  }

  // Case 3b: Already marked as Photo Added - skip
  if (currentStatus === 'Photo Added') {
    return {
      action: 'SKIP',
      warningLevel: currentCount,
      shouldNotifyAdmin: false,
      reason: 'Member marked as Photo Added, record should be deleted'
    };
  }

  // Case 3c: Active status - determine escalation
  const nextCount = currentCount + 1;

  // Safeguard: Cap at 5 warnings
  if (currentCount >= 5) {
    console.warn(`WARNING: Member ${member.email} has warning count >= 5 (${currentCount}). Capping at 5.`);
    return {
      action: 'SKIP',
      warningLevel: 5,
      shouldNotifyAdmin: true,
      reason: `Anomaly detected: warning count is ${currentCount}, expected max 5`
    };
  }

  // Warning 4→5: Deactivation time
  if (nextCount === 5) {
    return {
      action: 'DEACTIVATE',
      warningLevel: 5,
      shouldNotifyAdmin: true,
      reason: 'Member reached 5 warnings, account will be deactivated'
    };
  }

  // Warning 3→4: Final warning (triggers admin notification)
  if (nextCount === 4) {
    return {
      action: 'INCREMENT_WARNING',
      warningLevel: 4,
      shouldNotifyAdmin: true,
      reason: 'Member received final warning (4th warning)'
    };
  }

  // Warnings 1→2, 2→3: Standard increments
  return {
    action: 'INCREMENT_WARNING',
    warningLevel: nextCount,
    shouldNotifyAdmin: false,
    reason: `Member received warning ${nextCount} of 4 before deactivation`
  };
};

/**
 * Process enforcement action for a member
 * Orchestrates all operations: warnings, DMs, deactivation, admin notifications
 *
 * @param {object} member - Circle member object
 * @param {object|null} warningRecord - Existing Airtable warning record
 * @param {object} action - Action object from determineEnforcementAction()
 * @param {boolean} dryRun - If true, log actions without executing them
 * @returns {Promise<object>} Result {success, executedActions, errors}
 */
const processEnforcementAction = async (member, warningRecord, action, dryRun = false) => {
  const result = {
    success: false,
    executedActions: [],
    errors: []
  };

  try {
    if (dryRun) {
      console.log(`[DRY RUN] Would execute: ${action.action} for ${member.email} (level ${action.warningLevel})`);
      result.success = true;
      result.executedActions.push(`DRY_RUN:${action.action}`);
      return result;
    }

    console.log(`Processing enforcement action: ${action.action} for ${member.email}`);

    switch (action.action) {
      case 'CREATE_WARNING':
        // Create warning record in Airtable
        const newWarning = await createWarningRecord(member.name, member.email);
        result.executedActions.push('CREATED_WARNING_RECORD');

        // Send warning DM (non-blocking)
        try {
          await sendWarningDM(member, action.warningLevel);
          result.executedActions.push('SENT_WARNING_DM');
        } catch (dmError) {
          console.error('DM send failed (non-blocking):', dmError.message);
          result.errors.push(`DM send failed: ${dmError.message}`);
        }

        result.success = true;
        break;

      case 'INCREMENT_WARNING':
        // Increment warning count
        await incrementWarningCount(warningRecord.id);
        result.executedActions.push('INCREMENTED_WARNING_COUNT');

        // Send warning DM (non-blocking)
        try {
          await sendWarningDM(member, action.warningLevel);
          result.executedActions.push('SENT_WARNING_DM');
        } catch (dmError) {
          console.error('DM send failed (non-blocking):', dmError.message);
          result.errors.push(`DM send failed: ${dmError.message}`);
        }

        // Notify admin if final warning
        if (action.shouldNotifyAdmin) {
          try {
            await notifyAdmin(
              `Final Warning Issued: ${member.name}`,
              `${member.name} (${member.email}) received their 4th and final warning.`,
              member,
              action.warningLevel
            );
            result.executedActions.push('NOTIFIED_ADMIN');
          } catch (notifyError) {
            console.error('Admin notification failed (non-blocking):', notifyError.message);
            result.errors.push(`Admin notification failed: ${notifyError.message}`);
          }
        }

        result.success = true;
        break;

      case 'DEACTIVATE':
        // Deactivate member (blocking - must succeed)
        // No DM sent at deactivation — final warning (level 4) was the last message
        await deactivateMember(member.id);
        result.executedActions.push('DEACTIVATED_MEMBER');

        // Update warning status to Deactivated
        await updateWarningStatus(warningRecord.id, 'Deactivated');
        result.executedActions.push('UPDATED_STATUS_DEACTIVATED');

        // Notify admin
        try {
          await notifyAdmin(
            `Member Deactivated: ${member.name}`,
            `${member.name} (${member.email}) was deactivated after 5 warnings without profile photo.`,
            member,
            5
          );
          result.executedActions.push('NOTIFIED_ADMIN');
        } catch (notifyError) {
          console.error('Admin notification failed (non-blocking):', notifyError.message);
          result.errors.push(`Admin notification failed: ${notifyError.message}`);
        }

        result.success = true;
        break;

      case 'PHOTO_ADDED':
        // Send thank you DM (non-blocking)
        try {
          await sendThankYouDM(member);
          result.executedActions.push('SENT_THANK_YOU_DM');
        } catch (dmError) {
          console.error('Thank you DM send failed (non-blocking):', dmError.message);
          result.errors.push(`Thank you DM failed: ${dmError.message}`);
        }

        // Delete warning record
        await deleteWarningRecord(warningRecord.id);
        result.executedActions.push('DELETED_WARNING_RECORD');

        result.success = true;
        break;

      case 'SKIP':
        console.log(`Skipping enforcement for ${member.email}: ${action.reason}`);
        result.executedActions.push('SKIPPED');

        // Notify admin if anomaly detected
        if (action.shouldNotifyAdmin) {
          try {
            await notifyAdmin(
              `Enforcement Anomaly: ${member.name}`,
              `${member.name} (${member.email}): ${action.reason}`,
              member,
              action.warningLevel
            );
            result.executedActions.push('NOTIFIED_ADMIN_ANOMALY');
          } catch (notifyError) {
            console.error('Admin notification failed (non-blocking):', notifyError.message);
            result.errors.push(`Admin notification failed: ${notifyError.message}`);
          }
        }

        result.success = true;
        break;

      default:
        throw new Error(`Unknown enforcement action: ${action.action}`);
    }

    console.log(`Enforcement action completed for ${member.email}:`, result.executedActions);
  } catch (error) {
    console.error(`Error processing enforcement action for ${member.email}:`, error.message);
    result.success = false;
    result.errors.push(error.message);
  }

  return result;
};

module.exports = {
  determineEnforcementAction,
  processEnforcementAction
};
