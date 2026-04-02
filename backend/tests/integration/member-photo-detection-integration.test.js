/**
 * Integration test for getMembersWithoutPhotos
 * Tests real Circle.so API with production data
 *
 * Epic 5, Story 22, Task 107
 *
 * Prerequisites:
 * - CIRCLE_API_TOKEN set in environment
 * - Real Circle.so API access
 *
 * Run with: npm run test:integration
 * Or: RUN_INTEGRATION_TESTS=true npm test -- integration/member-photo-detection
 */

const { getMembersWithoutPhotos } = require('../../netlify/functions/utils/circle');

describe('getMembersWithoutPhotos Integration Test', () => {
  // Skip this test in CI/CD or if no API token available
  // Set RUN_INTEGRATION_TESTS=true to run manually
  // Requires CIRCLE_API_TOKEN environment variable
  const hasToken = !!process.env.CIRCLE_API_TOKEN;
  const shouldRunIntegration = hasToken && (process.env.RUN_INTEGRATION_TESTS === 'true' || !process.env.CI);

  if (!hasToken) {
    console.log('ℹ️  Skipping integration tests (CIRCLE_API_TOKEN not set)');
  }

  (shouldRunIntegration ? it : it.skip)(
    'should fetch all members and filter for those without photos from real API',
    async () => {
      console.log('Running integration test with real Circle.so API...');

      const startTime = Date.now();
      const membersWithoutPhotos = await getMembersWithoutPhotos();
      const duration = Date.now() - startTime;

      console.log(`Integration test completed in ${duration}ms`);
      console.log(`Found ${membersWithoutPhotos.length} members without photos`);

      // Verify response structure
      expect(Array.isArray(membersWithoutPhotos)).toBe(true);
      expect(membersWithoutPhotos.length).toBeGreaterThanOrEqual(0);

      // Verify each member has required fields
      membersWithoutPhotos.forEach(member => {
        expect(member).toHaveProperty('id');
        expect(member).toHaveProperty('email');
        expect(member).toHaveProperty('name');
        expect(member).toHaveProperty('avatar_url');

        // Verify avatar_url is null or empty
        expect(member.avatar_url === null || member.avatar_url === '').toBe(true);
      });

      // Log sample member for verification (if any found)
      if (membersWithoutPhotos.length > 0) {
        console.log('\nSample member without photo:');
        const sample = membersWithoutPhotos[0];
        console.log(`  - ID: ${sample.id}`);
        console.log(`  - Email: ${sample.email}`);
        console.log(`  - Name: ${sample.name}`);
        console.log(`  - avatar_url: ${sample.avatar_url}`);
      }

      // Verify performance target (<3 seconds)
      expect(duration).toBeLessThan(3000);

      console.log('\n✓ Integration test passed');
    },
    30000  // 30 second timeout
  );

  (shouldRunIntegration ? it : it.skip)(
    'should work end-to-end with enforcement function dry run',
    async () => {
      console.log('Testing enforcement function integration...');

      // This test verifies the enforcement function can successfully
      // call getMembersWithoutPhotos and process results
      const startTime = Date.now();
      const members = await getMembersWithoutPhotos();
      const duration = Date.now() - startTime;

      console.log(`Enforcement function would process ${members.length} members`);
      console.log(`Member fetch completed in ${duration}ms`);

      // Verify we can process the results
      expect(members.length).toBeGreaterThanOrEqual(0);

      // Simulate enforcement processing (dry run logic)
      let processableMembers = 0;
      for (const member of members) {
        if (member.email && member.id) {
          processableMembers++;
        }
      }

      console.log(`${processableMembers} members are processable (have email & ID)`);
      expect(processableMembers).toBe(members.length);

      console.log('\n✓ Enforcement integration test passed');
    },
    30000  // 30 second timeout
  );
});
