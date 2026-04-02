#!/bin/bash

# Circle.so API Diagnostic Test
# This script helps diagnose Circle.so API integration issues

echo "================================================"
echo "Circle.so API Diagnostic Test"
echo "================================================"
echo ""

# Check if CIRCLE_API_TOKEN is set (for local testing)
if [ -z "$CIRCLE_API_TOKEN" ]; then
    echo "⚠️  CIRCLE_API_TOKEN not set locally"
    echo "   This is expected - token should be set in Netlify"
    echo ""
fi

# Test 1: Make a check-in that should trigger Circle invitation
echo "📝 Test 1: Check-in with Circle invitation"
echo "Testing against: https://bocc-backend.netlify.app/.netlify/functions/checkin"
echo ""

TIMESTAMP=$(date +%s)
TEST_EMAIL="circle-test-${TIMESTAMP}@example.com"

echo "Test email: ${TEST_EMAIL}"
echo ""

RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "https://bocc-backend.netlify.app/.netlify/functions/checkin" \
  -H "Content-Type: application/json" \
  -d "{
    \"email\": \"${TEST_EMAIL}\",
    \"name\": \"Circle Test User\",
    \"phone\": \"555-0100\",
    \"businessName\": \"Test Company\",
    \"okToEmail\": true,
    \"eventId\": \"circle-test\",
    \"debug\": \"0\",
    \"token\": \"test-token-diagnostic\"
  }")

# Extract HTTP status code (last line)
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)

# Extract response body (all but last line)
BODY=$(echo "$RESPONSE" | sed '$d')

echo "Response:"
echo "${BODY}" | jq '.' 2>/dev/null || echo "${BODY}"
echo ""
echo "HTTP Status: ${HTTP_CODE}"
echo ""

if [ "${HTTP_CODE}" = "200" ]; then
    echo "✅ Check-in API call succeeded"
else
    echo "❌ Check-in API call failed"
    exit 1
fi

echo ""
echo "================================================"
echo "Next Steps:"
echo "================================================"
echo ""
echo "1. Check Netlify function logs at:"
echo "   https://app.netlify.com/sites/bocc-backend/functions"
echo ""
echo "2. Look for these log entries:"
echo "   - 'Inviting attendee to Circle.so: ${TEST_EMAIL}'"
echo "   - 'Searching for Circle member: ${TEST_EMAIL}'"
echo "   - 'Creating Circle member: ${TEST_EMAIL}'"
echo "   - 'Successfully ensured Circle member: [id]'"
echo "   - OR: 'Failed to invite to Circle.so (non-blocking): [error]'"
echo ""
echo "3. Check Circle.so community members:"
echo "   - Look for: ${TEST_EMAIL}"
echo "   - Or name: Circle Test User"
echo ""
echo "4. Check Circle.so API logs/analytics if available"
echo ""
