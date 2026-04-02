# STORY-12 Tasks: Airtable "No Photo Warnings" Operations

**Story**: [[STORY-12]] - Airtable "No Photo Warnings" Operations
**Epic**: [[EPIC-4]] - Profile Photo Enforcement System
**Total Tasks**: 7
**Estimated Time**: 10-12 hours

---

## Task Overview

Implement CRUD operations for Airtable "No Photo Warnings" table to track warning counts, status transitions, and enforcement history.

---

## TASK-67: Write Tests for Airtable Warning Operations

**Type**: Test
**Estimated Time**: 2 hours
**Status**: Ready
**Dependencies**: None

### Objective
Create comprehensive Jest unit tests for all warning CRUD operations before implementation.

### Test File
`/Users/zack/projects/bocc-backend/tests/unit/airtable-warnings.test.js`

### Test Specifications

```javascript
jest.mock('airtable');

describe('Airtable Warning Operations', () => {
  describe('findWarningByEmail', () => {
    it('should find existing warning record (case-insensitive)', async () => {
      // Mock Airtable select to return record for JOHN@EXAMPLE.COM
      // Call with john@example.com
      // Verify record found and email normalized
    });

    it('should return null if warning record not found', async () => {
      // Mock empty records array
      // Verify returns null
    });

    it('should escape formula injection in email parameter', async () => {
      // Call with malicious email: "test'; DROP TABLE"
      // Verify escapeAirtableFormula called
      // Verify no SQL injection
    });
  });

  describe('createWarningRecord', () => {
    it('should create warning record with all required fields', async () => {
      // Mock Airtable create
      // Call createWarningRecord('John Doe', 'john@example.com')
      // Verify fields: Name, Email (lowercase), Number of Warnings=1, Status=Active, Last Warning Date=today
    });

    it('should normalize email to lowercase', async () => {
      // Call with CAPS@EXAMPLE.COM
      // Verify stored as caps@example.com
    });
  });

  describe('incrementWarningCount', () => {
    it('should increment warning count from 1 to 2', async () => {
      // Mock find to return record with count=1
      // Mock update
      // Verify count updated to 2 and date refreshed
    });

    it('should update last warning date to today', async () => {
      // Mock current date
      // Verify Last Warning Date updated
    });
  });

  describe('updateWarningStatus', () => {
    it('should update status to Photo Added', async () => {
      // Mock update
      // Verify Status field updated
      // Verify Last Warning Date refreshed
    });

    it('should reject invalid status', async () => {
      // Call with status='InvalidStatus'
      // Verify throws error with message
    });

    it('should accept all valid statuses', async () => {
      // Test: Active, Photo Added, Deactivated
      // All should succeed
    });
  });

  describe('deleteWarningRecord', () => {
    it('should delete warning record by ID', async () => {
      // Mock destroy
      // Verify destroy called with correct recordId
    });
  });
});
```

### Definition of Done
- [ ] Test file created with 10+ test cases
- [ ] Tests fail with "module not found" error (Red phase)
- [ ] Airtable SDK mocked properly
- [ ] escapeAirtableFormula imported from validation.js
- [ ] Tests cover all CRUD operations

---

## TASK-68: Create airtable-warnings.js Module Structure

**Type**: Implementation
**Estimated Time**: 1 hour
**Status**: Ready
**Dependencies**: TASK-67
**Sequential After**: TASK-67

### Objective
Create new utility module with Airtable SDK configuration and basic structure.

### Implementation File
`/Users/zack/projects/bocc-backend/netlify/functions/utils/airtable-warnings.js`

### Module Structure

```javascript
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

// Function stubs (to be implemented in next tasks)
const findWarningByEmail = async (email) => {
  throw new Error('Not implemented');
};

const createWarningRecord = async (name, email) => {
  throw new Error('Not implemented');
};

const incrementWarningCount = async (recordId) => {
  throw new Error('Not implemented');
};

const updateWarningStatus = async (recordId, status) => {
  throw new Error('Not implemented');
};

const deleteWarningRecord = async (recordId) => {
  throw new Error('Not implemented');
};

module.exports = {
  findWarningByEmail,
  createWarningRecord,
  incrementWarningCount,
  updateWarningStatus,
  deleteWarningRecord
};
```

### Definition of Done
- [ ] Module file created
- [ ] Airtable SDK configured
- [ ] Base instance created
- [ ] All functions exported (stubbed)
- [ ] Tests still fail but now import module successfully

---

## TASK-69: Implement findWarningByEmail Function

**Type**: Implementation
**Estimated Time**: 1.5 hours
**Status**: Ready
**Dependencies**: TASK-68
**Sequential After**: TASK-68

### Objective
Implement case-insensitive email lookup with formula injection protection.

### Implementation

```javascript
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
```

### Definition of Done
- [ ] Function implemented
- [ ] Email normalized to lowercase
- [ ] Formula injection protection applied
- [ ] Case-insensitive Airtable query (LOWER)
- [ ] Tests for findWarningByEmail pass
- [ ] Logs search and result

---

## TASK-70: Implement createWarningRecord Function

**Type**: Implementation
**Estimated Time**: 1 hour
**Status**: Ready
**Dependencies**: TASK-69
**Sequential After**: TASK-69

### Objective
Implement warning record creation with initial values (count=1, status=Active).

### Implementation

```javascript
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
      'Number of Warnings': 1,
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
```

### Definition of Done
- [ ] Function implemented
- [ ] Email normalized to lowercase
- [ ] Initial warning count set to 1
- [ ] Status set to Active
- [ ] Date format: YYYY-MM-DD
- [ ] Tests for createWarningRecord pass
- [ ] Logs creation with record ID

---

## TASK-71: Implement incrementWarningCount Function

**Type**: Implementation
**Estimated Time**: 1.5 hours
**Status**: Ready
**Dependencies**: TASK-70
**Sequential After**: TASK-70

### Objective
Implement warning count increment with date update.

### Implementation

```javascript
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
    const currentCount = currentRecord.fields['Number of Warnings'];
    const newCount = currentCount + 1;
    const today = new Date().toISOString().split('T')[0];

    console.log(`Updating warning count: ${currentCount} → ${newCount}`);

    const updatedRecord = await base(WARNING_TABLE_NAME).update(recordId, {
      'Number of Warnings': newCount,
      'Last Warning Date': today
    });

    console.log('Successfully incremented warning count:', recordId, newCount);
    return updatedRecord;
  } catch (error) {
    console.error('Error incrementing warning count:', error.message);
    throw error;
  }
};
```

### Definition of Done
- [ ] Function implemented
- [ ] Current count fetched first
- [ ] Count incremented by 1
- [ ] Last Warning Date updated to today
- [ ] Tests for incrementWarningCount pass
- [ ] Logs count transition

---

## TASK-72: Implement updateWarningStatus and deleteWarningRecord Functions

**Type**: Implementation
**Estimated Time**: 1.5 hours
**Status**: Ready
**Dependencies**: TASK-71
**Sequential After**: TASK-71

### Objective
Implement status update and record deletion functions.

### Implementation - updateWarningStatus

```javascript
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
```

### Implementation - deleteWarningRecord

```javascript
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
```

### Definition of Done
- [ ] Both functions implemented
- [ ] Status validation with whitelist
- [ ] Status update refreshes date
- [ ] Delete uses destroy() method
- [ ] All tests from TASK-67 pass (Green phase)
- [ ] Comprehensive logging

---

## TASK-73: Integration Test with Real Airtable Table

**Type**: Integration Test
**Estimated Time**: 1.5 hours
**Status**: Ready
**Dependencies**: TASK-72
**Sequential After**: TASK-72

### Objective
Validate all warning operations work with real Airtable "No Photo Warnings" table.

### Test Prerequisites
- Airtable table "No Photo Warnings" created with schema
- AIRTABLE_API_KEY and AIRTABLE_BASE_ID configured
- Test Glick data: zglicka@gmail.com, Test Glick

### Test Script

Create `/Users/zack/projects/bocc-backend/tests/integration/warning-lifecycle-integration.test.js`:

```javascript
const {
  findWarningByEmail,
  createWarningRecord,
  incrementWarningCount,
  updateWarningStatus,
  deleteWarningRecord
} = require('../../netlify/functions/utils/airtable-warnings');

describe('Warning Lifecycle Integration Test', () => {
  let testRecordId;

  beforeAll(async () => {
    // Clean up any existing test record
    const existing = await findWarningByEmail('zglicka@gmail.com');
    if (existing) {
      await deleteWarningRecord(existing.id);
    }
  });

  afterAll(async () => {
    // Clean up test record
    if (testRecordId) {
      try {
        await deleteWarningRecord(testRecordId);
      } catch (error) {
        // Ignore if already deleted
      }
    }
  });

  it('should create new warning record', async () => {
    const record = await createWarningRecord('Test Glick', 'zglicka@gmail.com');
    testRecordId = record.id;

    expect(record.fields['Name']).toBe('Test Glick');
    expect(record.fields['Email']).toBe('zglicka@gmail.com');
    expect(record.fields['Number of Warnings']).toBe(1);
    expect(record.fields['Status']).toBe('Active');
  });

  it('should find warning by email (case-insensitive)', async () => {
    const record = await findWarningByEmail('ZGLICKA@GMAIL.COM');
    expect(record).not.toBeNull();
    expect(record.id).toBe(testRecordId);
  });

  it('should increment warning count', async () => {
    const updated = await incrementWarningCount(testRecordId);
    expect(updated.fields['Number of Warnings']).toBe(2);
  });

  it('should update status to Photo Added', async () => {
    const updated = await updateWarningStatus(testRecordId, 'Photo Added');
    expect(updated.fields['Status']).toBe('Photo Added');
  });

  it('should delete warning record', async () => {
    await deleteWarningRecord(testRecordId);
    const record = await findWarningByEmail('zglicka@gmail.com');
    expect(record).toBeNull();
    testRecordId = null; // Mark as deleted
  });

  it('should handle non-existent email gracefully', async () => {
    const record = await findWarningByEmail('nonexistent@example.com');
    expect(record).toBeNull();
  });
});
```

### Definition of Done
- [ ] Integration test file created
- [ ] Tests use real Airtable table
- [ ] Full CRUD lifecycle validated
- [ ] Test cleanup handled (before/after hooks)
- [ ] All integration tests pass
- [ ] Test documented in test suite

---

## Summary

**Total Tasks**: 7
**Red-Green-Refactor Cycles**: 2
- Cycle 1: TASK-67 (test) → TASK-68-72 (impl) → Clean code throughout
- Cycle 2: Integration testing (TASK-73)

**Critical Path**: TASK-67 → TASK-68 → TASK-69 → TASK-70 → TASK-71 → TASK-72 → TASK-73

**Dependencies for Other Stories**:
- STORY-13 (Enforcement Logic) depends on all warning operations
- STORY-17 (Scheduled Function) uses these operations

**Testing Coverage**:
- 10+ unit tests (TASK-67)
- 6 integration tests (TASK-73)
- Smoke test (part of STORY-18)

**Manual Setup Required**:
- Admin must create Airtable "No Photo Warnings" table before starting
- See `/Users/zack/projects/bocc-backend/docs/AIRTABLE_SCHEMA_PHOTO_WARNINGS.md` for schema
