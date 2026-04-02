/**
 * Airtable "No Photo Warnings" table operations
 * CRUD operations for profile photo enforcement warning tracking
 *
 * Epic 4: Profile Photo Enforcement System
 * STORY-12: Airtable Warning Operations
 */

const Airtable = require('airtable');
const { escapeAirtableFormula } = require('./validation');

console.log('Airtable API Key:', process.env.AIRTABLE_API_KEY ? 'Exists' : 'Not set');
console.log('Airtable Base ID:', process.env.AIRTABLE_BASE_ID ? 'Exists' : 'Not set');

// Configure Airtable SDK
Airtable.configure({
  endpointUrl: 'https://api.airtable.com',
  apiKey: process.env.AIRTABLE_API_KEY
});

const base = Airtable.base(process.env.AIRTABLE_BASE_ID);

// Table name constant
const WARNING_TABLE_NAME = 'No Photo Warnings';

/**
 * Find warning record by email (case-insensitive)
 * @param {string} email - Member email address
 * @returns {Promise<object|null>} Airtable record or null if not found
 */
const findWarningByEmail = async (email) => {
  try {
    const normalizedEmail = email.toLowerCase();
    const sanitizedEmail = escapeAirtableFormula(normalizedEmail);

    console.log('Searching for warning record:', normalizedEmail);

    const records = await base(WARNING_TABLE_NAME).select({
      filterByFormula: `LOWER({Email}) = '${sanitizedEmail}'`,
      maxRecords: 1
    }).firstPage();

    if (records.length > 0) {
      console.log('Found existing warning record:', records[0].id);
      return records[0];
    }

    console.log('No warning record found for:', normalizedEmail);
    return null;
  } catch (error) {
    console.error('Error finding warning record:', error.message);
    throw error;
  }
};

/**
 * Create new warning record for member
 * @param {string} name - Member's full name
 * @param {string} email - Member's email address
 * @returns {Promise<object>} Created Airtable record
 */
const createWarningRecord = async (name, email) => {
  try {
    const normalizedEmail = email.toLowerCase();
    const today = new Date().toISOString().split('T')[0];

    console.log('Creating warning record:', normalizedEmail);

    const record = await base(WARNING_TABLE_NAME).create({
      'Name': name,
      'Email': normalizedEmail,
      'Number of warnings': 1,
      'Last Warning Date': today,
      'Status': 'Active'
    });

    console.log('Created warning record:', record.id, 'for', normalizedEmail);
    return record;
  } catch (error) {
    console.error('Error creating warning record:', error.message);
    throw error;
  }
};

/**
 * Increment warning count for existing record
 * @param {string} recordId - Airtable record ID
 * @returns {Promise<object>} Updated Airtable record
 */
const incrementWarningCount = async (recordId) => {
  try {
    console.log('Incrementing warning count for record:', recordId);

    // Fetch current record to get current count
    const currentRecord = await base(WARNING_TABLE_NAME).find(recordId);
    const currentCount = currentRecord.fields['Number of warnings'];
    const newCount = currentCount + 1;
    const today = new Date().toISOString().split('T')[0];

    console.log(`Updating warning count: ${currentCount} → ${newCount}`);

    const updatedRecord = await base(WARNING_TABLE_NAME).update(recordId, {
      'Number of warnings': newCount,
      'Last Warning Date': today
    });

    console.log('Successfully incremented warning count:', recordId, newCount);
    return updatedRecord;
  } catch (error) {
    console.error('Error incrementing warning count:', error.message);
    throw error;
  }
};

/**
 * Update warning status for record
 * @param {string} recordId - Airtable record ID
 * @param {string} status - New status: 'Active', 'Photo Added', 'Deactivated'
 * @returns {Promise<object>} Updated Airtable record
 */
const updateWarningStatus = async (recordId, status) => {
  try {
    const validStatuses = ['Active', 'Photo Added', 'Deactivated'];
    if (!validStatuses.includes(status)) {
      throw new Error(`Invalid status: ${status}. Must be one of: ${validStatuses.join(', ')}`);
    }

    console.log('Updating warning status for record:', recordId, 'to', status);

    const today = new Date().toISOString().split('T')[0];

    const updatedRecord = await base(WARNING_TABLE_NAME).update(recordId, {
      'Status': status,
      'Last Warning Date': today
    });

    console.log('Successfully updated warning status:', recordId, status);
    return updatedRecord;
  } catch (error) {
    console.error('Error updating warning status:', error.message);
    throw error;
  }
};

/**
 * Delete warning record (used when member adds photo)
 * @param {string} recordId - Airtable record ID
 * @returns {Promise<void>}
 */
const deleteWarningRecord = async (recordId) => {
  try {
    console.log('Deleting warning record:', recordId);

    await base(WARNING_TABLE_NAME).destroy(recordId);

    console.log('Successfully deleted warning record:', recordId);
  } catch (error) {
    console.error('Error deleting warning record:', error.message);
    throw error;
  }
};

/**
 * Get all active warning records
 * @returns {Promise<Array>} Array of Airtable records with Status = 'Active'
 */
const getActiveWarnings = async () => {
  try {
    console.log('Fetching all active warning records...');

    const records = await base(WARNING_TABLE_NAME).select({
      filterByFormula: `{Status} = 'Active'`
    }).firstPage();

    console.log(`Found ${records.length} active warning records`);
    return records;
  } catch (error) {
    console.error('Error fetching active warnings:', error.message);
    throw error;
  }
};

module.exports = {
  findWarningByEmail,
  createWarningRecord,
  incrementWarningCount,
  updateWarningStatus,
  deleteWarningRecord,
  getActiveWarnings
};
