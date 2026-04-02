/**
 * Unit tests for Airtable "No Photo Warnings" table operations
 * Tests CRUD operations for warning tracking in Epic 4
 *
 * TASK-67: Write Tests for Airtable Warning Operations
 * Epic 4: Profile Photo Enforcement System
 */

// Mock Airtable before requiring module
const mockSelect = jest.fn();
const mockFirstPage = jest.fn();
const mockCreate = jest.fn();
const mockFind = jest.fn();
const mockUpdate = jest.fn();
const mockDestroy = jest.fn();

// Mock table returns object with methods
const mockTable = {
  select: mockSelect,
  create: mockCreate,
  find: mockFind,
  update: mockUpdate,
  destroy: mockDestroy
};

// Mock base function returns table when called with table name
const mockBaseFn = jest.fn((tableName) => mockTable);

// Mock Airtable.base() returns the base function
const mockBaseConstructor = jest.fn(() => mockBaseFn);

const mockAirtable = {
  configure: jest.fn(),
  base: mockBaseConstructor
};

jest.mock('airtable', () => mockAirtable);

const {
  findWarningByEmail,
  createWarningRecord,
  incrementWarningCount,
  updateWarningStatus,
  deleteWarningRecord,
  getActiveWarnings
} = require('../netlify/functions/utils/airtable-warnings');

describe('Airtable Warning Operations', () => {
  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Setup console mocks
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});

    // Default mock setup for select chain
    mockSelect.mockReturnValue({ firstPage: mockFirstPage });
  });

  afterEach(() => {
    console.log.mockRestore();
    console.error.mockRestore();
  });

  describe('findWarningByEmail', () => {
    it('should find existing warning record by email', async () => {
      const mockRecord = {
        id: 'rec123',
        fields: {
          'Name': 'John Doe',
          'Email': 'john@example.com',
          'Number of warnings': 2,
          'Status': 'Active',
          'Last Warning Date': '2025-02-05'
        }
      };

      mockFirstPage.mockResolvedValue([mockRecord]);

      const result = await findWarningByEmail('john@example.com');

      expect(result).toEqual(mockRecord);
      expect(mockSelect).toHaveBeenCalledWith({
        filterByFormula: "LOWER({Email}) = 'john@example.com'",
        maxRecords: 1
      });
    });

    it('should find record with case-insensitive email match', async () => {
      const mockRecord = {
        id: 'rec456',
        fields: {
          'Email': 'test@example.com'
        }
      };

      mockFirstPage.mockResolvedValue([mockRecord]);

      const result = await findWarningByEmail('TEST@EXAMPLE.COM');

      expect(result).toEqual(mockRecord);
      expect(mockSelect).toHaveBeenCalledWith({
        filterByFormula: "LOWER({Email}) = 'test@example.com'",
        maxRecords: 1
      });
    });

    it('should return null if warning record not found', async () => {
      mockFirstPage.mockResolvedValue([]);

      const result = await findWarningByEmail('nonexistent@example.com');

      expect(result).toBeNull();
    });

    it('should escape formula injection in email parameter', async () => {
      mockFirstPage.mockResolvedValue([]);

      await findWarningByEmail("test'; DROP TABLE--");

      // Verify escapeAirtableFormula would be called
      // Single quotes should be escaped in the formula
      const callArgs = mockSelect.mock.calls[0][0];
      expect(callArgs.filterByFormula).toContain("\\'");
    });

    it('should handle Airtable API errors gracefully', async () => {
      mockFirstPage.mockRejectedValue(new Error('Airtable API error'));

      await expect(findWarningByEmail('test@example.com'))
        .rejects
        .toThrow('Airtable API error');

      expect(console.error).toHaveBeenCalledWith(
        'Error finding warning record:',
        'Airtable API error'
      );
    });
  });

  describe('createWarningRecord', () => {
    it('should create warning record with all required fields', async () => {
      const mockDate = '2025-02-05';
      jest.spyOn(Date.prototype, 'toISOString').mockReturnValue(`${mockDate}T12:00:00.000Z`);

      const mockCreatedRecord = {
        id: 'rec789',
        fields: {
          'Name': 'Jane Smith',
          'Email': 'jane@example.com',
          'Number of warnings': 1,
          'Status': 'Active',
          'Last Warning Date': mockDate
        }
      };

      mockCreate.mockResolvedValue(mockCreatedRecord);

      const result = await createWarningRecord('Jane Smith', 'jane@example.com');

      expect(mockCreate).toHaveBeenCalledWith({
        'Name': 'Jane Smith',
        'Email': 'jane@example.com',
        'Number of warnings': 1,
        'Last Warning Date': mockDate,
        'Status': 'Active'
      });

      expect(result).toEqual(mockCreatedRecord);

      Date.prototype.toISOString.mockRestore();
    });

    it('should normalize email to lowercase when creating', async () => {
      jest.spyOn(Date.prototype, 'toISOString').mockReturnValue('2025-02-05T12:00:00.000Z');

      mockCreate.mockResolvedValue({ id: 'rec999', fields: {} });

      await createWarningRecord('Test User', 'CAPS@EXAMPLE.COM');

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          'Email': 'caps@example.com'
        })
      );

      Date.prototype.toISOString.mockRestore();
    });

    it('should set initial warning count to 1', async () => {
      jest.spyOn(Date.prototype, 'toISOString').mockReturnValue('2025-02-05T12:00:00.000Z');
      mockCreate.mockResolvedValue({ id: 'rec123', fields: {} });

      await createWarningRecord('New User', 'new@example.com');

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          'Number of warnings': 1
        })
      );

      Date.prototype.toISOString.mockRestore();
    });

    it('should set initial status to Active', async () => {
      jest.spyOn(Date.prototype, 'toISOString').mockReturnValue('2025-02-05T12:00:00.000Z');
      mockCreate.mockResolvedValue({ id: 'rec123', fields: {} });

      await createWarningRecord('New User', 'new@example.com');

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          'Status': 'Active'
        })
      );

      Date.prototype.toISOString.mockRestore();
    });

    it('should handle Airtable creation errors', async () => {
      mockCreate.mockRejectedValue(new Error('Creation failed'));

      await expect(createWarningRecord('Test', 'test@example.com'))
        .rejects
        .toThrow('Creation failed');
    });
  });

  describe('incrementWarningCount', () => {
    it('should increment warning count from 1 to 2', async () => {
      const mockDate = '2025-02-05';
      jest.spyOn(Date.prototype, 'toISOString').mockReturnValue(`${mockDate}T12:00:00.000Z`);

      mockFind.mockResolvedValue({
        id: 'rec123',
        fields: {
          'Number of warnings': 1
        }
      });

      mockUpdate.mockResolvedValue({
        id: 'rec123',
        fields: {
          'Number of warnings': 2,
          'Last Warning Date': mockDate
        }
      });

      const result = await incrementWarningCount('rec123');

      expect(mockFind).toHaveBeenCalledWith('rec123');
      expect(mockUpdate).toHaveBeenCalledWith('rec123', {
        'Number of warnings': 2,
        'Last Warning Date': mockDate
      });

      expect(result.fields['Number of warnings']).toBe(2);

      Date.prototype.toISOString.mockRestore();
    });

    it('should increment warning count from 4 to 5', async () => {
      const mockDate = '2025-02-05';
      jest.spyOn(Date.prototype, 'toISOString').mockReturnValue(`${mockDate}T12:00:00.000Z`);

      mockFind.mockResolvedValue({
        id: 'rec456',
        fields: {
          'Number of warnings': 4
        }
      });

      mockUpdate.mockResolvedValue({
        id: 'rec456',
        fields: {
          'Number of warnings': 5
        }
      });

      await incrementWarningCount('rec456');

      expect(mockUpdate).toHaveBeenCalledWith('rec456', {
        'Number of warnings': 5,
        'Last Warning Date': mockDate
      });

      Date.prototype.toISOString.mockRestore();
    });

    it('should update last warning date to today', async () => {
      const mockDate = '2025-02-10';
      jest.spyOn(Date.prototype, 'toISOString').mockReturnValue(`${mockDate}T12:00:00.000Z`);

      mockFind.mockResolvedValue({
        id: 'rec123',
        fields: {
          'Number of warnings': 2,
          'Last Warning Date': '2025-02-03'
        }
      });

      mockUpdate.mockResolvedValue({
        id: 'rec123',
        fields: {
          'Number of warnings': 3,
          'Last Warning Date': mockDate
        }
      });

      await incrementWarningCount('rec123');

      expect(mockUpdate).toHaveBeenCalledWith('rec123',
        expect.objectContaining({
          'Last Warning Date': mockDate
        })
      );

      Date.prototype.toISOString.mockRestore();
    });

    it('should handle increment errors', async () => {
      mockFind.mockRejectedValue(new Error('Record not found'));

      await expect(incrementWarningCount('rec999'))
        .rejects
        .toThrow('Record not found');
    });
  });

  describe('updateWarningStatus', () => {
    it('should update status to Photo Added', async () => {
      const mockDate = '2025-02-05';
      jest.spyOn(Date.prototype, 'toISOString').mockReturnValue(`${mockDate}T12:00:00.000Z`);

      mockUpdate.mockResolvedValue({
        id: 'rec123',
        fields: {
          'Status': 'Photo Added',
          'Last Warning Date': mockDate
        }
      });

      const result = await updateWarningStatus('rec123', 'Photo Added');

      expect(mockUpdate).toHaveBeenCalledWith('rec123', {
        'Status': 'Photo Added',
        'Last Warning Date': mockDate
      });

      expect(result.fields['Status']).toBe('Photo Added');

      Date.prototype.toISOString.mockRestore();
    });

    it('should update status to Deactivated', async () => {
      const mockDate = '2025-02-05';
      jest.spyOn(Date.prototype, 'toISOString').mockReturnValue(`${mockDate}T12:00:00.000Z`);

      mockUpdate.mockResolvedValue({
        id: 'rec456',
        fields: {
          'Status': 'Deactivated'
        }
      });

      await updateWarningStatus('rec456', 'Deactivated');

      expect(mockUpdate).toHaveBeenCalledWith('rec456', {
        'Status': 'Deactivated',
        'Last Warning Date': mockDate
      });

      Date.prototype.toISOString.mockRestore();
    });

    it('should reject invalid status', async () => {
      await expect(updateWarningStatus('rec123', 'InvalidStatus'))
        .rejects
        .toThrow('Invalid status: InvalidStatus');

      // Verify update was never called
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('should accept all valid statuses', async () => {
      const mockDate = '2025-02-05';
      jest.spyOn(Date.prototype, 'toISOString').mockReturnValue(`${mockDate}T12:00:00.000Z`);

      mockUpdate.mockResolvedValue({ id: 'rec123', fields: {} });

      const validStatuses = ['Active', 'Photo Added', 'Deactivated'];

      for (const status of validStatuses) {
        await updateWarningStatus('rec123', status);
        expect(mockUpdate).toHaveBeenCalledWith('rec123',
          expect.objectContaining({ 'Status': status })
        );
      }

      Date.prototype.toISOString.mockRestore();
    });

    it('should update last warning date when status changes', async () => {
      const mockDate = '2025-02-05';
      jest.spyOn(Date.prototype, 'toISOString').mockReturnValue(`${mockDate}T12:00:00.000Z`);

      mockUpdate.mockResolvedValue({ id: 'rec123', fields: {} });

      await updateWarningStatus('rec123', 'Active');

      expect(mockUpdate).toHaveBeenCalledWith('rec123',
        expect.objectContaining({
          'Last Warning Date': mockDate
        })
      );

      Date.prototype.toISOString.mockRestore();
    });
  });

  describe('deleteWarningRecord', () => {
    it('should delete warning record by ID', async () => {
      mockDestroy.mockResolvedValue(undefined);

      await deleteWarningRecord('rec123');

      expect(mockDestroy).toHaveBeenCalledWith('rec123');
      expect(console.log).toHaveBeenCalledWith(
        'Successfully deleted warning record:',
        'rec123'
      );
    });

    it('should handle deletion errors gracefully', async () => {
      mockDestroy.mockRejectedValue(new Error('Deletion failed'));

      await expect(deleteWarningRecord('rec999'))
        .rejects
        .toThrow('Deletion failed');

      expect(console.error).toHaveBeenCalledWith(
        'Error deleting warning record:',
        'Deletion failed'
      );
    });

    it('should handle deleting non-existent record', async () => {
      mockDestroy.mockRejectedValue(new Error('NOT_FOUND'));

      await expect(deleteWarningRecord('recNonExistent'))
        .rejects
        .toThrow('NOT_FOUND');
    });
  });

  describe('getActiveWarnings', () => {
    it('should return all active warning records', async () => {
      const mockRecords = [
        {
          id: 'rec123',
          fields: { 'Email': 'alice@example.com', 'Status': 'Active', 'Number of warnings': 2 }
        },
        {
          id: 'rec456',
          fields: { 'Email': 'bob@example.com', 'Status': 'Active', 'Number of warnings': 1 }
        }
      ];

      mockFirstPage.mockResolvedValue(mockRecords);

      const result = await getActiveWarnings();

      expect(result).toEqual(mockRecords);
      expect(result).toHaveLength(2);
      expect(mockSelect).toHaveBeenCalledWith({
        filterByFormula: `{Status} = 'Active'`
      });
    });

    it('should return empty array when no active warnings exist', async () => {
      mockFirstPage.mockResolvedValue([]);

      const result = await getActiveWarnings();

      expect(result).toEqual([]);
      expect(result).toHaveLength(0);
    });

    it('should handle Airtable API errors', async () => {
      mockFirstPage.mockRejectedValue(new Error('Airtable API error'));

      await expect(getActiveWarnings())
        .rejects
        .toThrow('Airtable API error');

      expect(console.error).toHaveBeenCalledWith(
        'Error fetching active warnings:',
        'Airtable API error'
      );
    });
  });
});
