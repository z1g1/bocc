#!/usr/bin/env bash
# Runs one weekly social task (ADR 0011 decision 3, amended 2026-11-20) on Modron's machine:
# Claude Code, unattended (`claude -p`), driving a dedicated Chrome profile through the
# Chrome DevTools MCP server. Unlike Claude in Chrome, its upload_file tool takes a local
# path, so the promo video (often over 10 MB) and the cover image can be uploaded.
#
#   scripts/social/run-task.sh chrome     start the task Chrome (if not running) and exit
#   scripts/social/run-task.sh schedule   the Wednesday task (prompts/schedule.txt)
#   scripts/social/run-task.sh verify     the Monday task (prompts/verify.txt)
#
# Environment:
#   BOCC_SITE         required for schedule/verify: https://716coffee.club or the staging URL
#   BOCC_CHROME_DIR   default ~/bocc-chrome (profile/, downloads/, logs/)
#   BOCC_CHROME_PORT  default 9222 (remote debugging, bound to 127.0.0.1 only)
#   CHROME_BIN        default: google-chrome on Linux, Google Chrome.app on macOS
#   CLAUDE_MODEL      optional, passed to `claude --model`
#   CLAUDE_CODE_OAUTH_TOKEN  recommended for cron: a long-lived token from `claude setup-token`
#                     (a /login sign-in expires within days and a scheduled run can't renew it)
#
# Setup and the prompts' contract: docs/social/CHROME_TASKS.md.
set -euo pipefail

TASK="${1:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR="${BOCC_CHROME_DIR:-$HOME/bocc-chrome}"
PORT="${BOCC_CHROME_PORT:-9222}"
PROFILE="$DIR/profile"
DOWNLOADS="$DIR/downloads"
LOGS="$DIR/logs"
# Pinned; raise it deliberately (npm view chrome-devtools-mcp version) and re-run a task by hand.
MCP_PACKAGE="${BOCC_MCP_PACKAGE:-chrome-devtools-mcp@1.13.0}"

case "$TASK" in
  chrome|schedule|verify) ;;
  *) echo "usage: $0 chrome|schedule|verify" >&2; exit 2 ;;
esac

if [[ -z "${CHROME_BIN:-}" ]]; then
  if [[ "$(uname)" == "Darwin" ]]; then
    CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  else
    CHROME_BIN="$(command -v google-chrome || command -v google-chrome-stable || true)"
  fi
fi

mkdir -p "$PROFILE" "$DOWNLOADS" "$LOGS"

chrome_up() { curl -fsS "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; }

start_chrome() {
  if chrome_up; then return 0; fi
  if [[ -z "$CHROME_BIN" || ! -x "$CHROME_BIN" ]]; then
    echo "Chrome not found; set CHROME_BIN." >&2; exit 1
  fi
  # First run only: send downloads to $DOWNLOADS without asking, so the prompts can name
  # the files' paths. Chrome reads this Preferences file when it creates the profile.
  if [[ ! -e "$PROFILE/Default/Preferences" ]]; then
    mkdir -p "$PROFILE/Default"
    printf '{"download":{"default_directory":"%s","prompt_for_download":false,"directory_upgrade":true}}\n' \
      "$DOWNLOADS" > "$PROFILE/Default/Preferences"
  fi
  # A visible window, never --headless: the platforms treat headless browsers as bots.
  # Since Chrome 136 remote debugging needs a non-default --user-data-dir, hence the
  # dedicated profile.
  nohup "$CHROME_BIN" \
    --user-data-dir="$PROFILE" \
    --remote-debugging-port="$PORT" \
    --remote-debugging-address=127.0.0.1 \
    --no-first-run --no-default-browser-check \
    >>"$LOGS/chrome.log" 2>&1 &
  for _ in $(seq 1 30); do chrome_up && return 0; sleep 1; done
  echo "Chrome did not open its debugging port $PORT." >&2; exit 1
}

start_chrome
[[ "$TASK" == "chrome" ]] && exit 0

: "${BOCC_SITE:?set BOCC_SITE (https://716coffee.club or the staging URL)}"
BOCC_SITE="${BOCC_SITE%/}"

# Last week's files must not be mistaken for this week's.
find "$DOWNLOADS" -mindepth 1 -maxdepth 1 -type f -delete

STAMP="$(date +%Y-%m-%d-%H%M)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; [[ "$TASK" == "schedule" ]] && find "$DOWNLOADS" -mindepth 1 -maxdepth 1 -type f -delete' EXIT

# --workspace: the only folder upload_file may read from (the server's default is the OS temp
# folder, so without it the downloaded video and cover are "not within any of the configured
# workspace roots").
cat >"$WORK/mcp.json" <<JSON
{"mcpServers":{"chrome-devtools":{"command":"npx","args":["-y","$MCP_PACKAGE","--browserUrl=http://127.0.0.1:$PORT","--workspace=$DOWNLOADS","--no-usage-statistics"]}}}
JSON

PROMPT="$(sed -e "s|{SITE}|$BOCC_SITE|g" -e "s|{DOWNLOADS}|$DOWNLOADS|g" "$HERE/prompts/$TASK.txt")"

# Run from an empty directory so no project CLAUDE.md or settings join the prompt, and
# load no user settings either (--setting-sources project, and the folder has none), so a
# personal "ask" rule, default mode or hook can't change what the task may do.
# Permissions: dontAsk mode refuses every tool not named below, instead of asking a person
# who isn't there. Allowing the whole server ("mcp__chrome-devtools") was not enough on
# Modron's machine: click came back "you haven't granted it yet". So each tool is named.
# Left out on purpose: evaluate_script (no JavaScript on the platforms' pages), the
# network and console readers (they can show tokens), emulate, lighthouse, performance,
# screencast, logpoints and heap snapshots. No shell, no file tools, no web tools.
ALLOWED_TOOLS=(
  click close_page drag fill fill_form handle_dialog hover list_pages navigate_page
  new_page press_key resize_page select_page take_screenshot take_snapshot type_text
  upload_file wait_for
)
ALLOWED_TOOLS=("${ALLOWED_TOOLS[@]/#/mcp__chrome-devtools__}")
cd "$WORK"
MODEL_ARGS=()
[[ -n "${CLAUDE_MODEL:-}" ]] && MODEL_ARGS=(--model "$CLAUDE_MODEL")
set +e
claude -p "$PROMPT" \
  ${MODEL_ARGS[@]+"${MODEL_ARGS[@]}"} \
  --mcp-config "$WORK/mcp.json" --strict-mcp-config \
  --setting-sources project \
  --permission-mode dontAsk \
  --allowedTools "${ALLOWED_TOOLS[@]}" \
  --disallowedTools "mcp__chrome-devtools__evaluate_script" "Bash" "Edit" "Write" "WebFetch" "WebSearch" \
  --output-format text \
  </dev/null 2>&1 | tee "$LOGS/$TASK-$STAMP.log"
STATUS="${PIPESTATUS[0]}"
set -e
exit "$STATUS"
