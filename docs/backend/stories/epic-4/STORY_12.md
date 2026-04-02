# Story 12: Airtable "No Photo Warnings" Operations

**ID**: STORY-12
**Epic**: EPIC-4 (Profile Photo Enforcement)
**Status**: READY
**Story Points**: 3
**Complexity**: Medium
**Created**: 2026-02-05
**Dependencies**: STORY-11 (needs member data from segment query)

---

## User Story

As a **developer**, I want **CRUD operations for the Airtable "No Photo Warnings" table**, so that the enforcement system can track warning counts, status transitions, and enforcement history for members without profile photos.

## Context

The "No Photo Warnings" Airtable table serves as the persistent state store for the enforcement system, tracking each member's warning count (1-5) and status (Active, Photo Added, Deactivated). This story implements the data access layer that enables the progressive warning logic to retrieve, create, update, and delete warning records. The operations must handle case-insensitive email lookups, status transitions, and provide audit trail capabilities.

Schema details are fully documented in `/Users/zack/projects/bocc-backend/docs/AIRTABLE_SCHEMA_PHOTO_WARNINGS.md`.

## Acceptance Criteria

### Functional Requirements
- [ ] Module `netlify/functions/utils/airtable-warnings.js` exports warning-specific operations
- [ ] `findWarningByEmail(email)` - Case-insensitive email lookup, returns existing record or null
- [ ] `createWarningRecord(name, email)` - Creates new warning record (count=1, status=Active)
- [ ] `incrementWarningCount(recordId)` - Increments warning count by 1, updates last warning date
- [ ] `updateWarningStatus(recordId, status)` - Updates status field (Active/Photo Added/Deactivated)
- [ ] `deleteWarningRecord(recordId)` - Deletes record (used when photo added)
- [ ] All email operations normalize to lowercase for consistency
- [ ] All date operations use `new Date().toISOString().split('T')[0]` for YYYY-MM-DD format

### Non-Functional Requirements
- [ ] Uses existing Airtable SDK connection from `netlify/functions/utils/airtable.js`
- [ ] All operations log key details (email, recordId, count, status)
- [ ] Errors include Airtable response details for debugging
- [ ] Formula injection protection on email parameter (reuse `escapeAirtableFormula()`)
- [ ] Operations are idempotent where possible (e.g., status update safe to call multiple times)

### Testing Requirements
- [ ] Unit test: Find existing warning by email (case-insensitive)
- [ ] Unit test: Find non-existent warning returns null
- [ ] Unit test: Create warning record with all required fields
- [ ] Unit test: Increment warning count from 1 to 2, verify date updated
- [ ] Unit test: Update status transitions (Active → Photo Added, Active → Deactivated)
- [ ] Unit test: Delete warning record by recordId
- [ ] Unit test: Formula injection protection on email lookups
- [ ] Integration test: Full lifecycle with Test Glick user (create, increment, update status, delete)

## Technical Implementation Notes

### Approach

**Module Structure**: Create new utility module `netlify/functions/utils/airtable-warnings.js` separate from main `airtable.js` to maintain clean separation of concerns (check-in operations vs. enforcement operations).

**Reuse Existing**:
- Import `Airtable` SDK from `airtable.js` (already configured with API key and base ID)
- Import `escapeAirtableFormula()` from `validation.js` for formula injection protection

**Table Name**: `'No Photo Warnings'` (exactly as created in Airtable, space-sensitive)

### Function Implementations

#### 1. Find Warning by Email

```javascript
const Airtable = require('airtable');
const { escapeAirtableFormula } = require('./validation');

// Reuse base configuration from existing airtable.js pattern
Airtable.configure({
    endpointUrl: 'https://api.airtable.com',
    apiKey: process.env.AIRTABLE_API_KEY
});
const base = Airtable.base(process.env.AIRTABLE_BASE_ID);

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

        const records = await base('No Photo Warnings').select({
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

#### 2. Create Warning Record

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

        const record = await base('No Photo Warnings').create({
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

#### 3. Increment Warning Count

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
        const currentRecord = await base('No Photo Warnings').find(recordId);
        const currentCount = currentRecord.fields['Number of Warnings'];
        const newCount = currentCount + 1;
        const today = new Date().toISOString().split('T')[0];

        console.log(`Updating warning count: ${currentCount} → ${newCount}`);

        const updatedRecord = await base('No Photo Warnings').update(recordId, {
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

#### 4. Update Warning Status

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

        const updatedRecord = await base('No Photo Warnings').update(recordId, {
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

#### 5. Delete Warning Record

```javascript
/**
 * Delete warning record (used when member adds photo)
 * @param {string} recordId - Airtable record ID
 * @returns {Promise<void>}
 */
const deleteWarningRecord = async (recordId) => {
    try {
        console.log('Deleting warning record:', recordId);

        await base('No Photo Warnings').destroy(recordId);

        console.log('Successfully deleted warning record:', recordId);
    } catch (error) {
        console.error('Error deleting warning record:', error.message);
        throw error;
    }
};
```

#### Module Exports

```javascript
module.exports = {
    findWarningByEmail,
    createWarningRecord,
    incrementWarningCount,
    updateWarningStatus,
    deleteWarningRecord
};
```

### Integration Points

- **Airtable SDK**: Reuses existing configuration from `netlify/functions/utils/airtable.js`
- **Validation**: Imports `escapeAirtableFormula()` from `validation.js`
- **Environment Variables**:
  - `AIRTABLE_API_KEY` (existing from Epic 1)
  - `AIRTABLE_BASE_ID` (existing from Epic 1)

- **Used By**:
  - STORY-13 (Progressive warning logic) calls all operations
  - STORY-17 (Scheduled function) orchestrates these operations

### Technical Considerations

**Email Normalization**:
- Always lowercase emails before storage/lookup: `email.toLowerCase()`
- Ensures case-insensitive matching (prevents duplicates: `John@Example.com` vs `john@example.com`)
- Airtable formula `LOWER({Email})` handles lookup side

**Date Format**:
- Use ISO date string, date portion only: `new Date().toISOString().split('T')[0]`
- Produces `YYYY-MM-DD` format (e.g., `2026-02-05`)
- Matches Airtable Date field type expectations
- Timezone-agnostic (always uses UTC for consistency)

**Error Handling**:
- Airtable errors include status codes (e.g., 404 if record not found, 401 if auth fails)
- Propagate all errors to caller with original error message
- Enforcement function (STORY-17) will handle non-blocking error patterns

**Idempotency**:
- Status updates are idempotent (safe to set status to same value multiple times)
- Warning count increment is NOT idempotent (must track if already incremented this run)
- Find operations are naturally idempotent (read-only)

**Performance**:
- Expected Airtable operation time: ~300-400ms per call (based on Epic 1 experience)
- Enforcement function will make sequential calls for each member
- For 200 members: ~60-80 seconds total (acceptable for weekly cron)

**Concurrency Considerations**:
- Enforcement function runs once per week (no concurrent access issues)
- If multiple enforcement runs overlap (unlikely), last-write-wins is acceptable
- Future enhancement: Add optimistic locking with version field

### Existing Patterns to Follow

From `netlify/functions/utils/airtable.js` (Epic 1):
- Use `base('Table Name').select()` for queries with `filterByFormula`
- Use `base('Table Name').create()` for record creation
- Use `base('Table Name').update()` for record updates
- Use `base('Table Name').destroy()` for record deletion
- Use `escapeAirtableFormula()` for all user inputs in formulas
- Log operation details before and after API calls

### Security Considerations

- **Formula Injection**: Email parameter must be escaped via `escapeAirtableFormula()`
- **PII Handling**: Email addresses are PII, never log full email lists, only individual lookups
- **API Key Security**: Uses existing `AIRTABLE_API_KEY` (secured in Netlify env vars)
- **Access Control**: API key must have write access to "No Photo Warnings" table
- **Status Validation**: Validate status parameter against allowed values before update

## Dependencies

### Blocks
- **STORY-13**: Progressive warning logic depends on these operations to track state

### Blocked By
- **STORY-11**: Needs member data (name, email) from segment query to create records

### Related
- **STORY-16**: Admin notifications will query warning records for alert context

## Out of Scope

- Batch operations (create/update multiple records at once) - not needed for weekly enforcement
- Historical audit trail separate from main table (current table provides sufficient audit via Created/Last Warning Date)
- Soft-delete implementation (hard delete is sufficient when photo added)
- Record archival automation (manual admin cleanup is acceptable)
- Custom field validation beyond status enum (Airtable enforces field types)

## Testing Approach

### Unit Tests (`tests/airtable-warnings.test.js`)

```javascript
jest.mock('airtable');

describe('Airtable Warning Operations', () => {
    describe('findWarningByEmail', () => {
        it('should find existing warning record (case-insensitive)', async () => {
            // Mock Airtable select to return record for JOHN@EXAMPLE.COM
            // Call findWarningByEmail('john@example.com')
            // Verify normalized to lowercase and found
        });

        it('should return null if warning record not found', async () => {
            // Mock Airtable select to return empty array
            // Verify returns null
        });

        it('should escape formula injection in email', async () => {
            // Call with malicious email: "test'; DROP TABLE"
            // Verify escapeAirtableFormula was called
        });
    });

    describe('createWarningRecord', () => {
        it('should create warning record with correct fields', async () => {
            // Mock Airtable create
            // Verify fields: Name, Email (lowercase), Number of Warnings=1, Status=Active, Last Warning Date
        });
    });

    describe('incrementWarningCount', () => {
        it('should increment warning count and update date', async () => {
            // Mock find to return record with count=2
            // Mock update
            // Verify updated to count=3 with today's date
        });
    });

    describe('updateWarningStatus', () => {
        it('should update status to Photo Added', async () => {
            // Mock update
            // Verify status field updated and date refreshed
        });

        it('should reject invalid status', async () => {
            // Call with status='InvalidStatus'
            // Verify throws error
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

### Integration Test

**Prerequisites**:
- Airtable "No Photo Warnings" table created with correct schema
- Test Glick user data available: `zglicka@gmail.com`, `Test Glick`

**Test Script** (manual):
```bash
# Test full warning lifecycle
node tests/integration/warning-lifecycle-test.js

# Test should:
# 1. Create warning for zglicka@gmail.com
# 2. Find by email (verify found)
# 3. Increment count (1 → 2)
# 4. Update status to "Photo Added"
# 5. Delete record
# 6. Find by email (verify null)
```

**Automated Integration Test**:
- Add to smoke test suite
- Use debug flag to mark test records
- Clean up test records after verification

## Notes

**Table Creation**:
- Admin must manually create "No Photo Warnings" table in Airtable before deployment
- See `/Users/zack/projects/bocc-backend/docs/AIRTABLE_SCHEMA_PHOTO_WARNINGS.md` for exact schema
- Table name is case-sensitive and space-sensitive in Airtable API

**Field Naming**:
- Airtable field names are case-sensitive: `'Number of Warnings'`, not `'number_of_warnings'`
- Must match Airtable UI field names exactly (including spaces)

**Why Separate Module**:
- Keeps check-in operations (`airtable.js`) separate from enforcement operations
- Cleaner imports for enforcement function (only import what's needed)
- Easier to test in isolation
- Follows single-responsibility principle

**Future Enhancements**:
- Add `getWarningRecordById(recordId)` for direct lookups
- Add `getAllActiveWarnings()` for admin dashboard
- Add batch operations if enforcement needs to scale beyond 1000 members
- Add versioning/optimistic locking if concurrent access becomes an issue

---

**Next Steps**: Implement all warning operations in `airtable-warnings.js`, write comprehensive unit tests, verify integration with test Airtable table using Test Glick user data.
