/**
 * Unit tests for Circle.so member photo detection
 * Tests getMembersWithoutPhotos() function with client-side filtering
 *
 * Epic 5: Circle.so Member Photo Detection Refactoring (STORY-20, STORY-21)
 * Refactored from segment-based to client-side filtering approach
 *
 * See: docs/CIRCLE_SEGMENTS_RESEARCH.md (why segments don't work)
 * See: docs/SAFETY_LIMITS_SPECIFICATION.md (safety limits rationale)
 * See: docs/NEW_TEST_SCENARIOS_EPIC_5.md (test scenarios)
 */

// Mock axios before requiring the module
const mockAxiosGet = jest.fn();
const mockAxiosPost = jest.fn();
const mockAxiosPatch = jest.fn();
const mockAxiosDelete = jest.fn();
const mockAxiosCreate = jest.fn(() => ({
  get: mockAxiosGet,
  post: mockAxiosPost,
  patch: mockAxiosPatch,
  delete: mockAxiosDelete
}));

jest.mock('axios', () => ({
  create: mockAxiosCreate
}));

const { getMembersWithoutPhotos, getAllMembers } = require('../netlify/functions/utils/circle');

describe('getAllMembers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    console.log.mockRestore();
    console.error.mockRestore();
    console.warn.mockRestore();
  });

  it('should return all members without filtering', async () => {
    const allMembers = [
      { id: '1', email: 'a@example.com', avatar_url: 'https://photo.jpg' },
      { id: '2', email: 'b@example.com', avatar_url: null },
      { id: '3', email: 'c@example.com', avatar_url: '' }
    ];

    mockAxiosGet.mockResolvedValue({
      data: { records: allMembers, has_next_page: false }
    });

    const result = await getAllMembers();
    expect(result).toHaveLength(3);
    expect(result).toEqual(allMembers);
  });

  it('should handle pagination across multiple pages', async () => {
    mockAxiosGet
      .mockResolvedValueOnce({
        data: {
          records: [{ id: '1', email: 'page1@example.com' }],
          has_next_page: true
        }
      })
      .mockResolvedValueOnce({
        data: {
          records: [{ id: '2', email: 'page2@example.com' }],
          has_next_page: false
        }
      });

    const result = await getAllMembers();
    expect(result).toHaveLength(2);
    expect(result[0].email).toBe('page1@example.com');
    expect(result[1].email).toBe('page2@example.com');
    expect(mockAxiosGet).toHaveBeenCalledTimes(2);
  });

  it('should throw error at hard limit (1000 members)', async () => {
    const members1000 = Array(1000).fill(null).map((_, i) => ({
      id: `member-${i}`, email: `user${i}@example.com`
    }));

    mockAxiosGet.mockResolvedValue({
      data: { records: members1000, has_next_page: false }
    });

    await expect(getAllMembers()).rejects.toThrow('Safety limit exceeded');
  });

  it('should log warning at 500 members but continue', async () => {
    const members500 = Array(500).fill(null).map((_, i) => ({
      id: `member-${i}`, email: `user${i}@example.com`
    }));

    mockAxiosGet.mockResolvedValue({
      data: { records: members500, has_next_page: false }
    });

    const result = await getAllMembers();
    expect(result).toHaveLength(500);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('WARNING: Processing 500 members')
    );
  });

  it('should throw on invalid API response', async () => {
    mockAxiosGet.mockResolvedValue({ data: {} });

    await expect(getAllMembers()).rejects.toThrow("Invalid API response: missing 'records' field");
  });
});

describe('getMembersWithoutPhotos', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    console.log.mockRestore();
    console.error.mockRestore();
    console.warn.mockRestore();
  });

  // TEST SCENARIO 1: Client-Side Filtering by avatar_url (Null)
  // See: docs/NEW_TEST_SCENARIOS_EPIC_5.md - Test Scenario 1
  describe('Client-side filtering logic', () => {
    it('should filter members with null avatar_url as having no photo', async () => {
      const membersWithMixedPhotos = [
        {
          id: 'member-1',
          email: 'hasphoto@example.com',
          name: 'Has Photo User',
          avatar_url: 'https://app.circle.so/rails/active_storage/photo.jpg'
        },
        {
          id: 'member-2',
          email: 'nophoto@example.com',
          name: 'No Photo User',
          avatar_url: null  // <-- NULL means no photo
        },
        {
          id: 'member-3',
          email: 'alsohphoto@example.com',
          name: 'Also Has Photo',
          avatar_url: 'https://example.com/another-photo.png'
        }
      ];

      mockAxiosGet.mockResolvedValue({
        data: {
          records: membersWithMixedPhotos,
          has_next_page: false
        }
      });

      const result = await getMembersWithoutPhotos();

      // Should return only the member with null avatar_url
      expect(result).toHaveLength(1);
      expect(result[0].email).toBe('nophoto@example.com');
      expect(result[0].avatar_url).toBeNull();

      // Should NOT include members with avatar URLs
      expect(result.find(m => m.email === 'hasphoto@example.com')).toBeUndefined();
      expect(result.find(m => m.email === 'alsohphoto@example.com')).toBeUndefined();
    });

    // TEST SCENARIO 2: Client-Side Filtering by avatar_url (Empty String)
    // See: docs/NEW_TEST_SCENARIOS_EPIC_5.md - Test Scenario 2
    it('should filter members with empty string avatar_url as having no photo', async () => {
      const membersWithEmptyStrings = [
        {
          id: 'member-1',
          email: 'emptystring@example.com',
          name: 'Empty String User',
          avatar_url: ''  // <-- EMPTY STRING means no photo
        },
        {
          id: 'member-2',
          email: 'hasphoto@example.com',
          name: 'Has Photo User',
          avatar_url: 'https://example.com/photo.jpg'
        },
        {
          id: 'member-3',
          email: 'nullphoto@example.com',
          name: 'Null Photo User',
          avatar_url: null
        }
      ];

      mockAxiosGet.mockResolvedValue({
        data: {
          records: membersWithEmptyStrings,
          has_next_page: false
        }
      });

      const result = await getMembersWithoutPhotos();

      // Should return members with null OR empty string
      expect(result).toHaveLength(2);

      // Both null and empty string should be included
      expect(result.find(m => m.email === 'emptystring@example.com')).toBeDefined();
      expect(result.find(m => m.email === 'nullphoto@example.com')).toBeDefined();

      // Members with actual URLs should be excluded
      expect(result.find(m => m.email === 'hasphoto@example.com')).toBeUndefined();
    });
  });

  // TEST SCENARIO 3: Safety Limit - Warning Threshold (500 Members)
  // See: docs/SAFETY_LIMITS_SPECIFICATION.md
  describe('Safety limits enforcement', () => {
    it('should log warning when fetching exactly 500 members but continue processing', async () => {
      // Generate 500 members: 250 with photos, 250 without
      const members500 = [
        ...Array(250).fill(null).map((_, i) => ({
          id: `with-photo-${i}`,
          email: `hasphoto${i}@example.com`,
          name: `User With Photo ${i}`,
          avatar_url: `https://example.com/photo-${i}.jpg`
        })),
        ...Array(250).fill(null).map((_, i) => ({
          id: `no-photo-${i}`,
          email: `nophoto${i}@example.com`,
          name: `User Without Photo ${i}`,
          avatar_url: null
        }))
      ];

      mockAxiosGet.mockResolvedValue({
        data: {
          records: members500,
          has_next_page: false
        }
      });

      const result = await getMembersWithoutPhotos();

      // Warning should be logged
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('WARNING: Processing 500 members')
      );
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Approaching safety limit')
      );

      // Processing should continue normally
      expect(result).toBeDefined();
      expect(result).toHaveLength(250);  // 250 members without photos

      // All 250 members without photos should be returned
      expect(result.every(m => m.avatar_url === null)).toBe(true);
    });

    // TEST SCENARIO 4: Safety Limit - Hard Cap (1000 Members)
    // See: docs/SAFETY_LIMITS_SPECIFICATION.md
    it('should throw error when fetching exactly 1000 members (hard limit)', async () => {
      // Generate 1000 members
      const members1000 = Array(1000).fill(null).map((_, i) => ({
        id: `member-${i}`,
        email: `user${i}@example.com`,
        name: `User ${i}`,
        avatar_url: i % 2 === 0 ? null : `https://example.com/photo-${i}.jpg`
      }));

      mockAxiosGet.mockResolvedValue({
        data: {
          records: members1000,
          has_next_page: false
        }
      });

      // Should throw error before filtering
      await expect(getMembersWithoutPhotos()).rejects.toThrow('Safety limit exceeded');
      await expect(getMembersWithoutPhotos()).rejects.toThrow('Found 1000 members');
      await expect(getMembersWithoutPhotos()).rejects.toThrow('maximum allowed is 1000');

      // Error should include instructions for fixing
      await expect(getMembersWithoutPhotos()).rejects.toThrow('Update HARD_LIMIT_MAX_MEMBERS');
    });

    // TEST SCENARIO 5: Safety Limit - Above Hard Cap (1001+ Members)
    // See: docs/SAFETY_LIMITS_SPECIFICATION.md
    it('should throw error when fetching more than 1000 members (5000 member test)', async () => {
      // Generate 5000 members (extreme case)
      const members5000 = Array(5000).fill(null).map((_, i) => ({
        id: `member-${i}`,
        email: `user${i}@example.com`,
        name: `User ${i}`,
        avatar_url: null  // All without photos for worst case
      }));

      mockAxiosGet.mockResolvedValue({
        data: {
          records: members5000,
          has_next_page: false
        }
      });

      // Error message should show actual count
      await expect(getMembersWithoutPhotos()).rejects.toThrow('Found 5000 members');

      // Console error should be logged (called with emoji prefix + error message)
      await getMembersWithoutPhotos().catch(() => {});  // Suppress error for assertion
      expect(console.error).toHaveBeenCalledWith(
        '🚨 SAFETY LIMIT EXCEEDED:',
        expect.stringContaining('Safety limit exceeded')
      );

      // Error should still reference the 1000 limit
      await expect(getMembersWithoutPhotos()).rejects.toThrow('maximum allowed is 1000');
    });
  });
});
