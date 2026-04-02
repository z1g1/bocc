#!/bin/bash
# Quick test script for Circle.so API tokens
# Usage: ./test-circle-api.sh

set -e

# Load environment variables
source .env

echo "=================================="
echo "Circle.so API Token Test"
echo "=================================="
echo ""

# Check if tokens are set
if [ -z "$CIRCLE_API_TOKEN" ]; then
    echo "❌ CIRCLE_API_TOKEN is not set in .env"
    exit 1
fi

if [ -z "$CIRCLE_HEADLESS_API" ]; then
    echo "❌ CIRCLE_HEADLESS_API is not set in .env"
    exit 1
fi

echo "✓ Tokens found in .env"
echo "  - CIRCLE_API_TOKEN length: ${#CIRCLE_API_TOKEN} characters"
echo "  - CIRCLE_HEADLESS_API length: ${#CIRCLE_HEADLESS_API} characters"
echo ""

# Test Admin API v2
echo "Testing Admin API v2..."
ADMIN_RESPONSE=$(curl -s -w "\n%{http_code}" \
  -H "Authorization: Bearer $CIRCLE_API_TOKEN" \
  -H "Content-Type: application/json" \
  "https://app.circle.so/api/admin/v2/community_members?per_page=1")

HTTP_CODE=$(echo "$ADMIN_RESPONSE" | tail -n1)
BODY=$(echo "$ADMIN_RESPONSE" | head -n -1)

if [ "$HTTP_CODE" = "200" ]; then
    echo "✅ Admin API token is VALID"
    echo ""
    echo "Sample member data:"
    echo "$BODY" | python3 -m json.tool 2>/dev/null | head -30
    echo ""

    # Check for has_profile_picture field
    if echo "$BODY" | grep -q "has_profile_picture"; then
        echo "✅ has_profile_picture field is available"
    else
        echo "⚠️  has_profile_picture field NOT found in response"
    fi
else
    echo "❌ Admin API token is INVALID"
    echo "   HTTP Status: $HTTP_CODE"
    echo "   Response: $BODY"
    exit 1
fi

echo ""
echo "=================================="
echo "Test Complete"
echo "=================================="
