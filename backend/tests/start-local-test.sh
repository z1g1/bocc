#!/bin/bash
# Helper script to start Netlify dev server, run smoke test, and clean up
# This automates the full local testing workflow

set -e

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "=========================================="
echo "Starting Local Smoke Test"
echo "=========================================="
echo ""

# Check if netlify CLI is available
if ! command -v netlify &> /dev/null && ! command -v npx &> /dev/null; then
    echo -e "${RED}Error: netlify CLI not found${NC}"
    echo "Install with: npm install netlify-cli"
    exit 1
fi

# Start Netlify dev in background
echo -e "${YELLOW}Starting Netlify dev server...${NC}"
npx netlify dev > /tmp/netlify-dev.log 2>&1 &
NETLIFY_PID=$!

# Function to cleanup on exit
cleanup() {
    echo ""
    echo "Cleaning up..."
    if [ ! -z "${NETLIFY_PID}" ]; then
        kill ${NETLIFY_PID} 2>/dev/null || true
        # Kill any remaining netlify processes
        pkill -f "netlify dev" 2>/dev/null || true
    fi
    rm -f /tmp/netlify-dev.log
}

# Register cleanup on script exit
trap cleanup EXIT INT TERM

# Wait for server to be ready (check for port 8888)
echo "Waiting for server to be ready..."
MAX_WAIT=30
ELAPSED=0

while ! curl -s http://localhost:8888 > /dev/null 2>&1; do
    sleep 1
    ELAPSED=$((ELAPSED + 1))
    if [ ${ELAPSED} -ge ${MAX_WAIT} ]; then
        echo -e "${RED}Timeout: Server did not start within ${MAX_WAIT} seconds${NC}"
        echo ""
        echo "Server log:"
        cat /tmp/netlify-dev.log
        exit 1
    fi
    echo -n "."
done

echo ""
echo -e "${GREEN}Server is ready!${NC}"
echo ""

# Run the smoke test
API_URL="http://localhost:8888/.netlify/functions/checkin" ./tests/smoke-test.sh

# Capture exit code
TEST_RESULT=$?

echo ""
if [ ${TEST_RESULT} -eq 0 ]; then
    echo -e "${GREEN}=========================================="
    echo "Local smoke test completed successfully!"
    echo "==========================================${NC}"
else
    echo -e "${RED}=========================================="
    echo "Local smoke test failed!"
    echo "==========================================${NC}"
fi

exit ${TEST_RESULT}
