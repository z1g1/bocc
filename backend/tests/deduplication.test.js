// Mock Airtable before requiring the module
const mockSelect = jest.fn();
const mockFirstPage = jest.fn();
const mockBase = jest.fn();

jest.mock('airtable', () => {
    return {
        configure: jest.fn(),
        base: jest.fn(() => mockBase)
    };
});

// Set up the mock base to return proper structure
mockBase.mockImplementation((tableName) => ({
    select: mockSelect.mockReturnValue({
        firstPage: mockFirstPage
    })
}));

const { findExistingCheckin } = require('../netlify/functions/utils/airtable');

describe('Check-in Deduplication', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockBase.mockImplementation((tableName) => ({
            select: mockSelect.mockReturnValue({
                firstPage: mockFirstPage
            })
        }));
    });

    describe('findExistingCheckin', () => {
        test('returns null when no check-in exists', async () => {
            mockFirstPage.mockResolvedValue([]);

            const result = await findExistingCheckin('recABC123', 'bocc', 'test-token');

            expect(result).toBeNull();
        });

        test('returns existing check-in when found', async () => {
            const mockCheckin = {
                id: 'rec123',
                get: jest.fn((field) => {
                    if (field === 'Attendee') return ['recABC123']; // Linked record field returns array
                    if (field === 'eventId') return 'bocc';
                    if (field === 'token') return 'test-token';
                    if (field === 'checkinDate') return new Date().toISOString();
                })
            };

            mockFirstPage.mockResolvedValue([mockCheckin]);

            const result = await findExistingCheckin('recABC123', 'bocc', 'test-token');

            expect(result).toBeTruthy();
            expect(result.id).toBe('rec123');
        });

        test('filters by attendeeId correctly', async () => {
            const mockCheckin1 = {
                id: 'rec123',
                get: jest.fn((field) => {
                    if (field === 'Attendee') return ['recDIFFERENT'];
                })
            };
            const mockCheckin2 = {
                id: 'rec456',
                get: jest.fn((field) => {
                    if (field === 'Attendee') return ['recABC123'];
                })
            };

            mockFirstPage.mockResolvedValue([mockCheckin1, mockCheckin2]);

            const result = await findExistingCheckin('recABC123', 'bocc', 'test-token');

            expect(result).toBeTruthy();
            expect(result.id).toBe('rec456'); // Should return the matching one
        });

        test('sanitizes inputs to prevent formula injection', async () => {
            mockFirstPage.mockResolvedValue([]);

            await findExistingCheckin('recABC123', "bocc'test", 'test-token');

            // Verify the formula escapes single quotes in eventId
            const selectCall = mockSelect.mock.calls[0][0];
            expect(selectCall.filterByFormula).toContain("\\'");
        });

        test('filters by same calendar day', async () => {
            mockFirstPage.mockResolvedValue([]);

            await findExistingCheckin('recABC123', 'bocc', 'test-token');

            // Verify the formula uses DATESTR for date comparison
            const selectCall = mockSelect.mock.calls[0][0];
            expect(selectCall.filterByFormula).toContain('DATESTR({checkinDate})');

            // Should use today's date
            const today = new Date().toISOString().split('T')[0];
            expect(selectCall.filterByFormula).toContain(today);
        });

        test('queries without maxRecords limit for client-side filtering', async () => {
            mockFirstPage.mockResolvedValue([]);

            await findExistingCheckin('recABC123', 'bocc', 'test-token');

            const selectCall = mockSelect.mock.calls[0][0];
            // maxRecords is not set because we filter client-side
            expect(selectCall.maxRecords).toBeUndefined();
        });

        test('sorts by checkinDate descending to get most recent', async () => {
            mockFirstPage.mockResolvedValue([]);

            await findExistingCheckin('recABC123', 'bocc', 'test-token');

            const selectCall = mockSelect.mock.calls[0][0];
            expect(selectCall.sort).toEqual([{ field: 'checkinDate', direction: 'desc' }]);
        });

        test('handles Airtable API errors gracefully', async () => {
            mockFirstPage.mockRejectedValue(new Error('Airtable API error'));

            await expect(
                findExistingCheckin('recABC123', 'bocc', 'test-token')
            ).rejects.toThrow('Airtable API error');
        });
    });
});
