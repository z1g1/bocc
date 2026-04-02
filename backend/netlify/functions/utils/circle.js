/**
 * Circle.so Admin API v2 Utilities
 * Community member management and photo enforcement
 *
 * IMPORTANT: Circle.so does NOT expose audience segments via API v2.
 * We fetch all members and filter client-side for members without photos.
 *
 * See why: docs/CIRCLE_SEGMENTS_RESEARCH.md
 * See safety limits: docs/SAFETY_LIMITS_SPECIFICATION.md
 *
 * Epic 4: Profile Photo Enforcement System
 * Epic 5: Refactored from segment-based to client-side filtering (Feb 2026)
 */

const axios = require('axios');

// Circle.so Admin API v2 configuration
const CIRCLE_API_BASE_URL = 'https://app.circle.so/api/admin/v2';
const CIRCLE_API_TOKEN = process.env.CIRCLE_API_TOKEN;

console.log('Circle API Token:', CIRCLE_API_TOKEN ? 'Exists' : 'Not set');

/**
 * Safety Limits for Member Processing
 *
 * These limits prevent accidental mass-processing scenarios where bugs or
 * misconfigurations could cause the system to process thousands of members
 * instead of the intended subset.
 *
 * Current stats (verified 2026-02-06):
 * - Total community members: 60 (API returns "Profile complete" only)
 * - Circle.so UI total: 77 (includes 17 pending/incomplete invitations)
 * - Members without photos: 10 (with "Profile complete" status)
 * - Expected 1-year growth: 200-500 total members
 *
 * Limit rationale:
 * - 500 warning = 8x current, top of expected range
 * - 1000 hard cap = 16x current, 2x expected max
 * - Performance acceptable up to 1000 members (<2 sec API response)
 *
 * If legitimately exceeded:
 * 1. Verify member count is correct (check Circle.so dashboard)
 * 2. Update constants below with new limits
 * 3. Document change in commit message
 * 4. Update this comment with new stats
 *
 * See full spec: docs/SAFETY_LIMITS_SPECIFICATION.md
 */

// Warning threshold: Log alert but continue processing
const WARNING_THRESHOLD_MEMBERS = 500;

// Hard limit: Throw error and stop processing
const HARD_LIMIT_MAX_MEMBERS = 1000;

// Create axios instance with default configuration
const circleApi = axios.create({
    baseURL: CIRCLE_API_BASE_URL,
    headers: {
        'Authorization': `Bearer ${CIRCLE_API_TOKEN}`,
        'Content-Type': 'application/json'
    }
});

/**
 * Search for a community member by email
 * @param {string} email - Member email address
 * @returns {Promise<object|null>} Member object if found, null otherwise
 */
const findMemberByEmail = async (email) => {
    try {
        console.log('Searching for Circle member:', email);

        // GET /api/admin/v2/community_members with pagination
        // We'll need to search through results to find matching email
        const response = await circleApi.get('/community_members', {
            params: {
                per_page: 100  // Fetch more results to improve search
            }
        });

        if (response.data && response.data.records) {
            // Search for member with matching email (case-insensitive)
            const member = response.data.records.find(
                m => m.email && m.email.toLowerCase() === email.toLowerCase()
            );

            if (member) {
                console.log('Found existing Circle member:', member.id);
                return member;
            }
        }

        console.log('No Circle member found with email:', email);
        return null;
    } catch (error) {
        console.error('Error searching for Circle member:', error.message);
        if (error.response) {
            console.error('Response status:', error.response.status);
            console.error('Response data:', error.response.data);
        }
        throw error;
    }
};

/**
 * Create or invite a new community member
 * @param {string} email - Member email address
 * @param {string} name - Member name
 * @returns {Promise<object>} Created member object
 */
const createMember = async (email, name) => {
    try {
        console.log('Creating Circle member:', email, name);

        const response = await circleApi.post('/community_members', {
            email: email,
            name: name
            // Additional fields may be required - will discover during testing
        });

        console.log('Successfully created Circle member:', response.data);
        return response.data;
    } catch (error) {
        console.error('Error creating Circle member:', error.message);
        if (error.response) {
            console.error('Response status:', error.response.status);
            console.error('Response data:', error.response.data);
        }
        throw error;
    }
};

/**
 * Update a member's custom field
 * @param {number|string} memberId - Circle member ID
 * @param {string} fieldName - Custom field name (e.g., 'checkinCount')
 * @param {any} value - Value to set
 * @returns {Promise<object>} Updated member object
 */
const updateMemberCustomField = async (memberId, fieldName, value) => {
    try {
        console.log(`Updating Circle member ${memberId} custom field ${fieldName}:`, value);

        const response = await circleApi.patch(`/community_members/${memberId}`, {
            custom_fields_attributes: {
                [fieldName]: value
            }
        });

        console.log('Successfully updated member custom field:', response.data);
        return response.data;
    } catch (error) {
        console.error('Error updating member custom field:', error.message);
        if (error.response) {
            console.error('Response status:', error.response.status);
            console.error('Response data:', error.response.data);
        }
        throw error;
    }
};

/**
 * Increment a member's check-in counter
 * @param {number|string} memberId - Circle member ID
 * @param {number} currentCount - Current check-in count (optional, fetches if not provided)
 * @returns {Promise<object>} Updated member object
 */
const incrementCheckinCount = async (memberId, currentCount = null) => {
    try {
        console.log('Incrementing check-in count for Circle member:', memberId);

        // If current count not provided, we'll increment by 1 from whatever exists
        // Circle.so might handle this automatically, or we may need to fetch first
        const newCount = currentCount !== null ? currentCount + 1 : 1;

        return await updateMemberCustomField(memberId, 'checkinCount', newCount);
    } catch (error) {
        console.error('Error incrementing check-in count:', error.message);
        throw error;
    }
};

/**
 * Create or update a community member (finds existing first)
 * @param {string} email - Member email address
 * @param {string} name - Member name
 * @returns {Promise<object>} Member object (existing or newly created)
 */
const ensureMember = async (email, name) => {
    // First check if member exists
    const existingMember = await findMemberByEmail(email);

    if (existingMember) {
        console.log('Member already exists in Circle:', email);
        return existingMember;
    }

    // Create new member if not found
    console.log('Creating new Circle member:', email);
    return await createMember(email, name);
};

/**
 * Get all community members
 *
 * Fetches ALL community members via /community_members endpoint with pagination.
 *
 * Safety Limits:
 * - 500 members: Warning logged (approaching limit)
 * - 1000 members: Error thrown (hard cap to prevent mass-processing bugs)
 * See: docs/SAFETY_LIMITS_SPECIFICATION.md
 *
 * @returns {Promise<Array>} All community members
 * @throws {Error} If member count exceeds 1000 (safety limit)
 *
 * @example
 * const members = await getAllMembers();
 * // Returns: [{id: 'abc', email: 'user@example.com', avatar_url: '...'}, ...]
 */
const getAllMembers = async () => {
    const startTime = Date.now();

    console.log('Fetching all community members...');

    try {
        let allMembers = [];
        let page = 1;
        let hasMore = true;

        // Fetch all community members with pagination
        // Circle.so uses has_next_page field (not page count math)
        while (hasMore) {
            const response = await circleApi.get('/community_members', {
                params: {
                    per_page: 100,
                    page: page
                },
                timeout: 30000
            });

            // Validate response structure
            if (!response.data || !response.data.records) {
                throw new Error(`Invalid API response: missing 'records' field`);
            }

            allMembers = allMembers.concat(response.data.records);

            // Check has_next_page field (Circle.so v2 API standard)
            hasMore = response.data.has_next_page === true;
            page++;

            if (hasMore) {
                console.log(`Fetched page ${page - 1}, continuing to next page...`);
            }
        }

        const totalMembers = allMembers.length;
        console.log(`Fetched ${totalMembers} total community members`);

        // Check safety limits before filtering
        // See: docs/SAFETY_LIMITS_SPECIFICATION.md

        if (totalMembers >= WARNING_THRESHOLD_MEMBERS && totalMembers < HARD_LIMIT_MAX_MEMBERS) {
            // Log warning but continue (not critical yet)
            console.warn(
                `⚠️  WARNING: Processing ${totalMembers} members. ` +
                `Approaching safety limit (${HARD_LIMIT_MAX_MEMBERS}). ` +
                `See: docs/SAFETY_LIMITS_SPECIFICATION.md`
            );
        }

        if (totalMembers >= HARD_LIMIT_MAX_MEMBERS) {
            // Throw error to prevent mass-processing bugs
            const errorMsg =
                `Safety limit exceeded: Found ${totalMembers} members, ` +
                `maximum allowed is ${HARD_LIMIT_MAX_MEMBERS}. ` +
                `This prevents accidental mass-processing. ` +
                `\n\n` +
                `If your community legitimately has ${totalMembers} members:\n` +
                `1. Verify this count is correct (check Circle.so dashboard)\n` +
                `2. Update HARD_LIMIT_MAX_MEMBERS in netlify/functions/utils/circle.js\n` +
                `3. Document the change in commit message\n` +
                `4. Update safety limits documentation\n` +
                `\n` +
                `See: docs/SAFETY_LIMITS_SPECIFICATION.md`;

            console.error('🚨 SAFETY LIMIT EXCEEDED:', errorMsg);
            throw new Error(errorMsg);
        }

        console.log(`getAllMembers completed in ${Date.now() - startTime}ms`);

        return allMembers;

    } catch (error) {
        console.error('CRITICAL ERROR: Failed to fetch members:', error.message);

        if (error.response) {
            console.error('Circle API response status:', error.response.status);
            console.error('Circle API response data:', JSON.stringify(error.response.data));

            // Provide helpful error messages for common failures
            if (error.response.status === 401) {
                throw new Error(`Circle API authentication failed. Check that CIRCLE_API_TOKEN is set correctly.`);
            }
        }

        throw error;
    }
};

/**
 * Get all community members without profile photos
 *
 * Fetches ALL community members via getAllMembers() and filters
 * client-side for members where avatar_url is null or empty string.
 *
 * Why client-side filtering?
 * Circle.so Admin API v2 does NOT support querying audience segments.
 * See: docs/CIRCLE_SEGMENTS_RESEARCH.md
 *
 * @returns {Promise<Array>} Members without profile photos (avatar_url null or "")
 * @throws {Error} If member count exceeds 1000 (safety limit)
 *
 * @example
 * const members = await getMembersWithoutPhotos();
 * // Returns: [{id: 'abc', email: 'user@example.com', avatar_url: null}, ...]
 */
const getMembersWithoutPhotos = async () => {
    const allMembers = await getAllMembers();

    // Filter for members without profile photos
    // No photo = avatar_url is null OR empty string
    const membersWithoutPhotos = allMembers.filter(member => {
        const hasPhoto = member.avatar_url && member.avatar_url !== '';
        return !hasPhoto;
    });

    console.log(`Found ${membersWithoutPhotos.length} members without profile photos`);

    return membersWithoutPhotos;
};

/**
 * FUTURE: If Circle.so adds segment API support
 *
 * If Circle.so implements /community_segments endpoint in the future:
 * 1. Test the endpoint thoroughly
 * 2. Compare performance (segment vs. client-side filtering)
 * 3. Consider migration only if >2000 members (see research doc)
 * 4. Keep this function as fallback if segment API fails
 *
 * Migration not recommended unless member count exceeds 5000.
 * Current approach works well at <1000 member scale.
 *
 * See: docs/CIRCLE_SEGMENTS_RESEARCH.md (Future Monitoring section)
 */

// REMOVED: getAllMembersWithoutPhotos() fallback
// Safety: We must NEVER fall back to processing all members
// If the segment doesn't exist, the function should fail

/**
 * Deactivate a community member
 * Soft-deletes member account via Admin API v2
 *
 * @param {string} memberId - Circle member ID to deactivate
 * @returns {Promise<void>}
 * @throws {Error} If deactivation fails
 */
const deactivateMember = async (memberId) => {
  try {
    // Input validation
    if (!memberId || memberId === '') {
      throw new Error('memberId is required');
    }

    console.log('Deactivating Circle member:', memberId);

    // DELETE /api/admin/v2/community_members/{id}
    // Note: This is typically a soft delete that deactivates the member
    await circleApi.delete(`/community_members/${memberId}`);

    console.log('Successfully deactivated Circle member:', memberId);
  } catch (error) {
    console.error('Error deactivating Circle member:', error.message);
    if (error.response) {
      console.error('Circle API response status:', error.response.status);
      console.error('Circle API response data:', JSON.stringify(error.response.data));
    }
    throw error;
  }
};

module.exports = {
    findMemberByEmail,
    createMember,
    updateMemberCustomField,
    incrementCheckinCount,
    ensureMember,
    deactivateMember,
    getAllMembers,
    getMembersWithoutPhotos
};
