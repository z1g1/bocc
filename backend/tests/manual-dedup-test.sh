#!/bin/bash

# Manual test script for Epic 1: Check-in Deduplication
# Usage: bash tests/manual-dedup-test.sh

API_URL="${API_URL:-http://localhost:8888/.netlify/functions/checkin}"

echo "🧪 Testing Epic 1: Check-in Deduplication"
echo "API URL: $API_URL"
echo ""

# Test 1: First check-in (should succeed)
echo "📝 Test 1: First check-in for test@example.com"
RESPONSE=$(curl -s -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "name": "Test User",
    "eventId": "bocc",
    "token": "test-token-123",
    "debug": "1"
  }')

echo "Response: $RESPONSE"

if echo "$RESPONSE" | grep -q "Check-in successful"; then
  echo "✅ PASS: First check-in succeeded"
else
  echo "❌ FAIL: First check-in failed"
fi
echo ""

# Wait a moment
sleep 1

# Test 2: Duplicate check-in (should be blocked)
echo "📝 Test 2: Duplicate check-in for same email/event/token"
RESPONSE=$(curl -s -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "name": "Test User",
    "eventId": "bocc",
    "token": "test-token-123",
    "debug": "1"
  }')

echo "Response: $RESPONSE"

if echo "$RESPONSE" | grep -q "Already checked in"; then
  echo "✅ PASS: Duplicate check-in blocked"
else
  echo "❌ FAIL: Duplicate check-in was not blocked!"
fi
echo ""

# Test 3: Different event (should succeed)
echo "📝 Test 3: Same email but different event"
RESPONSE=$(curl -s -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "name": "Test User",
    "eventId": "codeCoffee",
    "token": "different-token",
    "debug": "1"
  }')

echo "Response: $RESPONSE"

if echo "$RESPONSE" | grep -q "Check-in successful"; then
  echo "✅ PASS: Different event check-in succeeded"
else
  echo "❌ FAIL: Different event check-in failed"
fi
echo ""

# Test 4: Case-insensitive email (should be blocked)
echo "📝 Test 4: Case-insensitive email matching"
RESPONSE=$(curl -s -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "TEST@EXAMPLE.COM",
    "name": "Test User",
    "eventId": "bocc",
    "token": "test-token-123",
    "debug": "1"
  }')

echo "Response: $RESPONSE"

if echo "$RESPONSE" | grep -q "Already checked in"; then
  echo "✅ PASS: Case-insensitive duplicate blocked"
else
  echo "❌ FAIL: Case-insensitive matching not working"
fi
echo ""

# Test 5: Different token (should succeed)
echo "📝 Test 5: Same email/event but different token"
RESPONSE=$(curl -s -X POST "$API_URL" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "name": "Test User",
    "eventId": "bocc",
    "token": "new-token-789",
    "debug": "1"
  }')

echo "Response: $RESPONSE"

if echo "$RESPONSE" | grep -q "Check-in successful"; then
  echo "✅ PASS: Different token check-in succeeded"
else
  echo "❌ FAIL: Different token check-in failed"
fi
echo ""

echo "🏁 Test suite complete!"
echo ""
echo "💡 To run against production:"
echo "   API_URL=https://716coffee.club/.netlify/functions/checkin bash tests/manual-dedup-test.sh"
